"""Periodic maintenance loops carved out of ``server.py``.

Each function moved verbatim; references to server.py module-level
globals (``store``, ``base_cfg``, ``runtimes``, ``settings``,
``weather_service``, ``telegram_service``) flow through
:mod:`app_state` instead. The heartbeat shares timing primitives
with the shutdown bilanz, so ``_BOOT_TS`` / ``_format_uptime`` /
``_disk_free_gb_cached`` live in :mod:`lifecycle` and are imported
here rather than duplicated.
"""

from __future__ import annotations

import logging
import threading
import time

from . import app_state
from .lifecycle import _BOOT_TS, _disk_free_gb_cached, _format_uptime


def _run_daily_cleanup():
    retention = int(app_state.base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = app_state.store.cleanup_old(retention)
        if removed:
            logging.getLogger(__name__).info(
                f"[storage] Removed {removed} old event files (>{retention}d)"
            )
    except Exception as e:
        logging.getLogger(__name__).warning(f"[storage] Failed: {e}")
    t = threading.Timer(86400, _run_daily_cleanup)
    t.daemon = True
    t.start()


def _run_hourly_quest_eval():
    """Trigger (b) for the F09 quest system: hourly full re-evaluation.

    The motion-finalize hook (trigger a) covers the common case, but
    this safety net catches drift — e.g. when events get deleted from
    the archive or when a window-boundary tick crosses a quest's
    `from`/`to`. Idempotent; runs detached.
    """
    import threading as _thr

    try:
        from .quests import reevaluate_and_save

        reevaluate_and_save()
    except Exception as e:
        logging.getLogger(__name__).warning("[quests] hourly eval failed: %s", e)
    t = _thr.Timer(3600, _run_hourly_quest_eval)
    t.daemon = True
    t.start()


def _seconds_until_rollover_check() -> float:
    """Seconds from now until the next 00:05 local-time tick. The
    rollover timer fires once per day at that offset (5 min past
    midnight) so the date has fully advanced before we check whether
    today is Monday / day-of-month-1."""
    import time as _time

    now = _time.localtime()
    # Build a struct_time for tomorrow at 00:05.
    tomorrow_secs = _time.mktime(now) + 86400
    target = _time.localtime(tomorrow_secs)
    target_t = _time.struct_time(
        (
            target.tm_year,
            target.tm_mon,
            target.tm_mday,
            0,
            5,
            0,
            target.tm_wday,
            target.tm_yday,
            target.tm_isdst,
        )
    )
    target_secs = _time.mktime(target_t)
    return max(60.0, target_secs - _time.mktime(now))


def _run_daily_quest_rollover_check():
    """Daily wake-up that checks whether today is a week-start
    (Monday) or month-start (day-of-month == 1). When either is
    true we run a full re-evaluation with ``is_rollover=True`` so the
    archive sweep + rollover log line happen at that boundary. On
    every other day this is a 1-line check and re-arm — cheap.

    Runs in addition to the hourly job; the hourly catches drift
    BETWEEN rollovers, the daily handles the rollover itself."""
    import threading as _thr
    from datetime import datetime as _dt

    try:
        today = _dt.now()
        is_week_start = today.weekday() == 0  # Monday
        is_month_start = today.day == 1
        if is_week_start or is_month_start:
            from .quests import reevaluate_and_save

            reevaluate_and_save(is_rollover=True)
    except Exception as e:
        logging.getLogger(__name__).warning(
            "[quests] daily rollover check failed: %s",
            e,
        )
    t = _thr.Timer(_seconds_until_rollover_check(), _run_daily_quest_rollover_check)
    t.daemon = True
    t.start()


def _heartbeat_emit():
    """Single periodic [heartbeat] line that summarises every subsystem in
    one row. Reuses values already exposed elsewhere (rt.status(), the
    weather runtime poll ts, the polling status). When something is
    unhealthy, the line escalates to WARNING so the rate-limit filter
    coalesces repeats without losing the signal."""
    log = logging.getLogger("app.app.heartbeat")
    parts = [f"uptime={_format_uptime(time.time() - _BOOT_TS)}"]
    unhealthy = False
    # Camera roster
    cam_bits = []
    cams_iter = list(app_state.runtimes.items())
    cam_bits_count = len(cams_iter)
    for cam_id, rt in cams_iter:
        try:
            st = rt.status() or {}
        except Exception:
            st = {}
        name = (st.get("name") or cam_id).split()[0]  # one word per cam keeps the line short
        if st.get("status") in ("active", "starting"):
            fps = st.get("preview_fps") or 0
            r24 = st.get("reconnect_count_24h", 0)
            cam_bits.append(f"{name} {fps:.0f}fps r24h={r24}")
        else:
            age = st.get("frame_age_s")
            age_str = f"{int(age) // 60}m" if isinstance(age, (int, float)) else "?"
            cam_bits.append(f"{name} OFFLINE (last frame {age_str} ago)")
            unhealthy = True
    parts.append(f"cams={cam_bits_count} ({', '.join(cam_bits) if cam_bits else '—'})")
    # Weather
    try:
        last_iso = app_state.settings.runtime_get("weather_last_poll_ts")
        if last_iso:
            age_min = int((time.time() - float(last_iso)) / 60)
            if age_min < 15:
                wpart = f"weather=ok (last poll {age_min}m"
            else:
                wpart = f"weather=stale (last poll {age_min}m"
                unhealthy = True
            # Active events from weather_service.status()
            active = []
            try:
                if app_state.weather_service:
                    cur = (app_state.weather_service.status() or {}).get("current_state") or {}
                    from .weather_service import EVENT_LABEL_DE as _W_LBL

                    active = [_W_LBL.get(k, k) for k, on in cur.items() if on]
            except Exception:
                pass
            wpart += f", active={', '.join(active) if active else 'keine'})"
            parts.append(wpart)
        else:
            parts.append("weather=no-poll-yet")
    except Exception:
        pass
    # Coral inference avg
    coral_avgs = []
    for _id, rt in cams_iter:
        try:
            v = (rt.status() or {}).get("inference_avg_ms")
        except Exception:
            v = None
        if isinstance(v, (int, float)) and v > 0:
            coral_avgs.append(v)
    if coral_avgs:
        parts.append(f"coral={sum(coral_avgs) / len(coral_avgs):.0f}ms")
    # Disk
    free_gb = _disk_free_gb_cached()
    if free_gb < 10:
        parts.append(f"disk={free_gb:.1f}GB free  ⚠")
        unhealthy = True
    elif free_gb < 25:
        parts.append(f"disk={free_gb:.0f}GB free")
        unhealthy = True
    else:
        parts.append(f"disk={free_gb:.0f}GB free")
    # Telegram polling
    try:
        ps = app_state.telegram_service.get_polling_status() if app_state.telegram_service else {}
    except Exception:
        ps = {}
    pstate = ps.get("state", "?")
    if pstate == "active":
        parts.append(f"tg=polling {ps.get('since_seconds', 0) // 60}m")
    else:
        parts.append(f"tg={pstate}")
        unhealthy = True
    # Emit
    msg = "[heartbeat] " + " · ".join(parts)
    if unhealthy:
        log.warning(msg)
    else:
        log.info(msg)
    # Re-arm.
    t = threading.Timer(300.0, _heartbeat_emit)
    t.daemon = True
    t.start()

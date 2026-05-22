from __future__ import annotations

import contextlib

# ruff: noqa: F401
# Comprehensive per-mixin import block — some symbols are unused in this
# mixin but kept identical across mixins so methods can move between them
# without import bookkeeping. See service.py for the canonical import list.
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import requests

from .._consts import (
    EVENT_ICON_HEX,
    EVENT_LABEL_DE,
    HISTORY_FIELD_TO_EVENT,
    HISTORY_FIELDS,
    HISTORY_LABELS_DE,
    HISTORY_MAXLEN,
    HISTORY_UNITS,
    _atomic_write_json,
    _is_quiet_now,
    _safe_dt,
    _safe_subset,
    log,
)

# 70/30 pre-event bias on the sun-timelapse window: most of the captured
# minutes sit BEFORE the sun event so a sunrise video starts in twilight
# and watches the sun come up; a sunset video catches the run-up to dusk
# and a short tail of afterglow. Single source of truth — referenced by
# both the scheduler in _register_sun_jobs and the preview math in
# sun_times_today so the two never drift again.
_SUN_PRE_BIAS = 0.70

# Drift guard: refuse a "sunset" capture that fires hours after the
# real solar sunset. Without this, a misconfigured schedule produced an
# MP4 labelled "sunset · score=0.60" that was actually 312 minutes
# after the real event — pure IR night with no afterglow at all.
# Production runs refuse outright; test mode logs a WARNING and
# proceeds (the user is deliberately diagnosing).
_SUN_TL_DRIFT_LIMIT_MIN = 90

# Locked sunrise/sunset capture window — single value, not user-tunable.
# Sized to comfortably cover civil twilight (sun 0–6° below horizon, ~30
# min either side at mid-latitudes) PLUS golden hour (~30 min after the
# event). With the 70/30 pre-bias above that gives 52 min before and
# 23 min after the sun event, so the recording starts well into
# nautical twilight (when the first colours appear in the sky) and
# ends after the bright phase has settled. Smaller windows (the
# previous 30-min default) miss the early twilight transition; larger
# ones bloat the file without adding visible content. Per the F-task
# spec the user-facing slider was removed — fewer knobs to mis-set.
_SUN_TL_LOCKED_WINDOW_MIN = 75


@dataclass
class _SunTLTestSession:
    """In-memory state for an ad-hoc Sun-Timelapse capture fired from
    Settings → Wetter-Ereignisse → Test. One session at a time; the
    HTTP layer reads this back via get_sun_tl_test_status() while the
    daemon thread populates it. The frames_dir reference lets the
    status endpoint pull live counters directly from the same
    `_stats.json` the production capture path writes."""

    cam_id: str
    phase: str
    duration_s: int
    started_at: datetime
    expected_frames: int
    interval_s: int = 3
    fps: int = 25
    # Final encoded video length (seconds). Drives the encoder
    # directly via _write_video(target_duration_s, target_fps) so
    # the resulting MP4 plays for exactly this long instead of the
    # implicit n_written / target_fps clamp the production schedule
    # uses. None falls back to the legacy auto math.
    target_duration_s: int | None = None
    frames_dir: Path | None = None
    # In TEST mode the scratch dir is not deleted — instead it's
    # renamed to <stem>_raw/ (visible to normal file listings) so the
    # operator can audit raw frames + the per-reason _rejected/ tree
    # that the on_reject hook builds during the slot loop. Production
    # captures stay None and keep the original cleanup behaviour.
    raw_dir: Path | None = None
    # Cancellation flags — protected by `lock`. The HTTP cancel
    # endpoint sets ``cancel_requested``; the capture loop polls it
    # at the slot boundary and at every 0.5 s sleep tick, sets
    # ``cancelled`` when it actually unwinds, and skips the encode
    # path so a cancelled session never produces a sighting.
    cancel_requested: bool = False
    cancelled: bool = False
    # Adaptive validator profile diagnostics — surfaced by the UI so
    # the user can see whether their capture was treated as DAY /
    # TWILIGHT / NIGHT. ``baseline_brightness`` is the median scene
    # brightness from the 3-sample baseline (or None if no usable
    # samples came back). Updated at the end of the capture loop.
    validator_profile: str | None = None
    baseline_brightness: float | None = None
    # Drift guard — set when the capture started outside the
    # _SUN_TL_DRIFT_LIMIT_MIN window relative to the real sun event.
    # ``phase_drift_min`` is signed (+ = after, - = before). The UI
    # surfaces ``phase_drift_warning`` as an amber pill when it's set
    # so the operator sees "yes the MP4 is real night, that's why".
    phase_drift_min: int | None = None
    phase_drift_warning: str | None = None
    # Final stats snapshot — captured before scratch dir cleanup so the
    # post-completion status read still has accurate counters even
    # though `_stats.json` is gone with the scratch dir.
    final_stats: dict | None = None
    daynight_color_set: bool | None = None  # None = skipped (disabled / no rtsp)
    daynight_revert_set: bool | None = None
    result_clip_path: str | None = None
    result_sighting_id: str | None = None
    error: str | None = None
    finished: bool = False
    # Ring buffer of recent log lines tagged [sun-tl-test], [weather]
    # or [capture-stats] — surfaces the in-flight rejection clusters
    # without re-parsing docker logs. 200 lines is plenty for a 5-min
    # window even at WARN-heavy capture.
    log_lines: deque = field(default_factory=lambda: deque(maxlen=200))
    # Guards log_lines and the bool result fields — the daemon thread
    # writes them while the HTTP thread reads them.
    lock: threading.Lock = field(default_factory=threading.Lock)


class _SunTLTestLogHandler(logging.Handler):
    """Captures matching log lines into a session's ring buffer.

    Filters on the three tags we need to diagnose the duplicate-frame
    bug ([sun-tl-test], [weather], [capture-stats]); everything else
    propagates to the regular handlers untouched. Attached to the
    root logger when a test starts and detached when it finishes."""

    _TAGS = ("[sun-tl-test]", "[weather]", "[capture-stats]")

    def __init__(self, session: _SunTLTestSession):
        super().__init__()
        self.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(message)s",
                datefmt="%H:%M:%S",
            )
        )
        self.session = session

    def emit(self, record: logging.LogRecord):
        try:
            msg = record.getMessage()
            if not any(t in msg for t in self._TAGS):
                return
            line = self.format(record)
            with self.session.lock:
                self.session.log_lines.append(line)
        except Exception:
            pass


# Module-level singleton — survives WeatherService rebuilds (settings
# saves spawn a fresh instance via rebuild_services), so a poll that
# arrives after the service was swapped still finds the session it
# fired against the old instance. The daemon thread holds its own
# direct reference into the dataclass, so the GC chain stays intact
# even when these globals are replaced by a subsequent test.
_active_test_session: _SunTLTestSession | None = None
_active_test_handler: _SunTLTestLogHandler | None = None
_test_session_lock = threading.Lock()


def _raw_dir_relpath(session: _SunTLTestSession, sightings_dir: Path) -> str | None:
    """Return ``session.raw_dir`` as a path string relative to the
    storage root (i.e. starting with ``weather/...``) so the UI can
    render a copyable hint. None when the session has no raw_dir yet
    (in-flight test before _finalise_scratch landed) or when the path
    sits outside the storage tree (defensive guard — unexpected)."""
    if session.raw_dir is None:
        return None
    try:
        # storage_root = sightings_dir.parent (sightings_dir == .../storage/weather)
        return str(session.raw_dir.relative_to(sightings_dir.parent))
    except Exception:
        return str(session.raw_dir)


def _sun_window_bounds(sun_dt: datetime, window_min: int) -> tuple[datetime, datetime, int, int]:
    """Apply _SUN_PRE_BIAS to (sun_dt, window_min). Returns
    (start_dt, end_dt, pre_min, post_min). Pure function — no `self`,
    safe to call from anywhere in the module."""
    pre = int(round(window_min * _SUN_PRE_BIAS))
    post = window_min - pre
    return (
        sun_dt - timedelta(minutes=pre),
        sun_dt + timedelta(minutes=post),
        pre,
        post,
    )


def _write_sun_skip_json(
    out_dir: Path,
    stem: str,
    *,
    phase: str,
    camera_id: str,
    skip_reason: str,
    n_written: int,
    min_required: int,
    log_tail: list[str] | None = None,
    extra: dict | None = None,
) -> None:
    """Write a parallel ``<stem>_skip.json`` next to where the .json
    sighting would have lived. Called from every failure path inside
    ``_run_sun_capture_inner`` so a failed sun build leaves a trail
    the mediathek can surface as "capture aborted, here's why".

    Without this file the 2026-05-14 sunrise on Nut Bar was completely
    invisible — no mp4, no qa.json, no sighting JSON, nothing in the
    on-disk tree to tell the operator the schedule even fired. The
    payload mirrors the spec from the diagnose plan: phase, camera_id,
    skip_reason, n_written, min_required, captured_at, log_tail, plus
    any extras the caller wants to surface (e.g. exception type +
    message for loop crashes). All writes are best-effort — a failure
    here only emits a warning, never raises."""
    payload = {
        "phase": phase,
        "camera_id": camera_id,
        "skip_reason": skip_reason,
        "n_written": int(n_written),
        "min_required": int(min_required),
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "log_tail": list(log_tail or [])[-30:],
    }
    if extra:
        # Caller-supplied keys take precedence over defaults so a
        # crash-context can override even the boilerplate fields if it
        # wants. Realistic uses just add new keys.
        payload.update(extra)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(out_dir / f"{stem}_skip.json", payload)
        log.info(
            "[weather] _skip.json written: %s/%s_skip.json (reason=%s, " "n_written=%d, min=%d)",
            out_dir.name,
            stem,
            skip_reason,
            n_written,
            min_required,
        )
    except Exception as e:
        log.warning("[weather] _skip.json write failed: %s · %s", out_dir / f"{stem}_skip.json", e)


class SunTimelapseMixin:
    """Sunrise/sunset timelapse subsystem: scheduler + capture + day/night override.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def sun_event_today(self, phase: str, when: date | None = None) -> datetime | None:
        """Return today's sunrise/sunset as a local naive datetime, or None
        if astral can't compute it (polar day/night) or the location is
        missing. Cached for 60 seconds via _sun_cache hits is overkill here
        — we only call this once per cam per day."""
        loc = self.server_cfg.get("location") or {}
        lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            return None
        try:
            from astral import Observer
            from astral.sun import sun as _sun

            obs = Observer(
                latitude=float(lat),
                longitude=float(lon),
                elevation=float(loc.get("elevation") or 0.0),
            )
            d = when or date.today()
            evts = _sun(obs, date=d)
            dt = evts.get(phase)
            # astral returns aware UTC; convert to local naive for scheduling.
            if dt is None:
                return None
            return dt.astimezone().replace(tzinfo=None)
        except Exception as e:
            log.info("[weather] No %s for %s: %s", phase, when or date.today(), e)
            return None

    def _sun_jobs_keys(self) -> list[str]:
        if not self._scheduler:
            return []
        try:
            return [
                j.id
                for j in self._scheduler.get_jobs()
                if (
                    j.id.startswith("sun_tl_capture_")
                    or j.id.startswith("sun_tl_dnov_")
                    or j.id.startswith("sun_tl_dnrev_")
                )
            ]
        except Exception:
            return []

    def _register_sun_jobs(self):
        """Cancel any previously-registered sunrise/sunset capture jobs and
        re-register for today's events. Skips windows that have already
        started (no rückwirkende triggers). Idempotent — safe at every
        service start, every reload, and on the daily 00:05 re-compute."""
        if not self._scheduler:
            return
        # Drop stale capture jobs first so a phase-toggle change actually
        # takes effect (and so we don't keep yesterday's jobs after the
        # daily recompute).
        for k in self._sun_jobs_keys():
            with contextlib.suppress(Exception):
                self._scheduler.remove_job(k)
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            log.info("[weather] Standort fehlt — keine Sun-Jobs registriert")
            return
        from apscheduler.triggers.date import DateTrigger

        today = date.today()
        registered = []
        cams = self._cfg_cameras()
        for cam in cams:
            cam_id = cam.get("id")
            cam_name = cam.get("name") or cam_id
            cw = cam.get("weather") or {}
            stl = cw.get("sun_timelapse") or {}
            for phase in ("sunrise", "sunset"):
                pcfg = stl.get(phase) or {}
                if not pcfg.get("enabled"):
                    continue
                sun_dt = self.sun_event_today(phase, today)
                if sun_dt is None:
                    continue
                # Window locked to a known-good range — the previous
                # user-tunable slider let mis-configurations land at
                # 10 min, far too short to capture civil twilight.
                # See _SUN_TL_LOCKED_WINDOW_MIN above for sizing rationale.
                window = _SUN_TL_LOCKED_WINDOW_MIN
                # 70/30 bias around the sun event — see _SUN_PRE_BIAS.
                # With a 30-min window that's -21 / +9 around the event.
                start_dt, _end_dt, _pre, _post = _sun_window_bounds(sun_dt, window)
                if start_dt <= datetime.now():
                    log.info(
                        "[weather] %s %s @ %s already passed — skipping today",
                        cam_name,
                        phase,
                        sun_dt.strftime("%H:%M"),
                    )
                    continue
                key = f"sun_tl_capture_{cam_id}_{phase}_{today.isoformat()}"
                self._scheduler.add_job(
                    self._run_sun_capture_safe,
                    DateTrigger(run_date=start_dt),
                    id=key,
                    replace_existing=True,
                    args=[cam_id, phase, sun_dt, dict(pcfg)],
                )
                registered.append(
                    f"{cam_name} {phase} {sun_dt.strftime('%H:%M')} (window {window} min)"
                )
                # Optional day/night override. Two scheduled jobs frame
                # the capture window symmetrically:
                #   - LEAD-IN at (start_dt - lead_min): force "Color"
                #     so the camera's internal IR-cut doesn't sit in
                #     Black&White when capture begins.
                #   - REVERT at (end_dt + lead_min): restore "Auto" /
                #     "Black&White" only AFTER the window has closed
                #     plus the same lead buffer.
                # Hard invariant: no day/night flip may fire inside the
                # active recording window. Anchoring both jobs to
                # window bounds (NOT to the sun event itself) is what
                # guarantees this — anchoring to sun_dt would bracket
                # only a 30-min slice of a 60-min window and let the
                # camera flip mid-recording.
                dnov = pcfg.get("daynight_override") or {}
                if dnov.get("enabled"):
                    lead_min = max(1, min(15, int(dnov.get("lead_min", 5) or 5)))
                    override_at = start_dt - timedelta(minutes=lead_min)
                    revert_at = _end_dt + timedelta(minutes=lead_min)
                    revert_mode = "Black&White" if dnov.get("revert", "auto") == "off" else "Auto"
                    if not (cam.get("rtsp_url") or "").strip():
                        log.warning(
                            "[weather] %s %s: no rtsp_url, cannot infer Reolink host — daynight override skipped",
                            cam_name,
                            phase,
                        )
                    elif override_at <= datetime.now():
                        log.info(
                            "[weather] %s %s: daynight override window already passed, capture-only",
                            cam_name,
                            phase,
                        )
                    else:
                        dn_key = f"sun_tl_dnov_{cam_id}_{phase}_{today.isoformat()}"
                        self._scheduler.add_job(
                            self._apply_daynight_override,
                            DateTrigger(run_date=override_at),
                            id=dn_key,
                            replace_existing=True,
                            args=[cam_id, "Color", phase, lead_min],
                        )
                        registered.append(
                            f"{cam_name} {phase} daynight→Color @{override_at.strftime('%H:%M')}"
                        )
                        # Revert job anchored to window-end + lead_min.
                        rv_key = f"sun_tl_dnrev_{cam_id}_{phase}_{today.isoformat()}"
                        self._scheduler.add_job(
                            self._apply_daynight_override,
                            DateTrigger(run_date=revert_at),
                            id=rv_key,
                            replace_existing=True,
                            args=[cam_id, revert_mode, phase, lead_min],
                        )
                        registered.append(
                            f"{cam_name} {phase} daynight→{revert_mode} @{revert_at.strftime('%H:%M')}"
                        )
        if registered:
            log.info("[weather] Jobs registered: %s", " · ".join(registered))
        else:
            log.info("[weather] Keine Sun-Jobs heute (alle aus oder Fenster vorbei)")

    def _apply_daynight_override(
        self, cam_id: str, mode: str, phase: str = "", lead_min: int = 0
    ) -> bool:
        """Force a camera's day/night mode via the Reolink HTTP CGI.

        Called from the scheduler (lead-in: mode="Color") and from
        _run_sun_capture's tail (revert: mode="Auto"/"Black&White"). All
        failures are logged at WARNING and swallowed — the override must
        never block the capture or mark a finished timelapse as failed.
        """
        from urllib.parse import urlparse

        from ... import reolink_api

        cam = next((c for c in self._cfg_cameras() if c.get("id") == cam_id), None)
        if cam is None:
            log.warning("[weather] daynight override: cam %s not in config", cam_id)
            return False
        cam_name = cam.get("name") or cam_id
        rtsp_url = (cam.get("rtsp_url") or "").strip()
        if not rtsp_url:
            log.warning("[weather] daynight override %s: no rtsp_url, skipped", cam_name)
            return False
        try:
            host = urlparse(rtsp_url).hostname
        except Exception:
            host = None
        if not host:
            log.warning("[weather] daynight override %s: cannot parse host from rtsp_url", cam_name)
            return False
        user = cam.get("username") or ""
        password = cam.get("password") or ""
        token = reolink_api.login(host, user, password)
        if not token:
            log.warning("[weather] daynight override %s: login failed", cam_name)
            return False
        try:
            ok = reolink_api.set_daynight(host, token, mode)
        finally:
            reolink_api.logout(host, token)
        if ok:
            if mode == "Color" and lead_min:
                log.info(
                    "[weather] daynight override Color: %s (für %s in %d min)",
                    cam_name,
                    phase or "?",
                    lead_min,
                )
            else:
                log.info("[weather] daynight override %s: %s", mode, cam_name)
        else:
            # The detailed cause lives in the [reolink] WARNING line
            # emitted by reolink_api.set_daynight a few lines above
            # this one (rspCode + error.detail + body). Mention that
            # explicitly so the operator knows where to look.
            log.warning(
                "[weather] daynight override %s: SetIspCfg(%s) failed — "
                "siehe vorhergehende [reolink] Zeile für rspCode/detail",
                cam_name,
                mode,
            )
        return ok

    def _cfg_cameras(self) -> list[dict]:
        # Read the live, fully-merged camera list from the SettingsStore so
        # phase-toggles persisted via /api/settings/cameras are visible at
        # the next _register_sun_jobs() call without a service reload.
        try:
            return list(self.settings_store.data.get("cameras", []) or [])
        except Exception:
            return []

    def _run_sun_capture_safe(self, cam_id: str, phase: str, sun_dt: datetime, pcfg: dict):
        """APScheduler entry point. The actual capture loop is long (≥
        window_min minutes) and must NOT block the scheduler thread, so we
        spawn a daemon worker and return immediately."""
        threading.Thread(
            target=self._run_sun_capture,
            args=(cam_id, phase, sun_dt, pcfg),
            daemon=True,
            name=f"sun-tl-{cam_id}-{phase}",
        ).start()

    def _run_sun_capture(self, cam_id: str, phase: str, sun_dt: datetime, pcfg: dict):
        """Thin entry-point. The optional day/night revert used to live
        here as a finally-block call that fired the moment capture
        ended — but that violated the "no flip during recording window"
        invariant on the boundary. The revert is now an APScheduler
        DateTrigger registered alongside the lead-in (see
        _register_sun_jobs), anchored to (window_end + lead_min).
        That keeps the schedule symmetric and means a crashed capture
        still gets a clean revert at the proper time."""
        self._run_sun_capture_inner(cam_id, phase, sun_dt, pcfg)

    def _run_sun_capture_inner(
        self,
        cam_id: str,
        phase: str,
        sun_dt: datetime,
        pcfg: dict,
        test_session: _SunTLTestSession | None = None,
    ):
        from ...frame_helpers import (
            DAY_PROFILE,
            NIGHT_PROFILE,
            TWILIGHT_PROFILE,
            CaptureStats,
            grab_valid_frame,
            is_valid_frame,
            pick_profile_from_baseline,
            reason_family,
        )

        def _stricter_profile(p):
            """Bump the active profile one step toward strict for the
            backfill re-validation. NIGHT → TWILIGHT → DAY; DAY stays
            DAY (already the tightest tunings)."""
            if p is NIGHT_PROFILE:
                return TWILIGHT_PROFILE
            if p is TWILIGHT_PROFILE:
                return DAY_PROFILE
            return DAY_PROFILE

        rt = self.runtimes.get(cam_id)
        if rt is None or not hasattr(rt, "snapshot_jpeg_hires"):
            log.warning("[weather] cam %s nicht verfügbar — capture abgebrochen", cam_id)
            if test_session is not None:
                test_session.error = "camera runtime not available"
            return
        # Per-camera timestamp-overlay zone — bands inside it are the
        # camera's burnt-in clock readout, not corruption. Threaded
        # through grab_valid_frame + the strict re-validation below
        # so every reject decision on this camera honours its zone.
        _cam_rec = next((c for c in self._cfg_cameras() if c.get("id") == cam_id), None)
        timestamp_zone = (_cam_rec or {}).get("timestamp_overlay_zone")
        # Test mode shortens the window from minutes to seconds. The
        # rest of the pipeline (frame grab loop, validity gating,
        # encoder) runs unchanged so the test reproduces the real
        # bug — only the duration and the on-disk stem differ.
        if test_session is not None:
            window_seconds = max(15, int(test_session.duration_s))
            log_tag = "sun-tl-test"
        else:
            window_seconds = _SUN_TL_LOCKED_WINDOW_MIN * 60
            log_tag = "weather"
        # ── Drift guard ────────────────────────────────────────────────────
        # Compute the difference between "now" and the requested sun
        # event. Production refuses; test mode warns + proceeds (so
        # the user can deliberately reproduce a "midnight sunset" run).
        drift_min = int(round((datetime.now() - sun_dt).total_seconds() / 60.0))
        if abs(drift_min) > _SUN_TL_DRIFT_LIMIT_MIN:
            warn_msg = (
                f"{phase}-Capture lief {drift_min} min nach Sonnen"
                f"{'aufgang' if phase == 'sunrise' else 'untergang'} — "
                "Frames sind reine Nacht"
            )
            if test_session is None:
                log.warning(
                    "[%s] refusing capture: drift=%dmin > limit=%dmin cam=%s phase=%s",
                    log_tag,
                    drift_min,
                    _SUN_TL_DRIFT_LIMIT_MIN,
                    cam_id,
                    phase,
                )
                return
            # Test mode: log and proceed; surface drift on session.
            log.warning(
                "[%s] drift=%dmin (limit=%dmin) — proceeding because this "
                "is a diagnostic test run",
                log_tag,
                drift_min,
                _SUN_TL_DRIFT_LIMIT_MIN,
            )
            test_session.phase_drift_min = drift_min
            test_session.phase_drift_warning = warn_msg
        elif test_session is not None:
            # Within limits but still record the drift for the UI to
            # show "right on time" without a warning pill.
            test_session.phase_drift_min = drift_min
        # E1 · 8 s capture floor. The Reolink snapshot-API caches its
        # last-served buffer for ~5–14 consecutive pulls on a 3 s
        # cadence; an 8 s interval pushes the cache window past every
        # subsequent grab so each frame is a fresh fetch. Anything
        # below 8 s on legacy settings is clamped + logged so a future
        # regression at the storage layer surfaces immediately.
        _raw_interval = int(pcfg.get("interval_s", 8) or 8)
        if _raw_interval < 8:
            log.warning(
                "[weather] %s %s: interval_s=%d below 8 s floor — "
                "clamping (settings.json passed through without "
                "migration?)",
                cam_id,
                phase,
                _raw_interval,
            )
        interval_s = max(8, _raw_interval)
        # E1 · output fps is fixed at 15 across all timelapse paths.
        # The settings-side migration also forces fps=15, but if any
        # legacy value slips through (user-edited settings.json, etc.)
        # we land at 15 anyway — a per-build deviation here would just
        # re-introduce the "stretched fps → choppy mp4" failure mode.
        target_fps = 15
        cam_name = self._cam_name(cam_id)
        # Per-phase subdir so on-disk layout makes the kind obvious. The
        # legacy single "sun_timelapse/" directory is still walked at
        # read time (and the boot migration moves any existing files
        # over) but new captures land in sunrise_timelapse/ or
        # sunset_timelapse/.
        phase_dir = "sunrise_timelapse" if phase == "sunrise" else "sunset_timelapse"
        out_dir = self._sightings_dir() / cam_id / phase_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        date_label = sun_dt.strftime("%Y-%m-%d")
        # Test captures get a `_test_<HHMMSS>_` prefix so they show up
        # in Sichtungen alongside real captures but are trivially
        # identifiable (and bulk-deletable) by the user.
        # Every stem also carries a camera slug as a trailing
        # fragment so two cameras producing a sunrise/sunset
        # timelapse on the same day don't collide when the user
        # downloads them into a shared folder. The slug is derived
        # via ``camera_slug`` so it tracks the camera's display
        # name when the user renames the camera.
        from ...camera_id import camera_slug

        cam_slug = camera_slug(self.settings_store, cam_id)
        if test_session is not None:
            stem = f"_test_{datetime.now().strftime('%H%M%S')}_{date_label}_{phase}_{cam_slug}"
        else:
            stem = f"{date_label}_{phase}_{cam_slug}"
        mp4_path = out_dir / f"{stem}.mp4"
        thumb_path = out_dir / f"{stem}.jpg"
        # Frames go to a temporary scratch dir; deleted after encode.
        frames_dir = out_dir / f".scratch_{stem}"
        frames_dir.mkdir(parents=True, exist_ok=True)
        if test_session is not None:
            # Status endpoint reads _stats.json from this path each
            # poll, so wire it up before the loop starts emitting
            # counters.
            test_session.frames_dir = frames_dir
            test_session.interval_s = interval_s
            test_session.fps = target_fps
        # Sun snapshot at start (to compare with end).
        sun_at_start = self._sun_position()
        # Wetter-Snapshot zum Trigger-Zeitpunkt (für Score + Recap-Picker).
        api_snapshot = self._latest_api_snapshot_safe()
        end_at = datetime.now() + timedelta(seconds=window_seconds)
        log.info(
            "[%s] Capture start: %s %s (Fenster %ds, %ds-Intervall, %d fps)",
            log_tag,
            cam_name,
            phase,
            window_seconds,
            interval_s,
            target_fps,
        )
        # ── Adaptive validator profile ─────────────────────────────────────
        # Take 3 quick samples ~0.5 s apart to gauge actual scene
        # brightness, then pick DAY/TWILIGHT/NIGHT thresholds. Without
        # this a sunset capture started at midnight (real-world bug
        # report) ran the daytime validators against a pure IR night
        # scene and rejected most frames as "broken" when they were
        # legitimately dark. Falls back to DAY when no usable samples
        # come back — conservative against accidentally letting real
        # corruption through with night-loose thresholds.
        baseline_samples: list = []
        for _bi in range(3):
            try:
                jpg = rt.snapshot_jpeg_hires(quality=85)
                if jpg:
                    baseline_samples.append(jpg)
            except Exception:
                pass
            if _bi < 2:
                time.sleep(0.5)
        active_profile = pick_profile_from_baseline(baseline_samples)
        baseline_med = None
        if baseline_samples:
            try:
                import cv2 as _cv2_b  # noqa: PLC0415
                import numpy as _np_b  # noqa: PLC0415

                means = []
                for s in baseline_samples:
                    arr = _np_b.frombuffer(bytes(s), dtype=_np_b.uint8)
                    img = _cv2_b.imdecode(arr, _cv2_b.IMREAD_COLOR)
                    if img is not None and img.size > 0:
                        means.append(float(img.mean()))
                if means:
                    means.sort()
                    baseline_med = means[len(means) // 2]
            except Exception:
                pass
        log.info(
            "[%s] profile=%s brightness_med=%s cam=%s phase=%s",
            log_tag,
            active_profile.name.upper(),
            f"{baseline_med:.0f}" if baseline_med is not None else "?",
            cam_name,
            phase,
        )
        # ── stats container first ──────────────────────────────────────────
        # The stats mutations + slot loop below all reference ``stats``;
        # build it here before any code path can touch it. The baseline
        # grabs above intentionally bypassed grab_valid_frame so they
        # never wired an on_reject callback that could have hit
        # stats.record_invalid before this assignment.
        expected_frames = int(window_seconds / max(1, interval_s))
        if test_session is not None:
            test_session.expected_frames = expected_frames
        stats = CaptureStats(out_dir=frames_dir, expected_frames=expected_frames)
        # Mirror the profile + baseline into the CaptureStats so the
        # _stats.json blob picks them up on every flush — production
        # runs (no test_session) still leave the data on disk for the
        # build-side manifest to read later.
        stats.validator_profile = active_profile.name
        stats.baseline_brightness = baseline_med
        stats.phase_drift_min = drift_min
        if test_session is not None and test_session.phase_drift_warning:
            stats.phase_drift_warning = test_session.phase_drift_warning
        if test_session is not None:
            test_session.validator_profile = active_profile.name
            test_session.baseline_brightness = baseline_med
        # Re-pick every 2 minutes — was 5 min before the slot-287
        # false-positive wave showed that 5 min is too coarse: by
        # the time the 5-min sample fired, the loop had already
        # burned through 60+ rejections after the scene recovered
        # from a corruption episode. The picker sanity gate (added
        # in the same fix) prevents a corruption sample from
        # locking us back into DAY, so a tighter cadence is safe.
        # ``last_repick_at`` rate-limits the dead_area-triggered
        # forced re-pick (below) so a noisy slot can't stampede the
        # picker into running on every iteration.
        next_repick_at = datetime.now() + timedelta(minutes=2)
        last_repick_at: datetime | None = None
        n_written = 0
        i = 0
        # ── Test-mode reject sink ─────────────────────────────────────────
        # Production runs pass on_reject=None below so behaviour is
        # bit-identical to before this change. In test mode, every
        # rejected attempt (including all 6 retries when they all fail)
        # gets written to a per-reason subfolder under _rejected/ so the
        # operator can audit what the validators threw away. Encoding
        # errors in the lambda are caught at DEBUG by grab_valid_frame —
        # the diagnostic save path is best-effort by design.
        rejects_dir: Path | None = None
        save_reject_cb = None
        if test_session is not None:
            rejects_dir = frames_dir / "_rejected"
            try:
                rejects_dir.mkdir(parents=True, exist_ok=True)
            except Exception as _e:
                log.debug("[sun-tl-test] could not create rejects_dir: %s", _e)
                rejects_dir = None
        if rejects_dir is not None:
            import cv2 as _cv2  # noqa: PLC0415 — lazy, avoids extra boot cost

            def _save_reject(frame, reason, attempt_idx):
                # No frame to persist (grab_fn returned None or raised) — skip.
                if frame is None:
                    return
                # One folder per top-level reject family — parameter
                # variants like horizontal_anomaly_band(y=68%,h=4%) all
                # collapse into a single ``horizontal_anomaly_band/``
                # bucket. The full detail (y/h/score) lives in the
                # filename below, so the bucketing isn't lossy. A
                # sunset run that previously sprayed 37 sibling
                # ``horizontal_anomaly_band_y<X>_h<Y>/`` folders now
                # writes everything to one bucket.
                head = reason_family(reason)
                head = re.sub(r"[^a-z0-9_]+", "_", head.lower())[:40] or "unknown"
                bucket = rejects_dir / head
                bucket.mkdir(parents=True, exist_ok=True)
                # Detail tail (the part inside parens) for filename — keeps
                # std/area/score values in the filename so a directory
                # listing tells the story without opening every file.
                detail = ""
                if "(" in reason and reason.endswith(")"):
                    detail = reason[reason.index("(") + 1 : -1]
                    detail = re.sub(r"[^a-z0-9._=-]+", "_", detail.lower())[:60]
                fname = f"slot{i:05d}_a{attempt_idx}{('_' + detail) if detail else ''}.jpg"
                # Encode ndarray → JPEG bytes if needed; bytes pass through.
                try:
                    if isinstance(frame, (bytes, bytearray, memoryview)):
                        (bucket / fname).write_bytes(bytes(frame))
                    else:
                        ok, buf = _cv2.imencode(".jpg", frame, [int(_cv2.IMWRITE_JPEG_QUALITY), 85])
                        if ok:
                            (bucket / fname).write_bytes(buf.tobytes())
                except Exception as e:
                    log.debug("[sun-tl-test] reject-save encode failed: %s", e)

            save_reject_cb = _save_reject

        def _finalise_scratch():
            """Single-call finaliser run from every return path. In
            production: rmtree the scratch dir (current behaviour).
            In test mode: rename `.scratch_<stem>` → `<stem>_raw/`
            (visible name) and write the _rejected/_README.txt
            documenting the layout. Idempotent — second call is a
            no-op."""
            if test_session is None:
                self._cleanup_sun_scratch(frames_dir)
                return
            if test_session.raw_dir is not None:
                return  # already renamed by an earlier return path
            if not frames_dir.exists():
                return
            target = out_dir / f"{stem}_raw"
            n = 2
            while target.exists():
                target = out_dir / f"{stem}_raw_{n}"
                n += 1
            try:
                frames_dir.rename(target)
            except Exception as e:
                log.warning("[sun-tl-test] could not rename %s → %s: %s", frames_dir, target, e)
                return
            test_session.raw_dir = target
            # Status endpoint reads stats from frames_dir on every poll —
            # update it so post-rename polls find the renamed location.
            test_session.frames_dir = target
            rej = target / "_rejected"
            if rej.exists():
                try:
                    (rej / "_README.txt").write_text(
                        "Layout: <reason_head>/slotNNNNN_aN_<detail>.jpg\n"
                        "\n"
                        "Each file is one rejected JPEG attempt. Multiple\n"
                        "files per slot mean the retry helper hit several\n"
                        "rejects before giving up or recovering. See\n"
                        "../_stats.json for the per-reason counters that\n"
                        "produced these buckets.\n",
                        encoding="utf-8",
                    )
                except Exception as e:
                    log.debug("[sun-tl-test] README write failed: %s", e)

        # Last successfully-grabbed JPEG. When grab_valid_frame's retry
        # budget is exhausted on a slot (typical for `dead_area` /
        # `grey_uniform` bursts that persist past the 5 s wall-clock
        # cap), we still write a frame into the slot so the encoder
        # gets a continuous sequence — without this the resulting MP4
        # would have implicit gaps that ffmpeg pads at output-fps,
        # which is what produces the "single frame held for many
        # seconds" artefact the user reported. The slot is still
        # counted as invalid in CaptureStats so the per-reason
        # breakdown stays diagnostic.
        last_valid_jpg: bytes | None = None
        # ``n_consecutive_backfills`` tracks how many slots in a row
        # have been backfilled from the same ``last_valid_jpg``. After
        # > 3 consecutive uses the cache gets a strict re-validation
        # pass (one notch tighter profile) — if that rejects, drop
        # the cache so a frame that slipped through the main gate
        # can't infect 5–10 adjacent slots. The counter resets on
        # every fresh successful grab.
        n_consecutive_backfills = 0
        # Snapshot-API cache fingerprint. The 2026-05-14 sunset on
        # Nut Bar produced 670 frames with 95 % duplicate ratio; the
        # capture log shows 1090/1500 grabs succeeded fresh but the
        # MP4 still played as one held frame. Two paths can produce
        # that signature: (a) the camera's snapshot endpoint is
        # caching its last JPEG and serving the same bytes for
        # multiple successive grabs, (b) we backfilled invalid slots
        # with ``last_valid_jpg``. The hash check below tags FRESH
        # grabs that returned the same SHA1 as the previous fresh
        # grab — the (a) signature — and the backfill log line
        # carries an explicit ``[backfill]`` tag for the (b) one.
        # Counters land in CaptureStats so they persist into
        # _stats.json and the test-panel final_stats blob.
        _hash_state = {"last_hash": None, "consec_same": 0, "fresh_in_row": 0}
        # Loop exit bookkeeping — the 2026-05-14 Garten sunset run
        # produced a 92-frame MP4 with an empty capture-block in the
        # QA sidecar, which can only happen if the per-slot
        # stats.flush() at the end of every iteration never landed a
        # _stats.json on disk. The most likely cause is an unhandled
        # exception inside the loop body that propagated up before
        # the flush call ran. Wrap the whole loop in try/finally
        # below so a final stats.flush() ALWAYS happens, and emit a
        # single ``capture loop exit`` log line covering all three
        # exit paths (timeout / cancel / exception) so future
        # forensics can read why the loop stopped without digging
        # through the surrounding 200 lines.
        loop_exit_reason = "timeout"
        loop_exit_exc: Exception | None = None
        try:
            while datetime.now() < end_at:
                # Cancellation polling at the slot boundary — the user-
                # facing Abbrechen button sets ``cancel_requested`` via
                # the HTTP cancel endpoint. The lock acquisition is
                # cheap and matches the lifecycle invariant (HTTP writes
                # under the lock, capture loop reads under it).
                if test_session is not None:
                    with test_session.lock:
                        if test_session.cancel_requested:
                            log.info(
                                "[sun-tl-test] cancel requested at slot %05d "
                                "(%d frames captured)",
                                i,
                                n_written,
                            )
                            test_session.cancelled = True
                    if test_session.cancelled:
                        break
                # Periodic profile re-pick — production sun-tl windows span
                # 75 min and cross civil twilight, so the right thresholds
                # mid-window aren't necessarily the ones the start sample
                # picked. Cadence is 2 min (down from 5 min) so a scene
                # transition is detected before the slot loop burns
                # through dozens of false-positive rejects.
                now_dt = datetime.now()
                if now_dt >= next_repick_at:
                    try:
                        samp = rt.snapshot_jpeg_hires(quality=85)
                        if samp:
                            new_prof = pick_profile_from_baseline([samp])
                            if new_prof is not active_profile:
                                log.info(
                                    "[%s] profile-switch %s → %s mid-run",
                                    log_tag,
                                    active_profile.name.upper(),
                                    new_prof.name.upper(),
                                )
                                active_profile = new_prof
                                if test_session is not None:
                                    test_session.validator_profile = active_profile.name
                    except Exception:
                        pass
                    last_repick_at = now_dt
                    next_repick_at = now_dt + timedelta(minutes=2)
                # Long-running capture loop — uses grab_valid_frame defaults
                # (6 attempts × 0.4 s with a 5 s wall-clock cap). The hires
                # variant reads only from the main-stream buffer so
                # timelapses get the full sensor resolution rather than the
                # 640x360 sub-stream the live preview path uses. The
                # active validator profile flexes thresholds for the
                # current lighting (DAY/TWILIGHT/NIGHT).
                jpg, attempt_used, last_reason = grab_valid_frame(
                    lambda: rt.snapshot_jpeg_hires(quality=92),
                    on_reject=save_reject_cb,
                    profile=active_profile,
                    timestamp_zone=timestamp_zone,
                )
                if jpg:
                    out = frames_dir / f"{i:05d}.jpg"
                    try:
                        out.write_bytes(jpg)
                        n_written += 1
                        stats.record_capture(attempt_used=attempt_used)
                        last_valid_jpg = jpg
                        # Fresh successful grab → reset the consecutive-
                        # backfill counter. The next backfill, if any,
                        # starts the chain over from zero.
                        n_consecutive_backfills = 0
                        # Hash this fresh grab and compare against the
                        # previous fresh grab. Same hash on two distinct
                        # successful API calls means the snapshot endpoint
                        # returned a cached buffer — we record but do NOT
                        # reject, because the validator already accepted
                        # the bytes as a valid frame. The diagnostic surfaces
                        # so the operator can decide whether the camera
                        # firmware or RTSP backend needs a poke. SHA1
                        # truncated to 12 chars keeps log lines readable;
                        # full collisions across millions of slots are
                        # astronomically rare and not load-bearing here.
                        try:
                            jpg_bytes = (
                                bytes(jpg) if not isinstance(jpg, (bytes, bytearray)) else jpg
                            )
                            h = hashlib.sha1(jpg_bytes).hexdigest()[:12]
                        except Exception:
                            h = None
                        _slot_outcome = "retry_ok" if attempt_used > 0 else "fresh"
                        if h is not None:
                            if h == _hash_state["last_hash"]:
                                _hash_state["consec_same"] += 1
                                _hash_state["fresh_in_row"] = 0
                                stats.record_same_hash(_hash_state["consec_same"])
                                _slot_outcome = "cached"
                                log.info(
                                    "[%s] %s slot %05d: FRESH grab but SAME hash "
                                    "as last (consec_same=%d) — snapshot API "
                                    "likely cached",
                                    log_tag,
                                    cam_name,
                                    i,
                                    _hash_state["consec_same"],
                                )
                            else:
                                _hash_state["last_hash"] = h
                                _hash_state["consec_same"] = 0
                                _hash_state["fresh_in_row"] += 1
                        # G2 · push the slot-event for the live heatmap.
                        # Reason carries the cached-hash suffix when the
                        # outcome is "cached" so the UI tooltip can
                        # explain WHY the cell is amber.
                        stats.record_slot(
                            i,
                            _slot_outcome,
                            reason=(
                                f"consec_same={_hash_state['consec_same']}"
                                if _slot_outcome == "cached"
                                else None
                            ),
                        )
                    except Exception:
                        pass
                else:
                    stats.record_invalid(last_reason)
                    # ── Force re-pick on a dead_area reject ─────────────────
                    # A genuine scene-transition (twilight → night, daytime
                    # cloud rolling in) shows up first as a dead_area
                    # rejection: the validator's tile-fraction threshold
                    # for the OLD profile no longer fits the NEW lighting.
                    # Schedule the next re-pick immediately so the loop
                    # doesn't burn through 60+ false-positive slots
                    # waiting for the 2-min timer. Rate-limited to once
                    # per 30 s so a noisy slot can't stampede the picker
                    # into running on every iteration.
                    if last_reason and "dead_area" in last_reason:
                        if (
                            last_repick_at is None
                            or (now_dt - last_repick_at).total_seconds() >= 30
                        ):
                            next_repick_at = now_dt
                    # Self-defence: re-validate the cached jpg under a
                    # tighter profile after > 3 consecutive uses. If even
                    # the stricter gate accepts it, keep using it; if it
                    # now fails, drop the cache so a corrupt frame that
                    # snuck through can't infect adjacent slots.
                    if last_valid_jpg is not None and n_consecutive_backfills >= 3:
                        strict = _stricter_profile(active_profile)
                        ok_strict, strict_reason = is_valid_frame(
                            last_valid_jpg,
                            profile=strict,
                            timestamp_zone=timestamp_zone,
                        )
                        if not ok_strict:
                            log.info(
                                "[%s] dropped backfill cache after %d consecutive "
                                "uses — re-validation flagged %s",
                                log_tag,
                                n_consecutive_backfills,
                                strict_reason,
                            )
                            last_valid_jpg = None
                            n_consecutive_backfills = 0
                            stats.backfill_cache_drops += 1
                    # G2 · classify the invalid slot into one of three
                    # outcomes for the live heatmap: backfilled (the
                    # held last_valid_jpg got written into this slot),
                    # skipped (scene-level reject we didn't even try
                    # to backfill), or rejected (transient validator
                    # failure without a fallback). The reason head
                    # passes through verbatim for tooltip text.
                    if last_valid_jpg is not None:
                        # Backfill with the most recent valid frame so the
                        # slot index sequence stays gap-free for the
                        # encoder. Counter still bumps invalid_frames for
                        # diagnostic visibility. The ``[backfill]`` tag in
                        # the message lets the operator separate "API
                        # served us a cached buffer" (the FRESH-same-hash
                        # line above) from "API gave nothing usable, we
                        # filled in" — two failure modes the duplicate-
                        # ratio in qa.json otherwise lumps together.
                        out = frames_dir / f"{i:05d}.jpg"
                        try:
                            out.write_bytes(last_valid_jpg)
                            n_consecutive_backfills += 1
                            stats.record_slot(i, "backfilled", reason=last_reason)
                            log.info(
                                "[%s] [backfill] %s slot %05d: invalid "
                                "grab, filled with last valid frame "
                                "(consec=%d, %s)",
                                log_tag,
                                cam_name,
                                i,
                                n_consecutive_backfills,
                                last_reason,
                            )
                        except Exception:
                            stats.record_slot(i, "rejected", reason=last_reason)
                            log.info(
                                "[%s] [backfill] %s slot %05d: invalid "
                                "grab and backfill write failed (%s)",
                                log_tag,
                                cam_name,
                                i,
                                last_reason,
                            )
                    else:
                        # No held jpg to backfill from. Bucket by reason
                        # class — scene-level rejects (dead_area /
                        # no_detail / too_dark / too_bright) become
                        # "skipped" so the heatmap visually separates
                        # them from transient validator failures.
                        from ...frame_helpers._validator import _classify_reason as _cls_reason

                        _bucket = (
                            "skipped" if _cls_reason(last_reason or "") == "scene" else "rejected"
                        )
                        stats.record_slot(i, _bucket, reason=last_reason)
                        log.info(
                            "[%s] %s slot %05d: invalid grabs, " "leaving slot empty (%s)",
                            log_tag,
                            cam_name,
                            i,
                            last_reason,
                        )
                stats.flush()
                i += 1
                # ── Abort thresholds ────────────────────────────────────
                # The 2026-05-14 sunset on Nut Bar ran the full 75-min
                # window, ended up with 95 % duplicate ratio on the
                # final mp4, and produced a "successful" sighting file
                # that was visually a single held frame. That's worse
                # than no capture at all — the user spends time
                # opening the clip to discover it's worthless. Two
                # bail-outs below put a hard ceiling on backfill
                # before the encode runs:
                #
                #  (a) Cumulative ratio > 60 % over ≥ 100 slots —
                #      camera is structurally not delivering valid
                #      fresh frames for this window. Abort + write
                #      .skip.json. 60 % is the threshold below the
                #      observed 95 % failure but above the typical
                #      "noisy twilight, 30-40 % rejects" healthy run.
                #
                #  (b) > 20 consecutive backfills (≈ 1 min at the
                #      default 3 s interval) — camera dropped offline
                #      mid-window. The existing strict re-validation
                #      drops the cache after 3 consecutive backfills,
                #      so reaching 20 means even the stricter profile
                #      keeps accepting the cached frame — a clear
                #      "the buffer is the only thing we're getting"
                #      signature.
                if i >= 100 and stats.backfilled_slots / max(1, i) > 0.6:
                    log.warning(
                        "[%s] %s: aborting capture — %d/%d slots "
                        "backfilled (%.0f%%) — camera not delivering "
                        "fresh frames",
                        log_tag,
                        cam_name,
                        stats.backfilled_slots,
                        i,
                        100.0 * stats.backfilled_slots / i,
                    )
                    loop_exit_reason = "too_many_backfills"
                    break
                if n_consecutive_backfills > 20:
                    log.warning(
                        "[%s] %s: aborting capture — %d consecutive "
                        "backfills (~%d s without a fresh grab) — "
                        "camera offline or wedged",
                        log_tag,
                        cam_name,
                        n_consecutive_backfills,
                        n_consecutive_backfills * interval_s,
                    )
                    loop_exit_reason = "too_many_consecutive_backfills"
                    break
                # Sleep in short chunks so we react quickly to stop signals.
                slept = 0.0
                while slept < interval_s and datetime.now() < end_at:
                    if test_session is not None:
                        with test_session.lock:
                            if test_session.cancel_requested:
                                test_session.cancelled = True
                        if test_session.cancelled:
                            break
                    time.sleep(0.5)
                    slept += 0.5
                if test_session is not None and test_session.cancelled:
                    break
            # Loop ran to its `datetime.now() < end_at` ceiling without
            # an exception. Promote the reason to "cancelled" if a test
            # session signalled mid-run; "timeout" stays as the default
            # for both production windows that simply burn the budget
            # and tests that ride out the full duration_s.
            if test_session is not None and test_session.cancelled:
                loop_exit_reason = "cancelled"
        except Exception as _loop_exc:
            # ANY uncaught exception inside the slot loop ends up here.
            # Without this catch the daemon thread silently dies and the
            # operator gets no MP4, no QA sidecar, no _skip.json (since
            # the encode block below never runs) — exactly the failure
            # signature of the 2026-05-14 Garten sunset capture (92
            # frames on disk, empty QA capture-block, no logged crash).
            loop_exit_reason = f"exception:{type(_loop_exc).__name__}"
            loop_exit_exc = _loop_exc
            log.warning(
                "[%s] capture loop crashed at slot %d (n_written=%d): %s",
                log_tag,
                i,
                n_written,
                _loop_exc,
            )
        finally:
            # Guarantee a final ``_stats.json`` write regardless of how
            # the loop exited. The per-slot flush at line ~959 lands the
            # right shape after each iteration; this final flush makes
            # sure the LAST iteration's counters land even when the
            # loop body raised after a record_invalid / record_capture
            # call but before its own flush.
            try:
                stats.flush()
            except Exception as _fl:
                log.warning("[%s] final stats.flush failed: %s", log_tag, _fl)
            log.info(
                "[%s] capture loop exit · reason=%s i=%d n_written=%d "
                "fresh=%d backfilled=%d skipped=%d",
                log_tag,
                loop_exit_reason,
                i,
                n_written,
                int(stats.fresh_captures),
                int(stats.backfilled_slots),
                int(stats.skipped_slots),
            )
        sun_at_end = self._sun_position()
        log.info(
            "[%s] Capture done: %s %s · %d Frames erfasst", log_tag, cam_name, phase, n_written
        )
        if test_session is not None:
            # Stats snapshot — taken once the loop ends so every
            # early-return branch below (too-few-frames, encode-fail,
            # encode-crash, cancellation) still leaves accurate counters
            # on the session for the UI to read after cleanup.
            test_session.final_stats = {
                "expected_frames": int(stats.expected_frames),
                "captured_frames": int(stats.captured_frames),
                "invalid_frames": int(stats.invalid_frames),
                "retry_recoveries": int(stats.retry_recoveries),
                "rejected_by_reason": dict(stats.rejected_by_reason),
                "scene_skips_by_reason": dict(stats.scene_skips_by_reason),
                "rejected_by_reason_examples": dict(stats.rejected_by_reason_examples),
                "backfill_cache_drops": int(stats.backfill_cache_drops),
                "fresh_captures": int(stats.fresh_captures),
                "backfilled_slots": int(stats.backfilled_slots),
                "skipped_slots": int(stats.skipped_slots),
                "total_written": int(stats.total_written),
                # Snapshot-API cache fingerprint (cf. _hash_state in the
                # capture loop). ``api_cached_grabs`` is the local hash
                # state at loop end — last_hash / current run / total
                # distinct hashes seen. ``max_consec_same`` is the
                # longest run length of FRESH-but-same-hash events
                # observed during this run (a high value means the
                # snapshot API was stuck serving one buffer for many
                # slots in a row, NOT that we backfilled them).
                "api_cached_grabs": dict(_hash_state),
                "max_consec_same": int(stats.api_cached_grabs_max_consec),
                "api_cached_grabs_total": int(stats.api_cached_grabs_total),
                # G2 · also alias under api_cached_grabs_max_consec so
                # the status endpoint's stats.get() picks it up after
                # the live → final_stats handoff. ``max_consec_same``
                # is the legacy alias kept for the existing UI rows.
                "api_cached_grabs_max_consec": int(stats.api_cached_grabs_max_consec),
                "validator_profile": active_profile.name,
                "baseline_brightness": baseline_med,
                "phase_drift_min": test_session.phase_drift_min,
                "phase_drift_warning": test_session.phase_drift_warning,
                # G2 · snapshot the per-slot ring into final_stats so
                # the post-cleanup status endpoint can still surface it
                # (the live _stats.json gets nuked when the scratch dir
                # is cleaned up at the end of a successful run).
                "slot_events": list(stats.slot_events),
            }
        # ── _skip.json sidecar plumbing ─────────────────────────────────
        # Every early-return branch below leaves a parallel
        # ``<stem>_skip.json`` in ``out_dir`` so a failed sun build is
        # still visible in the mediathek. Without it the 2026-05-14
        # sunrise on Nut Bar produced no mp4, no qa.json, no .json —
        # literally nothing on disk to tell the operator the schedule
        # had fired. ``_log_tail`` only carries real lines in test mode
        # (the session handler buffers them); production captures get
        # an empty list because there's no per-capture handler attached.
        # That's an acceptable trade for now — the docker log is the
        # canonical trail in production, the .skip.json's job is just
        # to mark "this slot was attempted and aborted".
        min_frames = 4 if test_session is not None else target_fps * 2
        _log_tail: list = []
        if test_session is not None:
            try:
                with test_session.lock:
                    _log_tail = list(test_session.log_lines)
            except Exception:
                _log_tail = []
        # ── Capture loop crashed ────────────────────────────────────────
        # If the slot loop raised, ``loop_exit_exc`` carries the
        # exception. Skipping encode is the only safe move — the frames
        # on disk are in unknown state, and the QA sidecar would
        # otherwise read an incomplete _stats.json.
        if loop_exit_exc is not None:
            _write_sun_skip_json(
                out_dir,
                stem,
                phase=phase,
                camera_id=cam_id,
                skip_reason=f"capture_loop_crashed:{type(loop_exit_exc).__name__}",
                n_written=n_written,
                min_required=min_frames,
                log_tail=_log_tail,
                extra={"exception_message": str(loop_exit_exc)},
            )
            if test_session is not None and not test_session.error:
                test_session.error = f"capture loop crashed: {loop_exit_exc}"
            _finalise_scratch()
            return
        # ── Backfill-ratio bail-out ─────────────────────────────────────
        # The slot loop set ``loop_exit_reason`` to one of these when it
        # aborted itself before the window ran to end_at. Encoding the
        # already-captured frames would just produce another 95 %-
        # duplicate pseudo-success mp4, so we skip the encode and
        # surface the abort via ``_skip.json``. Production gets an
        # honest "capture aborted" in the mediathek instead of a
        # worthless video file.
        if loop_exit_reason in ("too_many_backfills", "too_many_consecutive_backfills"):
            _write_sun_skip_json(
                out_dir,
                stem,
                phase=phase,
                camera_id=cam_id,
                skip_reason=loop_exit_reason,
                n_written=n_written,
                min_required=min_frames,
                log_tail=_log_tail,
                extra={
                    "slots_attempted": int(i),
                    "fresh_captures": int(stats.fresh_captures),
                    "backfilled_slots": int(stats.backfilled_slots),
                    "backfill_ratio": round(stats.backfilled_slots / max(1, i), 3),
                },
            )
            if test_session is not None and not test_session.error:
                test_session.error = loop_exit_reason
            _finalise_scratch()
            return
        # Cancellation: skip the encode path entirely — a half-length
        # cancelled capture should not produce a sighting. Don't
        # overwrite ``error`` if a prior failure path already set it
        # (e.g. cancel landing while encode_failed was already true).
        if test_session is not None and test_session.cancelled:
            log.info("[sun-tl-test] capture cancelled — skipping encode")
            if not test_session.error:
                test_session.error = "abgebrochen"
            _write_sun_skip_json(
                out_dir,
                stem,
                phase=phase,
                camera_id=cam_id,
                skip_reason="cancelled",
                n_written=n_written,
                min_required=min_frames,
                log_tail=_log_tail,
            )
            _finalise_scratch()
            return
        # The "≥ 2 s of video" guard fits 75-min real captures fine
        # but kills 60-s tests at 3-s intervals (only ~20 frames).
        # Drop the guard to a static minimum during test so a short
        # window still produces a verifiable MP4.
        if n_written < min_frames:
            log.warning("[%s] Zu wenige Frames (%d) — Encode übersprungen", log_tag, n_written)
            if test_session is not None:
                test_session.error = f"too few frames ({n_written})"
            _write_sun_skip_json(
                out_dir,
                stem,
                phase=phase,
                camera_id=cam_id,
                skip_reason="too_few_frames",
                n_written=n_written,
                min_required=min_frames,
                log_tail=_log_tail,
            )
            _finalise_scratch()
            return
        # Re-use the existing TimelapseBuilder._write_video logic — same
        # JPEG-on-disk → ffmpeg pipeline as the regular timelapse builder
        # so we don't fork the encoder.
        try:
            from ...timelapse import TimelapseBuilder

            tb = TimelapseBuilder(self._sightings_dir().parent.parent)
            # Re-glob the scratch directory rather than trusting the
            # in-memory ``n_written`` counter. A mid-capture cleanup
            # (e.g. ``_finalise_scratch`` racing on a previous run) or
            # an aggressive antivirus pass would leave the counter
            # ahead of what's actually on disk; encoding from an empty
            # / partial directory then yields the 1-frame mp4 that
            # ffprobe rejects. Cheaper to spot it here than to debug
            # the diag sidecar later.
            images = sorted(frames_dir.glob("*.jpg"))
            if len(images) != n_written:
                log.warning(
                    "[%s] frame-count mismatch · captured=%d on-disk=%d (%s %s) — using on-disk count",
                    log_tag,
                    n_written,
                    len(images),
                    cam_name,
                    phase,
                )
            if len(images) < min_frames:
                log.warning(
                    "[%s] re-glob found only %d frames (min=%d) — encode skipped (%s %s)",
                    log_tag,
                    len(images),
                    min_frames,
                    cam_name,
                    phase,
                )
                if test_session is not None:
                    test_session.error = f"too few frames on disk ({len(images)})"
                _write_sun_skip_json(
                    out_dir,
                    stem,
                    phase=phase,
                    camera_id=cam_id,
                    skip_reason="too_few_frames_on_disk",
                    n_written=len(images),
                    min_required=min_frames,
                    log_tail=_log_tail,
                )
                _finalise_scratch()
                return
            # Test runs let the user pick the final encoded MP4 length
            # explicitly; production captures still use the legacy
            # implicit math (n_written/fps clamped to [8, 60]). This
            # keeps the existing schedule unchanged while giving the
            # diagnostic Test panel deterministic playback length.
            if test_session is not None and test_session.target_duration_s:
                target_seconds = int(test_session.target_duration_s)
            else:
                target_seconds = max(8, n_written // target_fps) if target_fps else 24
                target_seconds = min(target_seconds, 60)  # cap at 60s safety
            # QA context — drives the post-build sidecar (cm-37). The
            # frames_dir lets the sidecar embed _stats.json; settings_store
            # enables fps auto-adjust per (cam_id, profile_name).
            qa_ctx = {
                "camera_id": cam_id,
                "profile_name": phase,
                "validator_profile_used": getattr(active_profile, "name", None),
                "frames_dir": frames_dir,
                "settings_store": self.settings_store,
            }
            written = tb._write_video(images, mp4_path, target_seconds, target_fps, qa_ctx=qa_ctx)
            if not written or not mp4_path.exists():
                log.warning("[%s] Encode failed for %s %s", log_tag, cam_name, phase)
                if test_session is not None:
                    test_session.error = "encode failed"
                _write_sun_skip_json(
                    out_dir,
                    stem,
                    phase=phase,
                    camera_id=cam_id,
                    skip_reason="encode_failed",
                    n_written=n_written,
                    min_required=min_frames,
                    log_tail=_log_tail,
                )
                _finalise_scratch()
                return
        except Exception as e:
            log.warning("[%s] Encode crash %s %s: %s", log_tag, cam_name, phase, e)
            if test_session is not None:
                test_session.error = f"encode crash: {e}"
            _write_sun_skip_json(
                out_dir,
                stem,
                phase=phase,
                camera_id=cam_id,
                skip_reason=f"encode_crash:{type(e).__name__}",
                n_written=n_written,
                min_required=min_frames,
                log_tail=_log_tail,
                extra={"exception_message": str(e)},
            )
            _finalise_scratch()
            return
        # Write thumb from the middle JPEG (~halfway through the sun event).
        try:
            mid = images[len(images) // 2]
            thumb_path.write_bytes(mid.read_bytes())
        except Exception:
            pass
        # Score: clear sky → higher.
        cloud = (api_snapshot or {}).get("cloud_cover")
        score = 0.5 + 0.5 * (1.0 - (float(cloud) / 100.0)) if cloud is not None else 0.6
        # Use the same phase suffix as the API surfaces (`_rise` / `_set`)
        # so the id round-trips through `_manifest_path_for`.
        phase_suffix = "rise" if phase == "sunrise" else "set"
        manifest = {
            "id": f"{cam_id}__sun_timelapse_{phase_suffix}__{stem}",
            "cam_id": cam_id,
            "cam_name": cam_name,
            "event_type": "sun_timelapse",
            "sun_phase": phase,
            "is_test": test_session is not None,
            "started_at": datetime.now().isoformat(timespec="seconds"),
            # Actual sun event (sunrise/sunset) time. Distinct from
            # started_at, which is the moment the encode finished —
            # the Sichtungen card prefers this so the user sees
            # "Sonnenuntergang 20:32" instead of the window-end.
            "sun_event_at": sun_dt.isoformat(timespec="seconds"),
            "score": round(float(score), 3),
            "severity": round(float(score), 3),
            "window_min": round(window_seconds / 60.0, 2),
            "window_seconds": window_seconds,
            "interval_s": interval_s,
            "fps": target_fps,
            "api_snapshot": _safe_subset(
                api_snapshot or {},
                [
                    "time",
                    "precipitation",
                    "snowfall",
                    "lightning_potential",
                    "visibility",
                    "wind_gusts_10m",
                    "cloud_cover",
                    "weather_code",
                ],
            ),
            "sun_snapshot": {
                "altitude_at_start": sun_at_start.get("altitude"),
                "altitude_at_end": sun_at_end.get("altitude"),
                "azimuth_at_start": sun_at_start.get("azimuth"),
                "azimuth_at_end": sun_at_end.get("azimuth"),
            },
            "clip_path": f"weather/{cam_id}/{phase_dir}/{mp4_path.name}",
            "thumb_path": f"weather/{cam_id}/{phase_dir}/{thumb_path.name}",
            "duration_s": max(1, len(images) // target_fps),
            "width": 0,
            "height": 0,
        }
        try:
            import cv2

            cap = cv2.VideoCapture(str(mp4_path))
            manifest["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            manifest["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
        except Exception:
            pass
        _atomic_write_json(out_dir / f"{stem}.json", manifest)
        log.info("[%s] Manifest geschrieben: %s · score=%.2f", log_tag, manifest["id"], score)
        if test_session is not None:
            test_session.result_clip_path = manifest["clip_path"]
            test_session.result_sighting_id = manifest["id"]
        _finalise_scratch()
        if test_session is not None:
            # Test runs never push to Telegram — diagnostic only.
            return
        # Per-event Telegram push reuses the existing weather pipeline —
        # _maybe_push_telegram already gates on push.weather.events[<type>].
        # But our new event types ("sun_timelapse_rise"/"_set") are NOT in
        # the default events block, so users currently have to opt in via
        # the "Wetter-Pushes"-UI. That's fine — sun TLs default to no push.
        manifest_for_push = dict(manifest)
        manifest_for_push["event_type"] = (
            "sun_timelapse_rise" if phase == "sunrise" else "sun_timelapse_set"
        )
        self._maybe_push_telegram(manifest_for_push, mp4_path)

    @staticmethod
    def _cleanup_sun_scratch(scratch: Path):
        with contextlib.suppress(Exception):
            shutil.rmtree(scratch, ignore_errors=True)

    # ── Sun-Timelapse TEST runner (Settings → Wetter-Ereignisse → Test) ──
    # The user fires a 60-s … 40-min capture from the UI to reproduce the
    # twilight rejection bug live: a real sunrise/sunset is too rare to
    # iterate against, but the SAME _run_sun_capture_inner code path
    # underneath. The runner attaches a logging.Handler that mirrors
    # matching log lines into a per-session ring buffer so the status
    # endpoint can return a live tail without reparsing docker logs.
    #
    # G5 · INVARIANT — these tuples MUST stay aligned with
    #   web/static/js/weather/settings-suntltest.js
    # specifically _DURATIONS (the window options) and _TARGET_LENGTHS
    # (the video-length options). The frontend derives the live math
    # readout's Capture-Budget + which target chips are valid from
    # those constants; any divergence here silently breaks the
    # configurator (UI sends 1200 s, backend coerces to 120 s,
    # heatmap renders /15 instead of /150). Mismatched values now
    # error explicitly below instead of falling back — keep the two
    # files in sync.
    _SUN_TL_TEST_DURATIONS = (300, 600, 900, 1200, 1800, 2700, 3600, 4500)
    _SUN_TL_TEST_TARGET_LENGTHS = (5, 10, 15, 20, 30, 37)

    def start_sun_tl_test(
        self, cam_id: str, phase: str, duration_s: int, target_duration_s: int | None = None
    ) -> dict:
        """Spawn a daemon thread that runs a parameterised sun-tl capture.
        Returns {"ok": bool, "error": str|None}. Idempotent against a
        running session — a second start while one is still active
        returns ok=False with an explanatory error."""
        global _active_test_session, _active_test_handler
        if phase not in ("sunrise", "sunset"):
            return {"ok": False, "error": "phase must be sunrise or sunset"}
        # G5 · explicit error instead of the previous silent fallback to
        # 120 s. The frontend now ships values from a tightly-coupled
        # allowlist (see settings-suntltest.js · _DURATIONS); a value
        # outside this tuple means the two sides have drifted, and
        # silently coercing it would produce the exact regression that
        # motivated this fix (UI shows /150, backend logs /15). Loud
        # failure stops the drift dead.
        try:
            duration_s = int(duration_s)
        except (TypeError, ValueError):
            return {"ok": False, "error": f"duration_s must be an integer (got {duration_s!r})"}
        if duration_s not in self._SUN_TL_TEST_DURATIONS:
            return {
                "ok": False,
                "error": f"duration_s {duration_s} not in allowlist "
                f"{list(self._SUN_TL_TEST_DURATIONS)}",
            }
        # G5 · target encoded MP4 length. None means "let the legacy
        # math decide" — that path is still supported. A value that's
        # present but not in the allowlist errors out for the same
        # reason as duration_s above.
        if target_duration_s is not None:
            try:
                target_duration_s = int(target_duration_s)
            except (TypeError, ValueError):
                return {
                    "ok": False,
                    "error": f"target_duration_s must be an integer or null "
                    f"(got {target_duration_s!r})",
                }
            if target_duration_s not in self._SUN_TL_TEST_TARGET_LENGTHS:
                return {
                    "ok": False,
                    "error": f"target_duration_s {target_duration_s} not in "
                    f"allowlist {list(self._SUN_TL_TEST_TARGET_LENGTHS)}",
                }
        with _test_session_lock:
            existing = _active_test_session
            if existing is not None and not existing.finished:
                age = (datetime.now() - existing.started_at).total_seconds()
                if age < existing.duration_s + 60:
                    return {"ok": False, "error": "test already running"}
        rt = self.runtimes.get(cam_id)
        if rt is None:
            return {"ok": False, "error": "camera not running"}
        cam = next((c for c in self._cfg_cameras() if c.get("id") == cam_id), None)
        if cam is None:
            return {"ok": False, "error": "camera not in config"}

        pcfg_user = ((cam.get("weather") or {}).get("sun_timelapse") or {}).get(phase) or {}
        # E1 · same 8 s capture floor + fixed 15 fps the production
        # schedule enforces. Mirror here so the test panel runs against
        # exactly the values the real schedule will use.
        interval_s = max(8, int(pcfg_user.get("interval_s", 8) or 8))
        target_fps = 15
        # Carry the daynight_override block forward so the test
        # exercises the same Color/Auto flip the real schedule does.
        pcfg = {
            "interval_s": interval_s,
            "fps": target_fps,
            "daynight_override": dict(pcfg_user.get("daynight_override") or {}),
        }
        expected = int(duration_s / max(1, interval_s))
        session = _SunTLTestSession(
            cam_id=cam_id,
            phase=phase,
            duration_s=duration_s,
            started_at=datetime.now(),
            expected_frames=expected,
            interval_s=interval_s,
            fps=target_fps,
            target_duration_s=target_duration_s,
        )
        handler = _SunTLTestLogHandler(session)
        handler.setLevel(logging.INFO)
        # Tear down any handler from a prior session before attaching the
        # new one so the root logger doesn't accumulate dead handlers
        # across runs.
        with _test_session_lock:
            if _active_test_handler is not None:
                with contextlib.suppress(Exception):
                    logging.getLogger().removeHandler(_active_test_handler)
            logging.getLogger().addHandler(handler)
            _active_test_session = session
            _active_test_handler = handler
        log.info(
            "[sun-tl-test] %s · %s · %ds · interval=%ds fps=%d",
            self._cam_name(cam_id),
            phase,
            duration_s,
            interval_s,
            target_fps,
        )
        threading.Thread(
            target=self._run_sun_tl_test_thread,
            args=(cam_id, phase, pcfg, session),
            daemon=True,
            name=f"sun-tl-test-{cam_id}-{phase}",
        ).start()
        return {"ok": True}

    def _run_sun_tl_test_thread(
        self, cam_id: str, phase: str, pcfg: dict, session: _SunTLTestSession
    ):
        """Daemon body: apply daynight override, run the same capture
        path the real schedule uses, revert daynight, mark finished.
        All exceptions are swallowed onto session.error so the status
        endpoint always has a story to tell."""
        global _active_test_handler
        cam = next((c for c in self._cfg_cameras() if c.get("id") == cam_id), None)
        rtsp_url = (cam or {}).get("rtsp_url") or ""
        dnov = pcfg.get("daynight_override") or {}
        try:
            if dnov.get("enabled") and rtsp_url:
                log.info("[sun-tl-test] applying daynight override → Color")
                session.daynight_color_set = self._apply_daynight_override(
                    cam_id, "Color", phase, 0
                )
            else:
                log.info(
                    "[sun-tl-test] daynight override skipped (enabled=%s rtsp=%s)",
                    bool(dnov.get("enabled")),
                    bool(rtsp_url),
                )
                session.daynight_color_set = None
            # Pretend "now" is the sun event so the existing pre-bias
            # math + the manifest's sun_event_at field still resolve
            # to a valid timestamp.
            sun_dt = datetime.now()
            self._run_sun_capture_inner(cam_id, phase, sun_dt, pcfg, test_session=session)
        except Exception as e:
            log.warning("[sun-tl-test] crashed: %s", e)
            session.error = str(e)
        finally:
            try:
                if dnov.get("enabled") and rtsp_url and session.daynight_color_set:
                    revert_mode = "Black&White" if dnov.get("revert", "auto") == "off" else "Auto"
                    log.info("[sun-tl-test] reverting daynight → %s", revert_mode)
                    session.daynight_revert_set = self._apply_daynight_override(
                        cam_id, revert_mode, phase, 0
                    )
            except Exception as e:
                log.warning("[sun-tl-test] revert crashed: %s", e)
            session.finished = True
            log.info("[sun-tl-test] done")
            # Detach the log handler so a fresh test starts clean.
            with _test_session_lock:
                if _active_test_handler is not None:
                    with contextlib.suppress(Exception):
                        logging.getLogger().removeHandler(_active_test_handler)
                    _active_test_handler = None

    def cancel_sun_tl_test(self) -> dict:
        """Public API hit by ``POST /api/weather/sun-tl/test/cancel``.
        Sets the cancel flag on the active session — the capture loop
        polls it at slot boundaries and at every 0.5 s sleep tick, so
        the actual stop happens within ~0.5 s of this call. Returns
        a small status dict; never raises."""
        global _active_test_session
        with _test_session_lock:
            session = _active_test_session
        if session is None:
            return {"ok": False, "error": "no test running"}
        if session.finished:
            return {"ok": False, "error": "test already finished"}
        with session.lock:
            session.cancel_requested = True
        log.info(
            "[sun-tl-test] cancel signal sent (cam=%s phase=%s)", session.cam_id, session.phase
        )
        return {"ok": True}

    def get_sun_tl_test_status(self, since: float = 0.0) -> dict:
        """Snapshot for the UI's live panel. Counters come from
        `_stats.json` written by CaptureStats.flush(); buffered log
        lines come from the in-memory ring populated by
        _SunTLTestLogHandler. Returns {running:false, session:null}
        when no session has ever run in this process — the
        module-level singleton (not the WeatherService instance)
        backs this so a service rebuild mid-run can't drop a live
        session.

        G2 · ``since`` (epoch seconds) filters the slot_events ring so
        a polling client can ask for the delta only. Default 0.0
        returns the full list."""
        from ...frame_helpers import read_capture_stats
        from ...timelapse_qa import read_qa_sidecar

        with _test_session_lock:
            session = _active_test_session
        if session is None:
            return {"running": False, "session": None}
        elapsed = (datetime.now() - session.started_at).total_seconds()
        running = (not session.finished) and (elapsed < session.duration_s + 60)
        # Prefer the final snapshot taken just before scratch cleanup;
        # while the capture is still running, read the live _stats.json.
        if session.final_stats is not None:
            stats = dict(session.final_stats)
        elif session.frames_dir is not None:
            stats = read_capture_stats(session.frames_dir) or {}
        else:
            stats = {}
        # G4 · once the encode lands and result_clip_path is set, fetch
        # the <mp4>.qa.json playback metrics so the post-run diff
        # panel can render unique_fps, container_fps, duplicate_ratio
        # and the quality_grade chip without an extra round-trip.
        # Best-effort — failure here just leaves the diff with the
        # capture-side values only.
        qa_data: dict | None = None
        if session.result_clip_path:
            try:
                # result_clip_path is relative to storage/, so the
                # absolute path is _sightings_dir().parent / clip_path.
                # _sightings_dir() returns storage/weather, so parent
                # is storage/. Joined: storage/weather/<cam>/<phase>/<file>.mp4
                clip_abs = self._sightings_dir().parent / session.result_clip_path
                qa_data = read_qa_sidecar(clip_abs)
            except Exception:
                qa_data = None
        with session.lock:
            log_tail = list(session.log_lines)
            cancelled = bool(session.cancelled)
            cancel_requested = bool(session.cancel_requested)
        return {
            "running": bool(running),
            "cancelled": cancelled,
            "cancel_requested": cancel_requested,
            "cam_id": session.cam_id,
            "phase": session.phase,
            "started_at": session.started_at.isoformat(timespec="seconds"),
            "elapsed_s": int(elapsed),
            "target_s": session.duration_s,
            "interval_s": session.interval_s,
            "fps": session.fps,
            "target_duration_s": session.target_duration_s,
            "expected_frames": int(stats.get("expected_frames", session.expected_frames) or 0),
            "captured_frames": int(stats.get("captured_frames", 0) or 0),
            "retry_recoveries": int(stats.get("retry_recoveries", 0) or 0),
            "invalid_frames": int(stats.get("invalid_frames", 0) or 0),
            "rejected_by_reason": dict(stats.get("rejected_by_reason", {}) or {}),
            "scene_skips_by_reason": dict(stats.get("scene_skips_by_reason", {}) or {}),
            "rejected_by_reason_examples": dict(stats.get("rejected_by_reason_examples", {}) or {}),
            "backfill_cache_drops": int(stats.get("backfill_cache_drops", 0) or 0),
            "fresh_captures": int(stats.get("fresh_captures", 0) or 0),
            "backfilled_slots": int(stats.get("backfilled_slots", 0) or 0),
            "skipped_slots": int(stats.get("skipped_slots", 0) or 0),
            "total_written": int(stats.get("total_written", 0) or 0),
            "daynight_color_set": session.daynight_color_set,
            "daynight_revert_set": session.daynight_revert_set,
            "result_clip_path": session.result_clip_path,
            "result_sighting_id": session.result_sighting_id,
            "error": session.error,
            "finished": bool(session.finished),
            "last_log_lines": log_tail,
            # Test-mode raw frames + per-reason _rejected/ tree —
            # surfaced as a path string relative to /app/storage so
            # the UI can build a copy-able link. None on production
            # runs (no scratch dir is preserved there) and on
            # in-flight tests before _finalise_scratch has renamed
            # the dir.
            "raw_dir": _raw_dir_relpath(session, self._sightings_dir()),
            "validator_profile": session.validator_profile,
            "baseline_brightness": (
                round(session.baseline_brightness, 1)
                if session.baseline_brightness is not None
                else None
            ),
            "phase_drift_min": session.phase_drift_min,
            "phase_drift_warning": session.phase_drift_warning,
            # G2 · cache fingerprint counters surfaced for the live
            # panel + the post-run diff. final_stats covers the
            # post-cleanup case; the live-stats branch reads them
            # from disk on every poll.
            "api_cached_grabs_total": int(stats.get("api_cached_grabs_total", 0) or 0),
            "api_cached_grabs_max_consec": int(stats.get("api_cached_grabs_max_consec", 0) or 0),
            # G2 · per-slot event ring. ``since`` filters to entries
            # strictly newer than the caller's last-seen timestamp so
            # polling can ship the delta only. Default since=0
            # returns the whole list.
            "slot_events": [
                e
                for e in (stats.get("slot_events") or [])
                if float(e.get("ts") or 0.0) > float(since or 0.0)
            ],
            # G4 · QA-sidecar playback metrics for the post-run diff
            # panel. Only present once result_clip_path is set AND
            # the qa.json was found next to the mp4. Frontend renders
            # the quality_grade chip + unique_fps row from this block.
            "qa": (
                {
                    "quality_grade": qa_data.get("quality_grade"),
                    "playback": qa_data.get("playback") or {},
                    "target_duration_s": qa_data.get("target_duration_s"),
                }
                if qa_data
                else None
            ),
        }

    def sun_times_today(self) -> dict:
        """Used by the /api/weather/sun-times endpoint to power the
        Settings → Wetter live preview.

        Per-phase entries carry the next occurrence: today's event when
        the recording window hasn't started yet, otherwise tomorrow's.
        `next_is_tomorrow` lets the UI render "morgen" labels. ISO
        datetimes are emitted alongside the legacy HH:MM strings the
        existing UI already consumes."""
        out = {"location_set": False, "sunrise": None, "sunset": None, "cameras": []}
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            return out
        out["location_set"] = True
        # Top-level today values stay as-is for backwards compat — these
        # are location-level and consumers expect "today's events".
        sr_today = self.sun_event_today("sunrise")
        ss_today = self.sun_event_today("sunset")
        out["sunrise"] = sr_today.isoformat(timespec="minutes") if sr_today else None
        out["sunset"] = ss_today.isoformat(timespec="minutes") if ss_today else None

        now = datetime.now()
        for cam in self._cfg_cameras():
            cw = cam.get("weather") or {}
            stl = cw.get("sun_timelapse") or {}
            entry = {
                "id": cam.get("id"),
                "name": cam.get("name"),
                "weather_enabled": bool(cw.get("enabled")),
                "sunrise": dict(stl.get("sunrise") or {}),
                "sunset": dict(stl.get("sunset") or {}),
            }
            for phase in ("sunrise", "sunset"):
                p = entry[phase]
                if not p.get("enabled"):
                    p["window_start"] = p["window_end"] = None
                    continue
                window = int(p.get("window_min", 30) or 30)
                # Resolve "next" event: today if its capture window
                # hasn't started yet, else tomorrow. The capture-start
                # boundary is what determines whether the recording is
                # still ahead of us — the sun event itself can be in
                # the past while the post-roll is still recording.
                #
                # Tomorrow-fallback fires in BOTH cases — today's event
                # missing (polar day / astral failure) AND today's
                # window already past. Without the None-branch the row
                # would silently render empty even when tomorrow has a
                # valid event.
                sun_dt = self.sun_event_today(phase)
                next_is_tomorrow = False
                if sun_dt is None or _sun_window_bounds(sun_dt, window)[0] <= now:
                    sun_dt = self.sun_event_today(phase, date.today() + timedelta(days=1))
                    next_is_tomorrow = sun_dt is not None
                if sun_dt is None:
                    # Genuine no-event (polar night spanning ≥ 2 days).
                    # Write next_is_tomorrow explicitly so the response
                    # shape matches the success path — frontend treats
                    # absent and False the same today, but consistency
                    # matters as the consumer grows.
                    p["window_start"] = p["window_end"] = None
                    p["next_is_tomorrow"] = False
                    continue
                start_dt, end_dt, _, _ = _sun_window_bounds(sun_dt, window)
                p["window_start"] = start_dt.strftime("%H:%M")
                p["window_end"] = end_dt.strftime("%H:%M")
                p["sun_event"] = sun_dt.strftime("%H:%M")
                p["sun_event_iso"] = sun_dt.isoformat(timespec="seconds")
                p["capture_start_iso"] = start_dt.isoformat(timespec="seconds")
                p["capture_end_iso"] = end_dt.isoformat(timespec="seconds")
                p["next_is_tomorrow"] = next_is_tomorrow
            out["cameras"].append(entry)
        return out

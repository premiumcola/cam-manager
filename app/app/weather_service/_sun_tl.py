from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — some symbols are unused in this
# mixin but kept identical across mixins so methods can move between them
# without import bookkeeping. See service.py for the canonical import list.
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

from ._consts import (
    EVENT_ICON_HEX,
    EVENT_LABEL_DE,
    HISTORY_FIELDS,
    HISTORY_FIELD_TO_EVENT,
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

    def __init__(self, session: "_SunTLTestSession"):
        super().__init__()
        self.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(message)s",
            datefmt="%H:%M:%S",
        ))
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
_active_test_session: "_SunTLTestSession | None" = None
_active_test_handler: "_SunTLTestLogHandler | None" = None
_test_session_lock = threading.Lock()


def _raw_dir_relpath(session: "_SunTLTestSession", sightings_dir: Path) -> str | None:
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
            obs = Observer(latitude=float(lat), longitude=float(lon),
                           elevation=float(loc.get("elevation") or 0.0))
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
                j.id for j in self._scheduler.get_jobs()
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
            try:
                self._scheduler.remove_job(k)
            except Exception:
                pass
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
                    log.info("[weather] %s %s @ %s already passed — skipping today",
                             cam_name, phase, sun_dt.strftime("%H:%M"))
                    continue
                key = f"sun_tl_capture_{cam_id}_{phase}_{today.isoformat()}"
                self._scheduler.add_job(
                    self._run_sun_capture_safe,
                    DateTrigger(run_date=start_dt),
                    id=key, replace_existing=True,
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
                    revert_mode = (
                        "Black&White"
                        if dnov.get("revert", "auto") == "off"
                        else "Auto"
                    )
                    if not (cam.get("rtsp_url") or "").strip():
                        log.warning(
                            "[weather] %s %s: no rtsp_url, cannot infer Reolink host — daynight override skipped",
                            cam_name, phase)
                    elif override_at <= datetime.now():
                        log.info(
                            "[weather] %s %s: daynight override window already passed, capture-only",
                            cam_name, phase)
                    else:
                        dn_key = f"sun_tl_dnov_{cam_id}_{phase}_{today.isoformat()}"
                        self._scheduler.add_job(
                            self._apply_daynight_override,
                            DateTrigger(run_date=override_at),
                            id=dn_key, replace_existing=True,
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
                            id=rv_key, replace_existing=True,
                            args=[cam_id, revert_mode, phase, lead_min],
                        )
                        registered.append(
                            f"{cam_name} {phase} daynight→{revert_mode} @{revert_at.strftime('%H:%M')}"
                        )
        if registered:
            log.info("[weather] Jobs registered: %s", " · ".join(registered))
        else:
            log.info("[weather] Keine Sun-Jobs heute (alle aus oder Fenster vorbei)")

    def _apply_daynight_override(self, cam_id: str, mode: str,
                                 phase: str = "", lead_min: int = 0) -> bool:
        """Force a camera's day/night mode via the Reolink HTTP CGI.

        Called from the scheduler (lead-in: mode="Color") and from
        _run_sun_capture's tail (revert: mode="Auto"/"Black&White"). All
        failures are logged at WARNING and swallowed — the override must
        never block the capture or mark a finished timelapse as failed.
        """
        from urllib.parse import urlparse

        from .. import reolink_api
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
                log.info("[weather] daynight override Color: %s (für %s in %d min)",
                         cam_name, phase or "?", lead_min)
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
                cam_name, mode,
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

    def _run_sun_capture_inner(self, cam_id: str, phase: str, sun_dt: datetime,
                               pcfg: dict, test_session: "_SunTLTestSession | None" = None):
        from ..frame_helpers import (
            CaptureStats,
            DAY_PROFILE,
            NIGHT_PROFILE,
            TWILIGHT_PROFILE,
            grab_valid_frame,
            is_valid_frame,
            pick_profile_from_baseline,
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
                    log_tag, drift_min, _SUN_TL_DRIFT_LIMIT_MIN, cam_id, phase,
                )
                return
            # Test mode: log and proceed; surface drift on session.
            log.warning(
                "[%s] drift=%dmin (limit=%dmin) — proceeding because this "
                "is a diagnostic test run",
                log_tag, drift_min, _SUN_TL_DRIFT_LIMIT_MIN,
            )
            test_session.phase_drift_min = drift_min
            test_session.phase_drift_warning = warn_msg
        elif test_session is not None:
            # Within limits but still record the drift for the UI to
            # show "right on time" without a warning pill.
            test_session.phase_drift_min = drift_min
        interval_s = max(1, int(pcfg.get("interval_s", 3) or 3))
        target_fps = max(1, int(pcfg.get("fps", 25) or 25))
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
        if test_session is not None:
            stem = f"_test_{datetime.now().strftime('%H%M%S')}_{date_label}_{phase}"
        else:
            stem = f"{date_label}_{phase}"
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
        log.info("[%s] Capture start: %s %s (Fenster %ds, %ds-Intervall, %d fps)",
                 log_tag, cam_name, phase, window_seconds, interval_s, target_fps)
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
            log_tag, active_profile.name.upper(),
            f"{baseline_med:.0f}" if baseline_med is not None else "?",
            cam_name, phase,
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
            _BAND_Y_RE = re.compile(r"y=(\d+)%")
            _BAND_H_RE = re.compile(r"h=(\d+)%")
            def _save_reject(frame, reason, attempt_idx):
                # No frame to persist (grab_fn returned None or raised) — skip.
                if frame is None:
                    return
                # reason head = part before first '(' — sanitised for FS:
                head = reason.split("(", 1)[0].strip() or "unknown"
                head = re.sub(r"[^a-z0-9_]+", "_", head.lower())[:40] or "unknown"
                # When the reason carries band-location info (y=NN%,
                # h=NN% — emitted by horizontal_anomaly_band and the
                # legacy bottom_strip_* heads), append it to the
                # folder name so an audit run separates "y=55 mid-band
                # corruption" from "y=90 bottom-band corruption" at a
                # glance: _rejected/horizontal_anomaly_band_y55_h2/…
                m_y = _BAND_Y_RE.search(reason)
                m_h = _BAND_H_RE.search(reason)
                if m_y and m_h:
                    head = f"{head}_y{m_y.group(1)}_h{m_h.group(1)}"
                    head = head[:60]  # filesystem-friendly cap
                bucket = rejects_dir / head
                bucket.mkdir(parents=True, exist_ok=True)
                # Detail tail (the part inside parens) for filename — keeps
                # std/area/score values in the filename so a directory
                # listing tells the story without opening every file.
                detail = ""
                if "(" in reason and reason.endswith(")"):
                    detail = reason[reason.index("(") + 1:-1]
                    detail = re.sub(r"[^a-z0-9._=-]+", "_", detail.lower())[:60]
                fname = f"slot{i:05d}_a{attempt_idx}{('_' + detail) if detail else ''}.jpg"
                # Encode ndarray → JPEG bytes if needed; bytes pass through.
                try:
                    if isinstance(frame, (bytes, bytearray, memoryview)):
                        (bucket / fname).write_bytes(bytes(frame))
                    else:
                        ok, buf = _cv2.imencode(".jpg", frame,
                                                [int(_cv2.IMWRITE_JPEG_QUALITY), 85])
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
                log.warning("[sun-tl-test] could not rename %s → %s: %s",
                            frames_dir, target, e)
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
                            "(%d frames captured)", i, n_written,
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
                                log_tag, active_profile.name.upper(),
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
                    if (last_repick_at is None
                            or (now_dt - last_repick_at).total_seconds() >= 30):
                        next_repick_at = now_dt
                # Self-defence: re-validate the cached jpg under a
                # tighter profile after > 3 consecutive uses. If even
                # the stricter gate accepts it, keep using it; if it
                # now fails, drop the cache so a corrupt frame that
                # snuck through can't infect adjacent slots.
                if (last_valid_jpg is not None
                        and n_consecutive_backfills >= 3):
                    strict = _stricter_profile(active_profile)
                    ok_strict, strict_reason = is_valid_frame(
                        last_valid_jpg, profile=strict,
                    )
                    if not ok_strict:
                        log.info(
                            "[%s] dropped backfill cache after %d consecutive "
                            "uses — re-validation flagged %s",
                            log_tag, n_consecutive_backfills, strict_reason,
                        )
                        last_valid_jpg = None
                        n_consecutive_backfills = 0
                        stats.backfill_cache_drops += 1
                if last_valid_jpg is not None:
                    # Backfill with the most recent valid frame so the
                    # slot index sequence stays gap-free for the
                    # encoder. Counter still bumps invalid_frames for
                    # diagnostic visibility.
                    out = frames_dir / f"{i:05d}.jpg"
                    try:
                        out.write_bytes(last_valid_jpg)
                        n_consecutive_backfills += 1
                        log.info("[%s] %s slot %05d: invalid grab, "
                                 "filled with last valid frame (%s)",
                                 log_tag, cam_name, i, last_reason)
                    except Exception:
                        log.info("[%s] %s slot %05d: invalid grab and "
                                 "backfill write failed (%s)",
                                 log_tag, cam_name, i, last_reason)
                else:
                    log.info("[%s] %s slot %05d: invalid grabs, "
                             "leaving slot empty (%s)",
                             log_tag, cam_name, i, last_reason)
            stats.flush()
            i += 1
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
        sun_at_end = self._sun_position()
        log.info("[%s] Capture done: %s %s · %d Frames erfasst",
                 log_tag, cam_name, phase, n_written)
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
                "fresh_captures":   int(stats.fresh_captures),
                "backfilled_slots": int(stats.backfilled_slots),
                "skipped_slots":    int(stats.skipped_slots),
                "total_written":    int(stats.total_written),
                "validator_profile": active_profile.name,
                "baseline_brightness": baseline_med,
                "phase_drift_min": test_session.phase_drift_min,
                "phase_drift_warning": test_session.phase_drift_warning,
            }
        # Cancellation: skip the encode path entirely — a half-length
        # cancelled capture should not produce a sighting. Don't
        # overwrite ``error`` if a prior failure path already set it
        # (e.g. cancel landing while encode_failed was already true).
        if test_session is not None and test_session.cancelled:
            log.info("[sun-tl-test] capture cancelled — skipping encode")
            if not test_session.error:
                test_session.error = "abgebrochen"
            _finalise_scratch()
            return
        # The "≥ 2 s of video" guard fits 75-min real captures fine
        # but kills 60-s tests at 3-s intervals (only ~20 frames).
        # Drop the guard to a static minimum during test so a short
        # window still produces a verifiable MP4.
        min_frames = 4 if test_session is not None else target_fps * 2
        if n_written < min_frames:
            log.warning("[%s] Zu wenige Frames (%d) — Encode übersprungen",
                        log_tag, n_written)
            if test_session is not None:
                test_session.error = f"too few frames ({n_written})"
            _finalise_scratch()
            return
        # Re-use the existing TimelapseBuilder._write_video logic — same
        # JPEG-on-disk → ffmpeg pipeline as the regular timelapse builder
        # so we don't fork the encoder.
        try:
            from ..timelapse import TimelapseBuilder
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
                    log_tag, n_written, len(images), cam_name, phase,
                )
            if len(images) < min_frames:
                log.warning(
                    "[%s] re-glob found only %d frames (min=%d) — encode skipped (%s %s)",
                    log_tag, len(images), min_frames, cam_name, phase,
                )
                if test_session is not None:
                    test_session.error = f"too few frames on disk ({len(images)})"
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
            written = tb._write_video(images, mp4_path, target_seconds, target_fps)
            if not written or not mp4_path.exists():
                log.warning("[%s] Encode failed for %s %s", log_tag, cam_name, phase)
                if test_session is not None:
                    test_session.error = "encode failed"
                _finalise_scratch()
                return
        except Exception as e:
            log.warning("[%s] Encode crash %s %s: %s", log_tag, cam_name, phase, e)
            if test_session is not None:
                test_session.error = f"encode crash: {e}"
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
            "id":           f"{cam_id}__sun_timelapse_{phase_suffix}__{stem}",
            "cam_id":       cam_id,
            "cam_name":     cam_name,
            "event_type":   "sun_timelapse",
            "sun_phase":    phase,
            "is_test":      test_session is not None,
            "started_at":   datetime.now().isoformat(timespec="seconds"),
            # Actual sun event (sunrise/sunset) time. Distinct from
            # started_at, which is the moment the encode finished —
            # the Sichtungen card prefers this so the user sees
            # "Sonnenuntergang 20:32" instead of the window-end.
            "sun_event_at": sun_dt.isoformat(timespec="seconds"),
            "score":        round(float(score), 3),
            "severity":     round(float(score), 3),
            "window_min":   round(window_seconds / 60.0, 2),
            "window_seconds": window_seconds,
            "interval_s":   interval_s,
            "fps":          target_fps,
            "api_snapshot": _safe_subset(api_snapshot or {}, [
                "time", "precipitation", "snowfall", "lightning_potential",
                "visibility", "wind_gusts_10m", "cloud_cover", "weather_code",
            ]),
            "sun_snapshot": {
                "altitude_at_start": sun_at_start.get("altitude"),
                "altitude_at_end":   sun_at_end.get("altitude"),
                "azimuth_at_start":  sun_at_start.get("azimuth"),
                "azimuth_at_end":    sun_at_end.get("azimuth"),
            },
            "clip_path":    f"weather/{cam_id}/{phase_dir}/{mp4_path.name}",
            "thumb_path":   f"weather/{cam_id}/{phase_dir}/{thumb_path.name}",
            "duration_s":   max(1, len(images) // target_fps),
            "width":  0, "height": 0,
        }
        try:
            import cv2
            cap = cv2.VideoCapture(str(mp4_path))
            manifest["width"]  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            manifest["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
        except Exception:
            pass
        _atomic_write_json(out_dir / f"{stem}.json", manifest)
        log.info("[%s] Manifest geschrieben: %s · score=%.2f",
                 log_tag, manifest["id"], score)
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
        try:
            shutil.rmtree(scratch, ignore_errors=True)
        except Exception:
            pass

    # ── Sun-Timelapse TEST runner (Settings → Wetter-Ereignisse → Test) ──
    # The user fires a 60-s … 40-min capture from the UI to reproduce the
    # twilight rejection bug live: a real sunrise/sunset is too rare to
    # iterate against, but the SAME _run_sun_capture_inner code path
    # underneath. The runner attaches a logging.Handler that mirrors
    # matching log lines into a per-session ring buffer so the status
    # endpoint can return a live tail without reparsing docker logs.
    # The longer durations (30 / 40 min) span enough real twilight to
    # produce a usable MP4 that mirrors what a live sunset would write.
    _SUN_TL_TEST_DURATIONS = (60, 120, 300, 1800, 2400)
    _SUN_TL_TEST_TARGET_LENGTHS = (10, 15, 20, 30, 45)

    def start_sun_tl_test(self, cam_id: str, phase: str, duration_s: int,
                          target_duration_s: int | None = None) -> dict:
        """Spawn a daemon thread that runs a parameterised sun-tl capture.
        Returns {"ok": bool, "error": str|None}. Idempotent against a
        running session — a second start while one is still active
        returns ok=False with an explanatory error."""
        global _active_test_session, _active_test_handler
        if phase not in ("sunrise", "sunset"):
            return {"ok": False, "error": "phase must be sunrise or sunset"}
        try:
            duration_s = int(duration_s)
        except (TypeError, ValueError):
            duration_s = 120
        if duration_s not in self._SUN_TL_TEST_DURATIONS:
            duration_s = 120
        # Target encoded MP4 length — None means "let the legacy math
        # decide". Validated against the same allowlist the UI exposes.
        if target_duration_s is not None:
            try:
                target_duration_s = int(target_duration_s)
            except (TypeError, ValueError):
                target_duration_s = None
            if target_duration_s not in self._SUN_TL_TEST_TARGET_LENGTHS:
                target_duration_s = None
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

        pcfg_user = (((cam.get("weather") or {}).get("sun_timelapse") or {}).get(phase) or {})
        interval_s = max(1, int(pcfg_user.get("interval_s", 3) or 3))
        target_fps = max(1, int(pcfg_user.get("fps", 25) or 25))
        # Carry the daynight_override block forward so the test
        # exercises the same Color/Auto flip the real schedule does.
        pcfg = {
            "interval_s": interval_s,
            "fps": target_fps,
            "daynight_override": dict(pcfg_user.get("daynight_override") or {}),
        }
        expected = int(duration_s / max(1, interval_s))
        session = _SunTLTestSession(
            cam_id=cam_id, phase=phase, duration_s=duration_s,
            started_at=datetime.now(), expected_frames=expected,
            interval_s=interval_s, fps=target_fps,
            target_duration_s=target_duration_s,
        )
        handler = _SunTLTestLogHandler(session)
        handler.setLevel(logging.INFO)
        # Tear down any handler from a prior session before attaching the
        # new one so the root logger doesn't accumulate dead handlers
        # across runs.
        with _test_session_lock:
            if _active_test_handler is not None:
                try:
                    logging.getLogger().removeHandler(_active_test_handler)
                except Exception:
                    pass
            logging.getLogger().addHandler(handler)
            _active_test_session = session
            _active_test_handler = handler
        log.info(
            "[sun-tl-test] %s · %s · %ds · interval=%ds fps=%d",
            self._cam_name(cam_id), phase, duration_s, interval_s, target_fps,
        )
        threading.Thread(
            target=self._run_sun_tl_test_thread,
            args=(cam_id, phase, pcfg, session),
            daemon=True,
            name=f"sun-tl-test-{cam_id}-{phase}",
        ).start()
        return {"ok": True}

    def _run_sun_tl_test_thread(self, cam_id: str, phase: str,
                                pcfg: dict, session: "_SunTLTestSession"):
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
                    cam_id, "Color", phase, 0)
            else:
                log.info(
                    "[sun-tl-test] daynight override skipped (enabled=%s rtsp=%s)",
                    bool(dnov.get("enabled")), bool(rtsp_url),
                )
                session.daynight_color_set = None
            # Pretend "now" is the sun event so the existing pre-bias
            # math + the manifest's sun_event_at field still resolve
            # to a valid timestamp.
            sun_dt = datetime.now()
            self._run_sun_capture_inner(cam_id, phase, sun_dt, pcfg,
                                        test_session=session)
        except Exception as e:
            log.warning("[sun-tl-test] crashed: %s", e)
            session.error = str(e)
        finally:
            try:
                if dnov.get("enabled") and rtsp_url and session.daynight_color_set:
                    revert_mode = ("Black&White"
                                   if dnov.get("revert", "auto") == "off"
                                   else "Auto")
                    log.info("[sun-tl-test] reverting daynight → %s", revert_mode)
                    session.daynight_revert_set = self._apply_daynight_override(
                        cam_id, revert_mode, phase, 0)
            except Exception as e:
                log.warning("[sun-tl-test] revert crashed: %s", e)
            session.finished = True
            log.info("[sun-tl-test] done")
            # Detach the log handler so a fresh test starts clean.
            with _test_session_lock:
                if _active_test_handler is not None:
                    try:
                        logging.getLogger().removeHandler(_active_test_handler)
                    except Exception:
                        pass
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
        log.info("[sun-tl-test] cancel signal sent (cam=%s phase=%s)",
                 session.cam_id, session.phase)
        return {"ok": True}

    def get_sun_tl_test_status(self) -> dict:
        """Snapshot for the UI's live panel. Counters come from
        `_stats.json` written by CaptureStats.flush(); buffered log
        lines come from the in-memory ring populated by
        _SunTLTestLogHandler. Returns {running:false, session:null}
        when no session has ever run in this process — the
        module-level singleton (not the WeatherService instance)
        backs this so a service rebuild mid-run can't drop a live
        session."""
        from ..frame_helpers import read_capture_stats
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
            "fresh_captures":   int(stats.get("fresh_captures", 0) or 0),
            "backfilled_slots": int(stats.get("backfilled_slots", 0) or 0),
            "skipped_slots":    int(stats.get("skipped_slots", 0) or 0),
            "total_written":    int(stats.get("total_written", 0) or 0),
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
        }

    def sun_times_today(self) -> dict:
        """Used by the /api/weather/sun-times endpoint to power the
        Settings → Wetter live preview.

        Per-phase entries carry the next occurrence: today's event when
        the recording window hasn't started yet, otherwise tomorrow's.
        `next_is_tomorrow` lets the UI render "morgen" labels. ISO
        datetimes are emitted alongside the legacy HH:MM strings the
        existing UI already consumes."""
        out = {"location_set": False, "sunrise": None, "sunset": None,
               "cameras": []}
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            return out
        out["location_set"] = True
        # Top-level today values stay as-is for backwards compat — these
        # are location-level and consumers expect "today's events".
        sr_today = self.sun_event_today("sunrise")
        ss_today = self.sun_event_today("sunset")
        out["sunrise"] = sr_today.isoformat(timespec="minutes") if sr_today else None
        out["sunset"]  = ss_today.isoformat(timespec="minutes") if ss_today else None

        now = datetime.now()
        for cam in self._cfg_cameras():
            cw = cam.get("weather") or {}
            stl = cw.get("sun_timelapse") or {}
            entry = {"id": cam.get("id"), "name": cam.get("name"),
                     "weather_enabled": bool(cw.get("enabled")),
                     "sunrise": dict(stl.get("sunrise") or {}),
                     "sunset":  dict(stl.get("sunset")  or {})}
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
                p["window_start"]      = start_dt.strftime("%H:%M")
                p["window_end"]        = end_dt.strftime("%H:%M")
                p["sun_event"]         = sun_dt.strftime("%H:%M")
                p["sun_event_iso"]     = sun_dt.isoformat(timespec="seconds")
                p["capture_start_iso"] = start_dt.isoformat(timespec="seconds")
                p["capture_end_iso"]   = end_dt.isoformat(timespec="seconds")
                p["next_is_tomorrow"]  = next_is_tomorrow
            out["cameras"].append(entry)
        return out



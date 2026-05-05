from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — some symbols are unused in this
# mixin but kept identical across mixins so methods can move between them
# without import bookkeeping. See service.py for the canonical import list.
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
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
                window = int(pcfg.get("window_min", 30) or 30)
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

        from . import reolink_api
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
            log.warning("[weather] daynight override %s: SetIspCfg(%s) failed", cam_name, mode)
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

    def _run_sun_capture_inner(self, cam_id: str, phase: str, sun_dt: datetime, pcfg: dict):
        from ..frame_helpers import CaptureStats, grab_valid_frame
        rt = self.runtimes.get(cam_id)
        if rt is None or not hasattr(rt, "snapshot_jpeg_hires"):
            log.warning("[weather] cam %s nicht verfügbar — capture abgebrochen", cam_id)
            return
        window_min = int(pcfg.get("window_min", 30) or 30)
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
        stem = f"{date_label}_{phase}"
        mp4_path = out_dir / f"{stem}.mp4"
        thumb_path = out_dir / f"{stem}.jpg"
        # Frames go to a temporary scratch dir; deleted after encode.
        frames_dir = out_dir / f".scratch_{stem}"
        frames_dir.mkdir(parents=True, exist_ok=True)
        # Sun snapshot at start (to compare with end).
        sun_at_start = self._sun_position()
        # Wetter-Snapshot zum Trigger-Zeitpunkt (für Score + Recap-Picker).
        api_snapshot = self._latest_api_snapshot_safe()
        end_at = datetime.now() + timedelta(minutes=window_min)
        log.info("[weather] Capture start: %s %s (Fenster %d min, %ds-Intervall, %d fps)",
                 cam_name, phase, window_min, interval_s, target_fps)
        expected_frames = int((window_min * 60) / max(1, interval_s))
        stats = CaptureStats(out_dir=frames_dir, expected_frames=expected_frames)
        n_written = 0
        i = 0
        while datetime.now() < end_at:
            # Long-running capture loop — uses grab_valid_frame defaults
            # (6 attempts × 0.4 s with a 5 s wall-clock cap). The hires
            # variant reads only from the main-stream buffer so
            # timelapses get the full sensor resolution rather than the
            # 640x360 sub-stream the live preview path uses.
            jpg, attempt_used, last_reason = grab_valid_frame(
                lambda: rt.snapshot_jpeg_hires(quality=92),
            )
            if jpg:
                out = frames_dir / f"{i:05d}.jpg"
                try:
                    out.write_bytes(jpg)
                    n_written += 1
                    stats.record_capture(attempt_used=attempt_used)
                except Exception:
                    pass
            else:
                stats.record_invalid(last_reason)
                log.info("[weather] %s slot %05d: invalid grabs, leaving slot empty (%s)",
                         cam_name, i, last_reason)
            stats.flush()
            i += 1
            # Sleep in short chunks so we react quickly to stop signals.
            slept = 0.0
            while slept < interval_s and datetime.now() < end_at:
                time.sleep(0.5)
                slept += 0.5
        sun_at_end = self._sun_position()
        log.info("[weather] Capture done: %s %s · %d Frames erfasst", cam_name, phase, n_written)
        if n_written < target_fps * 2:
            log.warning("[weather] Zu wenige Frames (%d) — Encode übersprungen", n_written)
            self._cleanup_sun_scratch(frames_dir)
            return
        # Re-use the existing TimelapseBuilder._write_video logic — same
        # JPEG-on-disk → ffmpeg pipeline as the regular timelapse builder
        # so we don't fork the encoder.
        try:
            from ..timelapse import TimelapseBuilder
            tb = TimelapseBuilder(self._sightings_dir().parent.parent)
            images = sorted(frames_dir.glob("*.jpg"))
            target_seconds = max(8, n_written // target_fps) if target_fps else 24
            target_seconds = min(target_seconds, 60)  # cap at 60s safety
            written = tb._write_video(images, mp4_path, target_seconds, target_fps)
            if not written or not mp4_path.exists():
                log.warning("[weather] Encode failed for %s %s", cam_name, phase)
                self._cleanup_sun_scratch(frames_dir)
                return
        except Exception as e:
            log.warning("[weather] Encode crash %s %s: %s", cam_name, phase, e)
            self._cleanup_sun_scratch(frames_dir)
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
            "started_at":   datetime.now().isoformat(timespec="seconds"),
            # Actual sun event (sunrise/sunset) time. Distinct from
            # started_at, which is the moment the encode finished —
            # the Sichtungen card prefers this so the user sees
            # "Sonnenuntergang 20:32" instead of the window-end.
            "sun_event_at": sun_dt.isoformat(timespec="seconds"),
            "score":        round(float(score), 3),
            "severity":     round(float(score), 3),
            "window_min":   window_min,
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
        (out_dir / f"{stem}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        log.info("[weather] Manifest geschrieben: %s · score=%.2f", manifest["id"], score)
        self._cleanup_sun_scratch(frames_dir)
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



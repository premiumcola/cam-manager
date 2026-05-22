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


class EventTimelapseMixin:
    """Weather-event-driven timelapse capture (thunder rising / front passing / storm front).

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _latest_api_snapshot_safe(self) -> dict:
        """Best-effort fetch of the latest 15-minute API slot. Used by the
        sun capture so the manifest carries the actual sky conditions."""
        try:
            loc = self.server_cfg.get("location") or {}
            lat, lon = loc.get("lat"), loc.get("lon")
            if lat is None or lon is None:
                return {}
            api = self.cfg.get("api") or {}
            url = api.get("base_url") or "https://api.open-meteo.com/v1/forecast"
            params = {
                "latitude": lat,
                "longitude": lon,
                "minutely_15": "precipitation,snowfall,weather_code,lightning_potential,visibility,wind_gusts_10m,cloud_cover",
                "timezone": api.get("timezone") or "Europe/Berlin",
                "models": api.get("model") or "icon_d2",
            }
            r = requests.get(url, params=params, timeout=8)
            if r.status_code != 200:
                return {}
            return self._latest_slice(r.json())
        except Exception:
            return {}

    # ── Wetter-Ereignis-Timelapse ───────────────────────────────────────────

    # 4 h cross-trigger cooldown per camera, plus a per-day cap of 2.
    # Both keep the system from carpet-bombing the user with 60-min
    # timelapses during an active weather day.
    _EVENT_TL_COOLDOWN_S: int = 4 * 3600
    _EVENT_TL_DAILY_CAP: int = 2

    def _event_tl_state(self) -> dict:
        # Lazy attr — keeps __init__ unchanged.
        if not hasattr(self, "_event_tl_state_dict"):
            self._event_tl_state_dict = {
                "last_trigger_ts": {},  # cam_id -> unix ts (any-trigger 4h cooldown)
                "daily_count": {},  # (cam_id, "YYYY-MM-DD") -> int
            }
        return self._event_tl_state_dict

    def _event_tl_cooldown_active(self, cam_id: str) -> tuple[bool, int]:
        """Return (in_cooldown, minutes_remaining)."""
        st = self._event_tl_state()
        last = st["last_trigger_ts"].get(cam_id, 0.0)
        elapsed = time.time() - last
        if elapsed < self._EVENT_TL_COOLDOWN_S:
            return True, int((self._EVENT_TL_COOLDOWN_S - elapsed) // 60) + 1
        return False, 0

    def _event_tl_daily_cap_hit(self, cam_id: str) -> bool:
        st = self._event_tl_state()
        key = (cam_id, date.today().isoformat())
        return st["daily_count"].get(key, 0) >= self._EVENT_TL_DAILY_CAP

    def _event_tl_record_trigger(self, cam_id: str):
        st = self._event_tl_state()
        st["last_trigger_ts"][cam_id] = time.time()
        key = (cam_id, date.today().isoformat())
        st["daily_count"][key] = st["daily_count"].get(key, 0) + 1

    @staticmethod
    def _slices_window(payload: dict, past_min: int = 60, future_min: int = 180) -> list[dict]:
        """Return all 15-min slices within [-past_min, +future_min] of now,
        each as a dict {time, ...measurements}. Times beyond the API's
        returned array are simply absent — caller must handle empty lists."""
        m = (payload or {}).get("minutely_15") or {}
        times = m.get("time") or []
        if not times:
            return []
        keys = [k for k in m if k != "time"]
        now = datetime.now()
        out = []
        for i, t_iso in enumerate(times):
            t = _safe_dt(t_iso)
            if not t:
                continue
            delta_min = (t - now).total_seconds() / 60.0
            if delta_min < -past_min or delta_min > future_min:
                continue
            slot = {"time": t_iso, "_dt": t}
            for k in keys:
                arr = m.get(k) or []
                slot[k] = arr[i] if i < len(arr) else None
            out.append(slot)
        return out

    def _check_event_tl_triggers(self, payload: dict):
        """Evaluate the 3 event-tl triggers per opted-in camera. Anyone that
        fires arms the cross-trigger cooldown (so the OTHER triggers also
        get blocked for 4 h) and increments the daily counter."""
        slices = self._slices_window(payload, past_min=60, future_min=180)
        if not slices:
            return
        for cam in self._cfg_cameras():
            cam_id = cam.get("id")
            cw = cam.get("weather") or {}
            evt_cfg = cw.get("event_timelapse") or {}
            if not cw.get("enabled") or not evt_cfg.get("enabled"):
                continue
            in_cd, mins = self._event_tl_cooldown_active(cam_id)
            if in_cd:
                # Don't spam the log every 5-min poll — only log when a
                # detector would HAVE fired. Keep it simple by checking
                # detectors first, then emitting one cooldown line if any.
                fired = self._evaluate_event_tl_detectors(slices, evt_cfg)
                if fired:
                    log.info(
                        "[weather] Cooldown active (%dh %02dmin remaining) — %s skipped on %s",
                        mins // 60,
                        mins % 60,
                        fired[0],
                        self._cam_name(cam_id),
                    )
                continue
            if self._event_tl_daily_cap_hit(cam_id):
                fired = self._evaluate_event_tl_detectors(slices, evt_cfg)
                if fired:
                    log.info(
                        "[weather] Daily limit reached (%d/day), skipping %s on %s",
                        self._EVENT_TL_DAILY_CAP,
                        fired[0],
                        self._cam_name(cam_id),
                    )
                continue
            triggers = self._evaluate_event_tl_detectors(slices, evt_cfg)
            if not triggers:
                continue
            # Fire the FIRST matching trigger — once per cam per cycle.
            trig_kind, score, fc_snapshot = triggers[0]
            self._event_tl_record_trigger(cam_id)
            window_min = int(evt_cfg.get("window_min", 60) or 60)
            interval_s = max(1, int(evt_cfg.get("interval_s", 6) or 6))
            fps = max(1, int(evt_cfg.get("fps", 24) or 24))
            log.info(
                "[weather] %s on %s · score=%.2f · capture starting (%d min, %ds-Intervall, %d fps)",
                trig_kind,
                self._cam_name(cam_id),
                score,
                window_min,
                interval_s,
                fps,
            )
            threading.Thread(
                target=self._run_event_tl_capture,
                args=(
                    cam_id,
                    trig_kind,
                    score,
                    slices[0] if slices else {},
                    fc_snapshot,
                    window_min,
                    interval_s,
                    fps,
                ),
                daemon=True,
                name=f"weather-evt-tl-{cam_id}-{trig_kind}",
            ).start()

    def _evaluate_event_tl_detectors(
        self, slices: list[dict], evt_cfg: dict
    ) -> list[tuple[str, float, dict]]:
        """Run all 3 detectors that are enabled for this camera. Returns a
        list of (trigger_kind, score, forecast_snapshot) tuples for any
        that fired. Caller picks one — typically the first."""
        triggers_cfg = evt_cfg.get("triggers") or {}
        results: list[tuple[str, float, dict]] = []
        if triggers_cfg.get("thunder_rising", True):
            r = self._detect_thunder_rising(slices)
            if r:
                results.append(("thunder_rising", *r))
        if triggers_cfg.get("front_passing", True):
            r = self._detect_front_passing(slices)
            if r:
                results.append(("front_passing", *r))
        if triggers_cfg.get("storm_front", True):
            r = self._detect_storm_front(slices)
            if r:
                results.append(("storm_front", *r))
        return results

    @staticmethod
    def _slice_at_or_after(slices: list[dict], minutes_from_now: int) -> dict | None:
        for s in slices:
            dt = s.get("_dt")
            if dt and (dt - datetime.now()).total_seconds() / 60.0 >= minutes_from_now:
                return s
        return None

    def _detect_thunder_rising(self, slices: list[dict]) -> tuple[float, dict] | None:
        """Lightning-potential climbs from <500 to >1500 within the next
        60–90 min → trigger NOW. Score = peak_LP / 3000 (capped 0..1)."""
        now_slice = self._slice_at_or_after(slices, 0) or (slices[0] if slices else {})
        lp_now = now_slice.get("lightning_potential")
        # Look for the peak in the next 90 min.
        peak = 0.0
        peak_slot: dict | None = None
        for s in slices:
            t = s.get("_dt")
            if not t:
                continue
            delta = (t - datetime.now()).total_seconds() / 60.0
            if delta < 0 or delta > 90:
                continue
            v = s.get("lightning_potential")
            if v is None:
                continue
            if float(v) > peak:
                peak = float(v)
                peak_slot = s
        if peak_slot is None:
            return None
        if (lp_now is None or float(lp_now) < 500.0) and peak >= 1500.0:
            score = min(1.0, peak / 3000.0)
            return score, _safe_subset(
                peak_slot,
                [
                    "time",
                    "lightning_potential",
                    "cloud_cover",
                    "wind_gusts_10m",
                    "precipitation",
                ],
            )
        return None

    def _detect_front_passing(self, slices: list[dict]) -> tuple[float, dict] | None:
        """Cloud-cover swing > 50 percentage-points across any 60-min window
        AND wind-gust climb > 20 km/h within the same window."""
        # Build a (dt, cc, gust) sequence for slices in [-30, +120] min.
        seq = []
        for s in slices:
            dt = s.get("_dt")
            if not dt:
                continue
            delta = (dt - datetime.now()).total_seconds() / 60.0
            if delta < -30 or delta > 120:
                continue
            cc = s.get("cloud_cover")
            g = s.get("wind_gusts_10m")
            if cc is None or g is None:
                continue
            seq.append((dt, float(cc), float(g)))
        # Slide a 60-min window and check cloud-swing + gust-climb.
        for i in range(len(seq)):
            t0, cc0, g0 = seq[i]
            for j in range(i + 1, len(seq)):
                tj, ccj, gj = seq[j]
                if (tj - t0).total_seconds() / 60.0 > 60:
                    break
                if abs(ccj - cc0) > 50 and (gj - g0) > 20:
                    score = min(1.0, abs(ccj - cc0) / 100.0 + (gj - g0) / 100.0)
                    return score, {
                        "time_start": t0.isoformat(timespec="minutes"),
                        "time_end": tj.isoformat(timespec="minutes"),
                        "cloud_cover_delta": ccj - cc0,
                        "wind_gust_delta": gj - g0,
                    }
        return None

    def _detect_storm_front(self, slices: list[dict]) -> tuple[float, dict] | None:
        """Forecast peak wind gusts > 60 km/h in next 60 min AND
        cloud_cover > 70 in the same window."""
        peak_g = 0.0
        peak_slot: dict | None = None
        for s in slices:
            dt = s.get("_dt")
            if not dt:
                continue
            delta = (dt - datetime.now()).total_seconds() / 60.0
            if delta < 0 or delta > 60:
                continue
            g = s.get("wind_gusts_10m")
            cc = s.get("cloud_cover")
            if g is None or cc is None:
                continue
            if float(g) > peak_g and float(cc) > 70.0:
                peak_g = float(g)
                peak_slot = s
        if peak_slot is None or peak_g < 60.0:
            return None
        score = min(1.0, peak_g / 120.0)
        return score, _safe_subset(
            peak_slot,
            [
                "time",
                "wind_gusts_10m",
                "cloud_cover",
                "precipitation",
                "lightning_potential",
            ],
        )

    def _run_event_tl_capture(
        self,
        cam_id: str,
        trigger: str,
        score: float,
        api_now: dict,
        fc_snapshot: dict,
        window_min: int,
        interval_s: int,
        fps: int,
    ):
        from ..frame_helpers import CaptureStats, grab_valid_frame, pick_profile_from_baseline

        rt = self.runtimes.get(cam_id)
        if rt is None or not hasattr(rt, "snapshot_jpeg_hires"):
            log.warning("[weather] cam %s nicht verfügbar — capture abgebrochen", cam_id)
            return
        cam_name = self._cam_name(cam_id)
        out_dir = self._sightings_dir() / cam_id / "event_timelapse"
        out_dir.mkdir(parents=True, exist_ok=True)
        ts_label = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        # Camera slug appended so cross-camera downloads stay unique;
        # see camera_id.camera_slug for the derivation order.
        from ..camera_id import camera_slug

        cam_slug = camera_slug(self.settings_store, cam_id)
        stem = f"{ts_label}_{trigger}_{cam_slug}"
        mp4_path = out_dir / f"{stem}.mp4"
        thumb_path = out_dir / f"{stem}.jpg"
        frames_dir = out_dir / f".scratch_{stem}"
        frames_dir.mkdir(parents=True, exist_ok=True)
        end_at = datetime.now() + timedelta(minutes=window_min)
        expected_frames = int((window_min * 60) / max(1, interval_s))
        stats = CaptureStats(out_dir=frames_dir, expected_frames=expected_frames)
        n_written = 0
        i = 0
        # Adaptive validator profile — same approach as the sun-tl
        # capture: 3 quick samples → DAY/TWILIGHT/NIGHT. Event timelapses
        # can run during any weather event (storm at noon vs midnight
        # snowfall) so the profile-pick is just as relevant here.
        baseline_samples = []
        for _bi in range(3):
            try:
                _b = rt.snapshot_jpeg_hires(quality=85)
                if _b:
                    baseline_samples.append(_b)
            except Exception:
                pass
            if _bi < 2:
                time.sleep(0.5)
        active_profile = pick_profile_from_baseline(baseline_samples)
        log.info(
            "[weather] event-tl profile=%s cam=%s trigger=%s",
            active_profile.name.upper(),
            cam_name,
            trigger,
        )
        # 2 min cadence (was 5) so a scene transition is detected
        # before the loop burns through dozens of false-positive
        # rejects. ``last_repick_at`` rate-limits the dead_area-
        # triggered forced re-pick.
        next_repick_at = datetime.now() + timedelta(minutes=2)
        last_repick_at: datetime | None = None
        while datetime.now() < end_at:
            now_dt = datetime.now()
            if now_dt >= next_repick_at:
                try:
                    samp = rt.snapshot_jpeg_hires(quality=85)
                    if samp:
                        new_prof = pick_profile_from_baseline([samp])
                        if new_prof is not active_profile:
                            log.info(
                                "[weather] event-tl profile-switch %s → %s mid-run",
                                active_profile.name.upper(),
                                new_prof.name.upper(),
                            )
                            active_profile = new_prof
                except Exception:
                    pass
                last_repick_at = now_dt
                next_repick_at = now_dt + timedelta(minutes=2)
            jpg, attempt_used, last_reason = grab_valid_frame(
                lambda: rt.snapshot_jpeg_hires(quality=92),
                profile=active_profile,
            )
            if jpg:
                try:
                    (frames_dir / f"{i:05d}.jpg").write_bytes(jpg)
                    n_written += 1
                    stats.record_capture(attempt_used=attempt_used)
                except Exception:
                    pass
            else:
                stats.record_invalid(last_reason)
                # Force a profile re-pick on a dead_area reject (rate-
                # limited to once per 30 s) — same logic as sun-tl.
                if last_reason and "dead_area" in last_reason:
                    if last_repick_at is None or (now_dt - last_repick_at).total_seconds() >= 30:
                        next_repick_at = now_dt
                log.info(
                    "[weather] %s slot %05d: invalid grabs, leaving slot empty (%s)",
                    cam_name,
                    i,
                    last_reason,
                )
            stats.flush()
            i += 1
            slept = 0.0
            while slept < interval_s and datetime.now() < end_at:
                time.sleep(0.5)
                slept += 0.5
        log.info("[weather] Capture done: %s %s · %d Frames", cam_name, trigger, n_written)
        if n_written < fps * 2:
            log.warning("[weather] Zu wenige Frames (%d) — Encode übersprungen", n_written)
            self._cleanup_sun_scratch(frames_dir)
            return
        try:
            from ..timelapse import TimelapseBuilder

            tb = TimelapseBuilder(self._sightings_dir().parent.parent)
            images = sorted(frames_dir.glob("*.jpg"))
            target_seconds = max(15, min(45, n_written // fps))
            qa_ctx = {
                "camera_id": cam_id,
                "profile_name": trigger,
                "frames_dir": frames_dir,
                "settings_store": self.settings_store,
            }
            written = tb._write_video(images, mp4_path, target_seconds, fps, qa_ctx=qa_ctx)
            if not written or not mp4_path.exists():
                log.warning("[weather] Encode failed: %s %s", cam_name, trigger)
                self._cleanup_sun_scratch(frames_dir)
                return
        except Exception as e:
            log.warning("[weather] Encode crash %s %s: %s", cam_name, trigger, e)
            self._cleanup_sun_scratch(frames_dir)
            return
        try:
            mid = images[len(images) // 2]
            thumb_path.write_bytes(mid.read_bytes())
        except Exception:
            pass
        manifest = {
            "id": f"{cam_id}__{trigger}__{stem}",
            "cam_id": cam_id,
            "cam_name": cam_name,
            "event_type": "event_timelapse",
            "trigger": trigger,
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "score": round(float(score), 3),
            "severity": round(float(score), 3),
            "window_min": window_min,
            "interval_s": interval_s,
            "fps": fps,
            "api_snapshot": _safe_subset(
                api_now,
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
            "api_forecast": fc_snapshot,
            "clip_path": f"weather/{cam_id}/event_timelapse/{mp4_path.name}",
            "thumb_path": f"weather/{cam_id}/event_timelapse/{thumb_path.name}",
            "duration_s": max(1, len(images) // fps),
            "width": 0,
            "height": 0,
        }
        try:
            import cv2

            cap = cv2.VideoCapture(str(mp4_path))
            try:
                manifest["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                manifest["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            finally:
                cap.release()
        except Exception:
            pass
        _atomic_write_json(out_dir / f"{stem}.json", manifest)
        log.info("[weather] Manifest geschrieben: %s · score=%.2f", manifest["id"], score)
        self._cleanup_sun_scratch(frames_dir)
        # Optional Telegram push reuses the existing weather pipeline. The
        # event_type for push gating is the trigger name (matches the
        # WEATHER_TYPES map key on the frontend AND the per-event toggle in
        # the push.weather.events block once users add it).
        push_manifest = dict(manifest)
        push_manifest["event_type"] = trigger
        self._maybe_push_telegram(push_manifest, mp4_path)

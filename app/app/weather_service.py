"""Weather sightings backend.

Polls Open-Meteo's icon_d2 model every N seconds, runs a per-event-type
detector against the latest 15-minute slice + cached sun position, and on
trigger writes a 10-second clip (pre-roll from the camera prebuffer +
post-roll captured live) plus a JSON manifest.

Phase 1 = backend foundation. Phase 2 wires the web UI; Phase 3 builds
quarterly recaps and Telegram-side delivery. This module exposes only the
service lifecycle and read paths needed by phase-1 API routes.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from datetime import datetime, date, timedelta
from pathlib import Path

import requests

log = logging.getLogger(__name__)


# ── Public mappings (consumed by Phase-2 UI imports) ────────────────────────

EVENT_LABEL_DE: dict[str, str] = {
    "thunder":    "Gewitter",
    "heavy_rain": "Starkregen",
    "snow":       "Schnee",
    "fog":        "Nebel",
    "sunset":     "Sonnenuntergang",
}

EVENT_ICON_HEX: dict[str, str] = {
    "thunder":    "#facc15",  # yellow
    "heavy_rain": "#38bdf8",  # sky-blue
    "snow":       "#e2e8f0",  # near-white
    "fog":        "#94a3b8",  # slate
    "sunset":     "#fb923c",  # orange
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _safe_dt(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


class _CooldownTracker:
    """Per-(cam, event) cooldown: blocks subsequent triggers for N minutes."""

    def __init__(self):
        self._lock = threading.Lock()
        # key = (cam_id, event_type) -> unix ts when cooldown ends
        self._until: dict[tuple[str, str], float] = {}

    def check(self, cam_id: str, event: str) -> tuple[bool, int]:
        """Return (in_cooldown, minutes_remaining)."""
        with self._lock:
            until = self._until.get((cam_id, event), 0.0)
            now = time.time()
            if now < until:
                return True, int((until - now) // 60) + 1
            return False, 0

    def arm(self, cam_id: str, event: str, minutes: int):
        with self._lock:
            self._until[(cam_id, event)] = time.time() + max(1, int(minutes)) * 60


class _HysteresisState:
    """Per-(cam, event) on/off state for detectors that need it."""

    def __init__(self):
        self._lock = threading.Lock()
        self._state: dict[tuple[str, str], str] = {}  # "on" | "off"

    def get(self, cam_id: str, event: str) -> str:
        with self._lock:
            return self._state.get((cam_id, event), "off")

    def set(self, cam_id: str, event: str, value: str):
        with self._lock:
            self._state[(cam_id, event)] = value


class WeatherService:
    """Lifecycle mirror of TelegramService — start/shutdown/reload, idempotent.

    The polling job is owned by APScheduler; clip encoding runs in worker
    threads so a long ffmpeg call never starves the polling cadence.
    """

    def __init__(self, cfg: dict, runtimes: dict, settings_store, server_cfg: dict,
                 telegram_getter=None):
        self.cfg = cfg or {}
        # NEVER do `runtimes or {}` here: an empty dict is falsy, so that
        # idiom returns a fresh `{}` instead of the live reference. We need
        # the live reference so cameras added later (rebuild_runtimes adds
        # them AFTER service init) become visible to subsequent polls.
        self.runtimes = runtimes if runtimes is not None else {}
        self.settings_store = settings_store
        self.server_cfg = server_cfg or {}
        # Lambda returning the current TelegramService — passed as a getter
        # so the WeatherService doesn't pin a stale reference across a
        # telegram reload (Phase-1 reload swaps the service in place).
        self.telegram_getter = telegram_getter
        self._scheduler = None
        self._stopped = False
        self._cooldown = _CooldownTracker()
        self._hyst = _HysteresisState()
        self._sun_cache: tuple[float, dict] = (0.0, {})  # (ts_sec, data)
        # Sunset detector needs to know how long altitude has been in range
        # to enforce min_duration_min.
        self._sunset_in_window_since: float | None = None
        self._sunset_last_trigger_day: date | None = None
        self._fail_streak = 0
        # Status snapshot exposed via /api/weather/status — touched only
        # under self._lock to avoid the "current state" tearing.
        self._lock = threading.Lock()
        self._status: dict = {
            "enabled":      bool(self.cfg.get("enabled", True)),
            "last_poll_at": None,
            "last_api_ok":  None,
            "current_state": {k: False for k in EVENT_LABEL_DE},
            "location": {
                "lat": (self.server_cfg.get("location") or {}).get("lat"),
                "lon": (self.server_cfg.get("location") or {}).get("lon"),
            },
        }

    # ── Lifecycle ───────────────────────────────────────────────────────────

    def start(self):
        if not self.cfg.get("enabled", True):
            log.info("[Weather] Service disabled via config")
            return
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            log.warning("[Weather] No server.location set — service cannot poll. Refusing to start.")
            return
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            self._scheduler = BackgroundScheduler(daemon=True)
            self._scheduler.start()
        except Exception as e:
            log.error("[Weather] Scheduler start failed: %s", e)
            return
        # Attach prebuffers to opted-in cameras so post-roll capture has
        # something to splice on.
        self._attach_prebuffers()
        # Register the recurring poll job.
        from apscheduler.triggers.interval import IntervalTrigger
        interval = int(self.cfg.get("poll_interval", 300) or 300)
        self._scheduler.add_job(
            self._safe_poll, IntervalTrigger(seconds=interval),
            id="weather_poll", replace_existing=True,
            max_instances=1, coalesce=True,
        )
        # Fire once a few seconds after start so the dashboard isn't blank
        # for `interval` seconds — and so camera runtimes (which are started
        # by rebuild_runtimes() AFTER rebuild_services()) have time to be
        # inserted into the shared runtimes dict before _sync_prebuffers runs.
        try:
            from apscheduler.triggers.date import DateTrigger
            self._scheduler.add_job(
                self._safe_poll,
                DateTrigger(run_date=datetime.now() + timedelta(seconds=8)),
                id="weather_poll_initial",
            )
        except Exception:
            pass
        # Recap jobs (quarterly + yearly) — calculated for current and next
        # year so the scheduler always knows the upcoming firings even when
        # the service was started after this year's Q1 has already happened.
        self._register_recap_jobs()
        # Sun-Timelapse: register today's sunrise/sunset jobs and a daily
        # cron at 00:05 that re-registers for the new day.
        self._register_sun_jobs()
        try:
            from apscheduler.triggers.cron import CronTrigger
            self._scheduler.add_job(
                self._register_sun_jobs, CronTrigger(hour=0, minute=5),
                id="sun_tl_recompute", replace_existing=True,
                max_instances=1, coalesce=True,
            )
        except Exception as e:
            log.warning("[Sun-TL] daily recompute job failed: %s", e)
        cams_in = [self._cam_name(cid) for cid in self._enabled_cam_ids()]
        log.info("[Weather] Service started · interval=%ss · cameras=%s", interval, cams_in)

    def shutdown(self):
        if self._stopped:
            return
        self._stopped = True
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
                log.info("[Weather] Service stopped")
        except Exception as e:
            log.warning("[Weather] shutdown failed: %s", e)
        self._scheduler = None
        # Detach prebuffers so cameras stop spending CPU on JPEG encoding.
        self._detach_prebuffers()

    def reload(self, new_cfg: dict, server_cfg: dict | None = None):
        was_enabled = bool(self.cfg.get("enabled", True))
        self.cfg = new_cfg or {}
        if server_cfg is not None:
            self.server_cfg = server_cfg
        self._stopped = False
        # Tear down the scheduler and prebuffers, rebuild them under the new
        # config. Same in-place pattern TelegramService.reload uses.
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
        except Exception:
            pass
        self._scheduler = None
        self._detach_prebuffers()
        if not self.cfg.get("enabled", True):
            log.info("[Weather] reloaded — disabled")
            with self._lock:
                self._status["enabled"] = False
            return
        with self._lock:
            self._status["enabled"] = True
        self.start()
        if not was_enabled:
            log.info("[Weather] reloaded — newly enabled")
        else:
            log.info("[Weather] reload applied")

    # ── Camera prebuffer attach/detach ──────────────────────────────────────

    def _enabled_cam_ids(self) -> list[str]:
        ids = []
        for cam_id, rt in (self.runtimes or {}).items():
            if (rt.cfg.get("weather") or {}).get("enabled"):
                ids.append(cam_id)
        return ids

    def _cam_name(self, cam_id: str) -> str:
        rt = self.runtimes.get(cam_id)
        if not rt:
            return cam_id
        try:
            return rt.cfg.get("name") or cam_id
        except Exception:
            return cam_id

    def _attach_prebuffers(self):
        from .camera_runtime import WeatherPrebuffer
        clip = self.cfg.get("clip") or {}
        pre_s = int(clip.get("pre_roll_s", 5) or 5)
        fps   = int(clip.get("fps",        15) or 15)
        for cam_id in self._enabled_cam_ids():
            rt = self.runtimes.get(cam_id)
            if rt is None:
                continue
            if rt.weather_prebuffer is None:
                rt.weather_prebuffer = WeatherPrebuffer(pre_roll_s=pre_s, fps=fps)
                log.info("[Weather] Prebuffer attached to %s (pre=%ss fps=%s)",
                         self._cam_name(cam_id), pre_s, fps)

    def _detach_prebuffers(self):
        for rt in (self.runtimes or {}).values():
            try:
                rt.weather_prebuffer = None
            except Exception:
                pass

    # ── Polling ─────────────────────────────────────────────────────────────

    def _safe_poll(self):
        # Re-sync prebuffers every poll: rebuild_runtimes() runs the
        # service-init BEFORE the camera dict is populated, so the start()
        # call finds an empty runtimes map. Re-checking here is also how we
        # pick up cameras the user enables / disables at runtime.
        self._sync_prebuffers()
        try:
            self._poll_once()
            self._fail_streak = 0
        except Exception as e:
            self._fail_streak += 1
            log.warning("[Weather] poll failed (#%d): %s", self._fail_streak, e)
            with self._lock:
                self._status["last_api_ok"] = False
                self._status["last_poll_at"] = datetime.now().isoformat(timespec="seconds")

    def _sync_prebuffers(self):
        from .camera_runtime import WeatherPrebuffer
        clip = self.cfg.get("clip") or {}
        pre_s = int(clip.get("pre_roll_s", 5) or 5)
        fps   = int(clip.get("fps",        15) or 15)
        enabled_ids = set(self._enabled_cam_ids())
        for cam_id, rt in (self.runtimes or {}).items():
            if cam_id in enabled_ids:
                if rt.weather_prebuffer is None:
                    rt.weather_prebuffer = WeatherPrebuffer(pre_roll_s=pre_s, fps=fps)
                    log.info("[Weather] Prebuffer attached to %s (pre=%ss fps=%s)",
                             self._cam_name(cam_id), pre_s, fps)
            else:
                if rt.weather_prebuffer is not None:
                    rt.weather_prebuffer = None
                    log.info("[Weather] Prebuffer detached from %s (weather disabled)",
                             self._cam_name(cam_id))

    def _poll_once(self):
        loc = self.server_cfg.get("location") or {}
        lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            log.warning("[Weather] no location — skipping poll")
            return

        api = self.cfg.get("api") or {}
        url = api.get("base_url") or "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude":  lat,
            "longitude": lon,
            "minutely_15": ",".join([
                "precipitation", "snowfall", "weather_code",
                "lightning_potential", "visibility",
                "wind_gusts_10m", "cloud_cover",
            ]),
            "timezone": api.get("timezone") or "Europe/Berlin",
            "models":   api.get("model") or "icon_d2",
        }
        r = requests.get(url, params=params, timeout=10)
        if r.status_code >= 500:
            raise RuntimeError(f"upstream {r.status_code}")
        if r.status_code != 200:
            raise RuntimeError(f"http {r.status_code}: {r.text[:200]}")
        payload = r.json()
        latest = self._latest_slice(payload)
        sun = self._sun_position()

        # Build the "current state" dict that the status endpoint exposes
        # AND that Phase-2 UI panels will display in near-real-time.
        cur_state: dict[str, bool] = {}
        events_cfg = (self.cfg.get("events") or {})
        for evt_type in EVENT_LABEL_DE:
            cfg = events_cfg.get(evt_type) or {}
            if not cfg.get("enabled", False):
                cur_state[evt_type] = False
                continue
            active, severity = self._detect(evt_type, cfg, latest, sun)
            cur_state[evt_type] = bool(active)
            if not active:
                continue
            for cam_id in self._enabled_cam_ids():
                in_cd, mins = self._cooldown.check(cam_id, evt_type)
                if in_cd:
                    log.info("[Weather] Skip %s on %s: in cooldown (%d min remaining)",
                             evt_type, self._cam_name(cam_id), mins)
                    continue
                cooldown_min = int(cfg.get("cooldown_min", 30) or 30)
                self._cooldown.arm(cam_id, evt_type, cooldown_min)
                # Spin the clip build off so the next poll isn't blocked.
                threading.Thread(
                    target=self._trigger_clip,
                    args=(cam_id, evt_type, severity, latest, sun),
                    daemon=True,
                    name=f"weather-clip-{cam_id}-{evt_type}",
                ).start()
                log.info("[Weather] %s on %s · severity=%.2f · clip building",
                         EVENT_LABEL_DE.get(evt_type, evt_type), self._cam_name(cam_id), severity)

        # Wetter-Ereignis-Timelapse — separate trigger pipeline that walks
        # the full minutely_15 forecast (not just the latest slot) and uses
        # its own per-cam cross-trigger cooldown + daily cap.
        try:
            self._check_event_tl_triggers(payload)
        except Exception as e:
            log.warning("[Weather-TL] trigger eval failed: %s", e)

        with self._lock:
            self._status["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
            self._status["last_api_ok"] = True
            self._status["current_state"] = cur_state

    def _latest_slice(self, payload: dict) -> dict:
        """Pick the most recent 15-minute time slot whose data is non-null.
        Open-Meteo returns parallel arrays under `minutely_15`; we walk back
        from the end until we find a row that actually has values."""
        m = (payload or {}).get("minutely_15") or {}
        times = m.get("time") or []
        if not times:
            return {}
        keys = [k for k in m if k != "time"]
        # Walk from newest to oldest until we find a slot with at least one
        # non-null measurement.
        for i in range(len(times) - 1, -1, -1):
            slot = {"time": times[i]}
            any_val = False
            for k in keys:
                arr = m.get(k) or []
                v = arr[i] if i < len(arr) else None
                slot[k] = v
                if v is not None:
                    any_val = True
            if any_val:
                return slot
        return {"time": times[-1]}

    def _sun_position(self) -> dict:
        """Cached sun altitude/azimuth for the configured location.
        Cache TTL = 60s — astral.sun calls are cheap but we don't need
        sub-minute precision for sunset detection."""
        now = time.time()
        cached_ts, cached = self._sun_cache
        if now - cached_ts < 60.0 and cached:
            return cached
        loc = self.server_cfg.get("location") or {}
        lat, lon = loc.get("lat"), loc.get("lon")
        try:
            from astral import LocationInfo, Observer
            from astral.sun import elevation, azimuth
            obs = Observer(latitude=float(lat), longitude=float(lon),
                           elevation=float(loc.get("elevation") or 0.0))
            now_dt = datetime.now()
            data = {
                "altitude": float(elevation(obs, now_dt)),
                "azimuth":  float(azimuth(obs, now_dt)),
            }
        except Exception as e:
            log.debug("[Weather] sun position failed: %s", e)
            data = {"altitude": None, "azimuth": None}
        self._sun_cache = (now, data)
        return data

    # ── Detectors ───────────────────────────────────────────────────────────

    def _detect(self, evt: str, cfg: dict, d: dict, sun: dict) -> tuple[bool, float]:
        """Dispatch to the per-event detector. Returns (active, severity)."""
        if evt == "thunder":
            return self._detect_thunder(cfg, d)
        if evt == "heavy_rain":
            return self._detect_rain_or_snow(cfg, d, "heavy_rain", "precipitation", scale=20.0)
        if evt == "snow":
            return self._detect_rain_or_snow(cfg, d, "snow", "snowfall", scale=5.0)
        if evt == "fog":
            return self._detect_fog(cfg, d)
        if evt == "sunset":
            return self._detect_sunset(cfg, sun, d)
        return False, 0.0

    def _detect_thunder(self, cfg: dict, d: dict) -> tuple[bool, float]:
        lp = d.get("lightning_potential")
        if lp is None:
            return False, 0.0
        thr = float(cfg.get("threshold", 1000.0))
        if float(lp) >= thr:
            return True, min(1.0, float(lp) / 3000.0)
        return False, 0.0

    def _detect_rain_or_snow(self, cfg: dict, d: dict, evt: str, field: str,
                             scale: float) -> tuple[bool, float]:
        """Hysteresis: trigger only on off→on transition. Stays "on" until
        the value drops below `hysteresis` (or 0 if unset)."""
        val = d.get(field)
        if val is None:
            return False, 0.0
        val = float(val)
        thr = float(cfg.get("threshold", 0.0) or 0.0)
        hys = float(cfg.get("hysteresis", 0.0) or 0.0)
        # Hysteresis is per-event (not per-cam) — weather is global. The
        # state lookup uses a synthetic cam_id "_global_" so the same
        # tracker class works for both flavours.
        cur_state = self._hyst.get("_global_", evt)
        triggered = False
        if cur_state == "off" and val >= thr:
            self._hyst.set("_global_", evt, "on")
            triggered = True
        elif cur_state == "on" and val < hys:
            self._hyst.set("_global_", evt, "off")
        sev = min(1.0, val / scale) if triggered else 0.0
        return triggered, sev

    def _detect_fog(self, cfg: dict, d: dict) -> tuple[bool, float]:
        vis = d.get("visibility")
        if vis is None:
            return False, 0.0
        if float(vis) >= float(cfg.get("vis_max_m", 1000)):
            return False, 0.0
        # Frame-based confirmation: average contrast on the most recent
        # sub-stream frame of any opted-in camera. Open-Meteo's visibility
        # is a model estimate; the camera frame is ground truth.
        contrast = self._average_frame_contrast()
        if contrast is None:
            # No frame to confirm — be conservative, don't trigger.
            return False, 0.0
        if contrast > float(cfg.get("contrast_max", 0.25)):
            return False, 0.0
        sev = max(0.0, min(1.0, 1.0 - contrast * 4.0))
        return True, sev

    def _detect_sunset(self, cfg: dict, sun: dict, d: dict) -> tuple[bool, float]:
        alt = sun.get("altitude")
        if alt is None:
            return False, 0.0
        alt_min = float(cfg.get("alt_min", -2))
        alt_max = float(cfg.get("alt_max",  5))
        in_window = alt_min <= float(alt) <= alt_max
        # Once-per-day enforcement: once we've fired today, sit out until
        # midnight even if altitude is still in range.
        today = date.today()
        if self._sunset_last_trigger_day == today:
            return False, 0.0
        if not in_window:
            self._sunset_in_window_since = None
            return False, 0.0
        # Track entry timestamp so we can require min_duration_min before firing.
        if self._sunset_in_window_since is None:
            self._sunset_in_window_since = time.time()
            return False, 0.0
        in_window_for_min = (time.time() - self._sunset_in_window_since) / 60.0
        if in_window_for_min < float(cfg.get("min_duration_min", 12) or 12):
            return False, 0.0
        # Fire — record the day so we don't re-fire.
        self._sunset_last_trigger_day = today
        self._sunset_in_window_since = None
        cloud = d.get("cloud_cover") or 0
        sev = 0.5 + 0.5 * (1.0 - float(cloud) / 100.0)
        return True, max(0.0, min(1.0, sev))

    def _average_frame_contrast(self) -> float | None:
        """Mean per-cam contrast of the latest preview frame, normalised 0..1.
        Used as a sanity check for the fog detector."""
        import cv2
        import numpy as np
        vals = []
        for cam_id in self._enabled_cam_ids():
            rt = self.runtimes.get(cam_id)
            if rt is None:
                continue
            try:
                with rt.lock:
                    frame = rt._preview_frame
                if frame is None:
                    continue
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                vals.append(float(gray.std()) / 128.0)
            except Exception:
                continue
        if not vals:
            return None
        return sum(vals) / len(vals)

    # ── Trigger + clip writer ───────────────────────────────────────────────

    def _trigger_clip(self, cam_id: str, evt: str, severity: float,
                      api_data: dict, sun_data: dict):
        rt = self.runtimes.get(cam_id)
        if rt is None or rt.weather_prebuffer is None:
            log.warning("[Weather] cam %s has no prebuffer — clip aborted", cam_id)
            return
        clip_cfg = self.cfg.get("clip") or {}
        post_s = int(clip_cfg.get("post_roll_s", 5) or 5)
        fps    = int(clip_cfg.get("fps", 15) or 15)
        # Snap the pre-roll right now and start the post-roll session.
        pre = rt.weather_prebuffer.snapshot()
        session = rt.weather_prebuffer.start_postroll(post_s)
        # Wait for post-roll to complete.
        time.sleep(post_s + 0.3)
        post = rt.weather_prebuffer.collect_postroll(session)
        frames = pre + post
        if len(frames) < max(2, fps):
            log.warning("[Weather] clip %s/%s: only %d frames captured — discarding",
                        cam_id, evt, len(frames))
            return
        ts_dt = datetime.now()
        ts_label = ts_dt.strftime("%Y-%m-%d_%H%M%S")
        out_dir = self._sightings_dir() / cam_id / evt
        out_dir.mkdir(parents=True, exist_ok=True)
        mp4_path  = out_dir / f"{ts_label}.mp4"
        thumb_path = out_dir / f"{ts_label}.jpg"
        if not self._encode_clip(frames, mp4_path, fps):
            log.warning("[Weather] clip encode failed for %s/%s", cam_id, evt)
            return
        # Thumbnail = middle JPEG frame, written verbatim (no re-encode).
        try:
            mid = frames[len(frames) // 2][1]
            thumb_path.write_bytes(mid)
        except Exception as e:
            log.debug("[Weather] thumb write failed: %s", e)
        # Manifest.
        manifest = {
            "id":           f"{cam_id}__{evt}__{ts_label}",
            "cam_id":       cam_id,
            "cam_name":     self._cam_name(cam_id),
            "event_type":   evt,
            "started_at":   ts_dt.isoformat(timespec="seconds"),
            "severity":     round(float(severity), 3),
            "score":        round(float(severity), 3),
            "api_snapshot": _safe_subset(api_data, [
                "time", "precipitation", "snowfall", "lightning_potential",
                "visibility", "wind_gusts_10m", "cloud_cover", "weather_code",
            ]),
            "sun_snapshot": {"altitude": sun_data.get("altitude"),
                             "azimuth":  sun_data.get("azimuth")},
            "clip_path":    f"weather/{cam_id}/{evt}/{mp4_path.name}",
            "thumb_path":   f"weather/{cam_id}/{evt}/{thumb_path.name}",
            "duration_s":   round(len(frames) / max(1, fps), 2),
            "fps":          fps,
            "width":        int(clip_cfg.get("width", 1280) or 1280),
            "height":       0,  # filled below if probe succeeds
        }
        try:
            import cv2
            cap = cv2.VideoCapture(str(mp4_path))
            manifest["width"]  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))  or manifest["width"]
            manifest["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
        except Exception:
            pass
        manifest_path = out_dir / f"{ts_label}.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
        log.info("[Weather] Clip written: %s · %s · %.1fs · sev=%.2f",
                 self._cam_name(cam_id), EVENT_LABEL_DE.get(evt, evt),
                 manifest["duration_s"], severity)
        # Phase 3: per-event Telegram push.
        self._maybe_push_telegram(manifest, mp4_path)

    @staticmethod
    def _encode_clip(frames: list[tuple[float, bytes]], out_path: Path, fps: int) -> bool:
        """Pipe the JPEG stream straight into ffmpeg's mjpeg demuxer.
        Stream-copy would be cleanest but mjpeg→h264 transcode is essentially
        free on these clip lengths and gives us a browser-friendly mp4."""
        if not shutil.which("ffmpeg"):
            log.warning("[Weather] ffmpeg not available — cannot encode clip")
            return False
        cmd = [
            "ffmpeg", "-y",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-framerate", str(int(fps)),
            "-i", "pipe:0",
            "-vcodec", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(out_path),
        ]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            write_failed = False
            for _ts, jpg in frames:
                try:
                    proc.stdin.write(jpg)
                except Exception:
                    write_failed = True
                    break
            # Don't proc.stdin.close() here — communicate() does it for us, and
            # a manual close before communicate raises "flush of closed file"
            # on the next communicate() call.
            try:
                _out, err = proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                log.warning("[Weather] ffmpeg timeout — killed")
                return False
            if proc.returncode != 0:
                log.warning("[Weather] ffmpeg rc=%s stderr=%s",
                            proc.returncode, (err or b"").decode("utf-8", "replace")[-300:])
                return False
            if write_failed:
                log.debug("[Weather] partial frame write — clip may be short")
            return out_path.exists() and out_path.stat().st_size > 1024
        except Exception as e:
            log.warning("[Weather] ffmpeg pipe error: %s", e)
            return False

    # ── Read paths used by API endpoints ────────────────────────────────────

    def _sightings_dir(self) -> Path:
        # The settings_store doesn't have a clean "storage_root" accessor;
        # we read it the same way camera_runtime does — through the global
        # cfg block exposed by export_effective_config. Falls back to /app.
        try:
            return Path(self.settings_store.base_config.get("storage", {}).get("root", "/app/storage")) / "weather"
        except Exception:
            return Path("/app/storage/weather")

    def list_sightings(self, cam_id: str | None = None, event_type: str | None = None,
                       since_iso: str | None = None, until_iso: str | None = None,
                       page: int = 0, page_size: int = 50) -> dict:
        """Walk the sightings directory tree and return a paginated list +
        a counts-per-event-type aggregate for filter pills."""
        root = self._sightings_dir()
        items: list[dict] = []
        counts: dict[str, int] = {k: 0 for k in EVENT_LABEL_DE}
        if not root.exists():
            return {"items": [], "counts": counts, "total": 0,
                    "page": page, "page_size": page_size}
        since_dt = _safe_dt(since_iso) if since_iso else None
        until_dt = _safe_dt(until_iso) if until_iso else None
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir():
                continue
            if cam_id and cam_dir.name != cam_id:
                continue
            for evt_dir in cam_dir.iterdir():
                if not evt_dir.is_dir():
                    continue
                # Skip recap dir + scratch dirs leaked from a crashed encode.
                if evt_dir.name == "recaps" or evt_dir.name.startswith(".scratch_"):
                    continue
                # Pre-filter by directory name when the requested event_type
                # has a 1:1 dir mapping. Sun-Timelapse subtypes share one
                # dir ("sun_timelapse") and event_timelapse triggers share
                # the "event_timelapse" dir, so we always recurse those and
                # filter post-translation.
                _is_sun_request = event_type in ("sun_timelapse_rise", "sun_timelapse_set", "sun_timelapse")
                _is_evt_tl_request = event_type in ("thunder_rising", "front_passing", "storm_front", "event_timelapse")
                if event_type and not _is_sun_request and not _is_evt_tl_request and evt_dir.name != event_type:
                    continue
                for jf in evt_dir.glob("*.json"):
                    try:
                        m = json.loads(jf.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    started = _safe_dt(m.get("started_at", "")) or datetime.min
                    if since_dt and started < since_dt:
                        continue
                    if until_dt and started > until_dt:
                        continue
                    et = m.get("event_type") or evt_dir.name
                    # Sun-Timelapse: collapse the generic "sun_timelapse"
                    # event_type onto the phase-specific display type so the
                    # frontend's WEATHER_TYPES map (sun_timelapse_rise /
                    # sun_timelapse_set) drives both pills and card badges
                    # without any special-casing on the JS side.
                    if et == "sun_timelapse":
                        sp = (m.get("sun_phase") or "").lower()
                        if sp == "sunrise":
                            et = "sun_timelapse_rise"
                        elif sp == "sunset":
                            et = "sun_timelapse_set"
                        m["event_type"] = et
                    elif et == "event_timelapse":
                        # Trigger field carries the WEATHER_TYPES key
                        # (thunder_rising / front_passing / storm_front);
                        # surface that as the display type.
                        trig = (m.get("trigger") or "").lower()
                        if trig in ("thunder_rising", "front_passing", "storm_front"):
                            et = trig
                        m["event_type"] = et
                    if event_type and et != event_type and not (
                        event_type == "sun_timelapse" and et.startswith("sun_timelapse")
                    ) and not (
                        event_type == "event_timelapse" and et in ("thunder_rising", "front_passing", "storm_front")
                    ):
                        continue
                    counts[et] = counts.get(et, 0) + 1
                    items.append(m)
        items.sort(key=lambda m: m.get("started_at", ""), reverse=True)
        total = len(items)
        start = max(0, page) * page_size
        end = start + page_size
        return {"items": items[start:end], "counts": counts, "total": total,
                "page": page, "page_size": page_size}

    def get_sighting(self, sighting_id: str) -> dict | None:
        path = self._manifest_path_for(sighting_id)
        if not path or not path.exists():
            return None
        try:
            m = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        # Mirror list_sightings: collapse the on-disk generic type onto the
        # phase-specific display value the frontend WEATHER_TYPES map uses.
        et = m.get("event_type")
        if et == "sun_timelapse":
            sp = (m.get("sun_phase") or "").lower()
            if sp == "sunrise":
                m["event_type"] = "sun_timelapse_rise"
            elif sp == "sunset":
                m["event_type"] = "sun_timelapse_set"
        elif et == "event_timelapse":
            trig = (m.get("trigger") or "").lower()
            if trig in ("thunder_rising", "front_passing", "storm_front"):
                m["event_type"] = trig
        return m

    def delete_sighting(self, sighting_id: str) -> bool:
        path = self._manifest_path_for(sighting_id)
        if not path or not path.exists():
            return False
        stem = path.with_suffix("")
        for ext in (".json", ".mp4", ".jpg"):
            p = stem.with_suffix(ext)
            try:
                if p.exists():
                    p.unlink()
            except Exception as e:
                log.warning("[Weather] delete %s: %s", p.name, e)
        return True

    def _manifest_path_for(self, sighting_id: str) -> Path | None:
        # ID shape: <cam_id>__<event>__<ts_label>
        try:
            cam_id, evt, ts = sighting_id.split("__", 2)
        except ValueError:
            return None
        # Sun-Timelapse manifests live under "sun_timelapse/" regardless of
        # the per-phase id prefix the API exposes. Collapse the two phase
        # subtypes back to the shared directory name when looking up.
        # Also accept the legacy `sun_timelapse_sunrise/sunset` shape from
        # captures written before the rise/set rename.
        if evt in ("sun_timelapse_rise", "sun_timelapse_set",
                   "sun_timelapse_sunrise", "sun_timelapse_sunset"):
            evt = "sun_timelapse"
        # Event-Timelapse: id encodes the trigger kind (thunder_rising /
        # front_passing / storm_front) but all live in event_timelapse/.
        elif evt in ("thunder_rising", "front_passing", "storm_front"):
            evt = "event_timelapse"
        return self._sightings_dir() / cam_id / evt / f"{ts}.json"

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    # ── Telegram push (Phase 3) ─────────────────────────────────────────────

    def _maybe_push_telegram(self, manifest: dict, mp4_path: Path):
        """After a successful clip write, push the video to Telegram if the
        per-event toggle is on and severity meets the min-score gate."""
        try:
            tg = self.telegram_getter() if callable(self.telegram_getter) else None
            if tg is None or not getattr(tg, "enabled", False):
                return
            push_cfg = (getattr(tg, "push_cfg", {}) or {})
            wcfg = push_cfg.get("weather") or {}
            if not wcfg.get("enabled", True):
                return
            evt = manifest.get("event_type")
            if not (wcfg.get("events") or {}).get(evt, False):
                log.debug("[Weather] tg push skip: %s disabled in push.weather.events", evt)
                return
            min_score = float(wcfg.get("min_score", 0.4) or 0.0)
            score = float(manifest.get("score") or manifest.get("severity") or 0.0)
            if score < min_score:
                log.info("[Weather] tg push skip: %s score=%.2f < min=%.2f",
                         evt, score, min_score)
                return
            cam_name = manifest.get("cam_name") or manifest.get("cam_id", "?")
            cap = (f"<b>{EVENT_LABEL_DE.get(evt, evt)} · {cam_name}</b>\n"
                   f"{self._api_summary_line(manifest.get('api_snapshot') or {})}")
            buttons = [[
                ("🖼 In der Mediathek öffnen",
                 self._dashboard_url(f"#weather/{manifest.get('id', '')}")),
            ]]
            # Quiet hours respect — mirrors push.silent semantics from Phase 1.
            silent = bool(_is_quiet_now((push_cfg.get("quiet_hours") or {})))
            tg.send(cap, video=str(mp4_path), buttons=buttons, silent=silent)
            log.info("[Weather] Push gesendet: %s (%s, sev=%.2f)",
                     evt, cam_name, score)
        except Exception as e:
            log.warning("[Weather] tg push failed: %s", e)

    @staticmethod
    def _api_summary_line(snap: dict) -> str:
        parts = []
        for key, label, unit, fmt in [
            ("precipitation",       "Niederschlag",     "mm/h", "%g"),
            ("snowfall",            "Schnee",           "cm/h", "%g"),
            ("lightning_potential", "Blitz-Pot.",       "J/kg", "%g"),
            ("visibility",          "Sicht",            "m",    "%g"),
            ("wind_gusts_10m",      "Wind",             "km/h", "%g"),
            ("cloud_cover",         "Wolken",           "%",    "%g"),
        ]:
            v = snap.get(key)
            if v is None:
                continue
            try:
                parts.append(f"{fmt % float(v)} {unit} {label}")
            except Exception:
                pass
        return " · ".join(parts[:3]) if parts else "—"

    def _dashboard_url(self, suffix: str = "") -> str:
        base = (self.server_cfg.get("public_base_url") or "").rstrip("/")
        if not base:
            base = "https://example.invalid"
        return f"{base}/{suffix}"

    # ── Recaps (Phase 3) ────────────────────────────────────────────────────

    def _recaps_dir(self) -> Path:
        return self._sightings_dir() / "recaps"

    @staticmethod
    def _last_sunday_of(year: int, month: int) -> date:
        """Last Sunday on or before the last day of <month>."""
        # Find the last day of the month by stepping into the next month
        # and back one day. No relativedelta dependency needed.
        if month == 12:
            d = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            d = date(year, month + 1, 1) - timedelta(days=1)
        while d.weekday() != 6:  # 0=Mon, 6=Sun
            d -= timedelta(days=1)
        return d

    def _recap_definitions(self, year: int) -> list[dict]:
        """All recap firings for a given year. Each defines: period_id,
        period_label, run_at (datetime), period_start (date), period_end (date)."""
        out = []
        # Quarterly (Q1–Q3): last Sunday of Mar/Jun/Sep at 16:00.
        for q, end_month in [(1, 3), (2, 6), (3, 9)]:
            run_d = self._last_sunday_of(year, end_month)
            out.append({
                "period_id":    f"q{q}_{year}",
                "period_label": f"Q{q} {year}",
                "run_at":       datetime(run_d.year, run_d.month, run_d.day, 16, 0),
                "period_start": date(year, (q - 1) * 3 + 1, 1),
                "period_end":   date(year, end_month, 28) + timedelta(days=4),  # last day of month, sloppy
            })
        # Q4 + Jahres-Recap: 02. Januar des FOLGEJAHRES um 16:00.
        # Both fire on the same day; period_id distinguishes them so the
        # idempotent re-registration treats them as separate jobs.
        run_q4 = datetime(year + 1, 1, 2, 16, 0)
        out.append({
            "period_id":    f"q4_{year}",
            "period_label": f"Q4 {year}",
            "run_at":       run_q4,
            "period_start": date(year, 10, 1),
            "period_end":   date(year, 12, 31),
        })
        out.append({
            "period_id":    f"year_{year}",
            "period_label": f"Jahres-Rückblick {year}",
            "run_at":       run_q4 + timedelta(minutes=10),  # 16:10 same day
            "period_start": date(year, 1, 1),
            "period_end":   date(year, 12, 31),
        })
        # Trim period_end to actual last day of month for quarterly periods.
        for r in out:
            if r["period_id"].startswith("q") and not r["period_id"].startswith("q4"):
                # Re-derive precisely: last day of period_end month
                pe = r["period_end"]
                if pe.month == 12:
                    r["period_end"] = date(pe.year + 1, 1, 1) - timedelta(days=1)
                else:
                    r["period_end"] = date(pe.year, pe.month + 1, 1) - timedelta(days=1)
        return out

    def _register_recap_jobs(self):
        if not self._scheduler:
            return
        from apscheduler.triggers.date import DateTrigger
        now = datetime.now()
        registered = []
        for year in (now.year, now.year + 1):
            for r in self._recap_definitions(year):
                if r["run_at"] <= now:
                    continue  # past — don't re-fire
                # Idempotent skip if a recap manifest already exists for this period.
                if (self._recaps_dir() / f"{r['period_id']}.json").exists():
                    continue
                self._scheduler.add_job(
                    self._run_recap_safe,
                    DateTrigger(run_date=r["run_at"]),
                    id=f"weather_recap_{r['period_id']}",
                    replace_existing=True,
                    args=[r],
                )
                registered.append(f"{r['period_label']} → {r['run_at'].strftime('%Y-%m-%d %H:%M')}")
        if registered:
            log.info("[Weather] Recap jobs scheduled: %s", "; ".join(registered))
        else:
            log.info("[Weather] Recap jobs: keine zukünftigen Termine ausstehend")

    def _run_recap_safe(self, r: dict):
        """Wrapper that runs the build in a daemon thread so the scheduler
        thread isn't blocked by a long ffmpeg run."""
        threading.Thread(
            target=self._build_recap, args=[r],
            daemon=True, name=f"weather-recap-{r['period_id']}",
        ).start()

    def _build_recap(self, r: dict):
        try:
            cands = self._collect_recap_candidates(r["period_start"], r["period_end"])
            if len(cands) < 3:
                log.info("[Weather] Recap %s skipped — only %d candidates (need 3)",
                         r["period_label"], len(cands))
                return
            picks = self._pick_recap_clips(cands)
            if len(picks) < 3:
                log.info("[Weather] Recap %s: only %d picks survived", r["period_label"], len(picks))
                return
            self._recaps_dir().mkdir(parents=True, exist_ok=True)
            mp4_path = self._recaps_dir() / f"{r['period_id']}.mp4"
            duration = self._concat_clips([self._sightings_dir().parent / p["clip_path"] for p in picks], mp4_path)
            if not duration:
                log.warning("[Weather] Recap %s: ffmpeg concat failed", r["period_label"])
                return
            manifest = {
                "id":            r["period_id"],
                "period_label":  r["period_label"],
                "period_start":  r["period_start"].isoformat(),
                "period_end":    r["period_end"].isoformat(),
                "built_at":      datetime.now().isoformat(timespec="seconds"),
                "clip_path":     f"weather/recaps/{mp4_path.name}",
                "n_clips":       len(picks),
                "duration_s":    int(duration),
                "included_sightings": [p.get("id") for p in picks],
            }
            (self._recaps_dir() / f"{r['period_id']}.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            log.info("[Weather] Recap built: %s · %d Clips · %ds",
                     r["period_label"], len(picks), int(duration))
            self._maybe_push_recap(manifest, mp4_path)
        except Exception as e:
            log.warning("[Weather] Recap %s build failed: %s", r.get("period_label"), e)

    def _collect_recap_candidates(self, start_d: date, end_d: date) -> list[dict]:
        root = self._sightings_dir()
        out = []
        if not root.exists():
            return out
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir() or cam_dir.name == "recaps":
                continue
            for evt_dir in cam_dir.iterdir():
                if not evt_dir.is_dir():
                    continue
                for jf in evt_dir.glob("*.json"):
                    try:
                        m = json.loads(jf.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    started = _safe_dt(m.get("started_at", ""))
                    if not started:
                        continue
                    if started.date() < start_d or started.date() > end_d:
                        continue
                    if float(m.get("score") or 0.0) < 0.4:
                        continue
                    out.append(m)
        return out

    # Event-timelapse triggers — keep in sync with the WEATHER_TYPES keys
    # the frontend defines for these. Used to bump the per-type recap cap.
    _EVENT_TL_TRIGGERS: tuple[str, ...] = ("thunder_rising", "front_passing", "storm_front")

    @classmethod
    def _pick_recap_clips(cls, cands: list[dict], per_type_max: int = 3,
                          total_cap: int = 12) -> list[dict]:
        # Group by event_type, take top `per_type_max` by score per group.
        # Event-Timelapse triggers get a higher cap because they're longer,
        # rarer and more curated than the 10-s clips — a dramatic quarter
        # with several storm fronts deserves to be represented properly.
        EVT_TL_CAP = 5
        by_type: dict[str, list[dict]] = {}
        for m in cands:
            et = m.get("event_type", "?")
            # Manifest may carry the on-disk generic "event_timelapse" type
            # (when read straight from disk by the recap collector). Map
            # back to the trigger so per-type bucketing matches the UI.
            if et == "event_timelapse":
                et = (m.get("trigger") or et)
            by_type.setdefault(et, []).append(m)
        picked = []
        for evt, items in by_type.items():
            items.sort(key=lambda m: float(m.get("score") or 0.0), reverse=True)
            cap = EVT_TL_CAP if evt in cls._EVENT_TL_TRIGGERS else per_type_max
            picked.extend(items[:cap])
        picked.sort(key=lambda m: m.get("started_at", ""))
        return picked[:total_cap]

    @staticmethod
    def _concat_clips(input_paths: list[Path], out_path: Path) -> int:
        """Concat input mp4s into a single reel. Re-encodes to a uniform 1280×720
        H.264 so mixed source resolutions / fps don't trip up the demuxer.
        Returns the total duration in seconds (int) on success, 0 on failure."""
        if not shutil.which("ffmpeg"):
            log.warning("[Weather] ffmpeg unavailable — cannot build recap")
            return 0
        valid = [p for p in input_paths if p.exists() and p.stat().st_size > 1024]
        if len(valid) < 2:
            return 0
        # Build a concat-demuxer file list.
        list_file = out_path.with_suffix(".txt")
        list_file.write_text(
            "\n".join(f"file '{str(p).replace(chr(39), chr(92) + chr(39))}'" for p in valid),
            encoding="utf-8",
        )
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(list_file),
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=15,format=yuv420p",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-an", "-movflags", "+faststart",
            str(out_path),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=300)
            list_file.unlink(missing_ok=True)
            if proc.returncode != 0:
                log.warning("[Weather] ffmpeg concat rc=%s stderr=%s",
                            proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")[-300:])
                return 0
            # Probe duration via opencv as a cheap fallback (no ffprobe dep).
            try:
                import cv2
                cap = cv2.VideoCapture(str(out_path))
                fc  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                fps = float(cap.get(cv2.CAP_PROP_FPS)) or 15.0
                cap.release()
                return int(fc / fps) if fc > 0 and fps > 0 else 0
            except Exception:
                return 0
        except subprocess.TimeoutExpired:
            log.warning("[Weather] ffmpeg concat timeout — killed")
            return 0
        except Exception as e:
            log.warning("[Weather] ffmpeg concat error: %s", e)
            return 0

    def _maybe_push_recap(self, manifest: dict, mp4_path: Path):
        try:
            tg = self.telegram_getter() if callable(self.telegram_getter) else None
            if tg is None or not getattr(tg, "enabled", False):
                return
            push_cfg = (getattr(tg, "push_cfg", {}) or {})
            wcfg = push_cfg.get("weather") or {}
            if not wcfg.get("recap_push", True):
                return
            n = manifest.get("n_clips", 0)
            dur = int(manifest.get("duration_s", 0) or 0)
            mm, ss = divmod(dur, 60)
            cap = (f"<b>{manifest.get('period_label', '?')} · Wetter-Highlights</b>\n"
                   f"{n} Sichtungen · {mm}:{ss:02d} min")
            buttons = [[("🌐 Alle Sichtungen", self._dashboard_url("#weather"))]]
            tg.send(cap, video=str(mp4_path), buttons=buttons, silent=False)
            log.info("[Weather] Recap-Push gesendet: %s", manifest.get("period_label"))
        except Exception as e:
            log.warning("[Weather] recap push failed: %s", e)

    # ── Recap read helpers (used by API) ────────────────────────────────────

    def list_recaps(self) -> list[dict]:
        root = self._recaps_dir()
        if not root.exists():
            return []
        items: list[dict] = []
        for jf in root.glob("*.json"):
            try:
                items.append(json.loads(jf.read_text(encoding="utf-8")))
            except Exception:
                continue
        items.sort(key=lambda m: m.get("period_end", m.get("built_at", "")), reverse=True)
        return items

    def get_recap(self, recap_id: str) -> dict | None:
        path = self._recaps_dir() / f"{recap_id}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    # ── Sonnen-Timelapse (Phase: Sun-TL) ────────────────────────────────────

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
            log.info("[Sun-TL] No %s for %s: %s", phase, when or date.today(), e)
            return None

    def _sun_jobs_keys(self) -> list[str]:
        if not self._scheduler:
            return []
        try:
            return [j.id for j in self._scheduler.get_jobs() if j.id.startswith("sun_tl_capture_")]
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
            log.info("[Sun-TL] Standort fehlt — keine Sun-Jobs registriert")
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
                start_dt = sun_dt - timedelta(minutes=window // 2)
                if start_dt <= datetime.now():
                    log.info("[Sun-TL] %s %s @ %s already passed — skipping today",
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
        if registered:
            log.info("[Sun-TL] Jobs registered: %s", " · ".join(registered))
        else:
            log.info("[Sun-TL] Keine Sun-Jobs heute (alle aus oder Fenster vorbei)")

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
        rt = self.runtimes.get(cam_id)
        if rt is None or not hasattr(rt, "snapshot_jpeg"):
            log.warning("[Sun-TL] cam %s nicht verfügbar — capture abgebrochen", cam_id)
            return
        window_min = int(pcfg.get("window_min", 30) or 30)
        interval_s = max(1, int(pcfg.get("interval_s", 3) or 3))
        target_fps = max(1, int(pcfg.get("fps", 25) or 25))
        cam_name = self._cam_name(cam_id)
        out_dir = self._sightings_dir() / cam_id / "sun_timelapse"
        out_dir.mkdir(parents=True, exist_ok=True)
        date_label = sun_dt.strftime("%Y-%m-%d")
        stem = f"{date_label}_{phase}"
        mp4_path = out_dir / f"{stem}.mp4"
        thumb_path = out_dir / f"{stem}.jpg"
        # Frames go to a temporary scratch dir; deleted after encode.
        frames_dir = self._sightings_dir() / cam_id / "sun_timelapse" / f".scratch_{stem}"
        frames_dir.mkdir(parents=True, exist_ok=True)
        # Sun snapshot at start (to compare with end).
        sun_at_start = self._sun_position()
        # Wetter-Snapshot zum Trigger-Zeitpunkt (für Score + Recap-Picker).
        api_snapshot = self._latest_api_snapshot_safe()
        end_at = datetime.now() + timedelta(minutes=window_min)
        log.info("[Sun-TL] Capture start: %s %s (Fenster %d min, %ds-Intervall, %d fps)",
                 cam_name, phase, window_min, interval_s, target_fps)
        n_written = 0
        i = 0
        while datetime.now() < end_at:
            jpg = rt.snapshot_jpeg(quality=82) if hasattr(rt, "snapshot_jpeg") else None
            if jpg:
                out = frames_dir / f"{i:05d}.jpg"
                try:
                    out.write_bytes(jpg)
                    n_written += 1
                except Exception:
                    pass
            i += 1
            # Sleep in short chunks so we react quickly to stop signals.
            slept = 0.0
            while slept < interval_s and datetime.now() < end_at:
                time.sleep(0.5)
                slept += 0.5
        sun_at_end = self._sun_position()
        log.info("[Sun-TL] Capture done: %s %s · %d Frames erfasst", cam_name, phase, n_written)
        if n_written < target_fps * 2:
            log.warning("[Sun-TL] Zu wenige Frames (%d) — Encode übersprungen", n_written)
            self._cleanup_sun_scratch(frames_dir)
            return
        # Re-use the existing TimelapseBuilder._write_video logic — same
        # JPEG-on-disk → ffmpeg pipeline as the regular timelapse builder
        # so we don't fork the encoder.
        try:
            from .timelapse import TimelapseBuilder
            tb = TimelapseBuilder(self._sightings_dir().parent.parent)
            images = sorted(frames_dir.glob("*.jpg"))
            target_seconds = max(8, n_written // target_fps) if target_fps else 24
            target_seconds = min(target_seconds, 60)  # cap at 60s safety
            written = tb._write_video(images, mp4_path, target_seconds, target_fps)
            if not written or not mp4_path.exists():
                log.warning("[Sun-TL] Encode failed for %s %s", cam_name, phase)
                self._cleanup_sun_scratch(frames_dir)
                return
        except Exception as e:
            log.warning("[Sun-TL] Encode crash %s %s: %s", cam_name, phase, e)
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
            "clip_path":    f"weather/{cam_id}/sun_timelapse/{mp4_path.name}",
            "thumb_path":   f"weather/{cam_id}/sun_timelapse/{thumb_path.name}",
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
        log.info("[Sun-TL] Manifest geschrieben: %s · score=%.2f", manifest["id"], score)
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
                "latitude":  lat, "longitude": lon,
                "minutely_15": "precipitation,snowfall,weather_code,lightning_potential,visibility,wind_gusts_10m,cloud_cover",
                "timezone": api.get("timezone") or "Europe/Berlin",
                "models":   api.get("model") or "icon_d2",
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
                "last_trigger_ts": {},   # cam_id -> unix ts (any-trigger 4h cooldown)
                "daily_count":     {},   # (cam_id, "YYYY-MM-DD") -> int
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
                    log.info("[Weather-TL] Cooldown active (%dh %02dmin remaining) — %s skipped on %s",
                             mins // 60, mins % 60, fired[0], self._cam_name(cam_id))
                continue
            if self._event_tl_daily_cap_hit(cam_id):
                fired = self._evaluate_event_tl_detectors(slices, evt_cfg)
                if fired:
                    log.info("[Weather-TL] Daily limit reached (%d/day), skipping %s on %s",
                             self._EVENT_TL_DAILY_CAP, fired[0], self._cam_name(cam_id))
                continue
            triggers = self._evaluate_event_tl_detectors(slices, evt_cfg)
            if not triggers:
                continue
            # Fire the FIRST matching trigger — once per cam per cycle.
            trig_kind, score, fc_snapshot = triggers[0]
            self._event_tl_record_trigger(cam_id)
            window_min = int(evt_cfg.get("window_min", 60) or 60)
            interval_s = max(1, int(evt_cfg.get("interval_s", 6) or 6))
            fps        = max(1, int(evt_cfg.get("fps", 24) or 24))
            log.info("[Weather-TL] %s on %s · score=%.2f · capture starting (%d min, %ds-Intervall, %d fps)",
                     trig_kind, self._cam_name(cam_id), score, window_min, interval_s, fps)
            threading.Thread(
                target=self._run_event_tl_capture,
                args=(cam_id, trig_kind, score, slices[0] if slices else {}, fc_snapshot,
                      window_min, interval_s, fps),
                daemon=True,
                name=f"weather-evt-tl-{cam_id}-{trig_kind}",
            ).start()

    def _evaluate_event_tl_detectors(self, slices: list[dict], evt_cfg: dict) -> list[tuple[str, float, dict]]:
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
                peak = float(v); peak_slot = s
        if peak_slot is None:
            return None
        if (lp_now is None or float(lp_now) < 500.0) and peak >= 1500.0:
            score = min(1.0, peak / 3000.0)
            return score, _safe_subset(peak_slot, [
                "time", "lightning_potential", "cloud_cover", "wind_gusts_10m",
                "precipitation",
            ])
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
            cc = s.get("cloud_cover"); g = s.get("wind_gusts_10m")
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
                        "time_end":   tj.isoformat(timespec="minutes"),
                        "cloud_cover_delta": ccj - cc0,
                        "wind_gust_delta":   gj - g0,
                    }
        return None

    def _detect_storm_front(self, slices: list[dict]) -> tuple[float, dict] | None:
        """Forecast peak wind gusts > 60 km/h in next 60 min AND
        cloud_cover > 70 in the same window."""
        peak_g = 0.0; peak_slot: dict | None = None
        for s in slices:
            dt = s.get("_dt")
            if not dt:
                continue
            delta = (dt - datetime.now()).total_seconds() / 60.0
            if delta < 0 or delta > 60:
                continue
            g = s.get("wind_gusts_10m"); cc = s.get("cloud_cover")
            if g is None or cc is None:
                continue
            if float(g) > peak_g and float(cc) > 70.0:
                peak_g = float(g); peak_slot = s
        if peak_slot is None or peak_g < 60.0:
            return None
        score = min(1.0, peak_g / 120.0)
        return score, _safe_subset(peak_slot, [
            "time", "wind_gusts_10m", "cloud_cover", "precipitation",
            "lightning_potential",
        ])

    def _run_event_tl_capture(self, cam_id: str, trigger: str, score: float,
                              api_now: dict, fc_snapshot: dict,
                              window_min: int, interval_s: int, fps: int):
        rt = self.runtimes.get(cam_id)
        if rt is None or not hasattr(rt, "snapshot_jpeg"):
            log.warning("[Weather-TL] cam %s nicht verfügbar — capture abgebrochen", cam_id)
            return
        cam_name = self._cam_name(cam_id)
        out_dir = self._sightings_dir() / cam_id / "event_timelapse"
        out_dir.mkdir(parents=True, exist_ok=True)
        ts_label = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        stem = f"{ts_label}_{trigger}"
        mp4_path = out_dir / f"{stem}.mp4"
        thumb_path = out_dir / f"{stem}.jpg"
        frames_dir = out_dir / f".scratch_{stem}"
        frames_dir.mkdir(parents=True, exist_ok=True)
        end_at = datetime.now() + timedelta(minutes=window_min)
        n_written = 0
        i = 0
        while datetime.now() < end_at:
            jpg = rt.snapshot_jpeg(quality=82) if hasattr(rt, "snapshot_jpeg") else None
            if jpg:
                try:
                    (frames_dir / f"{i:05d}.jpg").write_bytes(jpg)
                    n_written += 1
                except Exception:
                    pass
            i += 1
            slept = 0.0
            while slept < interval_s and datetime.now() < end_at:
                time.sleep(0.5)
                slept += 0.5
        log.info("[Weather-TL] Capture done: %s %s · %d Frames", cam_name, trigger, n_written)
        if n_written < fps * 2:
            log.warning("[Weather-TL] Zu wenige Frames (%d) — Encode übersprungen", n_written)
            self._cleanup_sun_scratch(frames_dir)
            return
        try:
            from .timelapse import TimelapseBuilder
            tb = TimelapseBuilder(self._sightings_dir().parent.parent)
            images = sorted(frames_dir.glob("*.jpg"))
            target_seconds = max(15, min(45, n_written // fps))
            written = tb._write_video(images, mp4_path, target_seconds, fps)
            if not written or not mp4_path.exists():
                log.warning("[Weather-TL] Encode failed: %s %s", cam_name, trigger)
                self._cleanup_sun_scratch(frames_dir)
                return
        except Exception as e:
            log.warning("[Weather-TL] Encode crash %s %s: %s", cam_name, trigger, e)
            self._cleanup_sun_scratch(frames_dir)
            return
        try:
            mid = images[len(images) // 2]
            thumb_path.write_bytes(mid.read_bytes())
        except Exception:
            pass
        manifest = {
            "id":            f"{cam_id}__{trigger}__{stem}",
            "cam_id":        cam_id,
            "cam_name":      cam_name,
            "event_type":    "event_timelapse",
            "trigger":       trigger,
            "started_at":    datetime.now().isoformat(timespec="seconds"),
            "score":         round(float(score), 3),
            "severity":      round(float(score), 3),
            "window_min":    window_min,
            "interval_s":    interval_s,
            "fps":           fps,
            "api_snapshot":  _safe_subset(api_now, [
                "time", "precipitation", "snowfall", "lightning_potential",
                "visibility", "wind_gusts_10m", "cloud_cover", "weather_code",
            ]),
            "api_forecast":  fc_snapshot,
            "clip_path":     f"weather/{cam_id}/event_timelapse/{mp4_path.name}",
            "thumb_path":    f"weather/{cam_id}/event_timelapse/{thumb_path.name}",
            "duration_s":    max(1, len(images) // fps),
            "width": 0, "height": 0,
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
        log.info("[Weather-TL] Manifest geschrieben: %s · score=%.2f", manifest["id"], score)
        self._cleanup_sun_scratch(frames_dir)
        # Optional Telegram push reuses the existing weather pipeline. The
        # event_type for push gating is the trigger name (matches the
        # WEATHER_TYPES map key on the frontend AND the per-event toggle in
        # the push.weather.events block once users add it).
        push_manifest = dict(manifest); push_manifest["event_type"] = trigger
        self._maybe_push_telegram(push_manifest, mp4_path)

    def sun_times_today(self) -> dict:
        """Used by the /api/weather/sun-times endpoint to power the
        Settings → Wetter live preview."""
        out = {"location_set": False, "sunrise": None, "sunset": None,
               "cameras": []}
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            return out
        out["location_set"] = True
        sr = self.sun_event_today("sunrise")
        ss = self.sun_event_today("sunset")
        out["sunrise"] = sr.isoformat(timespec="minutes") if sr else None
        out["sunset"]  = ss.isoformat(timespec="minutes") if ss else None
        for cam in self._cfg_cameras():
            cw = cam.get("weather") or {}
            stl = cw.get("sun_timelapse") or {}
            entry = {"id": cam.get("id"), "name": cam.get("name"),
                     "weather_enabled": bool(cw.get("enabled")),
                     "sunrise": dict(stl.get("sunrise") or {}),
                     "sunset":  dict(stl.get("sunset")  or {})}
            for phase, sun_dt in (("sunrise", sr), ("sunset", ss)):
                p = entry[phase]
                if not p.get("enabled") or sun_dt is None:
                    p["window_start"] = p["window_end"] = None
                    continue
                w = int(p.get("window_min", 30) or 30) // 2
                p["window_start"] = (sun_dt - timedelta(minutes=w)).strftime("%H:%M")
                p["window_end"]   = (sun_dt + timedelta(minutes=w)).strftime("%H:%M")
                p["sun_event"]    = sun_dt.strftime("%H:%M")
            out["cameras"].append(entry)
        return out


def _is_quiet_now(quiet_hours: dict) -> bool:
    """Lightweight clone of telegram_helpers.is_quiet_now to keep this module
    free of a cross-import. Empty config → never quiet."""
    if not quiet_hours:
        return False
    def _p(s):
        try:
            h, m = (s or "").split(":", 1)
            return int(h) * 60 + int(m)
        except Exception:
            return 0
    s_min = _p(quiet_hours.get("start"))
    e_min = _p(quiet_hours.get("end"))
    if s_min == e_min:
        return False
    now = datetime.now()
    cur = now.hour * 60 + now.minute
    if s_min < e_min:
        return s_min <= cur < e_min
    return cur >= s_min or cur < e_min


def _safe_subset(d: dict, keys: list[str]) -> dict:
    if not isinstance(d, dict):
        return {}
    return {k: d.get(k) for k in keys if k in d}

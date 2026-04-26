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
                if event_type and evt_dir.name != event_type:
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
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

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

    @staticmethod
    def _pick_recap_clips(cands: list[dict], per_type_max: int = 3, total_cap: int = 12) -> list[dict]:
        # Group by event_type, take top `per_type_max` by score per group.
        by_type: dict[str, list[dict]] = {}
        for m in cands:
            by_type.setdefault(m.get("event_type", "?"), []).append(m)
        picked = []
        for evt, items in by_type.items():
            items.sort(key=lambda m: float(m.get("score") or 0.0), reverse=True)
            picked.extend(items[:per_type_max])
        # Chronological order so the reel walks the season.
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

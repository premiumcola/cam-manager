from __future__ import annotations
import cv2
import time
import threading
import logging
import json as _json_mod
from collections import deque
from datetime import datetime
from pathlib import Path
import requests
import numpy as np
from .detectors import CoralObjectDetector, BirdSpeciesClassifier, draw_detections
from .event_logic import is_in_schedule, choose_alarm_level

# Species name → achievement ID mapping (German species names → normalised IDs)
_SPECIES_TO_ACH_ID = {
    "blaumeise": "blaumeise",
    "kohlmeise": "kohlmeise",
    "rotkehlchen": "rotkehlchen",
    "buchfink": "buchfink",
    "amsel": "amsel",
    "hausspatz": "hausspatz",
    "grünfink": "gruenfink",
    "gruenfink": "gruenfink",
    "stieglitz": "stieglitz",
    "kleiber": "kleiber",
    "buntspecht": "buntspecht",
    "eichelhäher": "eichelhaher",
    "eichelhaher": "eichelhaher",
    "elster": "elster",
    "rabenkrähe": "rabenkraehe",
    "rabenkraehe": "rabenkraehe",
    "mäusebussard": "maeusebussard",
    "maeusebussard": "maeusebussard",
    "turmfalke": "turmfalke",
    "eichhörnchen": "eichhoernchen",
    "eichhoernchen": "eichhoernchen",
    "igel": "igel",
    "feldhase": "feldhase",
    "reh": "reh",
    "fuchs": "fuchs",
}

log = logging.getLogger(__name__)
log_tl = logging.getLogger(__name__ + ".timelapse")   # timelapse-specific logs
log_cam = logging.getLogger(__name__ + ".camera")     # connection/stream logs

_PROFILES = ("daily", "weekly", "monthly", "custom")
_PROFILE_PERIOD_DEFAULTS = {"daily": 86400, "weekly": 604800, "monthly": 2592000, "custom": 600}


class CameraRuntime:
    def __init__(self, camera_id: str, config_getter, global_cfg: dict, store, notifier, mqtt=None, cat_registry=None, person_registry=None):
        self.camera_id = camera_id
        self.config_getter = config_getter
        self.global_cfg = global_cfg
        self.store = store
        self.notifier = notifier
        self.mqtt = mqtt
        self.cat_registry = cat_registry
        self.person_registry = person_registry
        # ── Shared frame buffers (all protected by self.lock) ────────────────
        self.frame = None           # latest raw frame from main stream (main loop only writes)
        self.preview = None         # latest annotated frame (main loop only writes)
        self._preview_frame = None  # latest clean sub-stream frame (preview loop only writes)
        # ── Threading ────────────────────────────────────────────────────────
        self.running = False
        self.thread = None
        self.lock = threading.Lock()
        self._preview_cap_lock = threading.Lock()  # guards preview_cap handle exclusively
        # ── Connection state (main loop only) ───────────────────────────────
        self.last_event_at = datetime.min
        self.last_error = None
        self.event_counter_today = 0
        self.capture = None         # main RTSP capture — ONLY accessed by _loop
        self.preview_cap = None     # sub-stream capture — ONLY accessed by _preview_loop
        self.connect_time = None
        self.prev_gray = None
        self._error_streak = 0
        # Video recording state
        self._motion_frames: list = []
        self._motion_start_time: datetime | None = None
        self._last_motion_time: datetime | None = None
        proc = self.global_cfg.get("processing", {})
        self.detector = CoralObjectDetector(proc.get("detection", {}))
        self.bird_classifier = BirdSpeciesClassifier(proc.get("bird_species", {}))
        self._ach_lock = threading.Lock()
        self._ach_path = Path(self.global_cfg["storage"]["root"]) / "achievements.json"
        self._motion_confirm: deque = deque(maxlen=3)  # multi-frame confirmation
        self._tl_thread = None   # legacy single timelapse thread
        self._tl_threads: dict = {}  # profile_name → Thread

    @property
    def cfg(self):
        return self.config_getter(self.camera_id) or {"id": self.camera_id, "name": self.camera_id}

    def start(self):
        self.running = True
        # Clean up stale frame directories from previous runs before starting
        try:
            self._cleanup_stale_timelapse_frames()
        except Exception as _e:
            log.warning("[%s] stale timelapse frame cleanup error: %s", self.camera_id, _e)
        # Main ingest loop — sole reader of self.capture (RTSP / HTTP snapshot)
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()
        # Sub-stream preview loop — sole reader of self.preview_cap
        threading.Thread(target=self._preview_loop, daemon=True).start()
        # Per-profile timelapse threads — read from self.frame (no direct camera access)
        for prof_name in _PROFILES:
            t = threading.Thread(target=self._timelapse_profile_loop, args=(prof_name,), daemon=True)
            t.start()
            self._tl_threads[prof_name] = t
        # Legacy loop for cameras with old timelapse.enabled=True and no profiles configured
        tl = self.cfg.get("timelapse") or {}
        has_profiles = any((tl.get("profiles") or {}).get(p, {}).get("enabled") for p in _PROFILES)
        if tl.get("enabled") and not has_profiles:
            self._tl_thread = threading.Thread(target=self._timelapse_loop, daemon=True)
            self._tl_thread.start()

    def stop(self):
        self.running = False
        # Release main capture (only _loop touches this, so safe after running=False)
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:
                pass
            self.capture = None
        # Release sub-stream capture under its dedicated lock
        with self._preview_cap_lock:
            if self.preview_cap is not None:
                try:
                    self.preview_cap.release()
                except Exception:
                    pass
                self.preview_cap = None

    @staticmethod
    def _sub_stream_url(url: str) -> str | None:
        """Derive H.264 sub-stream URL from main-stream URL (Reolink pattern)."""
        if "/h264Preview_01_main" in url:
            return url.replace("/h264Preview_01_main", "/h264Preview_01_sub")
        return None

    def _open_capture(self):
        src = self.cfg.get("rtsp_url") or self.cfg.get("snapshot_url")
        if not src:
            raise RuntimeError(f"Kamera {self.camera_id}: keine Quelle gesetzt")
        if self.cfg.get("rtsp_url"):
            import os
            rtsp_url = self.cfg["rtsp_url"]

            # ── Main stream: motion detection + event snapshots ──────────────
            # TCP + software decode to prevent H.265 tile-split pink artifact.
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|hwaccel;none"
            cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            _RES_MAP = {"720p": (1280, 720), "1080p": (1920, 1080), "4k": (3840, 2160)}
            _res = self.cfg.get("resolution", "auto")
            if _res in _RES_MAP:
                _w, _h = _RES_MAP[_res]
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, _w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _h)
            if not cap.isOpened():
                raise RuntimeError(f"Kamera {self.camera_id}: RTSP konnte nicht geöffnet werden")
            self.capture = cap

            # ── Sub-stream: H.264 preview for dashboard (no pink) ────────────
            # Opened under _preview_cap_lock so _preview_loop sees a consistent handle.
            sub_url = self._sub_stream_url(rtsp_url)
            if sub_url:
                try:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
                    pcap = cv2.VideoCapture(sub_url, cv2.CAP_FFMPEG)
                    pcap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    with self._preview_cap_lock:
                        old = self.preview_cap
                        if pcap.isOpened():
                            self.preview_cap = pcap
                            log_cam.info("[%s] Sub-stream opened for preview: %s", self.camera_id, sub_url)
                        else:
                            pcap.release()
                            self.preview_cap = None
                    # Release old handle outside the lock to avoid blocking _preview_loop
                    if old is not None:
                        try:
                            old.release()
                        except Exception:
                            pass
                except Exception as e:
                    log_cam.warning("[%s] Sub-stream open failed: %s", self.camera_id, e)
                    with self._preview_cap_lock:
                        self.preview_cap = None

            self.connect_time = time.time()
            self.prev_gray = None  # reset motion state on reconnect
        else:
            self.capture = None

    def _preview_loop(self):
        """Dedicated thread: sole reader of self.preview_cap (sub-stream).
        Stores clean frames into self._preview_frame under self.lock.
        No other thread touches preview_cap or _preview_frame directly.
        """
        while self.running:
            with self._preview_cap_lock:
                cap = self.preview_cap
            if cap is None:
                time.sleep(0.5)
                continue
            try:
                with self._preview_cap_lock:
                    # Re-check under lock: cap may have been replaced during reconnect
                    cap = self.preview_cap
                    if cap is None or not cap.isOpened():
                        time.sleep(0.2)
                        continue
                    ok, frame = cap.read()
                if ok and frame is not None:
                    r = float(frame[:, :, 2].mean())
                    b = float(frame[:, :, 0].mean())
                    if not (r > b * 2.5 and r > 150):  # skip pink/artifact frames
                        with self.lock:
                            self._preview_frame = frame
            except Exception:
                time.sleep(0.2)

    def _grab_frame(self):
        if self.cfg.get("rtsp_url"):
            if self.capture is None or not self.capture.isOpened():
                self._open_capture()
            ok, frame = self.capture.read()
            if not ok or frame is None:
                raise RuntimeError(f"Kamera {self.camera_id}: Frame lesen fehlgeschlagen")
            # Reject H.265 pink/magenta corruption frames (hardware decode artifact)
            r = float(frame[:, :, 2].mean())
            b = float(frame[:, :, 0].mean())
            if r > b * 2.5 and r > 150:
                log.debug("[%s] Pink frame discarded (R=%.0f B=%.0f)", self.camera_id, r, b)
                ok2, frame2 = self.capture.read()
                if ok2 and frame2 is not None:
                    return frame2
                raise RuntimeError(f"Kamera {self.camera_id}: Frame nach Pink-Discard fehlgeschlagen")
            return frame
        url = self.cfg.get("snapshot_url")
        auth = None
        if self.cfg.get("username") and self.cfg.get("password"):
            auth = (self.cfg.get("username"), self.cfg.get("password"))
        resp = requests.get(url, auth=auth, timeout=8)
        resp.raise_for_status()
        frame = cv2.imdecode(np.frombuffer(resp.content, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError(f"Kamera {self.camera_id}: Snapshot lesen fehlgeschlagen")
        return frame

    def _is_frame_valid(self, frame) -> bool:
        """Reject corrupt, uniform-gray, white, pink-artifact, or near-black frames."""
        if frame is None or frame.size == 0:
            return False
        h, w = frame.shape[:2]
        if w < 64 or h < 48:
            return False
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mean_val = float(np.mean(gray))
        if mean_val < 8 or mean_val > 250:
            return False
        b_ch, g_ch, r_ch = cv2.split(frame)
        mean_r = float(r_ch.mean())
        mean_g = float(g_ch.mean())
        mean_b = float(b_ch.mean())
        # Reject H.265 pink/magenta corruption: dominant red channel + low green/blue
        if mean_r > 180 and mean_r > mean_g * 2:
            return False
        # Reject frames where >40% of pixels are R≈G≈B (uniform gray/white)
        uniform = np.sum(
            (np.abs(r_ch.astype(np.int16) - g_ch.astype(np.int16)) < 10) &
            (np.abs(r_ch.astype(np.int16) - b_ch.astype(np.int16)) < 10)
        )
        if uniform > 0.4 * h * w:
            return False
        return True

    @staticmethod
    def _has_corrupt_strip(frame, strip_height: int = 60) -> bool:
        """Detect H.264 corrupt bottom strip (pink/rainbow codec artifact)."""
        if frame is None or frame.shape[0] < strip_height * 2:
            return False
        strip = frame[-strip_height:, :, :]
        hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
        sat = hsv[:, :, 1].astype(np.float32)
        return float(sat.mean()) > 120 and float(sat.std()) > 60

    def _motion_detect(self, frame):
        """Returns (labels: list[str], motion_bbox: tuple|None).
        motion_bbox is (x, y, w, h) bounding rect of all motion combined.
        Applies per-camera exclusion masks and motion_sensitivity threshold."""
        proc = self.global_cfg.get("processing", {}).get("motion", {})
        if not proc.get("enabled", True):
            return [], None
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur_size = int(proc.get("blur_size", 15))
        if blur_size % 2 == 0:
            blur_size += 1
        gray = cv2.GaussianBlur(gray, (blur_size, blur_size), 0)
        # Reset if frame dimensions changed (e.g. bottom_crop_px config change)
        if self.prev_gray is not None and self.prev_gray.shape != gray.shape:
            self.prev_gray = None
        if self.prev_gray is None:
            self.prev_gray = gray
            return [], None
        diff = cv2.absdiff(self.prev_gray, gray)
        self.prev_gray = gray
        _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=2)
        # Apply camera exclusion masks: zero out masked regions
        cam_masks = self.cfg.get("masks", [])
        if cam_masks:
            h_f, w_f = thresh.shape[:2]
            excl = np.ones(thresh.shape, dtype=np.uint8) * 255
            for poly in cam_masks:
                if len(poly) >= 3:
                    pts = np.array([[int(p['x']), int(p['y'])] for p in poly], dtype=np.int32)
                    pts[:, 0] = np.clip(pts[:, 0], 0, w_f - 1)
                    pts[:, 1] = np.clip(pts[:, 1], 0, h_f - 1)
                    cv2.fillPoly(excl, [pts], 0)
            thresh = cv2.bitwise_and(thresh, excl)
        # Per-camera sensitivity → scales minimum contour area
        sensitivity = self.cfg.get("motion_sensitivity")
        if sensitivity is not None:
            sensitivity = float(sensitivity)
            h_f, w_f = frame.shape[:2]
            frame_area = h_f * w_f
            base_min_area = frame_area * 0.005
            min_area = int(base_min_area / max(0.1, sensitivity))
        else:
            min_area = int(proc.get("min_area", 3000))
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        big = [c for c in contours if cv2.contourArea(c) >= min_area]
        if not big:
            return [], None
        all_pts = np.concatenate(big)
        bbox = cv2.boundingRect(all_pts)
        return ["motion"], bbox

    def _crop(self, frame, bbox):
        x1, y1, x2, y2 = bbox
        return frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]

    def _group(self):
        groups = {g.get("id"): g for g in self.global_cfg.get("camera_groups", [])}
        return groups.get(self.cfg.get("group_id"), {})

    def _save_motion_video(self, start_time: datetime, frames: list) -> str | None:
        """Save buffered frames as MP4. Returns path or None."""
        if not frames:
            return None
        try:
            day_dir = Path(self.global_cfg["storage"]["root"]) / "events" / self.camera_id / start_time.strftime("%Y-%m-%d")
            day_dir.mkdir(parents=True, exist_ok=True)
            event_id = start_time.strftime("%Y%m%d-%H%M%S-vid")
            vid_path = day_dir / f"{event_id}.mp4"
            h, w = frames[0].shape[:2]
            interval = max(0.05, float(self.global_cfg.get("processing", {}).get("motion", {}).get("frame_interval_ms", 150)) / 1000.0)
            fps = max(5, min(25, int(1.0 / interval)))
            writer = cv2.VideoWriter(str(vid_path), cv2.VideoWriter_fourcc(*'mp4v'), fps, (w, h))
            for f in frames:
                writer.write(f)
            writer.release()
            log.info("[%s] Motion video saved: %s (%d frames, %.1fs)", self.camera_id, vid_path.name, len(frames), len(frames) / fps)
            return str(vid_path)
        except Exception as e:
            log.error("[%s] Video save error: %s", self.camera_id, e)
            return None

    def _try_unlock_achievement(self, species_name: str, species_label: str) -> bool:
        """Unlock achievement for a bird/animal species. Returns True if newly unlocked."""
        ach_id = _SPECIES_TO_ACH_ID.get(species_name.lower().strip())
        if not ach_id:
            return False
        try:
            with self._ach_lock:
                data: dict = {}
                if self._ach_path.exists():
                    try:
                        data = _json_mod.loads(self._ach_path.read_text(encoding="utf-8"))
                    except Exception:
                        data = {}
                if ach_id in data:
                    return False  # already unlocked
                data[ach_id] = {
                    "date": datetime.now().isoformat(timespec="seconds"),
                    "camera_id": self.camera_id,
                    "species": species_label,
                }
                self._ach_path.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            log.info("[%s] Achievement unlocked: %s (%s)", self.camera_id, ach_id, species_label)
            return True
        except Exception as e:
            log.warning("[%s] Achievement unlock failed: %s", self.camera_id, e)
            return False

    def _cleanup_stale_timelapse_frames(self):
        """Remove timelapse frame directories from previous runs on startup.
        - Previous-day directories: always deleted (stale)
        - Today's directories: all except the newest per profile are deleted
          (abandoned mid-run windows that never got encoded)
        Called once on startup before any encode thread begins."""
        import shutil
        storage_root = Path(self.global_cfg["storage"]["root"])
        today = datetime.now().strftime("%Y-%m-%d")
        tl_base = storage_root / "timelapse_frames" / self.camera_id
        if not tl_base.exists():
            return
        for profile_dir in tl_base.iterdir():
            if not profile_dir.is_dir():
                continue
            all_windows = sorted([d for d in profile_dir.iterdir() if d.is_dir()])
            for i, window_dir in enumerate(all_windows):
                dir_date = window_dir.name[:10]
                if dir_date < today:
                    # Previous day: always clean up
                    try:
                        shutil.rmtree(str(window_dir))
                        log_tl.info("[%s][media] cleaned stale frames (old day): %s/%s",
                                 self.camera_id, profile_dir.name, window_dir.name)
                    except Exception as e:
                        log_tl.warning("[%s][media] stale frame cleanup failed for %s: %s",
                                    self.camera_id, window_dir, e)
                elif dir_date == today and i < len(all_windows) - 1:
                    # Today but not the newest window → abandoned, safe to clean
                    try:
                        shutil.rmtree(str(window_dir))
                        log_tl.info("[%s][media] cleaned abandoned window (today): %s/%s",
                                 self.camera_id, profile_dir.name, window_dir.name)
                    except Exception as e:
                        log_tl.warning("[%s][media] abandoned cleanup failed for %s: %s",
                                    self.camera_id, window_dir, e)

    def _finalize_timelapse_window(self, profile_name: str, window_key: str,
                                   target_s: int, target_fps: int, period_s: int = 0):
        """Encode a completed timelapse window into a video, write a sidecar metadata JSON
        next to the video (NOT in EventStore), then delete the frame directory.
        Called from _timelapse_profile_loop only."""
        import shutil
        import json as _json
        from .timelapse import TimelapseBuilder as _TLB
        storage_root = Path(self.global_cfg["storage"]["root"])
        frames_dir = storage_root / "timelapse_frames" / self.camera_id / profile_name / window_key
        if not frames_dir.exists():
            log_tl.debug("[%s][%s] finalize: no frames dir for window %s",
                      self.camera_id, profile_name, window_key)
            return
        images = sorted(frames_dir.glob("*.jpg"))
        n = len(images)
        if n < 2:
            log_tl.debug("[%s][%s] finalize: only %d frames in window %s — skipping encode",
                      self.camera_id, profile_name, n, window_key)
            try:
                shutil.rmtree(str(frames_dir))
                log_tl.debug("[%s][%s] cleaned sparse dir: %s", self.camera_id, profile_name, frames_dir.name)
            except Exception as e:
                log_tl.warning("[%s][%s] cleanup failed: %s", self.camera_id, profile_name, e)
            return

        log_tl.info("[%s][timelapse] encoding window %s/%s (%d frames → %ds @ %dfps)",
                 self.camera_id, profile_name, window_key, n, target_s, target_fps)
        out_dir = storage_root / "timelapse" / self.camera_id
        out_dir.mkdir(parents=True, exist_ok=True)

        builder = _TLB(storage_root)
        stem = builder.make_output_name(window_key, profile_name, period_s, target_s)
        out_path = out_dir / f"{stem}.mp4"
        path = builder._write_video(images, out_path, target_s, target_fps)

        if path:
            size_mb = round(out_path.stat().st_size / 1024 / 1024, 2) if out_path.exists() else 0
            log_tl.info("[%s][timelapse] video created: %s (%.1f MB)", self.camera_id, out_path.name, size_mb)
            # Write sidecar JSON next to the video — NOT in EventStore
            try:
                meta = {
                    "event_id": f"tl_{stem}",
                    "camera_id": self.camera_id,
                    "type": "timelapse",
                    "profile": profile_name,
                    "window_key": window_key,
                    "period_s": period_s,
                    "target_s": target_s,
                    "frame_count": n,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "filename": out_path.name,
                    "relpath": f"timelapse/{self.camera_id}/{out_path.name}",
                    "size_mb": size_mb,
                }
                meta_path = out_dir / f"{stem}.json"
                meta_path.write_text(_json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                log_tl.debug("[%s][timelapse] sidecar JSON written: %s", self.camera_id, meta_path.name)
            except Exception as e:
                log_tl.warning("[%s][timelapse] sidecar write failed: %s", self.camera_id, e)
        else:
            log_tl.warning("[%s][timelapse] encode failed for window %s/%s", self.camera_id, profile_name, window_key)

        # Always clean up frames regardless of encode outcome
        try:
            shutil.rmtree(str(frames_dir))
            log_tl.info("[%s][timelapse] cleaned %d frames for window %s/%s",
                     self.camera_id, n, profile_name, window_key)
        except Exception as e:
            log_tl.warning("[%s][timelapse] frame cleanup failed: %s", self.camera_id, e)

    def _finalize_orphaned_windows(self, profile_name: str, current_key: str,
                                    target_s: int, target_fps: int, period_s: int):
        """Scan the profile's frame directory for any windows other than current_key and finalize them.
        Called after a new window is started so stale/abandoned windows get encoded and cleaned."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        profile_dir = storage_root / "timelapse_frames" / self.camera_id / profile_name
        if not profile_dir.exists():
            return
        for window_dir in sorted(profile_dir.iterdir()):
            if not window_dir.is_dir() or window_dir.name == current_key:
                continue
            log_tl.info("[%s][%s] orphaned window found: %s — finalizing",
                     self.camera_id, profile_name, window_dir.name)
            self._finalize_timelapse_window(profile_name, window_dir.name, target_s, target_fps, period_s)

    def _timelapse_loop(self):
        """Legacy single-profile timelapse. Reads latest frame from main loop — no direct camera access."""
        _period_map = {"day": 86400, "hour": 3600, "rolling_10min": 600}
        while self.running:
            tl = self.cfg.get("timelapse") or {}
            if not tl.get("enabled"):
                time.sleep(10)
                continue
            target_s = int(tl.get("daily_target_seconds", 60))
            target_fps = int(tl.get("fps", 30))
            period_s = _period_map.get(tl.get("period", "day"), 86400)
            total_frames = max(1, target_s * target_fps)
            interval_s = max(2.0, period_s / total_frames)
            # Read latest frame from shared buffer — no independent camera connection
            with self.lock:
                frame = self.frame.copy() if self.frame is not None else None
            if frame is not None:
                try:
                    tl_dir = (Path(self.global_cfg["storage"]["root"])
                              / "timelapse_frames" / self.camera_id
                              / datetime.now().strftime("%Y-%m-%d"))
                    tl_dir.mkdir(parents=True, exist_ok=True)
                    ts = datetime.now().strftime("%H%M%S")
                    out = tl_dir / f"{ts}.jpg"
                    cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
                    log_tl.debug("[%s] timelapse frame saved: %s (interval=%.0fs)", self.camera_id, out.name, interval_s)
                except Exception as e:
                    log_tl.debug("[%s] timelapse frame write error: %s", self.camera_id, e)
            deadline = time.time() + interval_s
            while self.running and time.time() < deadline:
                time.sleep(1)

    def _timelapse_profile_loop(self, profile_name: str):
        """Per-profile timelapse capture loop. Reads latest frame from main loop — no direct camera access.
        Tracks period windows: encodes, registers, and cleans up frames when each window ends.
        - custom: fixed-duration rolling windows (period_seconds long each)
        - daily/weekly/monthly: one window per calendar day, encoded at day boundary
        """
        window_key: str | None = None
        window_start_t: float = 0.0

        while self.running:
            tl = self.cfg.get("timelapse") or {}
            prof = (tl.get("profiles") or {}).get(profile_name) or {}
            if not prof.get("enabled"):
                if window_key is not None:
                    log_tl.debug("[%s][%s] profile disabled — resetting window %s", self.camera_id, profile_name, window_key)
                window_key = None
                window_start_t = 0.0
                time.sleep(10)
                continue

            target_s = int(prof.get("target_seconds", 60))
            target_fps = int(tl.get("fps", 30))
            period_s = int(prof.get("period_seconds", _PROFILE_PERIOD_DEFAULTS.get(profile_name, 86400)))
            total_frames = max(1, target_s * target_fps)
            interval_s = max(2.0, period_s / total_frames)

            now = datetime.now()
            now_t = time.time()

            # ── Determine current window key and handle period boundaries ─────
            if profile_name == "custom":
                if window_key is None:
                    # Start first window
                    window_start_t = now_t
                    window_key = now.strftime("%Y-%m-%d_%H%M%S")
                    log_tl.info("[%s][timelapse] custom window started: %s (period=%ds interval=%.0fs)",
                             self.camera_id, window_key, period_s, interval_s)
                elif now_t - window_start_t >= period_s:
                    # Period elapsed — finalize current window and start fresh
                    old_key = window_key
                    self._finalize_timelapse_window(profile_name, old_key, target_s, target_fps, period_s)
                    window_start_t = now_t
                    window_key = now.strftime("%Y-%m-%d_%H%M%S")
                    log_tl.info("[%s][timelapse] custom new window: %s", self.camera_id, window_key)
                    # Scan for any other abandoned windows and clean them
                    self._finalize_orphaned_windows(profile_name, window_key, target_s, target_fps, period_s)
            else:
                # Calendar-based: one window per calendar day
                new_key = now.strftime("%Y-%m-%d")
                if window_key is not None and new_key != window_key:
                    # Day rolled over — finalize the completed day
                    old_key = window_key
                    self._finalize_timelapse_window(profile_name, old_key, target_s, target_fps, period_s)
                    log_tl.info("[%s][timelapse] %s day boundary: finalized %s, starting %s",
                             self.camera_id, profile_name, old_key, new_key)
                if window_key is None or new_key != window_key:
                    window_key = new_key
                    log_tl.info("[%s][timelapse] %s window: %s (period=%ds interval=%.0fs)",
                             self.camera_id, profile_name, window_key, period_s, interval_s)
                    # Scan for abandoned windows from prior days
                    self._finalize_orphaned_windows(profile_name, window_key, target_s, target_fps, period_s)

            # ── Capture frame into the current window directory ───────────────
            with self.lock:
                frame = self.frame.copy() if self.frame is not None else None
            if frame is not None and window_key is not None:
                try:
                    # Validate frame quality before saving — reject corrupted/blank frames
                    from .timelapse import TimelapseBuilder as _TLB_check
                    ok, reason = _TLB_check._is_valid_frame(frame)
                    if not ok:
                        log_tl.debug("[%s][%s] frame skipped at capture: %s",
                                  self.camera_id, profile_name, reason)
                    else:
                        tl_dir = (Path(self.global_cfg["storage"]["root"])
                                  / "timelapse_frames" / self.camera_id
                                  / profile_name / window_key)
                        tl_dir.mkdir(parents=True, exist_ok=True)
                        ts = now.strftime("%H%M%S_%f")[:10]
                        out = tl_dir / f"{ts}.jpg"
                        cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 72])
                        log_tl.debug("[%s][%s] frame saved: %s window=%s (%.0fs/frame)",
                                  self.camera_id, profile_name, out.name, window_key, interval_s)
                except Exception as e:
                    log_tl.debug("[%s][%s] frame write error: %s", self.camera_id, profile_name, e)

            deadline = time.time() + interval_s
            while self.running and time.time() < deadline:
                time.sleep(1)

    def _loop(self):
        if self.cfg.get("rtsp_url"):
            interval = max(0.05, float(self.cfg.get("frame_interval_ms") or self.global_cfg.get("processing", {}).get("motion", {}).get("frame_interval_ms", 150)) / 1000.0)
        else:
            interval = max(1.0, float(self.cfg.get("snapshot_interval_s") or 3))
        cooldown = int(self.global_cfg.get("processing", {}).get("event_cooldown_seconds", 25))
        while self.running:
            try:
                frame = self._grab_frame()
                # Always store raw frame so status → "active" and snapshots work
                with self.lock:
                    self.frame = frame
                if self._error_streak > 0:
                    log_cam.info("[%s] Stream wiederhergestellt nach %d Fehlern", self.camera_id, self._error_streak)
                self.last_error = None
                self._error_streak = 0
                # Apply bottom crop before processing (removes corrupt H.264 bottom strip)
                bottom_crop_px = int(self.cfg.get("bottom_crop_px", 0))
                if bottom_crop_px > 0 and frame.shape[0] > bottom_crop_px:
                    proc_frame = frame[:-bottom_crop_px, :, :]
                else:
                    proc_frame = frame
                # Skip frames with corrupt bottom strip (high-saturation codec artifact)
                if self._has_corrupt_strip(proc_frame):
                    log.debug("[%s] corrupt strip detected, frame skipped", self.camera_id)
                    time.sleep(interval)
                    continue
                # Quality gate: skip corrupt/uniform/artifact frames for events only
                if not self._is_frame_valid(proc_frame):
                    time.sleep(interval)
                    continue
                # Stream warmup: ignore first 3 s after connect to skip transition frames
                if self.connect_time and time.time() - self.connect_time < 3.0:
                    time.sleep(interval)
                    continue
                motion_labels, motion_bbox = self._motion_detect(proc_frame)
                # Multi-frame confirmation: only trigger on motion in ≥2 of last 3 frames
                self._motion_confirm.append(1 if motion_labels else 0)
                motion_confirmed = sum(self._motion_confirm) >= 2
                effective_motion = motion_labels if motion_confirmed else []
                effective_bbox = motion_bbox if motion_confirmed else None
                detections = self.detector.detect_frame(proc_frame)
                allowed = set(self.cfg.get("object_filter") or [])
                if allowed:
                    detections = [d for d in detections if d.label in allowed]
                labels = effective_motion + [d.label for d in detections]
                if self.bird_classifier.available:
                    for d in detections:
                        if d.label == "bird":
                            crop = self._crop(proc_frame, d.bbox)
                            species, _ = self.bird_classifier.classify_crop(crop)
                            if species:
                                d.species = species
                if self.cat_registry:
                    for d in detections:
                        if d.label == "cat":
                            crop = self._crop(proc_frame, d.bbox)
                            m = self.cat_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                if self.person_registry:
                    for d in detections:
                        if d.label == "person":
                            crop = self._crop(proc_frame, d.bbox)
                            m = self.person_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                drawn = draw_detections(proc_frame, detections)
                with self.lock:
                    self.preview = drawn
                # ── Video recording: buffer frames during motion ──────────────
                has_motion_now = bool(labels)
                now_t = datetime.now()
                if has_motion_now:
                    if self._motion_start_time is None:
                        self._motion_start_time = now_t
                    self._last_motion_time = now_t
                    if self.cfg.get("rtsp_url"):
                        dur_so_far = (now_t - self._motion_start_time).total_seconds()
                        if dur_so_far <= 30:
                            self._motion_frames.append(proc_frame.copy())
                        elif len(self._motion_frames) >= 5:
                            # > 30s segment – save and start fresh
                            self._save_motion_video(self._motion_start_time, self._motion_frames)
                            self._motion_frames = [proc_frame.copy()]
                            self._motion_start_time = now_t
                elif self._last_motion_time is not None:
                    since_last = (now_t - self._last_motion_time).total_seconds()
                    if since_last >= 30:
                        motion_total = (self._last_motion_time - self._motion_start_time).total_seconds() if self._motion_start_time else 0
                        if motion_total >= 10 and len(self._motion_frames) >= 5:
                            self._save_motion_video(self._motion_start_time, self._motion_frames)
                        self._motion_frames = []
                        self._motion_start_time = None
                        self._last_motion_time = None

                # ── Event trigger: person bypasses cooldown ──────────────────
                has_person = "person" in labels
                elapsed = (datetime.now() - self.last_event_at).total_seconds()
                if labels and (has_person or elapsed >= cooldown):
                    self.last_event_at = datetime.now()
                    self.event_counter_today += 1
                    ts = datetime.now()
                    event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
                    day_dir = Path(self.global_cfg["storage"]["root"]) / "events" / self.camera_id / ts.strftime("%Y-%m-%d")
                    day_dir.mkdir(parents=True, exist_ok=True)
                    snap_path = day_dir / f"{event_id}.jpg"
                    # drawn is already based on proc_frame (bottom-cropped), so saved snapshot is clean
                    save_frame = drawn.copy()
                    # Draw green motion bounding box if motion was detected (coords match proc_frame)
                    if effective_bbox is not None:
                        mx, my, mw, mh = effective_bbox
                        cv2.rectangle(save_frame, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2)
                    h_px, w_px = save_frame.shape[:2]
                    if w_px > 1280:
                        scale = 1280 / w_px
                        save_frame = cv2.resize(save_frame, (1280, int(h_px * scale)), interpolation=cv2.INTER_AREA)
                    cv2.imwrite(str(snap_path), save_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                    rel = snap_path.relative_to(Path(self.global_cfg["storage"]["root"]))
                    public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
                    snapshot_url = f"{public_base}/media/{rel.as_posix()}" if public_base else None
                    top_det = max(detections, key=lambda d: d.score, default=None)
                    cat_match = next((d.identity for d in detections if d.label == "cat" and d.identity), None)
                    person_match = next((d.identity for d in detections if d.label == "person" and d.identity), None)
                    bird_species = next((d.species for d in detections if d.label == "bird" and d.species), None)
                    group = self._group()
                    after_hours = is_in_schedule(self.cfg.get("schedule") or group.get("schedule") or {})
                    whitelisted = bool(person_match and (person_match in (self.cfg.get("whitelist_names") or [])))
                    if self.person_registry and person_match:
                        p = self.person_registry.get_profile(person_match) or {}
                        whitelisted = whitelisted or bool(p.get("whitelisted"))
                    level, notify = choose_alarm_level(group, list(sorted(set(labels))), after_hours, whitelisted)
                    event = {
                        "event_id": event_id,
                        "camera_id": self.camera_id,
                        "camera_name": self.cfg.get("name", self.camera_id),
                        "group_id": self.cfg.get("group_id"),
                        "camera_role": self.cfg.get("role"),
                        "armed": bool(self.cfg.get("armed", True)),
                        "after_hours": after_hours,
                        "alarm_level": level,
                        "time": ts.isoformat(timespec="seconds"),
                        "labels": sorted(set(labels)),
                        "top_label": top_det.label if top_det else labels[0],
                        "bird_species": bird_species,
                        "cat_name": cat_match,
                        "person_name": person_match,
                        "whitelisted": whitelisted,
                        "detections": [d.to_dict() for d in detections],
                        "snapshot_url": snapshot_url,
                        "snapshot_relpath": rel.as_posix(),
                        "video_url": None,
                    }
                    self.store.add_event(self.camera_id, event)
                    if self.mqtt and self.cfg.get("mqtt_enabled", True):
                        self.mqtt.publish(f"events/{self.camera_id}", event)
                    # Apply group-specific telegram rules
                    _send_tg = notify and self.cfg.get("telegram_enabled", True)
                    if _send_tg:
                        tg_cfg = self.global_cfg.get("telegram", {})
                        tg_groups = tg_cfg.get("groups", {})
                        g_id = self.cfg.get("group_id")
                        if g_id and g_id in tg_groups:
                            gr = tg_groups[g_id]
                            if not gr.get("enabled", True):
                                _send_tg = False
                            elif gr.get("objects") and not any(lbl in set(gr["objects"]) for lbl in labels):
                                _send_tg = False
                            elif gr.get("from") and gr.get("to"):
                                if not is_in_schedule({"enabled": True, "start": gr["from"], "end": gr["to"]}):
                                    _send_tg = False
                    # Achievement unlock for first-time species detection
                    if bird_species:
                        newly_unlocked = self._try_unlock_achievement(bird_species, bird_species)
                        if newly_unlocked and self.notifier:
                            try:
                                ach_msg = f"🏆 Neue Trophäe freigeschaltet: {bird_species}!\n📷 Kamera: {self.cfg.get('name', self.camera_id)}"
                                import threading as _thr
                                _thr.Thread(target=self.notifier.send_alert_sync, kwargs={"caption": ach_msg}, daemon=True).start()
                            except Exception:
                                pass
                    if _send_tg:
                        top_bird_score = next((d.score for d in detections if d.label == "bird" and d.species), None)
                        if bird_species:
                            # Spezielles Vogel-Format
                            score_pct = f"{top_bird_score * 100:.0f}" if top_bird_score else "?"
                            caption = (
                                f"🐦 Vogel erkannt: {bird_species}\n"
                                f"📷 Kamera: {self.cfg.get('name', self.camera_id)}\n"
                                f"⏰ {event['time']}\n"
                                f"📊 Sicherheit: {score_pct}%"
                            )
                        else:
                            details = []
                            if cat_match:
                                details.append(f"🐈 {cat_match}")
                            if person_match:
                                details.append(f"🧍 {person_match}{' (Whitelist)' if whitelisted else ''}")
                            caption = f"{'🚨' if level == 'alarm' else 'ℹ️'} {', '.join(sorted(set(labels)))}\n📷 {self.cfg.get('name', self.camera_id)}\n📍 {self.cfg.get('location', '')}\n🕒 {event['time']}"
                            if details:
                                caption += "\n" + " · ".join(details)
                        with open(snap_path, "rb") as fh:
                            self.notifier.send_alert_sync(caption=caption, jpeg_bytes=fh.read(), snapshot_url=snapshot_url, dashboard_url=public_base, camera_id=self.camera_id)
                self.last_error = None
            except Exception as e:
                self._error_streak += 1
                self.last_error = str(e)
                if self._error_streak == 1:
                    log.debug("[%s] Frame lesen fehlgeschlagen: %s", self.camera_id, e)
                elif self._error_streak == 5:
                    log_cam.warning("[%s] Verbindungsprobleme – %d aufeinanderfolgende Fehler: %s", self.camera_id, self._error_streak, e)
                elif self._error_streak == 15 or (self._error_streak > 15 and self._error_streak % 30 == 0):
                    log.error("[%s] Stream verloren (streak=%d): %s", self.camera_id, self._error_streak, e)
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                time.sleep(5.0)
            time.sleep(interval)

    def snapshot_jpeg(self, quality=88):
        """Thread-safe snapshot encoder. Reads only from shared frame buffers.
        Priority: sub-stream clean frame → annotated main-stream frame → raw main-stream frame.
        All three live in self.lock — safe to call from multiple HTTP threads concurrently."""
        with self.lock:
            frame = self._preview_frame if self._preview_frame is not None else (
                self.preview if self.preview is not None else self.frame
            )
            if frame is None:
                return None
            frame = frame.copy()  # copy under lock so encoding happens outside
        ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes() if ok else None

    def status(self):
        cfg = self.cfg
        return {
            "id": self.camera_id,
            "name": cfg.get("name", self.camera_id),
            "location": cfg.get("location", ""),
            "enabled": cfg.get("enabled", True),
            "group_id": cfg.get("group_id"),
            "role": cfg.get("role"),
            "armed": cfg.get("armed", True),
            "source": "rtsp" if cfg.get("rtsp_url") else "snapshot",
            "last_error": self.last_error,
            "status": "error" if self._error_streak >= 10 else ("active" if self.frame is not None else "starting"),
            "today_events": self.event_counter_today,
            "timelapse_enabled": bool((cfg.get("timelapse") or {}).get("enabled")),
            "detection_mode": getattr(self.detector, "mode", "motion_only"),
            "coral_available": getattr(self.detector, "available", False),
            "coral_reason": getattr(self.detector, "reason", "disabled"),
            "bird_species_available": getattr(self.bird_classifier, "available", False),
            "bird_species_mode": getattr(self.bird_classifier, "mode", "none"),
        }

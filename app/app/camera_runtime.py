from __future__ import annotations
import cv2
import time
import threading
import logging
import json as _json_mod
import shutil as _shutil
import subprocess as _subprocess
from collections import deque
from datetime import datetime
from pathlib import Path
import requests
import numpy as np
from .detectors import CoralObjectDetector, BirdSpeciesClassifier, draw_detections
from .event_logic import is_in_schedule, choose_alarm_level

# Does this container have an ffmpeg binary? If so, motion recording uses the
# fast stream-copy path (direct RTSP → mp4, no CPU re-encode). Otherwise we
# fall back to the OpenCV frame-buffer approach, which loses timestamps.
_FFMPEG_AVAILABLE = _shutil.which('ffmpeg') is not None
if not _FFMPEG_AVAILABLE:
    logging.getLogger(__name__).warning(
        "ffmpeg binary not found — motion recording falls back to OpenCV frame buffer "
        "(playback speed may be incorrect)"
    )

# Species name → achievement ID mapping (German species names → normalised IDs)
# Birds: LBV Stunde der Gartenvögel 2025 Bayern — Top 20.
_SPECIES_TO_ACH_ID = {
    # Vögel (Top 20 Bayern)
    "haussperling": "haussperling",
    "amsel": "amsel",
    "kohlmeise": "kohlmeise",
    "star": "star",
    "feldsperling": "feldsperling",
    "blaumeise": "blaumeise",
    "ringeltaube": "ringeltaube",
    "mauersegler": "mauersegler",
    "elster": "elster",
    "mehlschwalbe": "mehlschwalbe",
    "buchfink": "buchfink",
    "rotkehlchen": "rotkehlchen",
    "grünfink": "gruenfink",
    "gruenfink": "gruenfink",
    "rabenkrähe": "rabenkraehe",
    "rabenkraehe": "rabenkraehe",
    "hausrotschwanz": "hausrotschwanz",
    "mönchsgrasmücke": "moenchsgrasmucke",
    "moenchsgrasmucke": "moenchsgrasmucke",
    "stieglitz": "stieglitz",
    "buntspecht": "buntspecht",
    "kleiber": "kleiber",
    "eichelhäher": "eichelhaher",
    "eichelhaher": "eichelhaher",
    # Säugetiere
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
        # Video recording state (ring pre-buffer + session tracking)
        self._pre_buffer: deque = deque(maxlen=300)  # (frame, epoch_float) pairs; time-filtered to 3s on use
        self._recording: bool = False
        self._rec_frames: list = []                  # OpenCV fallback only
        self._rec_start_time: datetime | None = None
        self._last_motion_ts: datetime | None = None  # last frame with confirmed motion
        self._rec_event_meta: dict | None = None      # metadata captured at session start
        self._rec_corrupt_frames: int = 0             # invalid frames rejected during current clip
        # ffmpeg stream-copy recording state (preferred path)
        self._ffmpeg_proc = None                      # running Popen, or None
        self._ffmpeg_out_path: Path | None = None     # raw stream-copy file
        self._ffmpeg_start_time: datetime | None = None
        self._rec_event_id: str | None = None         # event_id of the currently-recording clip
        self._prev_good_frame = None                  # last accepted frame (MAD reference)
        # Main-stream FPS measurement (rolling 5s window)
        self._main_fps: float = 0.0
        self._main_fps_frames: int = 0
        self._main_fps_window_start: float = time.time()
        proc = self.global_cfg.get("processing", {})
        self.detector = CoralObjectDetector(proc.get("detection", {}))
        self.bird_classifier = BirdSpeciesClassifier(proc.get("bird_species", {}))
        self._ach_lock = threading.Lock()
        self._ach_path = Path(self.global_cfg["storage"]["root"]) / "achievements.json"
        self._motion_confirm: deque = deque(maxlen=3)  # multi-frame confirmation
        self._tl_thread = None   # legacy single timelapse thread
        self._tl_threads: dict = {}  # profile_name → Thread
        # ── Connection health / diagnostics ──────────────────────────────────
        self.frame_ts: float = 0.0          # epoch of last frame written to self.frame
        self._reconnect_count: int = 0      # how many times capture was reopened
        self._stale_incidents: int = 0      # how often timelapse saw a stale frame buffer
        self._stale_streak: int = 0         # consecutive stale capture intervals (reset on fresh frame)
        self._force_reconnect: bool = False  # timelapse sets True to request RTSP reopen from _loop
        # ── Preview stream metrics ────────────────────────────────────────────
        self._preview_fps: float = 0.0          # measured sub-stream FPS (rolling 5s window)
        self._preview_fps_frames: int = 0        # frame counter for FPS window
        self._preview_fps_window_start: float = time.time()
        self._preview_resolution: str = ""      # "WxH" of last received preview frame
        # ── Viewer tracking (MJPEG stream connections) ────────────────────────
        self._live_viewers: int = 0
        self._viewers_lock = threading.Lock()
        # ── Supervisor ───────────────────────────────────────────────────────
        self._supervisor_restarts: int = 0

    @property
    def cfg(self):
        return self.config_getter(self.camera_id) or {"id": self.camera_id, "name": self.camera_id}

    def add_viewer(self):
        """Increment live viewer count (called when MJPEG client connects)."""
        with self._viewers_lock:
            self._live_viewers += 1

    def remove_viewer(self):
        """Decrement live viewer count (called when MJPEG client disconnects)."""
        with self._viewers_lock:
            self._live_viewers = max(0, self._live_viewers - 1)

    def _supervised(self, target, name: str):
        """Run target in a restart loop with exponential backoff on crash.

        Exits cleanly when target() returns while self.running is False.
        Resets the backoff counter after 300 s of stable uptime so a
        camera that ran fine for a long time doesn't keep the high delay.
        """
        attempt = 0
        while self.running:
            t_start = time.time()
            try:
                target()
            except Exception as exc:
                if not self.running:
                    return
                elapsed = time.time() - t_start
                if elapsed >= 300:
                    attempt = 0
                wait = min(2 ** attempt, 60)
                self._supervisor_restarts += 1
                log.error(
                    "[%s][supervisor] Thread '%s' crashed: %s — restarting in %ds",
                    self.camera_id, name, exc, wait,
                )
                attempt += 1
                deadline = time.time() + wait
                while self.running and time.time() < deadline:
                    time.sleep(0.5)
            else:
                return

    def start(self):
        self.running = True
        # Clean up stale frame directories from previous runs before starting
        try:
            self._cleanup_stale_timelapse_frames()
        except Exception as _e:
            log.warning("[%s] stale timelapse frame cleanup error: %s", self.camera_id, _e)
        # Main ingest loop — sole reader of self.capture (RTSP / HTTP snapshot)
        self.thread = threading.Thread(
            target=self._supervised, args=(self._loop, "loop"), daemon=True,
        )
        self.thread.start()
        # Sub-stream preview loop — sole reader of self.preview_cap
        threading.Thread(
            target=self._supervised, args=(self._preview_loop, "preview_loop"), daemon=True,
        ).start()
        # Per-profile timelapse threads — read from self.frame (no direct camera access)
        for prof_name in _PROFILES:
            t = threading.Thread(
                target=self._supervised,
                args=(lambda pn=prof_name: self._timelapse_profile_loop(pn), f"timelapse_{prof_name}"),
                daemon=True,
            )
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
        """Derive H.264 sub-stream URL from main-stream URL.
        Handles both Reolink H.264 and H.265 main streams:
          - h264Preview_01_main → h264Preview_01_sub (RLC-810A, older firmware)
          - h265Preview_01_main → h264Preview_01_sub (CX810, newer firmware — H.265 on main, H.264 on sub)
        """
        if "/h264Preview_01_main" in url:
            return url.replace("/h264Preview_01_main", "/h264Preview_01_sub")
        if "/h265Preview_01_main" in url:
            # Newer Reolink cameras (CX810 etc.) use H.265 on main stream.
            # Sub-stream is always H.264 regardless of main-stream codec.
            return url.replace("/h265Preview_01_main", "/h264Preview_01_sub")
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
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000)
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
                        h, w = frame.shape[:2]
                        self._preview_resolution = f"{w}×{h}"
                        with self.lock:
                            self._preview_frame = frame
                        # Measure sub-stream FPS over a rolling 5s window
                        self._preview_fps_frames += 1
                        elapsed = time.time() - self._preview_fps_window_start
                        if elapsed >= 5.0:
                            self._preview_fps = round(self._preview_fps_frames / elapsed, 1)
                            self._preview_fps_frames = 0
                            self._preview_fps_window_start = time.time()
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
                for _ in range(3):
                    ok2, frame2 = self.capture.read()
                    if ok2 and frame2 is not None:
                        r2 = float(frame2[:, :, 2].mean())
                        b2 = float(frame2[:, :, 0].mean())
                        if not (r2 > b2 * 2.5 and r2 > 150):
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
        """Reject corrupt, uniform-gray, white, pink-artifact, or near-black frames.
        Also rejects frames with large solid-color quadrants (RTSP corruption pattern)
        and frames with JPEG block artifacts (abnormally uniform 8×8 blocks).
        False-positive analysis: cam-Werkstatt.rechts.oben fires heavily during cloud/sun
        transitions and whenever H.265 decode produces solid magenta quadrants — both
        pass the simple channel-mean test but fail quadrant-HSV and block-variance checks."""
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
        # Quadrant solid-color check: reject if any quadrant is >60% high-saturation
        # pink/magenta (H=135–165 in OpenCV's 0–179 scale, which maps 270–330°)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hh, hw = h // 2, w // 2
        for qy, qx in [(0, 0), (0, hw), (hh, 0), (hh, hw)]:
            q = hsv[qy:qy + hh, qx:qx + hw]
            q_h, q_s, q_v = q[:, :, 0], q[:, :, 1], q[:, :, 2]
            vivid = (q_s > 178) & (q_v > 127)
            pink = vivid & (q_h >= 135) & (q_h <= 165)
            qpix = hh * hw
            if qpix > 0 and float(np.sum(pink)) / qpix > 0.60:
                log.debug("[%s] Corrupt quadrant (pink/magenta >60%%), frame rejected", self.camera_id)
                return False
        # JPEG block-artifact check: if >50% of sampled 8×8 blocks have near-zero
        # variance the image is a solid-fill decode artifact, not a real scene.
        bs = 8
        low_var = 0
        total_blocks = 0
        for by in range(0, h - bs, bs * 3):
            for bx in range(0, w - bs, bs * 3):
                blk = gray[by:by + bs, bx:bx + bs]
                if float(np.var(blk)) < 2.0:
                    low_var += 1
                total_blocks += 1
        if total_blocks > 0 and low_var > total_blocks * 0.50:
            log.debug("[%s] Block-artifact frame rejected (%d/%d uniform blocks)",
                      self.camera_id, low_var, total_blocks)
            return False
        return True

    def _is_frame_too_different(self, frame, prev_frame) -> bool:
        """Return True if mean absolute difference vs previous frame exceeds 60 (glitch/corrupt)."""
        if prev_frame is None or frame.shape != prev_frame.shape:
            return False
        mad = float(np.mean(np.abs(frame.astype(np.int16) - prev_frame.astype(np.int16))))
        return mad > 60

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
        Applies per-camera exclusion masks and motion_sensitivity threshold.
        Brightness-normalises both frames before diff to suppress cloud/sun transitions."""
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
        # Brightness normalisation: scale current frame to match previous mean so that
        # gradual global illumination changes (clouds, day/night) don't produce diff.
        mean_prev = float(np.mean(self.prev_gray))
        mean_curr = float(np.mean(gray))
        if mean_curr > 1:
            scale = mean_prev / mean_curr
            if 0.5 < scale < 2.0:  # only correct moderate shifts; ignore extreme jumps
                gray = np.clip(gray.astype(np.float32) * scale, 0, 255).astype(np.uint8)
        diff = cv2.absdiff(self.prev_gray, gray)
        self.prev_gray = gray
        _, thresh = cv2.threshold(diff, 28, 255, cv2.THRESH_BINARY)
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
        # Minimum changed-pixel count: a global brightness shift produces many small
        # changed pixels but no large contour — reject if total changed area < 1% of frame.
        h_f2, w_f2 = thresh.shape[:2]
        if int(np.sum(thresh > 0)) < int(h_f2 * w_f2 * 0.01):
            return [], None
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

    def _build_event_meta(self, ts: datetime, labels: list, detections: list,
                          drawn_frame, effective_bbox) -> dict:
        """Snapshot of all event metadata at the moment motion recording starts."""
        event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
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
        # Encode thumbnail for Telegram (in memory, never written as JPEG to disk)
        thumb_bytes = None
        if drawn_frame is not None:
            save_thumb = drawn_frame.copy()
            if effective_bbox is not None:
                mx, my, mw, mh = effective_bbox
                cv2.rectangle(save_thumb, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2)
            h_px, w_px = save_thumb.shape[:2]
            if w_px > 1280:
                scale = 1280 / w_px
                save_thumb = cv2.resize(save_thumb, (1280, int(h_px * scale)), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode('.jpg', save_thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                thumb_bytes = buf.tobytes()
        return {
            "event_id": event_id,
            "time": ts,
            "labels": sorted(set(labels)),
            "top_label": top_det.label if top_det else labels[0],
            "detections": [d.to_dict() for d in detections],
            "bird_species": bird_species,
            "cat_name": cat_match,
            "person_name": person_match,
            "whitelisted": whitelisted,
            "alarm_level": level,
            "after_hours": after_hours,
            "notify": notify,
            "group": group,
            "thumb_bytes": thumb_bytes,
        }

    def _write_clip_ffmpeg(self, frames, fps, out_path) -> bool:
        """Encode raw BGR frames to H.264/mp4 via ffmpeg pipe.

        Browsers cannot decode the mp4v codec cv2.VideoWriter produces.
        Piping raw BGR into libx264 yields a faststart-optimised mp4 that plays
        natively in every modern browser. Returns False on any failure so the
        caller can fall back to mp4v.
        """
        import subprocess as _sp
        if not frames:
            return False
        h, w = frames[0].shape[:2]
        fps_c = max(5.0, min(30.0, float(fps)))
        cmd = [
            'ffmpeg', '-y',
            '-f', 'rawvideo', '-vcodec', 'rawvideo',
            '-pix_fmt', 'bgr24', '-s', f'{w}x{h}', '-r', str(fps_c),
            '-i', 'pipe:0',
            '-vcodec', 'libx264', '-preset', 'fast', '-crf', '23',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart',
            str(out_path)
        ]
        try:
            proc = _sp.Popen(cmd, stdin=_sp.PIPE,
                             stdout=_sp.PIPE, stderr=_sp.PIPE)
            last_good = frames[0]
            for f in frames:
                if self._is_frame_valid(f) and \
                   not self._is_frame_too_different(f, last_good):
                    proc.stdin.write(f.tobytes())
                    last_good = f
                else:
                    proc.stdin.write(last_good.tobytes())
            proc.stdin.close()
            _, stderr = proc.communicate(timeout=120)
            if proc.returncode != 0:
                log.error('[%s] ffmpeg encode failed: %s',
                          self.camera_id,
                          stderr.decode(errors='replace')[-800:])
                return False
            return True
        except FileNotFoundError:
            log.warning('[%s] ffmpeg not found — falling back to mp4v',
                        self.camera_id)
            return False
        except Exception as e:
            log.error('[%s] ffmpeg pipe error: %s', self.camera_id, e)
            return False

    def _write_recording_event_stub(self, event_id: str, meta: dict,
                                    start_time: datetime, status: str = "recording"):
        """Write the event JSON for a clip whose encode is still in flight.
        Video fields are null; the frontend shows a 'recording'/'processing' state."""
        event = {
            "event_id": event_id,
            "camera_id": self.camera_id,
            "camera_name": self.cfg.get("name", self.camera_id),
            "group_id": self.cfg.get("group_id"),
            "camera_role": self.cfg.get("role"),
            "armed": bool(self.cfg.get("armed", True)),
            "after_hours": meta["after_hours"],
            "alarm_level": meta["alarm_level"],
            "time": start_time.isoformat(timespec="seconds"),
            "labels": meta["labels"],
            "top_label": meta["top_label"],
            "bird_species": meta["bird_species"],
            "cat_name": meta["cat_name"],
            "person_name": meta["person_name"],
            "whitelisted": meta["whitelisted"],
            "detections": meta["detections"],
            "snapshot_url": None,
            "snapshot_relpath": None,
            "thumb_url": None,
            "video_url": None,
            "video_relpath": None,
            "duration_s": 0.0,
            "file_size_bytes": 0,
            "status": status,
        }
        self.store.add_event(self.camera_id, event)

    def _start_ffmpeg_recording(self, start_time: datetime, meta: dict) -> bool:
        """Launch an ffmpeg subprocess that stream-copies the RTSP feed to disk.
        Returns True on success, False to let the caller fall back to OpenCV."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        day_dir = storage_root / "motion_detection" / self.camera_id / start_time.strftime("%Y-%m-%d")
        day_dir.mkdir(parents=True, exist_ok=True)
        event_id = start_time.strftime("%Y%m%d-%H%M%S-%f")
        raw_path = day_dir / f"{event_id}.raw.mp4"
        rtsp_url = self.cfg.get("rtsp_url")
        if not rtsp_url:
            return False
        cmd = [
            'ffmpeg', '-y', '-rtsp_transport', 'tcp',
            '-i', rtsp_url,
            '-c', 'copy',
            '-movflags', '+frag_keyframe+empty_moov',
            str(raw_path),
        ]
        try:
            proc = _subprocess.Popen(
                cmd,
                stdin=_subprocess.PIPE,
                stdout=_subprocess.DEVNULL,
                stderr=_subprocess.PIPE,
            )
        except FileNotFoundError:
            log.warning("[%s] ffmpeg not found — using OpenCV frame buffer "
                        "(playback speed may be incorrect)", self.camera_id)
            return False
        except Exception as e:
            log.error("[%s] ffmpeg spawn failed: %s", self.camera_id, e)
            return False
        self._ffmpeg_proc = proc
        self._ffmpeg_out_path = raw_path
        self._ffmpeg_start_time = start_time
        self._rec_event_id = event_id
        # Persist a 'recording' stub so the dashboard can show the clip immediately
        try:
            self._write_recording_event_stub(event_id, meta, start_time, status="recording")
        except Exception as e:
            log.warning("[%s] recording stub write failed: %s", self.camera_id, e)
        log.info("[%s] Recording started via ffmpeg (%s)", self.camera_id, raw_path.name)
        return True

    def _stop_ffmpeg_and_queue_reencode(self):
        """Stop the running ffmpeg subprocess gracefully, then kick off a background
        thread that re-encodes the raw stream-copy to browser-friendly H.264."""
        proc = self._ffmpeg_proc
        raw_path = self._ffmpeg_out_path
        event_id = self._rec_event_id
        meta = self._rec_event_meta
        start_time = self._ffmpeg_start_time
        # Reset state so a new recording can start immediately
        self._ffmpeg_proc = None
        self._ffmpeg_out_path = None
        self._ffmpeg_start_time = None
        self._rec_event_id = None
        if proc is None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.write(b'q\n')
                    proc.stdin.flush()
                except Exception:
                    pass
            try:
                proc.wait(timeout=5)
            except _subprocess.TimeoutExpired:
                log.warning("[%s] ffmpeg did not exit on 'q', terminating", self.camera_id)
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except _subprocess.TimeoutExpired:
                    proc.kill()
        except Exception as e:
            log.warning("[%s] ffmpeg stop error: %s", self.camera_id, e)
        log.info("[%s] Recording stopped (%s), queuing re-encode", self.camera_id,
                 raw_path.name if raw_path else "?")
        if raw_path is None or event_id is None or meta is None or start_time is None:
            return
        # Update status → processing so the UI shows the intermediate state
        try:
            ev = self.store.get_event(self.camera_id, event_id) or {}
            ev["status"] = "processing"
            self.store.update_event(self.camera_id, event_id, ev)
        except Exception:
            pass
        threading.Thread(
            target=self._reencode_motion_clip,
            args=(raw_path, event_id, meta, start_time),
            daemon=True,
        ).start()

    def _reencode_motion_clip(self, raw_path: Path, event_id: str, meta: dict,
                              start_time: datetime):
        """Background: transcode raw stream-copy → browser-friendly H.264.
        On success: delete the raw file, set video_url/snapshot/thumb/status=ready.
        On failure: keep raw as fallback, set encode_error on the event."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
        day_dir = raw_path.parent
        vid_path = day_dir / f"{event_id}.mp4"

        video_url = None
        video_relpath = None
        duration_s = 0.0
        file_size_bytes = 0
        encode_error = None
        try:
            if not raw_path.exists() or raw_path.stat().st_size < 1024:
                raise RuntimeError(f"raw clip missing/empty ({raw_path.stat().st_size if raw_path.exists() else 0} bytes)")
            cmd = [
                'ffmpeg', '-y', '-i', str(raw_path),
                '-vcodec', 'libx264', '-preset', 'fast', '-crf', '22',
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                '-an',
                str(vid_path),
            ]
            r = _subprocess.run(cmd, capture_output=True, timeout=300)
            if r.returncode != 0 or not vid_path.exists() or vid_path.stat().st_size < 1024:
                stderr_text = (r.stderr or b'').decode('utf-8', errors='replace')
                raise RuntimeError(f"ffmpeg re-encode rc={r.returncode}: {stderr_text[-300:]}")
            # Verify
            check = cv2.VideoCapture(str(vid_path))
            fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
            cfps = check.get(cv2.CAP_PROP_FPS) or 0.0
            check.release()
            duration_s = round(fc / cfps, 2) if cfps > 0 else 0.0
            file_size_bytes = vid_path.stat().st_size
            rel = vid_path.relative_to(storage_root)
            video_url = f"{public_base}/media/{rel.as_posix()}" if public_base else f"/media/{rel.as_posix()}"
            video_relpath = rel.as_posix()
            # Delete raw on success
            try:
                raw_path.unlink()
            except Exception:
                pass
            log.info("[%s] Re-encode complete: %s (%.1fs %dKB)",
                     self.camera_id, vid_path.name, duration_s, file_size_bytes // 1024)
        except Exception as e:
            log.error("[%s] Re-encode failed: %s", self.camera_id, e)
            encode_error = str(e)
            # Fallback: raw may still be playable — expose it if so
            if raw_path.exists() and raw_path.stat().st_size > 1024:
                rel = raw_path.relative_to(storage_root)
                video_url = f"{public_base}/media/{rel.as_posix()}" if public_base else f"/media/{rel.as_posix()}"
                video_relpath = rel.as_posix()
                file_size_bytes = raw_path.stat().st_size

        # Thumbnail from whichever file is present
        thumb_source = vid_path if vid_path.exists() else (raw_path if raw_path.exists() else None)
        thumb_rel = None
        thumb_url = None
        if thumb_source is not None:
            thumb_path = day_dir / f"{event_id}.jpg"
            try:
                cap = cv2.VideoCapture(str(thumb_source))
                total_f = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                if total_f > 3:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, total_f // 3)
                ok_th, frame_th = cap.read()
                cap.release()
                if ok_th and frame_th is not None:
                    tw = frame_th.shape[1]
                    if tw > 640:
                        scale = 640 / tw
                        frame_th = cv2.resize(frame_th, (640, int(frame_th.shape[0] * scale)))
                    if cv2.imwrite(str(thumb_path), frame_th, [int(cv2.IMWRITE_JPEG_QUALITY), 75]):
                        thumb_rel = thumb_path.relative_to(storage_root).as_posix()
                        thumb_url = f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}"
            except Exception as _te:
                log.debug("[%s] motion thumb (post-encode) failed: %s", self.camera_id, _te)

        # Update the event JSON: transition from 'processing' → 'ready' (or 'error')
        try:
            ev = self.store.get_event(self.camera_id, event_id) or {}
            ev["video_url"] = video_url
            ev["video_relpath"] = video_relpath
            ev["duration_s"] = duration_s
            ev["file_size_bytes"] = file_size_bytes
            ev["snapshot_url"] = thumb_url
            ev["snapshot_relpath"] = thumb_rel
            ev["thumb_url"] = thumb_url
            ev["status"] = "ready" if video_url else "error"
            if encode_error:
                ev["encode_error"] = encode_error
            self.store.update_event(self.camera_id, event_id, ev)
        except Exception as e:
            log.warning("[%s] event JSON update failed: %s", self.camera_id, e)

        # MQTT + Telegram (best-effort, only when we actually produced a video)
        if video_url and self.mqtt and self.cfg.get("mqtt_enabled", True):
            try:
                self.mqtt.publish(f"events/{self.camera_id}", {
                    "event_id": event_id,
                    "labels": meta["labels"],
                    "time": start_time.isoformat(timespec="seconds"),
                    "video_url": video_url,
                    "snapshot_url": thumb_url,
                })
            except Exception:
                pass
        notify = meta.get("notify", False)
        if video_url and notify and self.notifier and self.cfg.get("telegram_enabled", True):
            try:
                caption = (f"📷 {self.cfg.get('name', self.camera_id)}\n"
                           f"🕒 {start_time.isoformat(timespec='seconds')}\n"
                           f"🏷 {', '.join(meta['labels'])}")
                threading.Thread(target=self.notifier.send_alert_sync,
                                 kwargs={
                                     "caption": caption,
                                     "jpeg_bytes": meta.get("thumb_bytes"),
                                     "snapshot_url": thumb_url,
                                     "camera_id": self.camera_id,
                                 }, daemon=True).start()
            except Exception as e:
                log.debug("[%s] telegram alert skipped: %s", self.camera_id, e)

    def _finalize_motion_clip(self, frames: list, meta: dict, fps: float = 10.0):
        """Save MP4 clip (H.264 via ffmpeg, mp4v fallback), verify, write event JSON, send Telegram."""
        start_time: datetime = meta["time"]
        event_id: str = meta["event_id"]
        storage_root = Path(self.global_cfg["storage"]["root"])
        public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")

        vid_path = None
        video_url = None
        video_relpath = None
        duration_s: float = 0.0
        file_size_bytes: int = 0
        encode_error: str | None = None
        fps_clamped = max(5.0, min(30.0, float(fps)))
        try:
            day_dir = storage_root / "motion_detection" / self.camera_id / start_time.strftime("%Y-%m-%d")
            day_dir.mkdir(parents=True, exist_ok=True)
            vid_path = day_dir / f"{event_id}.mp4"
            ok = self._write_clip_ffmpeg(frames, fps, vid_path)
            if not ok:
                # Fallback: legacy mp4v (may not play in browser)
                log.warning("[%s] H.264 encode unavailable, writing mp4v fallback", self.camera_id)
                encode_error = encode_error or "ffmpeg h264 encode failed — mp4v fallback"
                h, w = frames[0].shape[:2]
                writer = cv2.VideoWriter(str(vid_path),
                    cv2.VideoWriter_fourcc(*'mp4v'), fps_clamped, (w, h))
                last_good = frames[0]
                for f in frames:
                    if self._is_frame_valid(f) and \
                       not self._is_frame_too_different(f, last_good):
                        writer.write(f); last_good = f
                    else:
                        writer.write(last_good)
                writer.release()

            # Verify output: must exist, have size, and be a readable video with real duration
            if not vid_path.exists() or vid_path.stat().st_size < 1024:
                raise RuntimeError(
                    f"clip empty/missing ({vid_path.stat().st_size if vid_path.exists() else 0} bytes)")
            check = cv2.VideoCapture(str(vid_path))
            fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
            cfps = check.get(cv2.CAP_PROP_FPS) or fps_clamped
            check.release()
            dur = fc / cfps if cfps > 0 else 0.0
            if fc < 3 or dur < 0.3:
                raise RuntimeError(f"clip broken: frames={fc} dur={dur:.2f}s")

            duration_s = round(dur, 2)
            file_size_bytes = vid_path.stat().st_size
            rel = vid_path.relative_to(storage_root)
            video_url = f"{public_base}/media/{rel.as_posix()}" if public_base else f"/media/{rel.as_posix()}"
            video_relpath = rel.as_posix()
            # Extract a representative thumbnail frame (~1/3 into the clip) and
            # downscale to max 640px wide. The motion card + lightbox both use
            # snapshot_relpath as their preview image.
            thumb_path = day_dir / f"{event_id}.jpg"
            try:
                check_thumb = cv2.VideoCapture(str(vid_path))
                total_f = int(check_thumb.get(cv2.CAP_PROP_FRAME_COUNT))
                if total_f > 0:
                    check_thumb.set(cv2.CAP_PROP_POS_FRAMES, min(total_f // 3, total_f - 1))
                ok_th, frame_th = check_thumb.read()
                check_thumb.release()
                if ok_th and frame_th is not None:
                    tw = frame_th.shape[1]
                    if tw > 640:
                        scale = 640 / tw
                        frame_th = cv2.resize(frame_th, (640, int(frame_th.shape[0] * scale)))
                    cv2.imwrite(str(thumb_path), frame_th, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            except Exception as _te:
                log.debug("[%s] motion thumb failed: %s", self.camera_id, _te)
            log.info("[%s] Motion clip saved: %s (%d frames %.1fs @ %.1ffps %dKB)",
                     self.camera_id, vid_path.name, len(frames), dur, fps_clamped,
                     file_size_bytes // 1024)
        except Exception as e:
            log.error("[%s] Motion clip save error: %s", self.camera_id, e)
            if encode_error is None:
                encode_error = str(e)

        # Fallback: primary path failed but file exists — the mp4v writer output may
        # still be playable even without faststart. Re-check via OpenCV.
        if video_url is None and vid_path is not None and vid_path.exists():
            try:
                size_bytes = vid_path.stat().st_size
                if size_bytes > 0:
                    check = cv2.VideoCapture(str(vid_path))
                    fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
                    cfps = check.get(cv2.CAP_PROP_FPS) or fps_clamped
                    check.release()
                    dur = fc / cfps if cfps > 0 else 0.0
                    if fc >= 3 and dur >= 0.3:
                        duration_s = round(dur, 2)
                        file_size_bytes = size_bytes
                        rel = vid_path.relative_to(storage_root)
                        video_url = f"{public_base}/media/{rel.as_posix()}" if public_base else f"/media/{rel.as_posix()}"
                        video_relpath = rel.as_posix()
                        log.warning("[%s] Motion clip recovered via fallback: %s (%d frames %.2fs, encode_error=%s)",
                                    self.camera_id, vid_path.name, fc, dur, encode_error)
                    else:
                        log.error("[%s] Fallback: clip unreadable (frames=%d dur=%.2fs) — removing",
                                  self.camera_id, fc, dur)
                        vid_path.unlink()
                else:
                    vid_path.unlink()
            except Exception as fe:
                log.error("[%s] Fallback read failed: %s", self.camera_id, fe)
                try:
                    vid_path.unlink()
                except Exception:
                    pass

        # Resolve thumbnail path (may have been created above after a successful encode)
        thumb_rel = None
        thumb_url = None
        try:
            if 'thumb_path' in locals() and thumb_path.exists():
                thumb_rel = thumb_path.relative_to(storage_root).as_posix()
                thumb_url = f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}"
        except Exception:
            pass

        # Write event JSON
        event = {
            "event_id": event_id,
            "camera_id": self.camera_id,
            "camera_name": self.cfg.get("name", self.camera_id),
            "group_id": self.cfg.get("group_id"),
            "camera_role": self.cfg.get("role"),
            "armed": bool(self.cfg.get("armed", True)),
            "after_hours": meta["after_hours"],
            "alarm_level": meta["alarm_level"],
            "time": start_time.isoformat(timespec="seconds"),
            "labels": meta["labels"],
            "top_label": meta["top_label"],
            "bird_species": meta["bird_species"],
            "cat_name": meta["cat_name"],
            "person_name": meta["person_name"],
            "whitelisted": meta["whitelisted"],
            "detections": meta["detections"],
            "snapshot_url": thumb_url,
            "snapshot_relpath": thumb_rel,
            "thumb_url": thumb_url,
            "video_url": video_url,
            "video_relpath": video_relpath,
            "duration_s": duration_s,
            "file_size_bytes": file_size_bytes,
        }
        if encode_error:
            event["encode_error"] = encode_error
        self.store.add_event(self.camera_id, event)

        if self.mqtt and self.cfg.get("mqtt_enabled", True):
            self.mqtt.publish(f"events/{self.camera_id}", event)

        # Achievement unlock
        bird_species = meta.get("bird_species")
        if bird_species:
            newly_unlocked = self._try_unlock_achievement(bird_species, bird_species)
            if newly_unlocked and self.notifier:
                try:
                    ach_msg = (f"🏆 Neue Trophäe freigeschaltet: {bird_species}!\n"
                               f"📷 Kamera: {self.cfg.get('name', self.camera_id)}")
                    threading.Thread(target=self.notifier.send_alert_sync,
                                     kwargs={"caption": ach_msg}, daemon=True).start()
                except Exception:
                    pass

        # Telegram
        notify = meta.get("notify", False)
        _send_tg = notify and self.cfg.get("telegram_enabled", True)
        if _send_tg:
            tg_cfg = self.global_cfg.get("telegram", {})
            tg_groups = tg_cfg.get("groups", {})
            g_id = self.cfg.get("group_id")
            if g_id and g_id in tg_groups:
                gr = tg_groups[g_id]
                if not gr.get("enabled", True):
                    _send_tg = False
                elif gr.get("objects") and not any(lbl in set(gr["objects"]) for lbl in meta["labels"]):
                    _send_tg = False
                elif gr.get("from") and gr.get("to"):
                    if not is_in_schedule({"enabled": True, "start": gr["from"], "end": gr["to"]}):
                        _send_tg = False
        if _send_tg and self.notifier:
            labels = meta["labels"]
            cat_match = meta.get("cat_name")
            person_match = meta.get("person_name")
            whitelisted = meta.get("whitelisted", False)
            level = meta.get("alarm_level")
            time_str = start_time.isoformat(timespec="seconds")
            if bird_species:
                top_score = next((d.get("score") for d in meta["detections"]
                                  if d.get("label") == "bird"), None)
                score_pct = f"{top_score * 100:.0f}" if top_score else "?"
                caption = (f"🐦 Vogel erkannt: {bird_species}\n"
                           f"📷 Kamera: {self.cfg.get('name', self.camera_id)}\n"
                           f"⏰ {time_str}\n📊 Sicherheit: {score_pct}%")
            else:
                details = []
                if cat_match:
                    details.append(f"🐈 {cat_match}")
                if person_match:
                    details.append(f"🧍 {person_match}{' (Whitelist)' if whitelisted else ''}")
                caption = (f"{'🚨' if level == 'alarm' else 'ℹ️'} {', '.join(sorted(set(labels)))}\n"
                           f"📷 {self.cfg.get('name', self.camera_id)}\n"
                           f"📍 {self.cfg.get('location', '')}\n🕒 {time_str}")
                if details:
                    caption += "\n" + " · ".join(details)
            self.notifier.send_alert_sync(
                caption=caption,
                jpeg_bytes=meta.get("thumb_bytes"),
                snapshot_url=video_url,
                dashboard_url=public_base,
                camera_id=self.camera_id,
            )

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
        """Scan timelapse frame directories on startup and log what was found.
        - Previous-day directories: preserved so _finalize_orphaned_windows can encode
          them when the profile loop starts (restart-safe behavior).
        - Today's directories: all except the newest per profile are cleaned up
          (mid-run windows that were abandoned without encode).
        Called once on startup before any profile thread begins."""
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
                    # Previous day: keep frames on disk — the profile loop will call
                    # _finalize_orphaned_windows() which encodes and then deletes them.
                    n = len(list(window_dir.glob("*.jpg")))
                    log_tl.info(
                        "[%s][media] previous-day frames preserved for encoding: "
                        "%s/%s (%d frames) — will be encoded on profile startup",
                        self.camera_id, profile_dir.name, window_dir.name, n)
                elif dir_date == today and i < len(all_windows) - 1:
                    # Today but not the newest window → abandoned mid-run, safe to delete
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
        _t0 = time.monotonic()
        path = builder._write_video(images, out_path, target_s, target_fps)
        elapsed = time.monotonic() - _t0

        if path:
            size_mb = round(out_path.stat().st_size / 1024 / 1024, 2) if out_path.exists() else 0
            log_tl.info("[%s][timelapse] encoded %s: %d frames → %ds video in %.1fs real time (%.1f MB)",
                        self.camera_id, out_path.name, n, target_s, elapsed, size_mb)
            # Extract a thumbnail from the middle frame of the finished video
            thumb_path = out_dir / f"{stem}.jpg"
            if not thumb_path.exists():
                try:
                    import cv2 as _cv2
                    cap = _cv2.VideoCapture(str(out_path))
                    total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                    if total > 0:
                        cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                    ok_t, frame_t = cap.read()
                    cap.release()
                    if ok_t and frame_t is not None:
                        tw = frame_t.shape[1]
                        if tw > 640:
                            scale = 640 / tw
                            frame_t = _cv2.resize(frame_t, (640, int(frame_t.shape[0] * scale)))
                        _cv2.imwrite(str(thumb_path), frame_t,
                                     [int(_cv2.IMWRITE_JPEG_QUALITY), 82])
                except Exception as _te:
                    log_tl.debug("[%s][timelapse] thumb failed: %s", self.camera_id, _te)
            # Write sidecar JSON next to the video — kept as fast index for the
            # /api/camera/<id>/timelapse/list endpoint
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
            # Register a unified EventStore entry so the media grid and filters
            # treat timelapse like any other event.
            try:
                public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
                video_rel = f"timelapse/{self.camera_id}/{out_path.name}"
                thumb_rel = f"timelapse/{self.camera_id}/{stem}.jpg" if thumb_path.exists() else None
                tl_event = {
                    "event_id": f"tl_{stem}",
                    "camera_id": self.camera_id,
                    "camera_name": self.cfg.get("name", self.camera_id),
                    "type": "timelapse",
                    "labels": ["timelapse"],
                    "top_label": "timelapse",
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "profile": profile_name,
                    "window_key": window_key,
                    "period_s": period_s,
                    "target_s": target_s,
                    "frame_count": n,
                    "filename": out_path.name,
                    "video_relpath": video_rel,
                    "video_url": f"{public_base}/media/{video_rel}" if public_base else f"/media/{video_rel}",
                    "snapshot_relpath": thumb_rel,
                    "snapshot_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "thumb_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "size_mb": size_mb,
                    "duration_s": 0.0,
                    "file_size_bytes": out_path.stat().st_size if out_path.exists() else 0,
                }
                self.store.add_event(self.camera_id, tl_event)
                log_tl.info("[%s][timelapse] event registered: %s", self.camera_id, tl_event["event_id"])
            except Exception as e:
                log_tl.warning("[%s][timelapse] EventStore register failed: %s", self.camera_id, e)
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
            target_fps = int(tl.get("fps", 25))
            period_s = _period_map.get(tl.get("period", "day"), 86400)
            total_frames = max(1, target_s * target_fps)
            interval_s = max(0.5, period_s / total_frames)
            jpeg_q = 50 if interval_s < 1.0 else 72
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
                    cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])
                    log_tl.debug("[%s] timelapse frame saved: %s (interval=%.2fs, q=%d)", self.camera_id, out.name, interval_s, jpeg_q)
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
        _last_frame_ts: float = 0.0   # frame_ts at last capture — detects stale buffer

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
            # Per-profile fps falls back to the camera-level fps, then 25.
            target_fps = int(prof.get("fps") or tl.get("fps") or 25)
            period_s = int(prof.get("period_seconds", _PROFILE_PERIOD_DEFAULTS.get(profile_name, 86400)))
            total_frames = max(1, target_s * target_fps)
            interval_s = max(0.5, period_s / total_frames)
            jpeg_q = 50 if interval_s < 1.0 else 72

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
                frame_ts = self.frame_ts
            if frame is not None and window_key is not None:
                try:
                    # Staleness guard: skip only when the frame buffer hasn't been updated
                    # since the last capture — this means the RTSP stream is genuinely stuck.
                    # A static scene (identical content, new timestamp) is intentionally saved.
                    if frame_ts == _last_frame_ts:
                        age_s = time.time() - frame_ts
                        self._stale_incidents += 1
                        self._stale_streak += 1
                        log_tl.warning("[%s][%s] stale frame buffer (age=%.0fs, streak=%d) — RTSP stream may be stuck",
                                      self.camera_id, profile_name, age_s, self._stale_streak)
                        # After 15 consecutive stale intervals, request a forced RTSP reconnect
                        if self._stale_streak >= 15 and not self._force_reconnect:
                            log_tl.error("[%s][%s] stale streak exceeded threshold — requesting RTSP reconnect",
                                        self.camera_id, profile_name)
                            self._force_reconnect = True
                        # Don't advance _last_frame_ts so we keep detecting stale each interval
                    else:
                        _last_frame_ts = frame_ts
                        if self._stale_streak > 0:
                            log_cam.info("[%s][%s] stream recovered after %d stale intervals",
                                         self.camera_id, profile_name, self._stale_streak)
                        self._stale_streak = 0  # reset streak on any fresh frame
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
                            cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])
                            log_tl.debug("[%s][%s] frame saved: %s window=%s (%.2fs/frame, q=%d)",
                                      self.camera_id, profile_name, out.name, window_key, interval_s, jpeg_q)
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
        cooldown = max(10, int(self.global_cfg.get("processing", {}).get("event_cooldown_seconds", 10)))
        while self.running:
            # Timelapse threads may request a forced reconnect when they detect a stale stream
            if self._force_reconnect:
                self._force_reconnect = False
                self._stale_streak = 0
                log_cam.warning("[%s] Forced RTSP reconnect triggered (stale-feed recovery)", self.camera_id)
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                self._reconnect_count += 1
                time.sleep(2.0)
                continue
            try:
                frame = self._grab_frame()
                # Always store raw frame so status → "active" and snapshots work
                with self.lock:
                    self.frame = frame
                    self.frame_ts = time.time()
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
                    if self._recording:
                        self._rec_corrupt_frames += 1
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
                cam_min_score = self.cfg.get("detection_min_score") or None
                detections = self.detector.detect_frame(proc_frame, min_score=cam_min_score)
                allowed = set(self.cfg.get("object_filter") or [])
                if allowed:
                    detections = [d for d in detections if d.label in allowed]
                labels = effective_motion + [d.label for d in detections]
                if self.bird_classifier.available:
                    for d in detections:
                        if d.label == "bird":
                            crop = self._crop(proc_frame, d.bbox)
                            species, species_latin, species_score = self.bird_classifier.classify_crop(crop)
                            if species:
                                d.species = species
                                d.species_latin = species_latin
                                d.species_score = float(species_score) if species_score is not None else None
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
                # ── MAD glitch check vs previous accepted frame ───────────────
                if self.cfg.get("rtsp_url") and self._is_frame_too_different(proc_frame, self._prev_good_frame):
                    log.warning("[%s] Frame MAD>60 (glitch/corrupt), skipped", self.camera_id)
                    time.sleep(interval)
                    continue
                self._prev_good_frame = proc_frame  # no copy — proc_frame is already a new array

                now_dt = datetime.now()
                has_motion = bool(labels)

                if self.cfg.get("rtsp_url"):
                    # ── RTSP: pre-buffer + per-session video recording ────────
                    # Measure main-stream FPS over a rolling 5s window
                    self._main_fps_frames += 1
                    _fps_el = time.time() - self._main_fps_window_start
                    if _fps_el >= 5.0:
                        self._main_fps = round(self._main_fps_frames / _fps_el, 1)
                        self._main_fps_frames = 0
                        self._main_fps_window_start = time.time()

                    # Clip boundary knobs (configurable); ffmpeg stream-copy ignores pre-buffer
                    _clip_max = int(self.global_cfg.get("processing", {}).get("clip_max_duration_s", 120))
                    _post_tail = float(self.global_cfg.get("processing", {}).get("post_motion_tail_s", 3.0))
                    ffmpeg_mode = bool(self._ffmpeg_proc) or (_FFMPEG_AVAILABLE and not self._recording)
                    # Pre-buffer only matters for the OpenCV fallback path
                    if not _FFMPEG_AVAILABLE:
                        self._pre_buffer.append((proc_frame.copy(), time.time()))

                    if has_motion:
                        self._last_motion_ts = now_dt
                        if not self._recording:
                            has_person = "person" in labels
                            elapsed = (now_dt - self.last_event_at).total_seconds()
                            if has_person or elapsed >= cooldown:
                                rec_meta = self._build_event_meta(
                                    now_dt, labels, detections, drawn, effective_bbox)
                                started = False
                                if _FFMPEG_AVAILABLE:
                                    started = self._start_ffmpeg_recording(now_dt, rec_meta)
                                if started:
                                    self._recording = True
                                    self._rec_start_time = now_dt
                                    self._rec_corrupt_frames = 0
                                    self._rec_event_meta = rec_meta
                                    self.last_event_at = now_dt
                                    self.event_counter_today += 1
                                else:
                                    # OpenCV fallback (legacy path)
                                    self._recording = True
                                    self._rec_start_time = now_dt
                                    self._rec_corrupt_frames = 0
                                    pre_cutoff = time.time() - 3.0
                                    self._rec_frames = [f for f, ts in self._pre_buffer if ts >= pre_cutoff]
                                    self._rec_event_meta = rec_meta
                                    self.last_event_at = now_dt
                                    self.event_counter_today += 1
                                    log.info("[%s] Motion recording started (OpenCV, labels=%s, prebuf=%d frames)",
                                             self.camera_id, labels, len(self._rec_frames))
                        # Append frames only in OpenCV mode — ffmpeg records itself
                        if self._recording and self._ffmpeg_proc is None:
                            self._rec_frames.append(proc_frame.copy())

                    elif self._recording:
                        since_last = (now_dt - self._last_motion_ts).total_seconds() if self._last_motion_ts else 999
                        since_start = (now_dt - self._rec_start_time).total_seconds() if self._rec_start_time else 0
                        # In OpenCV mode we keep accumulating tail frames
                        if self._ffmpeg_proc is None:
                            self._rec_frames.append(proc_frame.copy())
                        if since_last >= _post_tail or since_start >= _clip_max:
                            if self._rec_corrupt_frames > 5:
                                log.warning("[%s] %d corrupt frames rejected in this clip",
                                            self.camera_id, self._rec_corrupt_frames)
                            if self._ffmpeg_proc is not None:
                                # ffmpeg mode: stop subprocess + queue re-encode
                                self._stop_ffmpeg_and_queue_reencode()
                                self._recording = False
                                self._rec_start_time = None
                                self._last_motion_ts = None
                                self._rec_event_meta = None
                                self._rec_corrupt_frames = 0
                            else:
                                # OpenCV fallback: finalize from frame buffer
                                frames_snap = self._rec_frames[:]
                                meta_snap = self._rec_event_meta
                                measured_fps = (max(5.0, min(30.0, len(frames_snap) / since_start))
                                                if since_start > 0.5 else (self._main_fps or 10.0))
                                self._recording = False
                                self._rec_frames = []
                                self._rec_start_time = None
                                self._last_motion_ts = None
                                self._rec_event_meta = None
                                self._rec_corrupt_frames = 0
                                if meta_snap and len(frames_snap) >= 3:
                                    threading.Thread(target=self._finalize_motion_clip,
                                                     args=(frames_snap, meta_snap, measured_fps),
                                                     daemon=True).start()

                else:
                    # ── Snapshot camera: save JPEG event (unchanged behaviour) ─
                    has_person = "person" in labels
                    elapsed = (now_dt - self.last_event_at).total_seconds()
                    if labels and (has_person or elapsed >= cooldown):
                        self.last_event_at = now_dt
                        self.event_counter_today += 1
                        ts = now_dt
                        event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
                        day_dir = (Path(self.global_cfg["storage"]["root"]) / "motion_detection"
                                   / self.camera_id / ts.strftime("%Y-%m-%d"))
                        day_dir.mkdir(parents=True, exist_ok=True)
                        snap_path = day_dir / f"{event_id}.jpg"
                        save_frame = drawn.copy()
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
                        ev_meta = self._build_event_meta(ts, labels, detections, drawn, effective_bbox)
                        event = {
                            "event_id": event_id,
                            "camera_id": self.camera_id,
                            "camera_name": self.cfg.get("name", self.camera_id),
                            "group_id": self.cfg.get("group_id"),
                            "camera_role": self.cfg.get("role"),
                            "armed": bool(self.cfg.get("armed", True)),
                            "after_hours": ev_meta["after_hours"],
                            "alarm_level": ev_meta["alarm_level"],
                            "time": ts.isoformat(timespec="seconds"),
                            "labels": ev_meta["labels"],
                            "top_label": ev_meta["top_label"],
                            "bird_species": ev_meta["bird_species"],
                            "cat_name": ev_meta["cat_name"],
                            "person_name": ev_meta["person_name"],
                            "whitelisted": ev_meta["whitelisted"],
                            "detections": ev_meta["detections"],
                            "snapshot_url": snapshot_url,
                            "snapshot_relpath": rel.as_posix(),
                            "video_url": None,
                            "video_relpath": None,
                        }
                        self.store.add_event(self.camera_id, event)
                        if self.mqtt and self.cfg.get("mqtt_enabled", True):
                            self.mqtt.publish(f"events/{self.camera_id}", event)
                        _send_tg = ev_meta["notify"] and self.cfg.get("telegram_enabled", True)
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
                        if _send_tg and self.notifier:
                            with open(snap_path, "rb") as fh:
                                thumb = fh.read()
                            self.notifier.send_alert_sync(
                                caption=(f"ℹ️ {', '.join(ev_meta['labels'])}\n"
                                         f"📷 {self.cfg.get('name', self.camera_id)}\n"
                                         f"🕒 {event['time']}"),
                                jpeg_bytes=thumb, snapshot_url=snapshot_url,
                                dashboard_url=public_base, camera_id=self.camera_id)
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
                self._reconnect_count += 1
                # Short backoff for transient dropouts, longer for persistent failures
                sleep_t = 2.0 if self._error_streak <= 3 else min(30.0, 5.0 * (self._error_streak // 5 + 1))
                time.sleep(sleep_t)
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
        now_t = time.time()
        frame_age_s = round(now_t - self.frame_ts, 1) if self.frame_ts > 0 else None
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
            # Connection health diagnostics
            "frame_age_s": frame_age_s,
            "reconnect_count": self._reconnect_count,
            "stale_incidents": self._stale_incidents,
            "error_streak": self._error_streak,
            "stale_streak": self._stale_streak,
            # Stream activity
            "preview_fps": self._preview_fps,
            "preview_resolution": self._preview_resolution,
            "live_viewers": self._live_viewers,
            "stream_mode": "live" if self._live_viewers > 0 else "baseline",
            "supervisor_restarts": self._supervisor_restarts,
        }

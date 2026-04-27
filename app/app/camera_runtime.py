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
from .detectors import CoralObjectDetector, BirdSpeciesClassifier, WildlifeClassifier, Detection, draw_detections
from .event_logic import is_in_schedule, choose_alarm_level, schedule_action_active

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

# COCO classes whose geometry usually localises a small ground mammal even
# when the label is wrong (squirrels read as "cat" head-on, "bear" furry,
# "teddy bear" sitting upright, etc.). When wildlife confirms squirrel /
# fox / hedgehog we re-run COCO at a low threshold and steal the bbox
# of any of these — purely as a localisation hint, ignoring the label.
_WILDLIFE_BBOX_DONORS = ("cat", "dog", "bear", "sheep", "cow", "teddy bear")


def _bbox_iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    aa = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    bb = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = aa + bb - inter
    if union <= 0:
        return 0.0
    return inter / union


def _refine_wildlife_bbox(detector, frame, motion_bbox, frame_size):
    """Best-guess bbox for a wildlife hit.

    Re-runs COCO at threshold 0.25 and returns the bbox of any donor-class
    detection (the first one — they're score-sorted). Falls back to
    `motion_bbox` (which is `(x, y, w, h)`), then the full frame.
    """
    w0, h0 = frame_size
    try:
        low = detector.detect_frame(frame, min_score=0.25) or []
    except Exception:
        low = []
    for d in low:
        if d.label in _WILDLIFE_BBOX_DONORS:
            return d.bbox
    if motion_bbox is not None:
        mx, my, mw, mh = motion_bbox
        return (int(mx), int(my), int(mx + mw), int(my + mh))
    return (0, 0, int(w0), int(h0))


def _suppress_overlap(dets, ref_bbox, drop_labels, iou_min: float = 0.3):
    """Drop detections whose label is in `drop_labels` AND whose bbox
    overlaps `ref_bbox` (IoU >= iou_min). Used to silence COCO's
    cat/teddy-bear false positives once wildlife confirms a squirrel."""
    if not dets:
        return dets
    out = []
    for d in dets:
        if d.label in drop_labels and _bbox_iou(d.bbox, ref_bbox) >= iou_min:
            continue
        out.append(d)
    return out


class WeatherPrebuffer:
    """Per-camera rolling buffer of JPEG-encoded sub-stream frames.

    Used by WeatherService to splice a pre-roll onto a freshly captured
    post-roll when an event triggers, so the resulting clip starts a few
    seconds BEFORE the API noticed the lightning bolt.

    The buffer holds (timestamp, jpeg_bytes) tuples. JPEG is chosen over
    raw BGR for memory: a 1280×720 BGR frame is ≈ 2.7 MB, the JPEG
    equivalent at quality 75 is typically 60–120 KB. 10 s @ 15 fps =
    150 frames → ≈ 12 MB instead of 414 MB per camera.

    Encoding runs inline in the preview loop (push()). At 15 fps and
    1280×720 the per-frame cost is well under the 66 ms frame budget.
    """

    def __init__(self, pre_roll_s: int, fps: int, jpeg_quality: int = 78):
        # maxlen sized for the configured pre-roll only — post-roll is
        # collected into a separate transient buffer per recording session.
        self._maxlen = max(1, int(pre_roll_s) * max(1, int(fps)))
        self._fps = max(1, int(fps))
        self._quality = int(jpeg_quality)
        self._lock = threading.Lock()
        self._ring: deque = deque(maxlen=self._maxlen)
        # Active post-roll captures (one per recording session). Each is a
        # dict {frames: list, deadline: float, fps: int}. push() writes to
        # all of them in parallel until the deadline passes.
        self._postroll_sessions: list[dict] = []

    def push(self, bgr_frame) -> None:
        """Encode one BGR frame to JPEG and append to the ring buffer.
        Also fans out to any in-progress post-roll sessions."""
        try:
            ok, buf = cv2.imencode('.jpg', bgr_frame, [int(cv2.IMWRITE_JPEG_QUALITY), self._quality])
            if not ok:
                return
            jpg = buf.tobytes()
        except Exception:
            return
        ts = time.time()
        with self._lock:
            self._ring.append((ts, jpg))
            if self._postroll_sessions:
                expired = []
                for s in self._postroll_sessions:
                    if ts <= s["deadline"]:
                        s["frames"].append((ts, jpg))
                    else:
                        expired.append(s)
                for s in expired:
                    self._postroll_sessions.remove(s)

    def snapshot(self) -> list[tuple[float, bytes]]:
        """Frozen copy of the current pre-roll, oldest frame first."""
        with self._lock:
            return list(self._ring)

    def start_postroll(self, seconds: float) -> dict:
        """Begin collecting post-roll frames. Returns a session handle the
        caller passes to collect_postroll() once the duration has elapsed."""
        deadline = time.time() + max(0.1, float(seconds))
        session = {"frames": [], "deadline": deadline, "fps": self._fps}
        with self._lock:
            self._postroll_sessions.append(session)
        return session

    def collect_postroll(self, session: dict) -> list[tuple[float, bytes]]:
        """Detach a post-roll session from the buffer and return its frames.
        Safe to call before or after the deadline."""
        with self._lock:
            try:
                self._postroll_sessions.remove(session)
            except ValueError:
                pass
        return list(session.get("frames", []))


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
        # Rolling-average Coral inference latency. Sized to ~30 frames so
        # transient spikes don't dominate; the /status bubble reads the
        # current average from inference_avg_ms property below.
        self._inference_times_ms: deque = deque(maxlen=30)
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
        # Second-stage wildlife classifier — maps ImageNet top-1 to our
        # fox/squirrel/hedgehog labels so motion on a fox or hedgehog
        # doesn't go unrecognised (COCO has neither class).
        # Wildlife classifier gets the bird_species cfg as its iNat second-
        # stage backend by default — the bird-iNat model on disk is bird-
        # only (no mammal genera in inat_bird_labels.txt), so the iNat
        # branch never fires today, but the framework activates as soon as
        # the user drops a mammal-capable iNat model and points the
        # processing.bird_species path at it.
        self.wildlife_classifier = WildlifeClassifier(
            proc.get("wildlife", {}),
            inat_cfg=proc.get("bird_species", {}) or None,
        )
        # Exclusion-mask image cache. Built lazily on first frame and
        # rebuilt whenever the masks config signature changes (_mask_sig).
        # See _ensure_mask_image().
        self._mask_image = None
        self._mask_sig: str | None = None
        self._ensure_mask_image(log_summary=True)
        # Inclusion-zone image cache. Mirrors the mask helpers but inverts
        # the geometry: 255 = inside a zone (detect here), 0 = outside.
        # When no zones are configured, _zone_image is None and the whole
        # frame counts as active.
        self._zone_image = None
        self._zone_sig: str | None = None
        self._ensure_zone_image(log_summary=True)
        self._ach_lock = threading.Lock()
        self._ach_path = Path(self.global_cfg["storage"]["root"]) / "achievements.json"
        self._motion_confirm: deque = deque(maxlen=3)  # multi-frame confirmation (normal threshold)
        self._motion_confirm_wl: deque = deque(maxlen=3)  # wildlife low-threshold confirmation
        self._tl_thread = None   # legacy single timelapse thread
        self._tl_threads: dict = {}  # profile_name → Thread
        # ── Connection health / diagnostics ──────────────────────────────────
        self.frame_ts: float = 0.0          # epoch of last frame written to self.frame
        self._reconnect_count: int = 0      # how many times capture was reopened
        # Sliding-window log of reconnect timestamps. We never bound the
        # capacity hard because the prune-on-read step keeps only entries
        # < 86400 s old, and the increment-on-reconnect path is rare
        # enough that the deque stays small even on a chronically flaky
        # cam (a 5-minute reconnect interval gives 288 entries / 24 h).
        self._reconnect_log: deque = deque()
        # First-frame latency markers — set when cv2.VideoCapture opens,
        # cleared after the first decoded frame logs an "[cam:<id>] RTSP
        # opened — first frame in <ms> ms" line. Tells the operator
        # whether a reconnect actually succeeded.
        self._rtsp_opened_at: float | None = None
        self._rtsp_first_frame_logged: bool = False
        self._last_rtsp_success_ts: float = 0.0
        self._open_attempt_count: int = 0
        self._stale_incidents: int = 0      # how often timelapse saw a stale frame buffer
        # Camera-wide mirror of the highest-active profile's stale streak
        # — used by /api/camera/<id>/status for the diagnostic dashboard.
        # The authoritative per-profile counter lives as a local inside
        # _timelapse_profile_loop() so parallel profiles can't stomp on
        # each other. Main loop resets this to 0 on forced reconnect as
        # a fresh-start signal for the UI.
        self._stale_streak: int = 0
        self._force_reconnect: bool = False  # timelapse sets True to request RTSP reopen from _loop
        # ── Preview stream metrics ────────────────────────────────────────────
        self._preview_fps: float = 0.0          # measured sub-stream FPS (rolling 5s window)
        self._preview_fps_frames: int = 0        # frame counter for FPS window
        self._preview_fps_window_start: float = time.time()
        self._preview_resolution: str = ""      # "WxH" of last received preview frame
        # ── Wetter-Sichtungen prebuffer ───────────────────────────────────────
        # WeatherPrebuffer is created lazily by the WeatherService when a cam
        # opts in (cameras[i].weather.enabled=True). Until then it stays None
        # and _preview_loop's hook is a single attribute lookup ≈ free.
        self.weather_prebuffer: WeatherPrebuffer | None = None
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
            # Read timeout — without this, cap.read() blocks indefinitely
            # when the network pipe goes black mid-stream and the main loop
            # can't check self._force_reconnect / self.running until a frame
            # eventually arrives (which may never happen). 6 s is long
            # enough that healthy streams with occasional packet loss don't
            # trip it, short enough that a real dropout reaches the
            # exception handler and reconnect path quickly.
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000)
            _RES_MAP = {"720p": (1280, 720), "1080p": (1920, 1080), "4k": (3840, 2160)}
            _res = self.cfg.get("resolution", "auto")
            if _res in _RES_MAP:
                _w, _h = _RES_MAP[_res]
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, _w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _h)
            if not cap.isOpened():
                raise RuntimeError(f"Kamera {self.camera_id}: RTSP konnte nicht geöffnet werden")
            self.capture = cap
            # Mark the RTSP-open moment so the [cam:<id>] RTSP opened line
            # can include the first-frame latency. Picked up by _loop()
            # the next time a fresh frame is decoded.
            self._rtsp_opened_at = time.time()
            self._rtsp_first_frame_logged = False

            # ── Sub-stream: H.264 preview for dashboard (no pink) ────────────
            # Opened under _preview_cap_lock so _preview_loop sees a consistent handle.
            sub_url = self._sub_stream_url(rtsp_url)
            if sub_url:
                try:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
                    pcap = cv2.VideoCapture(sub_url, cv2.CAP_FFMPEG)
                    pcap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    pcap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000)
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
                        # Wetter-Sichtungen prebuffer hook — only spends CPU
                        # on JPEG encoding when a WeatherService has actually
                        # attached a buffer to this camera.
                        if self.weather_prebuffer is not None:
                            self.weather_prebuffer.push(frame)
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

    def _ensure_mask_image(self, log_summary: bool = False):
        """Build / refresh the binary exclusion-mask image from the camera's
        polygon list. White (255) = active detection area, black (0) = masked
        out. The image is sized 720×1280 — each frame gets resized to match
        at filter time so any frame resolution works. Rebuilds only when the
        mask config signature changes, so the per-frame filter path stays
        cheap."""
        cam_masks = self.cfg.get("masks", []) or []
        # Signature: stable serialisation of all polygons. Compared against
        # the cached signature to decide whether a rebuild is needed.
        try:
            sig = _json_mod.dumps(cam_masks, sort_keys=True, separators=(',', ':'))
        except Exception:
            sig = repr(cam_masks)
        if sig == self._mask_sig:
            return  # no change
        self._mask_sig = sig
        if not cam_masks:
            self._mask_image = None
            if log_summary:
                log.info("[%s] exclusion masks: none", self.camera_id)
            return
        h, w = 720, 1280
        mask = np.ones((h, w), dtype=np.uint8) * 255
        # The pre-baked image is used by motion detection and represents only
        # GLOBAL masks (no `labels` filter). Labeled masks restrict specific
        # object classes and are evaluated per-detection in
        # _filter_masked_detections — they shouldn't suppress motion.
        for poly in cam_masks:
            if isinstance(poly, dict) and poly.get("labels"):
                continue
            pts_list = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts_list, list) or len(pts_list) < 3:
                continue
            pts = np.array([[int(p.get('x', 0)), int(p.get('y', 0))] for p in pts_list], dtype=np.int32)
            pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
            cv2.fillPoly(mask, [pts], 0)
        self._mask_image = mask
        if log_summary:
            total_verts = 0
            for p in cam_masks:
                pts_list = p.get("points", p) if isinstance(p, dict) else p
                if isinstance(pts_list, list):
                    total_verts += len(pts_list)
            log.info("[%s] Loaded %d exclusion masks (%d total vertices)",
                     self.camera_id, len(cam_masks), total_verts)

    def _polys_for_label(self, polys_field: str, label: str | None) -> list:
        """Return the polygons (raw [{x,y},…] lists) that apply to a label.

        A polygon applies when:
          - it has no `labels` array (or empty) → global, applies to every
            label (legacy behaviour), or
          - its `labels` array contains the given label.

        Pure-list legacy polygons ([[{x,y},…], …]) are treated as global.
        """
        cfg_list = self.cfg.get(polys_field) or []
        out: list = []
        for poly in cfg_list:
            pts = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts, list) or len(pts) < 3:
                continue
            labels = (poly.get("labels") if isinstance(poly, dict) else None) or []
            if not labels or (label and label in labels):
                out.append(pts)
        return out

    @staticmethod
    def _point_in_poly(cx: int, cy: int, points: list, frame_w: int, frame_h: int) -> bool:
        """Polygon points are stored in 1280×720 coord space; rescale the
        frame centre into that space before testing so cameras at any
        resolution share one coordinate system."""
        sx = 1280.0 / max(1, frame_w)
        sy = 720.0 / max(1, frame_h)
        try:
            arr = np.array([[int(p.get('x', 0)), int(p.get('y', 0))] for p in points], dtype=np.int32)
        except Exception:
            return False
        if len(arr) < 3:
            return False
        return cv2.pointPolygonTest(arr, (float(cx) * sx, float(cy) * sy), False) >= 0

    def _filter_masked_detections(self, frame, detections: list) -> list:
        """Drop detections whose bbox-centre lands inside a masked region.

        Two-stage:
          1. Global masks are pre-baked into _mask_image and tested with a
             single pixel lookup — fast path, applies to every label.
          2. Labeled masks are evaluated per detection so a mask scoped to
             {"person"} only suppresses that label and lets cats/birds
             through the same area.
        """
        if not detections:
            return detections
        self._ensure_mask_image()
        h_f, w_f = frame.shape[:2]
        # Stage 1: global mask via pre-baked image.
        mask_resized = None
        if self._mask_image is not None:
            h_m, w_m = self._mask_image.shape[:2]
            if (h_m, w_m) != (h_f, w_f):
                mask_resized = cv2.resize(self._mask_image, (w_f, h_f), interpolation=cv2.INTER_NEAREST)
            else:
                mask_resized = self._mask_image
        # Pre-collect per-label labeled polygons so we don't re-scan cfg
        # for every detection.
        cam_masks = self.cfg.get("masks") or []
        has_labeled = any(isinstance(m, dict) and m.get("labels") for m in cam_masks)
        kept: list = []
        for d in detections:
            x1, y1, x2, y2 = d.bbox
            cx = max(0, min(w_f - 1, (x1 + x2) // 2))
            cy = max(0, min(h_f - 1, (y1 + y2) // 2))
            if mask_resized is not None and mask_resized[cy, cx] == 0:
                log.debug("[%s] Detection '%s' (%.0f%%) suppressed by global mask at (%d,%d)",
                          self.camera_id, d.label, d.score * 100, cx, cy)
                continue
            if has_labeled:
                # Walk only labeled masks here — globals were handled in
                # stage 1 via the prebaked image.
                dropped = False
                for m in cam_masks:
                    if not (isinstance(m, dict) and m.get("labels")):
                        continue
                    if d.label not in m.get("labels", []):
                        continue
                    pts = m.get("points") or []
                    if self._point_in_poly(cx, cy, pts, w_f, h_f):
                        log.debug("[%s] Detection '%s' (%.0f%%) suppressed by label-mask",
                                  self.camera_id, d.label, d.score * 100)
                        dropped = True
                        break
                if dropped:
                    continue
            kept.append(d)
        return kept

    def _ensure_zone_image(self, log_summary: bool = False):
        """Build / refresh the inclusion-zone image. Inverse logic vs. mask:
        the canvas starts BLACK and each zone polygon is filled with WHITE,
        so a pixel inside any zone is active (detect here). When no zones
        are configured, _zone_image stays None and the whole frame is
        active — behaviour equivalent to "no filter". Rebuilds only when
        the zones config signature changes, so the per-frame path stays
        cheap."""
        cam_zones = self.cfg.get("zones", []) or []
        try:
            sig = _json_mod.dumps(cam_zones, sort_keys=True, separators=(',', ':'))
        except Exception:
            sig = repr(cam_zones)
        if sig == self._zone_sig:
            return
        self._zone_sig = sig
        # Only GLOBAL zones (no `labels` filter) are baked into the motion-
        # suppression image. Labeled zones live alongside, evaluated per-
        # detection in _filter_zoned_detections so each label sees its own
        # inclusion area.
        global_zones = [
            z for z in cam_zones
            if not (isinstance(z, dict) and z.get("labels"))
        ]
        if not global_zones:
            # Even if labeled zones exist, motion detection has no label
            # context — so when no global zones are configured the motion
            # path treats the entire frame as active.
            self._zone_image = None
            if log_summary:
                if cam_zones:
                    log.info("[%s] inclusion zones: %d label-scoped (motion path unrestricted)",
                             self.camera_id, len(cam_zones))
                else:
                    log.info("[%s] inclusion zones: none (entire frame active)", self.camera_id)
            return
        h, w = 720, 1280
        zone = np.zeros((h, w), dtype=np.uint8)  # start all black (inactive)
        for poly in global_zones:
            pts_list = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts_list, list) or len(pts_list) < 3:
                continue
            pts = np.array([[int(p.get('x', 0)), int(p.get('y', 0))] for p in pts_list], dtype=np.int32)
            pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
            cv2.fillPoly(zone, [pts], 255)  # white = active zone
        self._zone_image = zone
        if log_summary:
            total_verts = 0
            for p in cam_zones:
                pts_list = p.get("points", p) if isinstance(p, dict) else p
                if isinstance(pts_list, list):
                    total_verts += len(pts_list)
            log.info("[%s] Loaded %d inclusion zones (%d total vertices) — outside zones = ignored",
                     self.camera_id, len(cam_zones), total_verts)

    def _filter_zoned_detections(self, frame, detections: list) -> list:
        """Keep only detections whose bbox-centre lands inside an applicable
        inclusion zone.

        Per-label semantics:
          - If a label has at least one applicable zone (global or its label
            specifically named), the detection MUST be inside one of them.
          - If no zone applies to that label, the detection passes through
            (this lets the user define "person only inside this polygon"
            without restricting cat/bird).
        """
        if not detections:
            return detections
        cam_zones = self.cfg.get("zones") or []
        if not cam_zones:
            return detections  # no zones at all → unrestricted
        self._ensure_zone_image()
        h_f, w_f = frame.shape[:2]
        # Stage 1: prebaked global-zone image. Labels covered by at least
        # one global zone go through this fast path. Cheap pixel lookup.
        zone_resized = None
        if self._zone_image is not None:
            h_z, w_z = self._zone_image.shape[:2]
            if (h_z, w_z) != (h_f, w_f):
                zone_resized = cv2.resize(self._zone_image, (w_f, h_f), interpolation=cv2.INTER_NEAREST)
            else:
                zone_resized = self._zone_image
        # Build the per-label zone list AND a parallel "global zones"
        # list. Both carry full polygon dicts (not just points) so we can
        # extract trigger flags (save_photo/save_video/send_telegram) from
        # the matching zone and tag them onto the surviving detection.
        labeled: dict[str, list] = {}
        global_polys: list = []
        for z in cam_zones:
            if not isinstance(z, dict):
                continue
            pts = z.get("points") or []
            if not isinstance(pts, list) or len(pts) < 3:
                continue
            zlabels = z.get("labels") or []
            if not zlabels:
                global_polys.append(z)
            else:
                for L in zlabels:
                    labeled.setdefault(L, []).append(z)
        kept: list = []
        for d in detections:
            x1, y1, x2, y2 = d.bbox
            cx = max(0, min(w_f - 1, (x1 + x2) // 2))
            cy = max(0, min(h_f - 1, (y1 + y2) // 2))
            global_applies = zone_resized is not None
            label_zones = labeled.get(d.label, [])
            if not global_applies and not label_zones:
                # No zone targets this label at all → pass through freely.
                kept.append(d)
                continue
            matched_zone = None
            # Prefer a label-scoped zone match (more specific) over global.
            for z in label_zones:
                if self._point_in_poly(cx, cy, z.get("points") or [], w_f, h_f):
                    matched_zone = z
                    break
            if matched_zone is None and global_applies and zone_resized[cy, cx] > 0:
                # Locate which global polygon contains the point so we can
                # forward its trigger flags. The prebaked image only tells
                # us "yes, inside SOMETHING" — we need the dict for flags.
                for z in global_polys:
                    if self._point_in_poly(cx, cy, z.get("points") or [], w_f, h_f):
                        matched_zone = z
                        break
            if matched_zone is not None:
                d.zone_flags = {
                    "save_photo":    bool(matched_zone.get("save_photo",    True)),
                    "save_video":    bool(matched_zone.get("save_video",    True)),
                    "send_telegram": bool(matched_zone.get("send_telegram", True)),
                }
                kept.append(d)
            else:
                log.debug("[%s] Detection '%s' (%.0f%%) outside applicable zones at (%d,%d)",
                          self.camera_id, d.label, d.score * 100, cx, cy)
        return kept

    def _motion_detect(self, frame):
        """Returns (labels: list[str], motion_bbox: tuple|None).
        motion_bbox is (x, y, w, h) bounding rect of all motion combined.
        Applies per-camera exclusion masks and motion_sensitivity threshold.
        Brightness-normalises both frames before diff to suppress cloud/sun transitions."""
        # Per-camera kill-switch — skips all motion work (saves CPU when
        # the camera is in objects-only mode).
        if not self.cfg.get("motion_enabled", True):
            return [], None, False
        proc = self.global_cfg.get("processing", {}).get("motion", {})
        if not proc.get("enabled", True):
            return [], None, False
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
            return [], None, False
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
        # Apply camera exclusion masks: zero out masked regions. Reuses
        # the cached mask image (_ensure_mask_image() rebuilds only on
        # signature changes) so this stays cheap per frame.
        self._ensure_mask_image()
        if self._mask_image is not None:
            h_t, w_t = thresh.shape[:2]
            if self._mask_image.shape[:2] != (h_t, w_t):
                mask_resized = cv2.resize(self._mask_image, (w_t, h_t), interpolation=cv2.INTER_NEAREST)
            else:
                mask_resized = self._mask_image
            thresh = cv2.bitwise_and(thresh, mask_resized)
        # Apply inclusion zones — keep only motion that happens inside at
        # least one zone. The cached _zone_image is None when no zones are
        # configured, in which case this is a no-op.
        self._ensure_zone_image()
        if self._zone_image is not None:
            h_t, w_t = thresh.shape[:2]
            if self._zone_image.shape[:2] != (h_t, w_t):
                zone_resized = cv2.resize(self._zone_image, (w_t, h_t), interpolation=cv2.INTER_NEAREST)
            else:
                zone_resized = self._zone_image
            thresh = cv2.bitwise_and(thresh, zone_resized)
        # Per-camera sensitivity → scales minimum contour area
        sensitivity = self.cfg.get("motion_sensitivity")
        h_f, w_f = frame.shape[:2]
        frame_area = h_f * w_f
        base_min_area = frame_area * 0.005
        if sensitivity is not None:
            sensitivity = float(sensitivity)
            min_area = int(base_min_area / max(0.1, sensitivity))
        else:
            min_area = int(proc.get("min_area", 3000))
        # Wildlife uses a parallel, more sensitive threshold so small animals
        # (squirrel/fox/hedgehog) can wake the wildlife classifier even when
        # the normal motion gate doesn't fire. 0.0 = "auto" → 1.4× the normal
        # sensitivity, capped at 1.0.
        wl_sens = self.cfg.get("wildlife_motion_sensitivity")
        if wl_sens is None or float(wl_sens) <= 0.0:
            base_sens = float(sensitivity) if sensitivity is not None else 0.5
            wl_sens = min(1.0, base_sens * 1.4)
        else:
            wl_sens = float(wl_sens)
        wl_min_area = int(base_min_area / max(0.1, wl_sens))
        # Minimum changed-pixel count: a global brightness shift produces many small
        # changed pixels but no large contour. We use a 0.5% floor (down from 1%)
        # so a single squirrel/fox can still trigger the wildlife threshold —
        # the actual per-contour size check below remains the primary filter
        # for real motion vs. noise.
        h_f2, w_f2 = thresh.shape[:2]
        if int(np.sum(thresh > 0)) < int(h_f2 * w_f2 * 0.005):
            return [], None, False
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # Two parallel checks against the same contour set — cheap.
        big_normal = [c for c in contours if cv2.contourArea(c) >= min_area]
        big_wl     = [c for c in contours if cv2.contourArea(c) >= wl_min_area]
        wildlife_motion_low = bool(big_wl) and not big_normal
        if not big_normal:
            # Normal motion didn't trigger — but tell the caller whether the
            # lower wildlife threshold did so the wildlife stage can still
            # run. No labels/bbox returned in this case (no event).
            return [], None, wildlife_motion_low
        all_pts = np.concatenate(big_normal)
        bbox = cv2.boundingRect(all_pts)
        return ["motion"], bbox, wildlife_motion_low

    def _crop(self, frame, bbox):
        x1, y1, x2, y2 = bbox
        return frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]

    def _build_event_meta(self, ts: datetime, labels: list, detections: list,
                          drawn_frame, effective_bbox) -> dict:
        """Snapshot of all event metadata at the moment motion recording starts."""
        event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
        top_det = max(detections, key=lambda d: d.score, default=None)
        cat_match = next((d.identity for d in detections if d.label == "cat" and d.identity), None)
        person_match = next((d.identity for d in detections if d.label == "person" and d.identity), None)
        bird_species = next((d.species for d in detections if d.label == "bird" and d.species), None)
        sched = self.cfg.get("schedule") or {}
        # "Hart-Modus" — when active, person → alarm regardless of profile.
        # When the schedule is disabled this is treated as 24/7 active so a
        # user with no schedule still gets the historic person→alarm
        # promotion via choose_alarm_level's profile rules.
        hard_active = schedule_action_active(sched, "hard")
        whitelisted = bool(person_match and (person_match in (self.cfg.get("whitelist_names") or [])))
        if self.person_registry and person_match:
            p = self.person_registry.get_profile(person_match) or {}
            whitelisted = whitelisted or bool(p.get("whitelisted"))
        profile = (self.cfg.get("alarm_profile") or "").strip() or "soft"
        level, notify = choose_alarm_level(profile, list(sorted(set(labels))), hard_active, whitelisted)
        # "Stumm" kill-switch: armed=false suppresses all Telegram alerts
        # but keeps the event recording and archive path intact.
        if not self.cfg.get("armed", True):
            notify = False
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
        # Aggregate per-zone trigger flags across all surviving detections.
        # OR-rule: if ANY detection sits in a zone that allows snapshot/
        # video/telegram, the event keeps that channel on. A detection
        # without zone_flags (no zones configured, or motion-only event)
        # contributes True for all three — preserves legacy behaviour.
        ev_save_photo = False
        ev_save_video = False
        ev_send_tg    = False
        any_with_flags = False
        for d in detections:
            f = getattr(d, "zone_flags", None)
            if f is None:
                ev_save_photo = ev_save_video = ev_send_tg = True
            else:
                any_with_flags = True
                if f.get("save_photo",    True): ev_save_photo = True
                if f.get("save_video",    True): ev_save_video = True
                if f.get("send_telegram", True): ev_send_tg    = True
        if not any_with_flags and not detections:
            # Motion-only event: keep legacy defaults.
            ev_save_photo = ev_save_video = ev_send_tg = True
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
            # `after_hours` historically meant "alerting schedule active"; we
            # keep the key for read-side compatibility (event JSONs already on
            # disk) but its value is now the schedule's hard-mode gate.
            "after_hours": hard_active,
            "notify": notify,
            "thumb_bytes": thumb_bytes,
            # Per-event recording switches derived from zone trigger flags.
            "save_photo":    ev_save_photo,
            "save_video":    ev_save_video,
            "send_telegram": ev_send_tg,
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
        # Telegram alert is fired once, by the modern push pipeline in
        # _finalize_motion_clip via TelegramService.send_event_alert. The
        # legacy send_alert_sync alert that used to live here was a duplicate
        # — it produced a second bubble per detection with a different button
        # layout and confused users. Removed.

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
                    ach_msg = (f"🌿 Neue Sichtung entdeckt: {bird_species}!\n"
                               f"📷 Kamera: {self.cfg.get('name', self.camera_id)}")
                    threading.Thread(target=self.notifier.send_alert_sync,
                                     kwargs={"caption": ach_msg}, daemon=True).start()
                except Exception:
                    pass

        # Telegram — gate the event through the same camera-level switches
        # the old code respected (armed, zone send_telegram, telegram_enabled,
        # notify-from-alarm-profile), then hand the event to the push system
        # which makes the final decision (label-config, threshold, suppress,
        # rate-limit, quiet/night).
        notify = meta.get("notify", False)
        if not self.cfg.get("armed", True):
            notify = False
        if not meta.get("send_telegram", True):
            notify = False
        if notify and self.cfg.get("telegram_enabled", True) and self.notifier:
            try:
                snap_path = (Path(self.global_cfg["storage"]["root"]) / thumb_rel) if thumb_rel else None
                if hasattr(self.notifier, "send_event_alert"):
                    self.notifier.send_event_alert(
                        meta=meta,
                        camera_id=self.camera_id,
                        snapshot_path=snap_path,
                    )
                else:
                    # Older notifier: fall back to legacy caption builder so
                    # local dev environments without the push system still
                    # produce alerts.
                    labels = meta["labels"]
                    level = meta.get("alarm_level")
                    caption = (f"{'🚨' if level == 'alarm' else 'ℹ️'} "
                               f"{', '.join(sorted(set(labels)))} · "
                               f"{self.cfg.get('name', self.camera_id)}")
                    self.notifier.send_alert_sync(
                        caption=caption,
                        jpeg_bytes=meta.get("thumb_bytes"),
                        snapshot_url=video_url,
                        dashboard_url=public_base,
                        camera_id=self.camera_id,
                    )
            except Exception as e:
                log.warning("[%s] telegram event push failed: %s", self.camera_id, e)

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
                # Merge per-window capture stats (_stats.json next to the
                # frames). Empty dict if missing — the build still writes a
                # sidecar with everything else.
                from .frame_helpers import read_capture_stats
                cap_stats = read_capture_stats(frames_dir)
                if cap_stats:
                    meta["capture_stats"] = cap_stats
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
            # Push the finished video to Telegram. Gated by push.timelapse.enabled
            # inside the notifier, so a global toggle disables this without
            # touching the camera config.
            try:
                if self.notifier and hasattr(self.notifier, "send_timelapse_alert"):
                    profile_de = {
                        "daily":   "Tag",
                        "weekly":  "Woche",
                        "monthly": "Monat",
                        "custom":  "Custom",
                    }.get(profile_name, profile_name)
                    self.notifier.send_timelapse_alert(
                        video_path=out_path,
                        cam_name=self.cfg.get("name", self.camera_id),
                        profile_de=profile_de,
                        duration_s=int(target_s),
                        rel_path=video_rel,
                    )
            except Exception as e:
                log_tl.warning("[%s][timelapse] push failed: %s", self.camera_id, e)
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
        from .frame_helpers import is_valid_frame as _fh_valid, CaptureStats as _CaptureStats
        window_key: str | None = None
        window_start_t: float = 0.0
        _last_frame_ts: float = 0.0   # frame_ts at last capture — detects stale buffer
        # Per-window stats. Replaced when the window key rolls over so each
        # day/period gets its own _stats.json next to its frames.
        stats: _CaptureStats | None = None
        stats_window_key: str | None = None
        # Per-profile stale streak — local instead of a self. attribute so
        # two profiles running at different cadences don't corrupt each
        # other's counter. self._stale_streak is still written for the
        # status UI (acts as a "max recent" mirror).
        stale_streak: int = 0

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
                        stale_streak += 1
                        self._stale_streak = stale_streak  # mirror for status UI
                        # Noise control: only surface streak 1 and 5 at
                        # WARNING (first sign + "this is getting bad"),
                        # everything in between goes to DEBUG. The reconnect
                        # decision still uses the full streak.
                        if stale_streak in (1, 5):
                            log_tl.warning("[%s][%s] stale frame buffer (age=%.0fs, streak=%d) — RTSP stream may be stuck",
                                          self.camera_id, profile_name, age_s, stale_streak)
                        else:
                            log_tl.debug("[%s][%s] stale frame buffer (age=%.0fs, streak=%d)",
                                         self.camera_id, profile_name, age_s, stale_streak)
                        # After 15 consecutive stale intervals, request a forced RTSP reconnect
                        if stale_streak >= 15 and not self._force_reconnect:
                            log_tl.error("[%s][%s] stale streak exceeded threshold — requesting RTSP reconnect",
                                        self.camera_id, profile_name)
                            self._force_reconnect = True
                        # Don't advance _last_frame_ts so we keep detecting stale each interval
                    else:
                        _last_frame_ts = frame_ts
                        if stale_streak > 0:
                            log_cam.info("[%s][%s] stream recovered after %d stale intervals",
                                         self.camera_id, profile_name, stale_streak)
                        stale_streak = 0  # reset local streak on any fresh frame
                        self._stale_streak = 0  # clear the UI mirror too
                        # Resolve the per-window stats container (lazy: first
                        # frame in a window gets a fresh CaptureStats keyed
                        # to that window's frame directory).
                        tl_dir = (Path(self.global_cfg["storage"]["root"])
                                  / "timelapse_frames" / self.camera_id
                                  / profile_name / window_key)
                        if stats is None or stats_window_key != window_key:
                            tl_dir.mkdir(parents=True, exist_ok=True)
                            stats = _CaptureStats(out_dir=tl_dir,
                                                  expected_frames=int(period_s / max(0.5, interval_s)))
                            stats_window_key = window_key
                        # Three-attempt validity check. The shared frame buffer
                        # is refreshed by the main RTSP loop, so a 0.7 s pause
                        # between attempts gives the decode loop time to
                        # produce a fresh frame past the hickup. We only
                        # attempt up to 3 times — past that the slot stays
                        # empty (gap-tolerant: ffmpeg concat just skips it).
                        ok, reason = _fh_valid(frame)
                        attempt_used = 0
                        # For the daily profile we emit a per-rejection INFO
                        # line on every failed attempt — diagnostic to
                        # explain dawn-hour gaps in the assembled video.
                        # Other profiles stay on the existing post-3-attempts
                        # summary to keep the log volume sane.
                        if not ok and profile_name == "daily":
                            log_tl.info(
                                "[timelapse] %s/daily reject @ %s (attempt 1): %s",
                                self.camera_id, now.strftime("%H:%M:%S"), reason,
                            )
                        if not ok:
                            for retry in range(1, 3):
                                time.sleep(0.7)
                                with self.lock:
                                    cand = self.frame.copy() if self.frame is not None else None
                                if cand is None:
                                    continue
                                ok, reason = _fh_valid(cand)
                                if not ok and profile_name == "daily":
                                    log_tl.info(
                                        "[timelapse] %s/daily reject @ %s (attempt %d): %s",
                                        self.camera_id, datetime.now().strftime("%H:%M:%S"),
                                        retry + 1, reason,
                                    )
                                if ok:
                                    frame = cand
                                    attempt_used = retry
                                    break
                        if not ok:
                            stats.record_invalid()
                            log_tl.info("[timelapse] %s frame %s: 3 invalid grabs, leaving slot empty (%s)",
                                        self.camera_id, now.strftime("%H%M%S_%f")[:10], reason)
                        else:
                            ts = now.strftime("%H%M%S_%f")[:10]
                            out = tl_dir / f"{ts}.jpg"
                            cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])
                            stats.record_capture(attempt_used=attempt_used)
                            log_tl.debug("[%s][%s] frame saved: %s window=%s (%.2fs/frame, q=%d, attempt=%d)",
                                      self.camera_id, profile_name, out.name, window_key, interval_s, jpeg_q,
                                      attempt_used + 1)
                        # Cheap to flush each interval; lets the build path
                        # see partial-window stats if it runs while capture
                        # is still going.
                        stats.flush()
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

        # ── Watchdog: hard-kill a wedged capture handle ──────────────────
        # CAP_PROP_READ_TIMEOUT_MSEC isn't reliably honoured across every
        # OpenCV/FFmpeg build — some combos still block forever on a dead
        # TCP half-open. The watchdog releases the capture after 20 s of
        # silence so the next loop iteration is guaranteed to enter the
        # reconnect branch via self.capture becoming None / not-opened.
        # Updated on every successful frame inside the loop below.
        self._last_activity = time.time()
        def _watchdog():
            while self.running:
                time.sleep(10.0)
                if not self.running:
                    return
                if self.cfg.get("rtsp_url") and (time.time() - self._last_activity) > 20:
                    log_cam.warning("[%s] watchdog: capture silent >20s, forcing release",
                                    self.camera_id)
                    try:
                        if self.capture is not None:
                            self.capture.release()
                    except Exception:
                        pass
                    self.capture = None
                    # Bump the activity marker so we don't fire again on the
                    # very next tick before the reconnect attempt completes.
                    self._last_activity = time.time()
        threading.Thread(target=_watchdog, daemon=True,
                         name=f"cam-wd-{self.camera_id}").start()

        while self.running:
            # Timelapse threads may request a forced reconnect when they detect a stale stream
            if self._force_reconnect:
                self._force_reconnect = False
                self._stale_streak = 0
                log_cam.warning(
                    "[cam:%s] forced reconnect — stale-feed recovery "
                    "(stale_streak=%d, last_frame_age=%.0fs, reconnects_24h=%d)",
                    self.camera_id, self._stale_streak,
                    (time.time() - self.frame_ts) if self.frame_ts > 0 else 0,
                    self._reconnect_count_24h(),
                )
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                self._reconnect_count += 1
                self._reconnect_log.append(time.time())
                time.sleep(2.0)
                continue
            try:
                frame = self._grab_frame()
                # Always store raw frame so status → "active" and snapshots work
                with self.lock:
                    self.frame = frame
                    self.frame_ts = time.time()
                # First decoded frame after an open() — log latency so the
                # operator can confirm a reconnect actually recovered the
                # stream. Only fires once per open cycle.
                if self._rtsp_opened_at and not self._rtsp_first_frame_logged:
                    latency_ms = int((time.time() - self._rtsp_opened_at) * 1000)
                    masked = self._masked_rtsp_url()
                    log_cam.info("[cam:%s] RTSP opened — %s · first frame in %d ms",
                                 self.camera_id, masked, latency_ms)
                    self._rtsp_first_frame_logged = True
                    self._last_rtsp_success_ts = time.time()
                # Feed the watchdog — any successful grab resets the silence clock.
                self._last_activity = time.time()
                if self._error_streak > 0:
                    downtime_s = int(time.time() - (self._last_rtsp_success_ts or self._rtsp_opened_at or time.time()))
                    log_cam.info("[cam:%s] frame flow recovered after %d errors (downtime≈%ds)",
                                 self.camera_id, self._error_streak, downtime_s)
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
                motion_labels, motion_bbox, wildlife_motion_low = self._motion_detect(proc_frame)
                # Multi-frame confirmation: only trigger on motion in ≥2 of last 3 frames.
                # Two parallel deques — one for the regular threshold (which gates
                # event recording + COCO) and one for the lower wildlife threshold
                # (which extends the gate for the wildlife classifier only).
                self._motion_confirm.append(1 if motion_labels else 0)
                # Wildlife deque counts BOTH normal motion and wildlife-only motion;
                # wildlife is by definition more sensitive, so anything that
                # registers as normal motion must also register as wildlife motion.
                self._motion_confirm_wl.append(1 if (motion_labels or wildlife_motion_low) else 0)
                motion_confirmed = sum(self._motion_confirm) >= 2
                wlmotion_confirmed = sum(self._motion_confirm_wl) >= 2
                wildlife_motion_only = wlmotion_confirmed and not motion_confirmed
                effective_motion = motion_labels if motion_confirmed else []
                effective_bbox = motion_bbox if motion_confirmed else None
                cam_min_score = self.cfg.get("detection_min_score") or None
                # Per-label confidence overrides (e.g. {"person": 0.72}).
                # Used to suppress false-positive person detections on
                # static garden cameras without affecting recall on
                # cat/bird/etc.
                label_thresholds = self.cfg.get("label_thresholds") or None
                _t0 = time.time()
                detections = self.detector.detect_frame(
                    proc_frame,
                    min_score=cam_min_score,
                    label_thresholds=label_thresholds,
                    cam_id=self.camera_id,
                )
                # Track a rolling-average inference latency for the /status
                # bubble. Cheap (one append + one slice) and gives operators
                # a visible sign that the Coral path is healthy.
                self._inference_times_ms.append((time.time() - _t0) * 1000.0)
                allowed = set(self.cfg.get("object_filter") or [])
                if allowed:
                    detections = [d for d in detections if d.label in allowed]
                # Exclusion mask first: drop detections inside masked
                # regions before zone filtering or any second-stage
                # classification runs. Applied BEFORE the bird / cat /
                # person classifiers so we don't waste cycles on a crop
                # we're about to drop.
                detections = self._filter_masked_detections(proc_frame, detections)
                # Inclusion zones next: if any zones are defined, keep
                # only detections whose centre lies inside a zone.
                # Masks + zones compose: detect inside zones BUT exclude
                # masked areas within zones.
                detections = self._filter_zoned_detections(proc_frame, detections)
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
                # Wildlife second-stage: catches fox / squirrel / hedgehog —
                # none of which have a COCO class. Gating logic:
                #   - Confident COCO bird / dog / person → skip wildlife.
                #     These animals genuinely look like themselves to COCO,
                #     no point second-guessing.
                #   - Confident COCO cat (≥0.92) → skip wildlife. Anything
                #     below that threshold is a "soft cat" that COCO often
                #     emits on frontal-sitting squirrels; we keep wildlife
                #     in the running and let it overrule a soft cat below.
                hard_skip_labels = ("bird", "dog", "person")
                soft_cat = next(
                    (d for d in detections if d.label == "cat" and d.score < 0.92),
                    None,
                )
                hard_cat = any(d.label == "cat" and d.score >= 0.92 for d in detections)
                if (
                    (motion_confirmed or wildlife_motion_only)
                    and self.wildlife_classifier.available
                    and not any(d.label in hard_skip_labels for d in detections)
                    and not hard_cat
                ):
                    try:
                        wl_min = self.cfg.get("wildlife_min_score") or None
                        cat, raw_lbl, wscore = self.wildlife_classifier.classify_crop(
                            proc_frame, min_score=wl_min,
                        )
                    except Exception:
                        cat, raw_lbl, wscore = None, None, None
                    if cat and (not allowed or cat in allowed):
                        h0, w0 = proc_frame.shape[:2]
                        # Localise the animal: re-run COCO at a low threshold
                        # and pick the bbox of any animal-shaped class
                        # (cat/dog/bear/sheep/cow). The label is wrong but
                        # the geometry is right — we only borrow the bbox.
                        # Falls back to the motion bbox, then the full frame.
                        bb = _refine_wildlife_bbox(
                            self.detector, proc_frame, effective_bbox, (w0, h0),
                        )
                        wl_det = Detection(
                            label=cat,
                            score=float(wscore) if wscore is not None else 0.5,
                            bbox=bb,
                            species=raw_lbl,
                            species_score=float(wscore) if wscore is not None else None,
                        )
                        survivors = self._filter_masked_detections(proc_frame, [wl_det])
                        survivors = self._filter_zoned_detections(proc_frame, survivors)
                        if survivors:
                            # Cat-vs-squirrel override: COCO often calls a
                            # frontal squirrel "cat" with moderate
                            # confidence. If wildlife is sure enough, drop
                            # the soft-cat detection and let squirrel win.
                            if cat == "squirrel" and soft_cat is not None and float(wscore or 0) >= 0.45:
                                log.info(
                                    "[%s] cat→squirrel override: cat %.2f replaced by wildlife squirrel %.2f",
                                    self.camera_id, soft_cat.score, float(wscore),
                                )
                                detections = [d for d in detections if d is not soft_cat]
                                labels = [L for L in labels if L != "cat"]
                            # Confident squirrel → suppress overlapping COCO
                            # false-positives (cat/dog/bear/teddy bear) so
                            # the event isn't double-labelled. The whole
                            # project's purpose is squirrel detection — once
                            # the wildlife model is sure, COCO's misreads on
                            # the same patch become noise.
                            if cat == "squirrel" and float(wscore or 0) >= 0.55:
                                pre = len(detections)
                                detections = _suppress_overlap(
                                    detections, bb,
                                    drop_labels=("cat", "dog", "bear", "teddy bear"),
                                    iou_min=0.3,
                                )
                                if len(detections) != pre:
                                    labels = [L for L in labels
                                              if L not in ("cat", "dog", "bear", "teddy bear")
                                              or any(d.label == L for d in detections)]
                            detections.append(wl_det)
                            labels.append(cat)
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
                # Per-camera trigger mode:
                #   motion_and_objects (default) — motion OR object fires event
                #   objects_only                 — motion alone ignored; objects
                #                                  still carry motion in metadata
                #   motion_only                  — only motion fires; objects
                #                                  are still labelled for metadata
                trigger_mode = self.cfg.get("detection_trigger", "motion_and_objects")
                object_labels = [d.label for d in detections]
                if trigger_mode == "objects_only":
                    has_motion = bool(object_labels)
                    labels = sorted(set(effective_motion + object_labels)) if has_motion else []
                elif trigger_mode == "motion_only":
                    has_motion = bool(effective_motion)
                    labels = sorted(set(effective_motion + object_labels)) if has_motion else []
                else:
                    has_motion = bool(labels)

                # Per-camera unified schedule — record action gate. Outside
                # the configured window (or when actions.record is off) we
                # still detect, but never start a new on-disk event.
                # In-progress recordings finalize normally (gate only fires
                # when has_motion AND we're not already recording).
                if has_motion and not self._recording:
                    if not schedule_action_active(self.cfg.get("schedule") or {}, "record"):
                        time.sleep(interval)
                        continue

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
                    _post_tail = float(
                        self.cfg.get("post_motion_tail_s")
                        or self.global_cfg.get("processing", {}).get("post_motion_tail_s", 3.0)
                    )
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
                                # Zone trigger flag: if every detection in
                                # this event sits in a zone with save_video
                                # turned off, skip recording entirely. Cheap
                                # short-circuit before ffmpeg launches.
                                if not rec_meta.get("save_video", True):
                                    log.debug("[%s] event %s: save_video=False, skipping clip",
                                              self.camera_id, rec_meta.get("event_id"))
                                    continue
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
                        # Build event meta first so we know whether the
                        # zone(s) the detections fell into actually want a
                        # photo saved. save_photo:false zones still log the
                        # event JSON but skip the JPEG write.
                        ev_meta = self._build_event_meta(ts, labels, detections, drawn, effective_bbox)
                        snap_path = day_dir / f"{event_id}.jpg"
                        rel = snap_path.relative_to(Path(self.global_cfg["storage"]["root"]))
                        public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
                        snapshot_url = None
                        if ev_meta.get("save_photo", True):
                            save_frame = drawn.copy()
                            if effective_bbox is not None:
                                mx, my, mw, mh = effective_bbox
                                cv2.rectangle(save_frame, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2)
                            h_px, w_px = save_frame.shape[:2]
                            if w_px > 1280:
                                scale = 1280 / w_px
                                save_frame = cv2.resize(save_frame, (1280, int(h_px * scale)), interpolation=cv2.INTER_AREA)
                            cv2.imwrite(str(snap_path), save_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                            snapshot_url = f"{public_base}/media/{rel.as_posix()}" if public_base else None
                        event = {
                            "event_id": event_id,
                            "camera_id": self.camera_id,
                            "camera_name": self.cfg.get("name", self.camera_id),
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
                            "snapshot_relpath": rel.as_posix() if snapshot_url else None,
                            "video_url": None,
                            "video_relpath": None,
                        }
                        self.store.add_event(self.camera_id, event)
                        if self.mqtt and self.cfg.get("mqtt_enabled", True):
                            self.mqtt.publish(f"events/{self.camera_id}", event)
                        _send_tg = ev_meta["notify"] and self.cfg.get("telegram_enabled", True)
                        # Defensive: "Stumm" cameras never send Telegram.
                        if not self.cfg.get("armed", True):
                            _send_tg = False
                        if not ev_meta.get("send_telegram", True):
                            _send_tg = False
                        if _send_tg and self.notifier:
                            # Only attach the JPEG when one was actually
                            # written. If save_photo was off, fall back to
                            # the in-memory thumb_bytes from ev_meta.
                            thumb = ev_meta.get("thumb_bytes")
                            if snapshot_url:
                                try:
                                    with open(snap_path, "rb") as fh:
                                        thumb = fh.read()
                                except Exception:
                                    pass
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
                self._reconnect_log.append(time.time())
                # Short backoff for transient dropouts, longer for persistent failures
                sleep_t = 2.0 if self._error_streak <= 3 else min(30.0, 5.0 * (self._error_streak // 5 + 1))
                time.sleep(sleep_t)
            time.sleep(interval)

    def record_adhoc_clip(self, seconds: int) -> str | None:
        """Capture a `seconds`-long mp4 from the live RTSP stream.

        Used by the Telegram menu's "Clip 5/15/30 s". Stream-copies the
        camera's H.264 directly into mp4 — no transcode, fast, ~1× wallclock.
        Returns the absolute path on success, None on failure.
        """
        if seconds <= 0 or seconds > 60:
            return None
        rtsp = self.cfg.get("rtsp_url")
        if not rtsp:
            return None
        if not _FFMPEG_AVAILABLE:
            log.warning("[%s] adhoc clip: ffmpeg unavailable", self.camera_id)
            return None
        out_dir = Path(self.global_cfg["storage"]["root"]) / "adhoc_clips" / self.camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = out_dir / f"adhoc-{ts}-{seconds}s.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-rtsp_transport", "tcp",
            "-i", rtsp,
            "-t", str(int(seconds)),
            "-c", "copy",
            "-movflags", "+faststart",
            str(out_path),
        ]
        try:
            # Generous timeout: allow seconds + 5s startup + 5s flush.
            proc = _subprocess.run(cmd, capture_output=True, timeout=int(seconds) + 10)
            if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 1024:
                log.warning("[%s] adhoc clip ffmpeg rc=%s stderr=%s",
                            self.camera_id, proc.returncode,
                            proc.stderr.decode("utf-8", "replace")[-300:])
                return None
            log.info("[%s] adhoc clip recorded: %s (%d bytes)",
                     self.camera_id, out_path.name, out_path.stat().st_size)
            return str(out_path)
        except Exception as e:
            log.warning("[%s] adhoc clip failed: %s", self.camera_id, e)
            return None

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
            "inference_avg_ms": (sum(self._inference_times_ms) / len(self._inference_times_ms))
                                if self._inference_times_ms else None,
            "reconnect_count_24h": self._reconnect_count_24h(),
        }

    def _masked_rtsp_url(self) -> str:
        """Return the configured rtsp_url with the password replaced by
        '•••' so log lines and operator messages don't leak credentials.
        Falls back to the bare host when the URL has no embedded creds."""
        url = self.cfg.get("rtsp_url", "") or ""
        if not url or "://" not in url:
            return url
        try:
            scheme, rest = url.split("://", 1)
            if "@" in rest:
                creds, host = rest.rsplit("@", 1)
                if ":" in creds:
                    user, _ = creds.split(":", 1)
                    return f"{scheme}://{user}:•••@{host}"
        except Exception:
            pass
        return url

    def _reconnect_count_24h(self) -> int:
        """Prune reconnect log entries older than 24 h on each read, then
        return the count. Cheap because the log only ever contains
        reconnect events (rare on a healthy cam, capped naturally by the
        stream-watchdog cadence on a flaky one)."""
        cutoff = time.time() - 86400
        log = self._reconnect_log
        while log and log[0] < cutoff:
            log.popleft()
        return len(log)

"""CameraRuntime + WeatherPrebuffer.

CameraRuntime is decomposed via mixins; the public class lives here so
`from .camera_runtime import CameraRuntime` keeps working byte-for-byte.
Method definitions live in _lifecycle / _capture / _zones / _motion /
_recording / _timelapse / _status / _main_loop. Only __init__ stays here.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2

from ..detection_confirmer import DetectionConfirmer
from ..detectors import (
    BirdSpeciesClassifier,
    CoralObjectDetector,
    WildlifeClassifier,
)
from ._capture import CaptureMixin
from ._consts import log  # noqa: F401  (kept for parity with original module log binding)
from ._lifecycle import LifecycleMixin
from ._main_loop import MainLoopMixin
from ._motion import MotionMixin
from ._recording import RecordingMixin
from ._status import StatusMixin
from ._timelapse import TimelapseMixin
from ._zones import ZonesMixin


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


class CameraRuntime(
    LifecycleMixin,
    CaptureMixin,
    ZonesMixin,
    MotionMixin,
    RecordingMixin,
    TimelapseMixin,
    StatusMixin,
    MainLoopMixin,
):
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
        # N-of-M confirmation gate — per-runtime instance so its state
        # (per-(cam,label) deque) dies cleanly when the runtime restarts.
        self._confirmer = DetectionConfirmer()
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

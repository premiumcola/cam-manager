"""Background object-tracking worker.

Phase 1: after every motion clip is finalized, generate a `tracks.json`
sidecar next to the mp4. The sidecar carries per-frame bounding boxes
with stable track IDs so the lightbox can render boxes synced to video
playback (Phase 2).

Design:
- Single daemon thread, low priority. One queue.Queue() of jobs.
- Each job runs detection at ~1 Hz across the clip, associates detections
  to tracks via IoU (>0.3 threshold), and writes a sparse-sample JSON.
- The mp4 is NEVER modified — tracks.json is purely a subtitle-style
  sidecar. Re-indexing overwrites the JSON only.
- Per-frame CSRT tracking between detection samples is intentionally NOT
  implemented in Phase 1. opencv-python-headless 4.10 (the runtime image)
  doesn't ship the contrib tracking modules, and a 1 Hz sample rate plus
  client-side linear interpolation already gives smooth box motion in
  the lightbox without a dependency change. The schema reserves
  `source: "track"` so a future CSRT pass can fill in dense samples
  without breaking compatibility.
"""
from __future__ import annotations

import collections
import json
import logging
import os
import queue
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

# Schema version of the tracks.json file. Bump when the shape changes;
# the reindex-all endpoint uses schema mismatch as the trigger to re-queue
# stale sidecars.
#
#   v1 — initial release (schema, video_path, fps, frame_count, duration_s,
#        best_frame, tracks, built_at).
#   v2 — adds top-level "filter_applied": list[str] | None recording the
#        camera's object_filter at write time. Detections with labels
#        outside the filter are dropped BEFORE track association, so the
#        sidecar only carries tracks the camera would have notified on.
#        None means "no filter, all classes accepted" (distinct from an
#        empty list).
TRACKS_SCHEMA = 2

# Detection-job timing target. A 30-second clip should finish in
# under ~10 s on CPU; anything slower triggers a one-line WARN so the
# operator notices a degraded run without losing frames.
SLOW_JOB_RATIO = 1.0 / 3.0  # processing time / clip duration

# Track-association tuning.
IOU_MATCH_THRESHOLD = 0.30
TRACK_MISS_WINDOWS = 2          # how many sample windows a track may go un-matched
SAMPLE_BBOX_DELTA_PX = 2        # skip samples whose bbox didn't move by ≥ this many px


@dataclass
class TrackingJob:
    event_id: str
    video_path: Path
    snapshot_path: Path | None
    camera_id: str


def _short_id() -> str:
    """6-hex-char id for a track. Stable across the clip but not globally
    unique — the (event_id, track_id) pair is what callers index on."""
    return uuid.uuid4().hex[:6]


def _color_for_track(track_id: str) -> str:
    """Deterministic 6-char hex colour from the track id. The lightbox
    overlay uses this to keep each subject visually distinct without a
    server-side palette table. Picks from a hue-spread set of saturated
    colours so two adjacent tracks never collide."""
    palette = [
        "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7",
        "#14b8a6", "#ec4899", "#84cc16", "#f97316", "#06b6d4",
        "#eab308", "#8b5cf6", "#10b981", "#f43f5e", "#0ea5e9",
    ]
    h = sum(ord(c) for c in track_id) % len(palette)
    return palette[h]


def _iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    """Standard intersection-over-union for axis-aligned (x1,y1,x2,y2)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    a_area = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    b_area = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = a_area + b_area - inter
    return inter / union if union > 0 else 0.0


def _bbox_dist_px(a: dict, b: dict) -> float:
    """Centre-to-centre distance in pixels between two bbox dicts. Used
    to suppress sparse samples that haven't moved meaningfully — tiny
    shimmer would inflate the JSON without adding visual information."""
    acx = (a["x1"] + a["x2"]) / 2.0
    acy = (a["y1"] + a["y2"]) / 2.0
    bcx = (b["x1"] + b["x2"]) / 2.0
    bcy = (b["y1"] + b["y2"]) / 2.0
    return ((acx - bcx) ** 2 + (acy - bcy) ** 2) ** 0.5


class _Track:
    """Mutable track state held during a single job. Closed at the end
    and serialised into tracks.json's `tracks` array."""

    __slots__ = ("track_id", "label", "color", "samples",
                 "first_frame", "last_frame", "best_score", "best_frame_idx",
                 "active", "missed_windows")

    def __init__(self, track_id: str, label: str, frame_idx: int):
        self.track_id = track_id
        self.label = label
        self.color = _color_for_track(track_id)
        self.samples: list[dict] = []
        self.first_frame = frame_idx
        self.last_frame = frame_idx
        self.best_score: float = 0.0
        self.best_frame_idx: int = frame_idx
        self.active = True
        self.missed_windows = 0

    def add_sample(self, frame_idx: int, t_s: float, bbox_dict: dict,
                   score: float | None, source: str):
        # Squelch micro-jitter samples — only emit when the bbox moved
        # by ≥ SAMPLE_BBOX_DELTA_PX pixels at the centroid OR this is a
        # detection sample (always kept so score history is preserved).
        if source == "track" and self.samples:
            last = self.samples[-1]["bbox"]
            if _bbox_dist_px(last, bbox_dict) < SAMPLE_BBOX_DELTA_PX:
                return
        self.samples.append({
            "f": frame_idx,
            "t": round(t_s, 3),
            "bbox": bbox_dict,
            "score": (round(float(score), 4) if score is not None else None),
            "source": source,
        })
        self.last_frame = frame_idx
        if score is not None and score > self.best_score:
            self.best_score = float(score)
            self.best_frame_idx = frame_idx
        self.missed_windows = 0

    def to_dict(self) -> dict:
        return {
            "track_id": self.track_id,
            "label": self.label,
            "color": self.color,
            "first_frame": self.first_frame,
            "last_frame": self.last_frame,
            "best_score": round(self.best_score, 4),
            "best_frame": self.best_frame_idx,
            "samples": self.samples,
        }


@dataclass
class _TrackerState:
    """Per-job mutable state shared across the per-frame helpers. Replaces
    the four locals tracks_active / tracks_closed / samples_emitted /
    best_top in the legacy `_run_one` body."""
    active: list = field(default_factory=list)   # list[_Track]
    closed: list = field(default_factory=list)   # list[_Track]
    samples_emitted: int = 0
    best_top: dict | None = None


# ── Per-job pure helpers (R05) ───────────────────────────────────────────
# Module-level so each step is independently readable + unit-testable.
# `TrackingWorker._run_one` composes them with the worker's detector +
# config getters; the helpers themselves never reach back into the worker.

def _open_video(video_path: Path):
    """Open the file and read its sampling cadence. Returns
    ``(capture, meta)``; capture is None on failure (and is released
    before returning so the caller doesn't have to). meta carries
    ``fps``, ``frame_count``, ``duration_s``, ``sample_interval``;
    duration / sample_interval are 0 on failure but fps / frame_count
    are populated so the caller can log them."""
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if frame_count <= 0 or fps <= 0:
        cap.release()
        return None, {
            "fps": fps,
            "frame_count": frame_count,
            "duration_s": 0.0,
            "sample_interval": 0,
        }
    duration_s = frame_count / fps
    sample_interval = max(1, int(round(fps)))  # ~1 Hz
    return cap, {
        "fps": fps,
        "frame_count": frame_count,
        "duration_s": duration_s,
        "sample_interval": sample_interval,
    }


def _resolve_object_filter(cam_cfg_getter, camera_id):
    """Pull the camera's object_filter and translate to the worker's
    allowed-set semantics. Mirrors camera_runtime/_main_loop:
    ``None`` == no filter (all classes pass), set == filter active.
    Filtered classes can't spawn or extend tracks because the filter is
    applied BEFORE association."""
    try:
        cam_cfg = cam_cfg_getter(camera_id) or {}
    except Exception:
        cam_cfg = {}
    of_raw = cam_cfg.get("object_filter")
    if isinstance(of_raw, list) and of_raw:
        return {str(x) for x in of_raw}
    return None


def _detect_and_filter(detector, frame, allowed):
    """One sample's detector pass with the per-frame label filter. Empty
    list when the detector is unavailable (worker stays alive but writes
    a tracks.json with no tracks)."""
    if not detector.available:
        return []
    dets = detector.detect_frame(frame)
    if allowed is not None:
        dets = [d for d in dets if d.label in allowed]
    return dets


def _update_best_top(state: _TrackerState, det, frame_idx: int, t_s: float):
    """Bump state.best_top when det.score beats the current best.
    Lifted to a helper because the legacy code ran this exact 3-line
    block twice — once after the match-loop and once after the spawn
    loop."""
    score = float(det.score)
    if state.best_top is None or score > state.best_top["score"]:
        state.best_top = {
            "f": frame_idx,
            "t": round(t_s, 3),
            "score": round(score, 4),
            "label": det.label,
        }


def _associate_detections(state: _TrackerState, dets, frame_idx: int, t_s: float):
    """Greedy IoU pairing + spawn + age-out for one frame. Mutates
    ``state`` in place: extends matched tracks with a new sample, spawns
    tracks for unmatched detections, ages out tracks that missed too
    many windows.

    The pre-spawn snapshot (`original_count = len(state.active)`) keeps
    freshly-spawned tracks out of the age-out pass on their birth
    frame — without it they'd immediately get missed_windows += 1 and
    halve the intended TRACK_MISS_WINDOWS grace period."""
    # Match each detection to the best-IoU active track of the
    # same label. Greedy assignment per frame — for typical
    # 1-3 detections this is correct and orders-of-magnitude
    # cheaper than Hungarian.
    taken_tracks: set[int] = set()
    taken_dets: set[int] = set()
    pairings: list[tuple[int, int, float]] = []
    for di, d in enumerate(dets):
        for ti, tr in enumerate(state.active):
            if not tr.active or tr.label != d.label:
                continue
            # Compare against the track's most recent bbox.
            if not tr.samples:
                continue
            last = tr.samples[-1]["bbox"]
            last_t = (last["x1"], last["y1"], last["x2"], last["y2"])
            iou = _iou(last_t, d.bbox)
            if iou >= IOU_MATCH_THRESHOLD:
                pairings.append((di, ti, iou))
    # Sort by descending IoU so the best matches consume their
    # partners first.
    pairings.sort(key=lambda p: p[2], reverse=True)
    for di, ti, _iou_v in pairings:
        if di in taken_dets or ti in taken_tracks:
            continue
        taken_dets.add(di)
        taken_tracks.add(ti)
        tr = state.active[ti]
        d = dets[di]
        bbox_dict = {"x1": int(d.bbox[0]), "y1": int(d.bbox[1]),
                     "x2": int(d.bbox[2]), "y2": int(d.bbox[3])}
        tr.add_sample(frame_idx, t_s, bbox_dict,
                      float(d.score), "detect")
        state.samples_emitted += 1
        _update_best_top(state, d, frame_idx, t_s)
    # Snapshot the pre-spawn track count so the age-out loop
    # below can skip tracks that are about to be created on
    # this same frame. Without this, a freshly spawned track
    # is not in `taken_tracks` (which was built from the
    # original indices) and immediately gets missed_windows
    # += 1 on the same frame as its birth — halving the
    # intended TRACK_MISS_WINDOWS grace period.
    original_count = len(state.active)
    # Unmatched detections → start fresh tracks.
    for di, d in enumerate(dets):
        if di in taken_dets:
            continue
        tid = _short_id()
        tr = _Track(tid, d.label, frame_idx)
        bbox_dict = {"x1": int(d.bbox[0]), "y1": int(d.bbox[1]),
                     "x2": int(d.bbox[2]), "y2": int(d.bbox[3])}
        tr.add_sample(frame_idx, t_s, bbox_dict,
                      float(d.score), "detect")
        state.active.append(tr)
        state.samples_emitted += 1
        _update_best_top(state, d, frame_idx, t_s)
    # Age out tracks that didn't get a hit this window. After
    # TRACK_MISS_WINDOWS misses they close — guards against the
    # subject leaving frame and a different one re-entering at
    # the same coordinates. Restricted to indices < original_count
    # so newly-spawned tracks (appended above) skip this pass and
    # get their first miss-check on the NEXT frame iteration.
    for ti, tr in enumerate(state.active[:original_count]):
        if ti in taken_tracks:
            continue
        tr.missed_windows += 1
        if tr.missed_windows >= TRACK_MISS_WINDOWS:
            tr.active = False
    state.closed.extend([t for t in state.active if not t.active])
    state.active = [t for t in state.active if t.active]


def _build_payload(state: _TrackerState, fps: float, frame_count: int,
                   duration_s: float, allowed, video_path: Path,
                   storage_root: Path) -> dict:
    """Assemble the tracks.json payload. The track-serialisation block
    iterates state.closed; the caller is responsible for flushing any
    still-active tracks into closed before this runs."""
    return {
        "schema": TRACKS_SCHEMA,
        "video_path": _safe_relpath(video_path, storage_root),
        "fps": round(float(fps), 3),
        "frame_count": frame_count,
        "duration_s": round(duration_s, 3),
        "best_frame": state.best_top,
        # `filter_applied` records the allowed object_filter at
        # write time. None = no filter (all classes accepted),
        # list = exactly these classes were considered.
        "filter_applied": sorted(allowed) if allowed is not None else None,
        "tracks": [t.to_dict() for t in state.closed],
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }


def _write_payload_atomic(tracks_path: Path, payload: dict) -> None:
    """Atomic write: tmp file + rename. Pattern matches B08."""
    tmp_path = tracks_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(tracks_path)


class TrackingWorker(threading.Thread):
    """Single daemon thread that pulls TrackingJob items off a queue and
    writes tracks.json sidecars. Built once at boot via build_worker()
    in this module; access the singleton via `tracking_worker.singleton()`."""

    def __init__(self, *, storage_root: Path,
                 detection_cfg_getter: Callable[[], dict] | None = None,
                 cam_cfg_getter: Callable[[str], dict] | None = None):
        super().__init__(name="tracking-worker", daemon=True)
        self._q: queue.Queue[TrackingJob | None] = queue.Queue()
        self._stop = threading.Event()
        self._storage_root = Path(storage_root)
        self._cfg_getter = detection_cfg_getter or (lambda: {})
        # Per-camera live config lookup (typically settings.get_camera).
        # Used to pull each job's object_filter so the worker mirrors the
        # camera_runtime/_main_loop label filter exactly.
        self._cam_cfg_getter = cam_cfg_getter or (lambda _cam_id: {})
        self._detector = None        # built lazily on first job
        self._detector_cfg_id = None  # id() of cfg dict — rebuild on swap
        self._jobs_done = 0
        self._jobs_failed = 0
        # Bounded ring of recent per-event failures so the UI can tell
        # the user *why* a re-index didn't produce a fresh sidecar.
        # Keyed by event_id; oldest entries fall off when the cap is
        # exceeded. 32 is plenty for the polling UI to find the failure
        # before it ages out.
        self._recent_failures: collections.OrderedDict[str, dict] = (
            collections.OrderedDict()
        )
        self._recent_failures_cap = 32
        self._failures_lock = threading.Lock()

    # ── Public API ────────────────────────────────────────────────────────

    def enqueue(self, job: TrackingJob):
        """Fire-and-forget — recording finalize must not block on tracking."""
        self._q.put(job)

    def stop(self, timeout: float = 5.0):
        """Drain the queue, give the active job a few seconds to finish."""
        self._stop.set()
        self._q.put(None)
        self.join(timeout=timeout)

    def stats(self) -> dict:
        now = time.time()
        with self._failures_lock:
            # Newest first — OrderedDict preserves insertion order so
            # reversed() is the freshest-to-oldest view.
            recent = [
                {
                    "event_id": eid,
                    "error": entry["error"],
                    "age_seconds": max(0, int(now - entry["ts"])),
                }
                for eid, entry in reversed(self._recent_failures.items())
            ]
        return {
            "queued": self._q.qsize(),
            "done": self._jobs_done,
            "failed": self._jobs_failed,
            "alive": self.is_alive(),
            "recent_failures": recent,
        }

    def _record_failure(self, event_id: str, error: str) -> None:
        """Push a per-event failure into the bounded recent-failures ring.
        Called from the run-loop's exception branch only; the lock keeps
        a concurrent stats() reader from observing a torn dict during
        the popitem/__setitem__ sequence."""
        with self._failures_lock:
            if event_id in self._recent_failures:
                # Re-insert to refresh recency ordering.
                self._recent_failures.pop(event_id)
            self._recent_failures[event_id] = {
                "error": error,
                "ts": time.time(),
            }
            while len(self._recent_failures) > self._recent_failures_cap:
                self._recent_failures.popitem(last=False)

    # ── Thread loop ──────────────────────────────────────────────────────

    def run(self):
        # Lower nice value so this thread doesn't compete with the camera
        # capture loops. Best-effort — Windows/macOS containers ignore
        # this silently which is fine.
        try:
            os.nice(10)
        except (OSError, AttributeError):
            pass
        log.info("[tracking] worker started")
        while not self._stop.is_set():
            try:
                job = self._q.get(timeout=1.0)
            except queue.Empty:
                continue
            if job is None:
                break  # stop sentinel
            try:
                self._run_one(job)
                self._jobs_done += 1
            except Exception as e:
                self._jobs_failed += 1
                self._record_failure(job.event_id, str(e) or e.__class__.__name__)
                log.error("[tracking] event=%s failed: %s",
                          job.event_id, e, exc_info=True)
            finally:
                self._q.task_done()
        log.info("[tracking] worker stopped (done=%d failed=%d)",
                 self._jobs_done, self._jobs_failed)

    # ── Detector lifecycle ───────────────────────────────────────────────

    def _ensure_detector(self):
        """Build the detector on first use; rebuild when the cfg dict
        contents change. Uses a content-derived signature rather than
        id() because export_effective_config returns a fresh dict each
        call — id() would force a model reload on every single job.

        The worker runs on CPU to avoid contending with the per-camera
        runtimes for the single Coral TPU device (one process can hold
        the TPU at a time). If TPU acquisition succeeded for the camera
        runtimes, the worker quietly falls back to tflite-runtime CPU
        inference and continues. ~1 Hz sampling on a 30-s clip stays
        well within the time budget on CPU."""
        try:
            cfg = self._cfg_getter() or {}
        except Exception:
            cfg = {}
        sig = self._detector_signature(cfg)
        if self._detector is None or sig != self._detector_cfg_id:
            from .detectors import CoralObjectDetector
            # Strip device hint so make_interpreter doesn't race the
            # camera runtimes for the TPU. The CPU fallback path inside
            # CoralObjectDetector.__init__ kicks in automatically.
            worker_cfg = dict(cfg)
            worker_cfg["device"] = None
            self._detector = CoralObjectDetector(worker_cfg)
            self._detector_cfg_id = sig
        return self._detector

    @staticmethod
    def _detector_signature(cfg: dict) -> tuple:
        """Tuple of the cfg fields that materially affect detection
        output. Anything outside this list (e.g. region_filter_enabled
        on by default) is fine to ignore — a tweak there doesn't justify
        a model reload."""
        return (
            cfg.get("mode"),
            cfg.get("model_path"),
            cfg.get("cpu_model_path"),
            cfg.get("labels_path"),
            float(cfg.get("min_score") or 0.55),
        )

    # ── Per-job processing ───────────────────────────────────────────────

    def _run_one(self, job: TrackingJob):
        import cv2
        t_start = time.time()
        if not job.video_path.exists():
            log.warning("[tracking] event=%s video missing: %s",
                        job.event_id, job.video_path)
            return

        cap, meta = _open_video(job.video_path)
        if cap is None:
            log.warning("[tracking] event=%s unreadable (fps=%.1f frames=%d)",
                        job.event_id, meta.get("fps", 0.0), meta.get("frame_count", 0))
            return

        try:
            detector = self._ensure_detector()
            allowed = _resolve_object_filter(self._cam_cfg_getter, job.camera_id)
            state = _TrackerState()
            frame_idx = 0
            sample_interval = meta["sample_interval"]
            frame_count = meta["frame_count"]
            fps = meta["fps"]

            while frame_idx < frame_count:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    frame_idx += sample_interval
                    continue
                t_s = frame_idx / fps
                dets = _detect_and_filter(detector, frame, allowed)
                _associate_detections(state, dets, frame_idx, t_s)
                frame_idx += sample_interval

            # Flush any tracks still active at end-of-clip into closed so
            # _build_payload's serialisation comprehension picks them up.
            state.closed.extend(state.active)
            state.active = []

            payload = _build_payload(
                state, fps, frame_count, meta["duration_s"],
                allowed, job.video_path, self._storage_root,
            )
            tracks_path = tracks_path_for(job.video_path)
            _write_payload_atomic(tracks_path, payload)

            elapsed = time.time() - t_start
            best_str = (f"best={payload['best_frame']['score']:.2f}"
                        if payload["best_frame"] else "best=—")
            log.info("[tracking] event=%s dur=%.1fs tracks=%d samples=%d %s",
                     job.event_id, elapsed, len(payload["tracks"]),
                     state.samples_emitted, best_str)
            self._record_slow_job(job, elapsed, meta["duration_s"])
        finally:
            cap.release()

    def _record_slow_job(self, job: TrackingJob, elapsed: float, duration_s: float):
        """One-line WARN when processing took more than SLOW_JOB_RATIO of
        the clip duration AND was longer than 5 s in absolute terms.
        Lifted out of `_run_one` so the orchestrator stays linear; the
        threshold logic is unchanged."""
        if duration_s > 0 and elapsed > duration_s * SLOW_JOB_RATIO and elapsed > 5.0:
            log.warning("[tracking] event=%s SLOW: processing %.1fs for clip %.1fs",
                        job.event_id, elapsed, duration_s)


def _safe_relpath(p: Path, root: Path) -> str:
    try:
        return p.relative_to(root).as_posix()
    except ValueError:
        return p.as_posix()


# ── Module-level singleton ───────────────────────────────────────────────
# Built and started by server.py's bootstrap; everything else reaches the
# worker through `singleton()` so the camera_runtime enqueue path doesn't
# need an explicit handle.
_worker: TrackingWorker | None = None
_worker_lock = threading.Lock()


def build_worker(*, storage_root: Path,
                 detection_cfg_getter: Callable[[], dict] | None = None,
                 cam_cfg_getter: Callable[[str], dict] | None = None) -> TrackingWorker:
    """Construct and start the singleton. Idempotent — second call
    returns the existing instance even if different getters are provided
    (both are captured on first build)."""
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return _worker
        _worker = TrackingWorker(storage_root=storage_root,
                                 detection_cfg_getter=detection_cfg_getter,
                                 cam_cfg_getter=cam_cfg_getter)
        _worker.start()
        return _worker


def singleton() -> TrackingWorker | None:
    """Return the running worker if any. None until build_worker() runs."""
    return _worker


def tracks_path_for(video_path: Path) -> Path:
    """Conventional sidecar path: `<video>.tracks.json` next to the mp4."""
    return video_path.with_name(video_path.stem + ".tracks.json")

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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

# The tracking algorithm itself lives in :mod:`tracker_core` — same
# code runs in the live camera_runtime path AND here in the post-clip
# worker. Constants / dataclasses / helpers re-exported under their
# legacy underscore-prefixed names so any external import that
# happened to grab them via `from .tracking_worker import _Track`
# keeps resolving.
from .tracker_core import (
    IOU_MATCH_THRESHOLD,
    SAMPLE_BBOX_DELTA_PX,
    TRACK_FLOOR_SCORE,
    TRACK_MISS_WINDOWS,
    TRACK_SPAWN_SCORE,
    Track as _Track,
    TrackerState as _TrackerState,
    associate_detections as _associate_detections,
    color_for_track as _color_for_track,
    predicted_bbox as _predicted_bbox,
    resolve_track_thresholds as _resolve_track_thresholds,
    short_id as _short_id,
    update_best_top as _update_best_top,
)

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
#   v3 — ByteTrack-style two-tier association. The worker now pulls
#        detections at the raw model floor (TRACK_FLOOR_SCORE = 0.20)
#        and treats anything < TRACK_SPAWN_SCORE (0.50) as a tentative
#        sample that can only EXTEND an existing track via IoU — never
#        spawn. Combined with linear-velocity bbox prediction and a
#        wider miss window (TRACK_MISS_WINDOWS bumped from 2 to 4),
#        this keeps a single moving subject on ONE track id across
#        short low-confidence dips. Sample dicts gain no new fields;
#        the score history already lets the lightbox distinguish
#        confirmed vs. tentative frames.
TRACKS_SCHEMA = 3

# Detection-job timing target. A 30-second clip should finish in
# under ~10 s on CPU; anything slower triggers a one-line WARN so the
# operator notices a degraded run without losing frames.
SLOW_JOB_RATIO = 1.0 / 3.0  # processing time / clip duration

# Track-association tuning — IOU_MATCH_THRESHOLD, TRACK_FLOOR_SCORE,
# TRACK_SPAWN_SCORE, TRACK_MISS_WINDOWS, SAMPLE_BBOX_DELTA_PX all live
# in :mod:`tracker_core` and are imported at the top of this file.


@dataclass
class TrackingJob:
    event_id: str
    video_path: Path
    snapshot_path: Path | None
    camera_id: str



# ── Per-job pure helpers (R05) ───────────────────────────────────────────
# Module-level so each step is independently readable + unit-testable.
# `TrackingWorker._run_one` composes them with the worker's detector +
# config getters; the helpers themselves never reach back into the worker.

def _open_video(video_path: Path):
    """Open the file and read its sampling cadence. Returns
    ``(capture, meta)``; capture is None on failure (and is released
    before returning so the caller doesn't have to). meta carries
    ``fps``, ``frame_count``, ``duration_s``, ``sample_interval``,
    ``frame_w``, ``frame_h``. The frame dimensions feed the per-track
    end-state diagnostics (last_bbox_frac_h / last_bbox_frac_area)."""
    import cv2
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if frame_count <= 0 or fps <= 0:
        cap.release()
        return None, {
            "fps": fps,
            "frame_count": frame_count,
            "duration_s": 0.0,
            "sample_interval": 0,
            "frame_w": frame_w,
            "frame_h": frame_h,
        }
    duration_s = frame_count / fps
    sample_interval = max(1, int(round(fps)))  # ~1 Hz
    return cap, {
        "fps": fps,
        "frame_count": frame_count,
        "duration_s": duration_s,
        "sample_interval": sample_interval,
        "frame_w": frame_w,
        "frame_h": frame_h,
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


def _detect_and_filter(detector, frame, allowed, *, floor_score: float):
    """One sample's detector pass at the worker's low confidence floor.
    Uses ``detect_frame_raw`` so we receive every candidate ≥
    ``floor_score`` BEFORE the live pipeline's per-label thresholds /
    size floors trim the list — those gates would otherwise prevent
    the tentative-continuation tier in v3 from seeing anything below
    the spawn threshold. The allowed-label filter (the camera's
    object_filter) IS still applied here so tentative detections of
    forbidden classes don't leak through to track association.
    Empty list when the detector is unavailable (worker stays alive
    but writes a tracks.json with no tracks)."""
    if not detector.available:
        return []
    dets = detector.detect_frame_raw(frame, threshold=float(floor_score))
    if allowed is not None:
        dets = [d for d in dets if d.label in allowed]
    return dets



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
            spawn_score, floor_score = _resolve_track_thresholds(
                self._cam_cfg_getter, job.camera_id,
            )
            state = _TrackerState()
            frame_idx = 0
            sample_interval = meta["sample_interval"]
            frame_count = meta["frame_count"]
            fps = meta["fps"]
            frame_w = meta.get("frame_w", 0)
            frame_h = meta.get("frame_h", 0)

            while frame_idx < frame_count:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ok, frame = cap.read()
                if not ok or frame is None:
                    frame_idx += sample_interval
                    continue
                t_s = frame_idx / fps
                dets = _detect_and_filter(detector, frame, allowed,
                                          floor_score=floor_score)
                _associate_detections(state, dets, frame_idx, t_s,
                                      frame_w, frame_h,
                                      spawn_score=spawn_score)
                frame_idx += sample_interval

            # Flush any tracks still active at end-of-clip into closed so
            # _build_payload's serialisation comprehension picks them up.
            # close() populates the per-track end_reason + last_* fields
            # so the lightbox × tooltip has something to render.
            for tr in state.active:
                tr.close("ended_at_clip", frame_w, frame_h)
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
            # Update the event JSON with the achievement aggregates now
            # that the tracks pass is complete. Best-effort — a failed
            # write is logged but doesn't trash the tracks.json we just
            # produced.
            self._update_event_achievement(job, payload)
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

    def _update_event_achievement(self, job: TrackingJob, payload: dict) -> None:
        """Merge tracks-derived stats (tracks_by_class, peak_score_by_class,
        confirm_hits_by_track) into the event JSON's achievement block.
        Pure additive — fields already there (inference_avg_ms etc. set
        synchronously at finalize) stay untouched. Best-effort: a missing
        event store, missing event, or write failure is logged at INFO
        and the tracks.json we just produced is unaffected."""
        try:
            from . import app_state
        except Exception:
            return
        store = getattr(app_state, "store", None)
        if store is None:
            return
        try:
            ev = store.get_event(job.camera_id, job.event_id) or {}
            if not ev:
                return
        except Exception as e:
            log.info("[tracking] event=%s achievement read skipped: %s",
                     job.event_id, e)
            return
        tracks = payload.get("tracks", []) or []
        tracks_by_class: dict[str, int] = {}
        peak_score_by_class: dict[str, float] = {}
        confirm_hits: list[dict] = []
        # Pull per-class N/seconds from the camera config; fall back to
        # the wizard defaults (n=3, seconds=5) when the camera has no
        # confirmation_window entry. The worker has no access to the
        # confirmer's runtime state, so we re-derive "would this have
        # confirmed" purely from the sample stream — any sliding window
        # of `seconds` containing ≥ n detect-samples → confirmed.
        cw_cfg: dict = {}
        try:
            cam_cfg = self._cam_cfg_getter(job.camera_id) if self._cam_cfg_getter else {}
            cw_cfg = (cam_cfg.get("confirmation_window") or {}) if cam_cfg else {}
        except Exception:
            cw_cfg = {}
        default_n = 3
        default_secs = 5.0
        global_cw = cw_cfg.get("global") or {}
        if global_cw:
            default_n = int(global_cw.get("n", default_n))
            default_secs = float(global_cw.get("seconds", default_secs))
        for tr in tracks:
            lbl = tr.get("label") or "unknown"
            tracks_by_class[lbl] = tracks_by_class.get(lbl, 0) + 1
            best = float(tr.get("best_score") or 0.0)
            if best > peak_score_by_class.get(lbl, 0.0):
                peak_score_by_class[lbl] = best
            # confirm_hits_by_track entry: count detect samples and
            # check the N-of-window confirmation purely on sample
            # timestamps. Skip 0-sample tracks defensively.
            samples = tr.get("samples") or []
            detect_samples = [s for s in samples if s.get("source") == "detect"]
            hit_count = len(detect_samples)
            span_seconds = 0.0
            if len(samples) >= 2:
                span_seconds = round(
                    float(samples[-1].get("t", 0)) - float(samples[0].get("t", 0)),
                    2,
                )
            cw = cw_cfg.get(lbl) or {"n": default_n, "seconds": default_secs}
            n = int(cw.get("n", default_n))
            secs = float(cw.get("seconds", default_secs))
            confirmed = False
            # Sliding-window confirmation: at any anchor i, does the
            # detect-only window [t_i, t_i + secs] contain ≥ n samples?
            for i, s in enumerate(detect_samples):
                t0 = float(s.get("t", 0))
                in_win = 1
                for j in range(i + 1, len(detect_samples)):
                    if float(detect_samples[j].get("t", 0)) - t0 > secs:
                        break
                    in_win += 1
                if in_win >= n:
                    confirmed = True
                    break
            confirm_hits.append({
                "track_id": tr.get("track_id"),
                "label": lbl,
                "hit_count": hit_count,
                "span_seconds": span_seconds,
                "confirmed": confirmed,
            })
        ach = dict(ev.get("achievement") or {})
        if tracks_by_class:
            ach["tracks_by_class"] = tracks_by_class
        # Round peaks to 4 decimals so the JSON stays compact and the
        # frontend can compare against per-class thresholds cleanly.
        if peak_score_by_class:
            ach["peak_score_by_class"] = {
                k: round(v, 4) for k, v in peak_score_by_class.items()
            }
        if confirm_hits:
            ach["confirm_hits_by_track"] = confirm_hits
        ev["achievement"] = ach
        try:
            store.update_event(job.camera_id, job.event_id, ev)
        except Exception as e:
            log.info("[tracking] event=%s achievement write skipped: %s",
                     job.event_id, e)


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

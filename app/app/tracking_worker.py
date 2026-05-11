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

# Track-association tuning.
IOU_MATCH_THRESHOLD = 0.30
# Two-tier detection floor — see TRACKS_SCHEMA v3 doc above.
#   TRACK_FLOOR_SCORE — the raw model floor we ask the detector for.
#     Everything between FLOOR and SPAWN is "tentative": it may
#     continue an existing IoU match, never starts a new track.
#   TRACK_SPAWN_SCORE — minimum confidence to spawn a NEW track.
# Per-camera overrides land via `track_continue_min_score` and
# `track_spawn_min_score` (camera schema); 0.0 means "use the module
# default".
TRACK_FLOOR_SCORE = 0.20
TRACK_SPAWN_SCORE = 0.50
# Bumped from 2 to 4 in v3: with the tentative-continuation phase
# there's a real chance of recovering a low-conf frame *after* one
# miss, so the wider grace window pays for itself by keeping the
# track id stable across short occlusions / partial bbox dropouts.
TRACK_MISS_WINDOWS = 4          # how many sample windows a track may go un-matched
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


from .bbox_utils import bbox_centroid_dist, iou


class _Track:
    """Mutable track state held during a single job. Closed at the end
    and serialised into tracks.json's `tracks` array. end_reason +
    last_* diagnostics surface in the lightbox × tooltip so the user
    sees WHY a track dropped without having to grep worker logs."""

    __slots__ = ("track_id", "label", "color", "samples",
                 "first_frame", "last_frame", "best_score", "best_frame_idx",
                 "active", "missed_windows",
                 "end_reason", "last_score",
                 "last_bbox_w_px", "last_bbox_h_px",
                 "last_bbox_frac_h", "last_bbox_frac_area")

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
        # End-state diagnostics — populated by close() before
        # serialisation. None means "track never closed cleanly" and
        # the consumer should treat it as missing.
        self.end_reason: str | None = None
        self.last_score: float | None = None
        self.last_bbox_w_px: int | None = None
        self.last_bbox_h_px: int | None = None
        self.last_bbox_frac_h: float | None = None
        self.last_bbox_frac_area: float | None = None

    def add_sample(self, frame_idx: int, t_s: float, bbox_dict: dict,
                   score: float | None, source: str):
        # Squelch micro-jitter samples — only emit when the bbox moved
        # by ≥ SAMPLE_BBOX_DELTA_PX pixels at the centroid OR this is a
        # detection sample (always kept so score history is preserved).
        if source == "track" and self.samples:
            last = self.samples[-1]["bbox"]
            if bbox_centroid_dist(last, bbox_dict) < SAMPLE_BBOX_DELTA_PX:
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

    def close(self, reason: str, frame_w: int, frame_h: int) -> None:
        """Mark the track inactive and capture diagnostic fields from
        the LAST detect sample (falls back to last sample of any
        source when no detect samples exist — happens for tracks that
        only ever got `track`-source extrapolations). `reason` is one
        of "timeout" or "ended_at_clip" today; the worker's pipeline
        doesn't run per-track conf_drop / class_filter / bbox_too_small
        gates after the detector so those reasons aren't emitted from
        here.
        """
        self.active = False
        self.end_reason = reason
        last_detect = next(
            (s for s in reversed(self.samples) if s.get("source") == "detect"),
            None,
        )
        last = last_detect or (self.samples[-1] if self.samples else None)
        if not last:
            return
        if last.get("score") is not None:
            self.last_score = float(last["score"])
        bb = last.get("bbox") or {}
        try:
            bw = max(0, int(bb["x2"]) - int(bb["x1"]))
            bh = max(0, int(bb["y2"]) - int(bb["y1"]))
        except Exception:
            return
        self.last_bbox_w_px = bw
        self.last_bbox_h_px = bh
        if frame_h > 0:
            self.last_bbox_frac_h = round(bh / frame_h, 4)
        if frame_w > 0 and frame_h > 0:
            self.last_bbox_frac_area = round((bw * bh) / (frame_w * frame_h), 5)

    def to_dict(self) -> dict:
        d = {
            "track_id": self.track_id,
            "label": self.label,
            "color": self.color,
            "first_frame": self.first_frame,
            "last_frame": self.last_frame,
            "best_score": round(self.best_score, 4),
            "best_frame": self.best_frame_idx,
            "samples": self.samples,
        }
        # End-state diagnostics — additive. Omit fields that close()
        # didn't populate (e.g. a track with zero samples). The
        # lightbox tooltip falls back to "—" / "unknown" for missing
        # values, never breaks on absence.
        if self.end_reason is not None:
            d["end_reason"] = self.end_reason
        if self.last_score is not None:
            d["last_score"] = round(self.last_score, 4)
        if self.last_bbox_w_px is not None and self.last_bbox_h_px is not None:
            d["last_bbox_size_px"] = [self.last_bbox_w_px, self.last_bbox_h_px]
        if self.last_bbox_frac_h is not None:
            d["last_bbox_frac_h"] = self.last_bbox_frac_h
        if self.last_bbox_frac_area is not None:
            d["last_bbox_frac_area"] = self.last_bbox_frac_area
        return d


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


def _resolve_track_thresholds(cam_cfg_getter, camera_id) -> tuple[float, float]:
    """Pull the camera's spawn / continue thresholds.

    Returns ``(spawn_score, floor_score)``. A camera that hasn't
    customised these fields (or has them set to 0.0, the schema's
    "use module default" sentinel) falls back to the module-level
    ``TRACK_SPAWN_SCORE`` / ``TRACK_FLOOR_SCORE`` so the worker
    behaves identically to today on an unconfigured install.
    """
    spawn = TRACK_SPAWN_SCORE
    floor = TRACK_FLOOR_SCORE
    try:
        cfg = cam_cfg_getter(camera_id) or {}
    except Exception:
        cfg = {}
    try:
        s = float(cfg.get("track_spawn_min_score") or 0.0)
        if s > 0.0:
            spawn = s
    except (TypeError, ValueError):
        pass
    try:
        f = float(cfg.get("track_continue_min_score") or 0.0)
        if f > 0.0:
            floor = f
    except (TypeError, ValueError):
        pass
    # Refuse a configuration where spawn dips below floor — that would
    # let "tentative" samples spawn tracks, defeating the whole point
    # of the two-tier design. Clamp floor up to spawn.
    if floor > spawn:
        floor = spawn
    return spawn, floor


def _predicted_bbox(track: "_Track", frame_idx: int) -> tuple[int, int, int, int]:
    """Linear-velocity bbox prediction for IoU matching at ``frame_idx``.

    Uses the last two *detect-source* samples to estimate centroid
    velocity (dx/df, dy/df) and projects the centroid forward to the
    current frame index, keeping the most recent bbox size. With
    fewer than two detect samples we have no velocity signal, so we
    fall back to the literal last sample bbox — same behaviour as
    pre-v3.

    Linear is intentional: at ~1 Hz sampling and the IoU threshold
    of 0.30, the prediction only needs to bring the bbox within
    ~70 % overlap of the next detection. Full Kalman buys nothing
    at this cadence."""
    detect_samples = [s for s in track.samples if s.get("source") == "detect"]
    if not track.samples:
        return (0, 0, 0, 0)
    if len(detect_samples) < 2:
        last = track.samples[-1]["bbox"]
        return (int(last["x1"]), int(last["y1"]),
                int(last["x2"]), int(last["y2"]))
    s_prev = detect_samples[-2]
    s_last = detect_samples[-1]
    bb_prev = s_prev["bbox"]
    bb_last = s_last["bbox"]
    cx_prev = (bb_prev["x1"] + bb_prev["x2"]) / 2.0
    cy_prev = (bb_prev["y1"] + bb_prev["y2"]) / 2.0
    cx_last = (bb_last["x1"] + bb_last["x2"]) / 2.0
    cy_last = (bb_last["y1"] + bb_last["y2"]) / 2.0
    df = max(1, int(s_last["f"]) - int(s_prev["f"]))
    dx = (cx_last - cx_prev) / df
    dy = (cy_last - cy_prev) / df
    elapsed = max(0, frame_idx - int(s_last["f"]))
    p_cx = cx_last + dx * elapsed
    p_cy = cy_last + dy * elapsed
    half_w = (bb_last["x2"] - bb_last["x1"]) / 2.0
    half_h = (bb_last["y2"] - bb_last["y1"]) / 2.0
    return (int(p_cx - half_w), int(p_cy - half_h),
            int(p_cx + half_w), int(p_cy + half_h))


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


def _associate_detections(state: _TrackerState, dets, frame_idx: int, t_s: float,
                          frame_w: int = 0, frame_h: int = 0,
                          spawn_score: float = TRACK_SPAWN_SCORE):
    """Two-tier greedy IoU pairing + spawn + age-out for one frame.

    Mutates ``state`` in place. v3 rules:

    * Phase 1 — *confirmed* detections (score ≥ ``spawn_score``) are
      matched to active tracks of the same label by descending IoU.
      Targets use the track's predicted bbox (linear velocity from
      the last two detect samples) so a fast-moving subject still
      lands inside an existing patch.
    * Phase 2 — *tentative* detections (FLOOR ≤ score < spawn) may
      ONLY extend a still-unmatched active track via the same IoU
      rule. The sample is recorded with ``source="detect"`` (it IS
      a real detector hit, just below the spawn floor); the lightbox
      branches on score to draw it differently.
    * Phase 3 — unmatched confirmed detections spawn fresh tracks.
      Unmatched tentative detections are dropped entirely.

    frame_w / frame_h feed each closed track's `last_bbox_frac_h` and
    `last_bbox_frac_area` diagnostics — the worker's only writer for
    those fields, so missing dims (0) leave the fractions unpopulated
    and the consumer falls back gracefully.

    The pre-spawn snapshot (`original_count = len(state.active)`) keeps
    freshly-spawned tracks out of the age-out pass on their birth
    frame — without it they'd immediately get missed_windows += 1 and
    halve the intended TRACK_MISS_WINDOWS grace period."""
    confirmed: list[tuple[int, "Detection"]] = []   # noqa: F821
    tentative: list[tuple[int, "Detection"]] = []   # noqa: F821
    for di, d in enumerate(dets):
        (confirmed if float(d.score) >= spawn_score else tentative).append((di, d))

    # Predict each active track's bbox at the current frame — used as
    # the IoU target for BOTH phases. Computed once per track, indexed
    # by track index so phase 2 reuses the cache without re-walking
    # the sample list.
    predicted: list[tuple[int, int, int, int]] = [
        _predicted_bbox(tr, frame_idx) for tr in state.active
    ]

    taken_tracks: set[int] = set()

    def _pair_pass(pool):
        """Greedy IoU pairing for one tier; yields (di, ti, det).
        Mutates ``taken_tracks`` so phase 2 sees phase 1's claims."""
        candidates: list[tuple[int, int, float]] = []
        for di, d in pool:
            for ti, tr in enumerate(state.active):
                if not tr.active or tr.label != d.label or not tr.samples:
                    continue
                if ti in taken_tracks:
                    continue
                iou_v = iou(predicted[ti], d.bbox)
                if iou_v >= IOU_MATCH_THRESHOLD:
                    candidates.append((di, ti, iou_v))
        candidates.sort(key=lambda p: p[2], reverse=True)
        taken_dets_local: set[int] = set()
        out = []
        for di, ti, _iou_v in candidates:
            if di in taken_dets_local or ti in taken_tracks:
                continue
            taken_dets_local.add(di)
            taken_tracks.add(ti)
            out.append((di, ti))
        return out, taken_dets_local

    def _record_match(di_ti_pairs, pool_by_di):
        for di, ti in di_ti_pairs:
            d = pool_by_di[di]
            tr = state.active[ti]
            bbox_dict = {"x1": int(d.bbox[0]), "y1": int(d.bbox[1]),
                         "x2": int(d.bbox[2]), "y2": int(d.bbox[3])}
            tr.add_sample(frame_idx, t_s, bbox_dict,
                          float(d.score), "detect")
            state.samples_emitted += 1
            _update_best_top(state, d, frame_idx, t_s)

    # Phase 1 — confirmed dets fight for tracks first.
    confirmed_by_di = {di: d for di, d in confirmed}
    pairs1, taken_confirmed = _pair_pass(confirmed)
    _record_match(pairs1, confirmed_by_di)

    # Phase 2 — tentative dets extend whatever's still unmatched.
    tentative_by_di = {di: d for di, d in tentative}
    pairs2, _taken_tentative = _pair_pass(tentative)
    _record_match(pairs2, tentative_by_di)

    # Snapshot the pre-spawn track count so the age-out loop
    # below can skip tracks that are about to be created on
    # this same frame. Without this, a freshly spawned track
    # is not in `taken_tracks` (which was built from the
    # original indices) and immediately gets missed_windows
    # += 1 on the same frame as its birth — halving the
    # intended TRACK_MISS_WINDOWS grace period.
    original_count = len(state.active)
    # Phase 3 — unmatched confirmed dets → new tracks. Unmatched
    # tentative dets are intentionally dropped (no spawn) so a flicker
    # of low-conf noise can't seed a new track id.
    for di, d in confirmed:
        if di in taken_confirmed:
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
            tr.close("timeout", frame_w, frame_h)
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

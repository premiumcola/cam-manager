"""Pure two-tier object-tracking algorithm shared by the post-clip
worker AND the live camera-runtime path.

Carved out of ``tracking_worker.py`` so both callers reach the same
ByteTrack-style logic — confirmed detections spawn / extend tracks,
tentative (sub-spawn, above-floor) detections may only extend an
existing IoU-matched track. Linear-velocity bbox prediction bridges
the typical 1-frame motion gap; a miss-grace window keeps a track
alive across short occlusions.

Module scope is intentionally tight: NO file I/O, NO queue, NO event
store, NO Flask app state. Both callers wrap this module with their
own orchestration — see ``tracking_worker.TrackingWorker`` (post-clip)
and ``camera_runtime._main_loop`` (live).
"""
from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

from .bbox_utils import bbox_centroid_dist, iou

log = logging.getLogger(__name__)


# ── Tunables ────────────────────────────────────────────────────────────────
# Track-association tuning. The live runtime and the post-clip worker
# both read these defaults; per-camera overrides flow through
# ``resolve_track_thresholds`` below.
IOU_MATCH_THRESHOLD = 0.30
# Two-tier detection floor.
#   TRACK_FLOOR_SCORE — the raw model floor we ask the detector for.
#     Everything between FLOOR and SPAWN is "tentative": it may
#     continue an existing IoU match, never starts a new track.
#   TRACK_SPAWN_SCORE — minimum confidence to spawn a NEW track.
TRACK_FLOOR_SCORE = 0.20
TRACK_SPAWN_SCORE = 0.50
# Default miss-grace expressed in sampling windows. The post-clip
# worker samples at 1 Hz, so 4 windows ≈ 4 wall-clock seconds. The
# live runtime computes its sample count from
# ``compute_miss_grace_samples(seconds, fps)`` so the SAME wall-clock
# intent (default 4 s) maps to the right sample count at any cadence.
TRACK_MISS_WINDOWS = 4
MISS_GRACE_DEFAULT_SECONDS = 4.0
# Sub-pixel jitter cutoff for `source="track"` samples (the post-clip
# worker only — the live path emits no synthetic track samples today).
SAMPLE_BBOX_DELTA_PX = 2


# ── ID + colour helpers ─────────────────────────────────────────────────────
def short_id() -> str:
    """6-hex-char id for a track. Stable across the clip but not globally
    unique — the (event_id, track_id) pair is what callers index on."""
    return uuid.uuid4().hex[:6]


def color_for_track(track_id: str) -> str:
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


def classify_tier(score: float, spawn_score: float) -> str:
    """Map a detection score to ``"confirmed"`` (≥ spawn) or
    ``"tentative"`` (< spawn). Below-floor detections are expected to
    be filtered out by the caller BEFORE this function — we don't gate
    on the floor here because the live and post-clip floors are
    consumed at different points (post-clip: detect_frame_raw
    threshold; live: same)."""
    return "confirmed" if float(score) >= float(spawn_score) else "tentative"


def compute_miss_grace_samples(seconds: float, fps: float) -> int:
    """Translate a wall-clock grace period into a sample-count grace
    that ``associate_detections`` consumes. Same intent at every
    cadence — 4 s × 1 Hz = 4 samples, 4 s × 3 Hz = 12 samples. Returns
    ``TRACK_MISS_WINDOWS`` as a safe default when the inputs aren't
    usable (zero or negative)."""
    try:
        secs = float(seconds)
        rate = float(fps)
    except (TypeError, ValueError):
        return TRACK_MISS_WINDOWS
    if secs <= 0 or rate <= 0:
        return TRACK_MISS_WINDOWS
    return max(1, int(round(secs * rate)))


# ── Per-camera threshold resolver ───────────────────────────────────────────
def resolve_track_thresholds(cam_cfg_getter, camera_id) -> tuple[float, float, float]:
    """Pull the camera's spawn / continue / miss-grace overrides.

    Returns ``(spawn_score, floor_score, miss_grace_seconds)``. A
    camera that hasn't customised these fields (or has them set to
    0.0, the schema's "use module default" sentinel) falls back to
    the module-level defaults so an unconfigured install behaves
    identically to before the per-camera fields existed.

    Floor is clamped up to spawn — letting `floor > spawn` would
    allow tentative samples to spawn tracks, defeating the two-tier
    design.
    """
    spawn = TRACK_SPAWN_SCORE
    floor = TRACK_FLOOR_SCORE
    grace_s = MISS_GRACE_DEFAULT_SECONDS
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
    try:
        g = float(cfg.get("track_miss_grace_seconds") or 0.0)
        if g > 0.0:
            grace_s = g
    except (TypeError, ValueError):
        pass
    if floor > spawn:
        floor = spawn
    return spawn, floor, grace_s


# ── Track + state ───────────────────────────────────────────────────────────
class Track:
    """Mutable track state held during one tracking run. Used by both
    the post-clip worker (a track lives the length of a clip, then
    gets serialised into tracks.json) and the live runtime (a track
    lives the camera's whole session, ages out via the miss-grace
    window when motion stops).

    The end-state diagnostic fields (``end_reason`` / ``last_*``) are
    sidecar-only — the live runtime doesn't write them anywhere. They
    stay on the class so the post-clip worker can call ``close()``
    and ``to_dict()`` without conditional branches."""

    __slots__ = ("track_id", "label", "color", "samples",
                 "first_frame", "last_frame", "best_score", "best_frame_idx",
                 "active", "missed_windows",
                 "end_reason", "last_score",
                 "last_bbox_w_px", "last_bbox_h_px",
                 "last_bbox_frac_h", "last_bbox_frac_area")

    def __init__(self, track_id: str, label: str, frame_idx: int):
        self.track_id = track_id
        self.label = label
        self.color = color_for_track(track_id)
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
class TrackerState:
    """Per-run mutable state shared across the per-frame helpers. The
    live runtime uses ONE instance per camera (lives the session); the
    post-clip worker creates ONE instance per clip."""
    active: list = field(default_factory=list)   # list[Track]
    closed: list = field(default_factory=list)   # list[Track]
    samples_emitted: int = 0
    best_top: dict | None = None


# ── Algorithm ───────────────────────────────────────────────────────────────
def predicted_bbox(track: Track, frame_idx: int) -> tuple[int, int, int, int]:
    """Linear-velocity bbox prediction for IoU matching at ``frame_idx``.

    Uses the last two *detect-source* samples to estimate centroid
    velocity (dx/df, dy/df) and projects the centroid forward to the
    current frame index, keeping the most recent bbox size. With
    fewer than two detect samples we have no velocity signal, so we
    fall back to the literal last sample bbox.

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


def update_best_top(state: TrackerState, det, frame_idx: int, t_s: float) -> None:
    """Bump state.best_top when det.score beats the current best."""
    score = float(det.score)
    if state.best_top is None or score > state.best_top["score"]:
        state.best_top = {
            "f": frame_idx,
            "t": round(t_s, 3),
            "score": round(score, 4),
            "label": det.label,
        }


def associate_detections(state: TrackerState, dets, frame_idx: int, t_s: float,
                         *,
                         frame_w: int = 0, frame_h: int = 0,
                         spawn_score: float = TRACK_SPAWN_SCORE,
                         spawn_for: Callable[[str], float] | None = None,
                         miss_grace_samples: int = TRACK_MISS_WINDOWS,
                         ) -> list[tuple[int, Track]]:
    """Two-tier greedy IoU pairing + spawn + age-out for one frame.

    Rules:

    * Phase 1 — *confirmed* detections (score ≥ resolved-spawn) are
      matched to active tracks of the same label by descending IoU.
      Targets use the track's predicted bbox.
    * Phase 2 — *tentative* detections (score < resolved-spawn) may
      ONLY extend a still-unmatched active track via the same IoU
      rule.
    * Phase 3 — unmatched confirmed detections spawn fresh tracks.
      Unmatched tentative detections are dropped entirely.

    ``spawn_for`` is an optional callable ``label -> spawn_score`` so
    callers with per-label thresholds (the live runtime's
    label_thresholds dict) classify each detection against ITS label's
    spawn floor instead of the global one. ``spawn_score`` is the
    fallback when ``spawn_for`` is None or returns None.

    Returns ``[(detection_index, track), …]`` for every detection that
    matched OR spawned a track. The live caller forwards those
    detections to the rest of the pipeline (confirmer + classifiers +
    event triggers). The post-clip caller ignores the return value
    (it queries state.closed at the end of the clip instead).
    """
    spawn_lookup: Callable[[str], float]
    if spawn_for is None:
        spawn_lookup = lambda _lbl: float(spawn_score)
    else:
        def _resolve(lbl: str) -> float:
            try:
                v = spawn_for(lbl)
            except Exception:
                v = None
            return float(v) if v is not None else float(spawn_score)
        spawn_lookup = _resolve

    confirmed: list[tuple[int, object]] = []
    tentative: list[tuple[int, object]] = []
    for di, d in enumerate(dets):
        if float(d.score) >= spawn_lookup(d.label):
            confirmed.append((di, d))
        else:
            tentative.append((di, d))

    predicted: list[tuple[int, int, int, int]] = [
        predicted_bbox(tr, frame_idx) for tr in state.active
    ]
    taken_tracks: set[int] = set()
    matches: list[tuple[int, Track]] = []  # (di, track)

    def _pair_pass(pool):
        """Greedy IoU pairing for one tier; returns
        [(di, ti), …] and the set of di's that matched."""
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
            update_best_top(state, d, frame_idx, t_s)
            matches.append((di, tr))

    # Phase 1 — confirmed dets fight for tracks first.
    confirmed_by_di = {di: d for di, d in confirmed}
    pairs1, taken_confirmed = _pair_pass(confirmed)
    _record_match(pairs1, confirmed_by_di)

    # Phase 2 — tentative dets extend whatever's still unmatched.
    tentative_by_di = {di: d for di, d in tentative}
    pairs2, _taken_tentative = _pair_pass(tentative)
    _record_match(pairs2, tentative_by_di)

    # Snapshot the pre-spawn track count so the age-out loop below
    # can skip tracks that are about to be created on this same
    # frame. Without this, a freshly spawned track is not in
    # `taken_tracks` and immediately gets missed_windows += 1 on its
    # birth frame — halving the intended grace period.
    original_count = len(state.active)
    # Phase 3 — unmatched confirmed dets → new tracks. Unmatched
    # tentative dets are intentionally dropped (no spawn) so a flicker
    # of low-conf noise can't seed a new track id.
    for di, d in confirmed:
        if di in taken_confirmed:
            continue
        tid = short_id()
        tr = Track(tid, d.label, frame_idx)
        bbox_dict = {"x1": int(d.bbox[0]), "y1": int(d.bbox[1]),
                     "x2": int(d.bbox[2]), "y2": int(d.bbox[3])}
        tr.add_sample(frame_idx, t_s, bbox_dict,
                      float(d.score), "detect")
        state.active.append(tr)
        state.samples_emitted += 1
        update_best_top(state, d, frame_idx, t_s)
        matches.append((di, tr))

    # Age out tracks that didn't get a hit this window. After
    # ``miss_grace_samples`` misses they close. Restricted to indices
    # < original_count so newly-spawned tracks (appended above) skip
    # this pass and get their first miss-check on the NEXT frame.
    grace = max(1, int(miss_grace_samples))
    for ti, tr in enumerate(state.active[:original_count]):
        if ti in taken_tracks:
            continue
        tr.missed_windows += 1
        if tr.missed_windows >= grace:
            tr.close("timeout", frame_w, frame_h)
    state.closed.extend([t for t in state.active if not t.active])
    state.active = [t for t in state.active if t.active]
    return matches


# ── Live runtime convenience wrapper ────────────────────────────────────────
class LiveTracker:
    """Per-camera tracker — one instance per :class:`CameraRuntime`.

    Wraps a ``TrackerState`` plus the cadence-aware miss-grace logic so
    the live runtime's per-frame loop reads as a one-liner:
        survivors = self.tracker.step(detections, t_s=time.monotonic(),
                                      fps=self._main_fps,
                                      spawn_for=spawn_for_label)

    Returns the subset of input detections that should continue down
    the pipeline (every detection that either matched an existing
    track or spawned a fresh one). Tentative detections that found no
    IoU partner are dropped here — the second-stage classifiers
    (bird species / wildlife) and DetectionConfirmer see only the
    tracker's output.
    """

    __slots__ = (
        "camera_id", "state", "_frame_idx",
        "spawn_default", "floor", "grace_seconds",
    )

    def __init__(self, camera_id: str, *,
                 spawn_default: float = TRACK_SPAWN_SCORE,
                 floor: float = TRACK_FLOOR_SCORE,
                 grace_seconds: float = MISS_GRACE_DEFAULT_SECONDS):
        self.camera_id = camera_id
        self.state = TrackerState()
        self._frame_idx = 0
        self.spawn_default = float(spawn_default)
        self.floor = float(floor)
        self.grace_seconds = float(grace_seconds)

    def configure(self, *, spawn_default: float, floor: float,
                  grace_seconds: float) -> None:
        """Replace the per-camera thresholds. Called on settings reload
        so a tweaked spawn / continue / grace value takes effect without
        rebuilding the runtime."""
        self.spawn_default = float(spawn_default)
        self.floor = float(floor)
        self.grace_seconds = float(grace_seconds)

    def step(self, detections, *, t_s: float, fps: float,
             spawn_for: Callable[[str], float] | None = None) -> list:
        """Run one tracker step and return the surviving detections.

        ``fps`` is the camera's effective per-frame inference rate —
        the LiveTracker turns it into a sample-count grace via
        ``compute_miss_grace_samples`` so the configured
        ``grace_seconds`` (wall-clock) lands at the right sample count
        regardless of cadence.

        ``spawn_for`` defaults to a callable that returns this
        tracker's ``spawn_default`` for every label — pass a richer
        callable to honour the camera's label_thresholds dict.
        """
        self._frame_idx += 1
        grace = compute_miss_grace_samples(self.grace_seconds, fps)
        if spawn_for is None:
            spawn_for = lambda _lbl: self.spawn_default  # noqa: E731
        matches = associate_detections(
            self.state, list(detections),
            frame_idx=self._frame_idx, t_s=float(t_s),
            spawn_score=self.spawn_default,
            spawn_for=spawn_for,
            miss_grace_samples=grace,
        )
        # Return the detection objects (not the (di, track) tuples) in
        # input order so downstream pipeline stages see a clean list.
        matched_dets = [detections[di] for di, _tr in matches]
        return matched_dets

    def active_count(self) -> int:
        return len(self.state.active)

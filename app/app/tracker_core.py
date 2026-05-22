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

import contextlib
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
# 2026-05: lowered 0.30 → 0.20 after garden-cam testing — one walking
# person was breaking into 3-4 fresh track ids inside the first 10 s
# of a clip because the detector's bbox wobbled enough to drop IoU
# below 0.30 frame-over-frame. 0.20 keeps the same identity through
# normal detector jitter without merging two distinct subjects (the
# class label gate + the 0.20 floor on overlapping objects still
# keeps adjacent-but-different tracks apart).
IOU_MATCH_THRESHOLD = 0.20
# Two-tier detection floor.
#   TRACK_FLOOR_SCORE — the raw model floor we ask the detector for.
#     Everything between FLOOR and SPAWN is "tentative": it may
#     continue an existing IoU match, never starts a new track.
#   TRACK_SPAWN_SCORE — minimum confidence to spawn a NEW track.
TRACK_FLOOR_SCORE = 0.20
TRACK_SPAWN_SCORE = 0.50
# Default miss-grace expressed in sampling windows. The post-clip
# worker samples at 1 Hz, so 6 windows ≈ 6 wall-clock seconds. The
# live runtime computes its sample count from
# ``compute_miss_grace_samples(seconds, fps)`` so the SAME wall-clock
# intent (default 6 s) maps to the right sample count at any cadence.
# 2026-05: bumped 4 → 6 → 8. The grace window has to cover both
# (a) occlusion behind a foreground obstacle and (b) the velocity-
# prediction "blind spot" right after a direction reversal — for the
# back-and-forth-walking person the old 6 s window expired before
# the bbox re-aligned with the actual subject. Eight seconds keeps
# one identity through both cases without merging genuinely
# distinct subjects (the IoU + label gates still discriminate).
TRACK_MISS_WINDOWS = 8
MISS_GRACE_DEFAULT_SECONDS = 8.0
# Re-identification window — measured in WALL-CLOCK seconds so the
# post-clip worker (sample_interval = fps frames per iteration; 1 Hz
# wall-clock cadence regardless of source fps) and the live runtime
# (frame-counter steps per loop) share the same temporal intuition.
# 12 s covers a person walking back into frame after wandering off
# briefly without merging into a fresh subject 5 minutes later.
TRACK_REID_MAX_SECONDS = 12.0
# Re-identification gates. Centroid must be within
# ``REID_DIST_FACTOR × max(last_bw, last_bh)`` of the closed
# track's last position, AND the size ratio must be ≤
# ``REID_SIZE_RATIO`` so a tiny new det doesn't re-attach to a
# large prior track. Same-label is enforced by the caller.
TRACK_REID_DIST_FACTOR = 1.6
TRACK_REID_SIZE_RATIO = 1.7
# Sub-pixel jitter cutoff for `source="track"` samples (the post-clip
# worker only — the live path emits no synthetic track samples today).
SAMPLE_BBOX_DELTA_PX = 2
# J1 · per-label NMS gate. The SSD detector occasionally fires two or
# three near-identical bboxes on a single object (model-internal NMS
# imperfect at low confidence floors). Without dedup, each duplicate
# spawns its own track and they coexist forever in parallel. 0.5 is
# the standard NMS threshold — generous enough to collapse the
# duplicate cluster while leaving genuinely distinct objects alone.
NMS_IOU = 0.5
# K4 · frame-edge handling.
#   EDGE_MARGIN_PX — a bbox is "at the edge" when any side sits within
#   this many pixels of the frame boundary.
#   EDGE_GRACE_SAMPLES — once a track at the edge stops getting detect
#   samples, it ages out after this many missed frames (much smaller
#   than the normal miss-grace). A subject that left the frame should
#   close immediately, not keep tracking-on-prediction for 8 s.
EDGE_MARGIN_PX = 8
EDGE_GRACE_SAMPLES = 2
# J2 · spawn-block IoU. An unmatched confirmed detection may only
# spawn a NEW track when it does NOT strongly overlap any currently-
# active track of ANY label. If it does, the detection is either
# a same-label duplicate (extend instead) or a cross-label
# misclassification of an already-tracked subject (drop) — the SSD's
# occasional "Vogel" on a person used to spawn a fat parallel bird
# track on top of the existing person track. 0.45 catches both
# without blocking a fresh subject who happens to brush past an
# unrelated existing track.
SPAWN_BLOCK_IOU = 0.45
# J3 · sustained-overlap merge for active tracks that drift parallel
# along the same subject. Two same-label active tracks merge when
# the IoU of their last N detect-sample bboxes consistently exceeds
# MERGE_IOU. Sustained gate (≥ MERGE_SUSTAIN samples) avoids
# accidentally merging two people who briefly cross paths.
MERGE_IOU = 0.6
MERGE_SUSTAIN = 3
# J4 · the re-id revive path may only resume a closed track when the
# new detection's bbox doesn't overlap ANY currently-active track
# above this IoU. A revived closed track on top of a live track
# would just create a parallel duplicate (the visual symptom the
# user reported as "many simultaneous lanes"). Smaller than
# SPAWN_BLOCK_IOU so even a moderate overlap with an existing track
# blocks revival — the new detection should EXTEND that track via
# the spawn-block path, not raise a second copy from the dead.
REID_OCCUPIED_IOU = 0.2


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
        "#22c55e",
        "#3b82f6",
        "#f59e0b",
        "#ef4444",
        "#a855f7",
        "#14b8a6",
        "#ec4899",
        "#84cc16",
        "#f97316",
        "#06b6d4",
        "#eab308",
        "#8b5cf6",
        "#10b981",
        "#f43f5e",
        "#0ea5e9",
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
def resolve_track_thresholds(cam_cfg_getter, camera_id) -> tuple[float, float, float, float]:
    """Pull the camera's spawn / continue / miss-grace / IoU overrides.

    Returns ``(spawn_score, floor_score, miss_grace_seconds,
    iou_threshold)``. A camera that hasn't customised these fields
    (or has them set to 0.0, the schema's "use module default"
    sentinel) falls back to the module-level defaults so an
    unconfigured install behaves identically to before the per-camera
    fields existed.

    Floor is clamped up to spawn — letting `floor > spawn` would
    allow tentative samples to spawn tracks, defeating the two-tier
    design. IoU is clamped to [0.0, 0.95] so a typo or extreme value
    can't break the matcher entirely.
    """
    spawn = TRACK_SPAWN_SCORE
    floor = TRACK_FLOOR_SCORE
    grace_s = MISS_GRACE_DEFAULT_SECONDS
    iou_t = IOU_MATCH_THRESHOLD
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
    try:
        i = float(cfg.get("track_iou_match_threshold") or 0.0)
        if i > 0.0:
            iou_t = max(0.0, min(0.95, i))
    except (TypeError, ValueError):
        pass
    if floor > spawn:
        floor = spawn
    return spawn, floor, grace_s, iou_t


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

    __slots__ = (
        "track_id",
        "label",
        "color",
        "samples",
        "first_frame",
        "last_frame",
        "best_score",
        "best_frame_idx",
        "active",
        "missed_windows",
        "end_reason",
        "last_score",
        "last_bbox_w_px",
        "last_bbox_h_px",
        "last_bbox_frac_h",
        "last_bbox_frac_area",
    )

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

    def add_sample(
        self,
        frame_idx: int,
        t_s: float,
        bbox_dict: dict,
        score: float | None,
        source: str,
        label: str | None = None,
    ):
        # Squelch micro-jitter samples — only emit when the bbox moved
        # by ≥ SAMPLE_BBOX_DELTA_PX pixels at the centroid OR this is a
        # detection sample (always kept so score history is preserved).
        # `predicted` samples are NEVER squelched — every miss-grace
        # tick should be visible in the bar so the swimlane's dashed
        # tail renders without gaps even when the predicted position
        # barely moved.
        if source == "track" and self.samples:
            last = self.samples[-1]["bbox"]
            if bbox_centroid_dist(last, bbox_dict) < SAMPLE_BBOX_DELTA_PX:
                return
        sample_label = label if label else self.label
        self.samples.append(
            {
                "f": frame_idx,
                "t": round(t_s, 3),
                "bbox": bbox_dict,
                "score": (round(float(score), 4) if score is not None else None),
                "source": source,
                "label": sample_label,
            }
        )
        self.last_frame = frame_idx
        if score is not None and score > self.best_score:
            self.best_score = float(score)
            self.best_frame_idx = frame_idx
        # Reset the miss counter ONLY on positive evidence — a real
        # `detect` or a `track`-source interpolation between detect
        # frames. `predicted` samples are emitted EXACTLY during the
        # miss-grace window; resetting on them would prevent the
        # track from ever timing out.
        if source != "predicted":
            self.missed_windows = 0
        # J5 · sliding-window majority vote on the dominant label.
        # Only DETECT samples vote (predicted ones inherit and would
        # feed back on themselves). Window of 5 lets the track
        # correctly relabel after a misclassified spawn-frame once
        # the truth wins majority, while a single off-label blip on
        # a long track never overturns the established label. Tie
        # breaks TOWARD the current label so a 1-frame flip can't
        # ever relabel: we only switch when strictly more frames
        # vote for the new label than for the current one.
        if source in ("detect", "track"):
            recent_labels: list[str] = []
            for s in reversed(self.samples):
                if s.get("source") not in ("detect", "track"):
                    continue
                recent_labels.append(s.get("label") or self.label)
                if len(recent_labels) >= 5:
                    break
            if recent_labels:
                counts: dict[str, int] = {}
                for lbl in recent_labels:
                    counts[lbl] = counts.get(lbl, 0) + 1
                max_count = max(counts.values())
                current_count = counts.get(self.label, 0)
                if max_count > current_count:
                    self.label = max(counts.items(), key=lambda kv: kv[1])[0]

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

    active: list = field(default_factory=list)  # list[Track]
    closed: list = field(default_factory=list)  # list[Track]
    samples_emitted: int = 0
    best_top: dict | None = None


# ── Algorithm ───────────────────────────────────────────────────────────────
# K2 · stationary detection — if recent average centroid speed is
# below this fraction of the bbox dimension PER FRAME, the subject
# counts as "standing still" and predicted_bbox returns the last
# observed bbox unchanged. A real moving person walks ≫ 5 % of
# their bbox per frame; a wobbling stationary subject doesn't.
STATIONARY_SPEED_FRAC = 0.05
# K2 · per-frame displacement clamp + miss-window decay. Cap a
# single predicted step at 40 % of the bbox dim (was 80 %, too
# permissive), and decay the velocity contribution as the miss
# grows — by miss-grace-cap we predict no movement at all and
# rely entirely on the last observed position.
PRED_STEP_FRAC = 0.4
PRED_DECAY_CAP_SAMPLES = 6


def predicted_bbox(track: Track, frame_idx: int) -> tuple[int, int, int, int]:
    """Stationary-aware, magnitude-clamped, miss-decay bbox prediction
    for IoU matching at ``frame_idx``.

    Three rules combine to keep a small wobble from producing a
    large prediction vector:

      * MEDIAN velocity over up to 6 detect-source samples (was 4)
        — more samples drown a single reversal frame.
      * STATIONARY short-circuit — if the average centroid speed
        across the recent window is below
        ``STATIONARY_SPEED_FRAC × min(bw, bh)``, treat the subject
        as stationary and return the last observed bbox unchanged.
        A static subject must be matched by position, never flung
        away by per-frame jitter.
      * DECAY across the miss window — the further into the miss
        we are, the less we trust the velocity estimate. At
        elapsed = ``PRED_DECAY_CAP_SAMPLES`` the decay factor is
        0 and the prediction reduces to the last observed bbox.
        Combined with the hard ``PRED_STEP_FRAC`` clamp this caps
        the worst-case overshoot regardless of velocity history."""
    if not track.samples:
        return (0, 0, 0, 0)
    detect_samples = [s for s in track.samples if s.get("source") == "detect"]
    if len(detect_samples) < 2:
        last = track.samples[-1]["bbox"]
        return (int(last["x1"]), int(last["y1"]), int(last["x2"]), int(last["y2"]))
    s_last = detect_samples[-1]
    bb_last = s_last["bbox"]
    bw = bb_last["x2"] - bb_last["x1"]
    bh = bb_last["y2"] - bb_last["y1"]
    cx_last = (bb_last["x1"] + bb_last["x2"]) / 2.0
    cy_last = (bb_last["y1"] + bb_last["y2"]) / 2.0
    # Wider window than before (6 samples vs 4) — five-plus pairwise
    # deltas drown an outlier reversal frame in the median.
    window = detect_samples[-min(6, len(detect_samples)) :]
    dxs: list[float] = []
    dys: list[float] = []
    for i in range(1, len(window)):
        s_a = window[i - 1]
        s_b = window[i]
        bb_a = s_a["bbox"]
        bb_b = s_b["bbox"]
        df = max(1, int(s_b["f"]) - int(s_a["f"]))
        cx_a = (bb_a["x1"] + bb_a["x2"]) / 2.0
        cy_a = (bb_a["y1"] + bb_a["y2"]) / 2.0
        cx_b = (bb_b["x1"] + bb_b["x2"]) / 2.0
        cy_b = (bb_b["y1"] + bb_b["y2"]) / 2.0
        dxs.append((cx_b - cx_a) / df)
        dys.append((cy_b - cy_a) / df)
    # Stationary short-circuit — average MAGNITUDE of per-frame
    # velocity. If the subject barely moved across the window, do
    # NOT extrapolate; the next detection should match against the
    # last-observed position. Compute mean speed = mean(sqrt(dx² + dy²)).
    mean_speed = sum((d * d + e * e) ** 0.5 for d, e in zip(dxs, dys, strict=False)) / max(
        1, len(dxs)
    )
    min_dim = max(1.0, float(min(bw, bh)))
    if mean_speed < STATIONARY_SPEED_FRAC * min_dim:
        return (int(bb_last["x1"]), int(bb_last["y1"]), int(bb_last["x2"]), int(bb_last["y2"]))
    dxs.sort()
    dys.sort()
    dx = dxs[len(dxs) // 2]
    dy = dys[len(dys) // 2]
    elapsed = max(0, frame_idx - int(s_last["f"]))
    # Decay: linear ramp from 1.0 at elapsed=0 to 0.0 at
    # PRED_DECAY_CAP_SAMPLES. Past that point, prediction stops
    # extrapolating entirely and stays at the last observed
    # position. Below the cap, the velocity contribution gradually
    # shrinks so a long miss doesn't fling the predicted box
    # further and further away from the (likely returning)
    # subject.
    decay = max(0.0, 1.0 - elapsed / float(PRED_DECAY_CAP_SAMPLES))
    # Hard clamp per-frame displacement to PRED_STEP_FRAC × bbox.
    # Combined with the decay, the total displacement also stays
    # bounded as elapsed grows.
    max_dx = bw * PRED_STEP_FRAC
    max_dy = bh * PRED_STEP_FRAC
    total_dx = max(-max_dx, min(max_dx, dx * elapsed * decay))
    total_dy = max(-max_dy, min(max_dy, dy * elapsed * decay))
    p_cx = cx_last + total_dx
    p_cy = cy_last + total_dy
    half_w = bw / 2.0
    half_h = bh / 2.0
    return (int(p_cx - half_w), int(p_cy - half_h), int(p_cx + half_w), int(p_cy + half_h))


def _try_reidentify(state: TrackerState, det, t_s: float):
    """Find the most recent CLOSED track that plausibly matches
    ``det`` so an unmatched confirmed detection can RESUME the
    track instead of spawning a fresh id. Returns the candidate
    Track (still in ``state.closed`` — caller is responsible for
    moving it back to ``state.active``) or None.

    Match gates:
      * same label
      * closed within ``TRACK_REID_MAX_SECONDS`` of ``t_s``
      * centroid distance ≤ ``TRACK_REID_DIST_FACTOR × max(bw,bh)``
      * size ratio ≤ ``TRACK_REID_SIZE_RATIO``
      * (J4) the det's bbox does NOT overlap any ACTIVE track above
        REID_OCCUPIED_IOU — re-id only ever resumes into truly free
        space, never on top of a live track (which would create a
        parallel duplicate).

    Among candidates passing all gates, the closest in centroid
    distance wins.
    """
    closed = state.closed
    if not closed:
        return None
    bb = det.bbox
    # J4 · refuse re-id if ANY active track already occupies this
    # spot — the det should extend that live track via the spawn-
    # block path instead of resurrecting a parallel ghost.
    for tr in state.active:
        if not tr.samples:
            continue
        last_bb = tr.samples[-1]["bbox"]
        last_tuple = (
            int(last_bb["x1"]),
            int(last_bb["y1"]),
            int(last_bb["x2"]),
            int(last_bb["y2"]),
        )
        if iou(bb, last_tuple) > REID_OCCUPIED_IOU:
            return None
    cx = (bb[0] + bb[2]) / 2.0
    cy = (bb[1] + bb[3]) / 2.0
    bw = max(1.0, float(bb[2] - bb[0]))
    bh = max(1.0, float(bb[3] - bb[1]))
    best: Track | None = None
    best_dist = float("inf")
    # Scan the recently-closed window. Iterate over a bounded tail of
    # the closed list (newest closes first), then per-track filter on
    # last-sample t proximity. `continue` rather than `break` because
    # closed-order ≠ last_sample.t order — a track that closed late
    # after a long active span can have an older tail than one that
    # closed earlier with a fresher final sample.
    for tr in reversed(closed[-32:]):
        if tr.label != det.label:
            continue
        if not tr.samples:
            continue
        last_t = float(tr.samples[-1].get("t", 0) or 0)
        if t_s - last_t > TRACK_REID_MAX_SECONDS:
            continue
        last_bb = tr.samples[-1]["bbox"]
        last_bw = max(1.0, float(last_bb["x2"] - last_bb["x1"]))
        last_bh = max(1.0, float(last_bb["y2"] - last_bb["y1"]))
        sz_ratio = max(bw, last_bw) / min(bw, last_bw)
        if sz_ratio > TRACK_REID_SIZE_RATIO:
            continue
        sz_ratio_h = max(bh, last_bh) / min(bh, last_bh)
        if sz_ratio_h > TRACK_REID_SIZE_RATIO:
            continue
        last_cx = (last_bb["x1"] + last_bb["x2"]) / 2.0
        last_cy = (last_bb["y1"] + last_bb["y2"]) / 2.0
        d = ((cx - last_cx) ** 2 + (cy - last_cy) ** 2) ** 0.5
        max_d = max(last_bw, last_bh) * TRACK_REID_DIST_FACTOR
        if d > max_d:
            continue
        if d < best_dist:
            best_dist = d
            best = tr
    return best


def nms_per_label(dets, iou_threshold: float = NMS_IOU):
    """Per-label non-max suppression on raw detector output.

    Collapses the SSD's duplicate boxes on a single subject before
    track association runs — without this, every duplicate spawns
    its own track and the parallel copies coexist forever (the user-
    reported "4 boxes stacked on one person, dozens of lanes" symptom).

    Greedy, score-descending: within each label group, keep the
    highest-score bbox, then drop any subsequent bbox whose IoU
    against an already-kept box of the SAME label exceeds the
    threshold. Cross-label overlaps are NOT touched here — they're
    handled by the spawn-block gate in associate_detections so the
    SSD's occasional misclassification (e.g. "Vogel" on a person)
    can never seed a parallel cross-label track on the same subject.

    Returns a NEW list (caller's input is untouched) so the helper
    can sit pure at the entry of the live AND the post-clip path.
    """
    if not dets:
        return list(dets)
    by_label: dict[str, list] = {}
    for d in dets:
        by_label.setdefault(d.label, []).append(d)
    survivors: list = []
    for _lbl, group in by_label.items():
        group_sorted = sorted(group, key=lambda d: float(d.score), reverse=True)
        kept: list = []
        for d in group_sorted:
            if any(iou(d.bbox, k.bbox) > iou_threshold for k in kept):
                continue
            kept.append(d)
        survivors.extend(kept)
    return survivors


def _last_n_detect_bboxes(track: Track, n: int):
    """Return up to the last ``n`` detect-source sample bboxes as
    (x1,y1,x2,y2) tuples in original order. Used by the merge pass
    to test SUSTAINED overlap between two active tracks."""
    out: list[tuple[int, int, int, int]] = []
    for s in reversed(track.samples or []):
        src = s.get("source")
        if src not in ("detect", "track"):
            continue
        bb = s["bbox"]
        out.append((int(bb["x1"]), int(bb["y1"]), int(bb["x2"]), int(bb["y2"])))
        if len(out) >= n:
            break
    out.reverse()
    return out


def _track_quality_score(track: Track) -> float:
    """Heuristic ordering for "which track to KEEP when merging two
    duplicates". Higher score wins. Ranks on: number of detect
    samples first (longer history = canonical), then best_score
    (stronger evidence). Ties broken by first_frame (earlier id
    keeps the id the operator already learned)."""
    detect_n = sum(1 for s in (track.samples or []) if s.get("source") in ("detect", "track"))
    return detect_n * 100.0 + float(track.best_score or 0.0) * 10.0


def _merge_active_duplicates(state: TrackerState):
    """One-pass merge for parallel duplicate active tracks. Scans
    every (i, j) pair of active tracks; merges j into i when:
      * same label
      * both have at least MERGE_SUSTAIN detect samples
      * their last MERGE_SUSTAIN detect bboxes pairwise overlap
        above MERGE_IOU on EVERY pair (= "sustained co-location")

    The winner is picked via _track_quality_score so the operator's
    canonical id (the one with more history) keeps living. The loser
    is absorbed (samples merged in chronological order then re-sorted
    by frame index) and moved to ``state.closed`` with end_reason
    ``"merged"`` so the post-clip diagnostics can audit the merge.

    Conservative-by-design — the sustained-overlap requirement
    avoids merging two genuinely distinct people who happen to cross
    paths for a single sample.
    """
    active = state.active
    if len(active) < 2:
        return
    # Pre-compute tail bboxes once per track per pass.
    tails: dict[int, list] = {}
    for ti, tr in enumerate(active):
        tails[ti] = _last_n_detect_bboxes(tr, MERGE_SUSTAIN)
    absorbed: set[int] = set()
    for i in range(len(active)):
        if i in absorbed:
            continue
        ti_tail = tails[i]
        if len(ti_tail) < MERGE_SUSTAIN:
            continue
        for j in range(i + 1, len(active)):
            if j in absorbed:
                continue
            if active[i].label != active[j].label:
                continue
            tj_tail = tails[j]
            if len(tj_tail) < MERGE_SUSTAIN:
                continue
            # Sustained pairwise overlap across the last MERGE_SUSTAIN
            # detect samples. Compare position-by-position (oldest to
            # newest) so two tracks that overlap NOW but didn't earlier
            # don't get merged on a single-frame coincidence.
            all_overlap = True
            for k in range(MERGE_SUSTAIN):
                if iou(ti_tail[k], tj_tail[k]) < MERGE_IOU:
                    all_overlap = False
                    break
            if not all_overlap:
                continue
            # Pick the winner / loser.
            qi = _track_quality_score(active[i])
            qj = _track_quality_score(active[j])
            if qj > qi or (qj == qi and active[j].first_frame < active[i].first_frame):
                winner, loser = active[j], active[i]
                absorbed.add(i)
            else:
                winner, loser = active[i], active[j]
                absorbed.add(j)
            # Absorb loser samples — frame-deduplicated merge so
            # overlapping frames don't double-count. The winner keeps
            # its own bbox for any frame both touched (its sample is
            # already in its list).
            existing_frames = {s.get("f") for s in (winner.samples or [])}
            for s in loser.samples or []:
                if s.get("f") in existing_frames:
                    continue
                winner.samples.append(s)
            winner.samples.sort(key=lambda s: int(s.get("f", 0)))
            # Refresh aggregate fields from the merged sample set.
            winner.first_frame = min(winner.first_frame, loser.first_frame)
            winner.last_frame = max(winner.last_frame, loser.last_frame)
            for s in winner.samples or []:
                sc = s.get("score")
                if sc is not None and float(sc) > float(winner.best_score):
                    winner.best_score = float(sc)
                    winner.best_frame_idx = int(s.get("f", 0))
            loser.active = False
            loser.end_reason = "merged"
            # Refresh winner's tail cache so subsequent comparisons in
            # this same pass see the post-merge state.
            tails[active.index(winner)] = _last_n_detect_bboxes(winner, MERGE_SUSTAIN)
            if winner is active[i]:
                ti_tail = tails[i]
            # If winner was j, the outer loop will skip i since i is
            # in `absorbed` — no need to update outer indices.
    if not absorbed:
        return
    # Move absorbed tracks to closed.
    survivors = []
    for idx, tr in enumerate(active):
        if idx in absorbed:
            state.closed.append(tr)
        else:
            survivors.append(tr)
    state.active = survivors


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


def associate_detections(
    state: TrackerState,
    dets,
    frame_idx: int,
    t_s: float,
    *,
    frame_w: int = 0,
    frame_h: int = 0,
    spawn_score: float = TRACK_SPAWN_SCORE,
    spawn_for: Callable[[str], float] | None = None,
    miss_grace_samples: int = TRACK_MISS_WINDOWS,
    iou_threshold: float = IOU_MATCH_THRESHOLD,
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

    # J1 · NMS at the entry so every later stage works on a deduped
    # detection stream. Same-label boxes whose IoU exceeds NMS_IOU
    # collapse to the highest-score one — kills the SSD-internal
    # duplicate cluster that used to spawn parallel tracks on a
    # single subject. Caller's `dets` list is left untouched (helper
    # returns a new list).
    dets = nms_per_label(dets, NMS_IOU)

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
                if iou_v >= iou_threshold:
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
            bbox_dict = {
                "x1": int(d.bbox[0]),
                "y1": int(d.bbox[1]),
                "x2": int(d.bbox[2]),
                "y2": int(d.bbox[3]),
            }
            tr.add_sample(frame_idx, t_s, bbox_dict, float(d.score), "detect", d.label)
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

    # Phase 3 — unmatched confirmed dets. The flow now is:
    #
    #   1. SPAWN-BLOCK check (J2). If the det's bbox strongly
    #      overlaps an active track's LAST-OBSERVED bbox (any
    #      label, IoU > SPAWN_BLOCK_IOU), the det is either a
    #      same-label duplicate (likely a direction-reversal that
    #      slipped past Phase 1's prediction-based matcher) or a
    #      cross-label misclassification of an already-tracked
    #      subject. Same-label → ATTACH to that track. Cross-label
    #      → DROP. Either way no fresh id spawns.
    #   2. RE-ID against recently-closed same-label tracks for
    #      "person walked back in after grace expired".
    #   3. Fallback: spawn a fresh id.
    #
    # Unmatched tentative dets are still dropped (no spawn) so a
    # flicker of low-conf noise can't seed a new track id.
    def _spawn_blocking_track(det):
        """Return the ACTIVE track whose last-observed bbox
        overlaps ``det.bbox`` above SPAWN_BLOCK_IOU, or None.
        Considers ALL labels — a cross-label hit indicates a
        misclassification of an already-tracked subject. Picks the
        highest IoU when multiple qualify."""
        best_track: Track | None = None
        best_iou = SPAWN_BLOCK_IOU
        for ti, tr in enumerate(state.active):
            if not tr.samples:
                continue
            # Predicted bbox was computed at frame entry — reuse.
            pred = predicted[ti] if ti < len(predicted) else None
            last_bb = tr.samples[-1]["bbox"]
            last_tuple = (
                int(last_bb["x1"]),
                int(last_bb["y1"]),
                int(last_bb["x2"]),
                int(last_bb["y2"]),
            )
            iou_pred = iou(det.bbox, pred) if pred is not None else 0.0
            iou_last = iou(det.bbox, last_tuple)
            best_for_track = max(iou_pred, iou_last)
            if best_for_track > best_iou:
                best_iou = best_for_track
                best_track = tr
        return best_track

    for di, d in confirmed:
        if di in taken_confirmed:
            continue
        bbox_dict = {
            "x1": int(d.bbox[0]),
            "y1": int(d.bbox[1]),
            "x2": int(d.bbox[2]),
            "y2": int(d.bbox[3]),
        }
        blocker = _spawn_blocking_track(d)
        if blocker is not None:
            # J5 · attach the det to the blocker REGARDLESS of label.
            # The per-sample label is preserved on the new sample and
            # the track's dominant label re-votes inside add_sample;
            # a single off-label frame (the SSD's occasional "Vogel"
            # on a person) gets absorbed into the same track and the
            # majority "person" wins, so no parallel cross-label
            # ghost ever materialises.
            blocker.add_sample(frame_idx, t_s, bbox_dict, float(d.score), "detect", d.label)
            blocker.missed_windows = 0
            state.samples_emitted += 1
            update_best_top(state, d, frame_idx, t_s)
            matches.append((di, blocker))
            try:
                ti = state.active.index(blocker)
                taken_tracks.add(ti)
            except ValueError:
                pass
            continue
        revived = _try_reidentify(state, d, t_s)
        if revived is not None:
            with contextlib.suppress(ValueError):
                state.closed.remove(revived)
            revived.active = True
            revived.end_reason = None
            revived.missed_windows = 0
            revived.add_sample(frame_idx, t_s, bbox_dict, float(d.score), "detect", d.label)
            state.active.append(revived)
            state.samples_emitted += 1
            update_best_top(state, d, frame_idx, t_s)
            matches.append((di, revived))
            continue
        tid = short_id()
        tr = Track(tid, d.label, frame_idx)
        tr.add_sample(frame_idx, t_s, bbox_dict, float(d.score), "detect", d.label)
        state.active.append(tr)
        state.samples_emitted += 1
        update_best_top(state, d, frame_idx, t_s)
        matches.append((di, tr))

    # Age out tracks that didn't get a hit this window. After
    # ``miss_grace_samples`` misses they close. Restricted to indices
    # < original_count so newly-spawned tracks (appended above) skip
    # this pass and get their first miss-check on the NEXT frame.
    # Each miss also emits ONE ``source="predicted"`` sample at the
    # already-computed predicted bbox — the IoU matcher already uses
    # the prediction internally; this just stops hiding it from the
    # downstream consumers. The Mediathek swimlane renders these as
    # the dashed tail of the track bar so the operator sees that
    # tracking is still alive across short occlusions instead of a
    # hard gap. Scoring is conservative: the last detect score
    # scaled to 0.7 (floor 0.05) — a coarse "still tracking, lower
    # confidence" signal that doesn't invent fresh evidence.
    grace = max(1, int(miss_grace_samples))

    # K4 · helper — is a bbox touching/exceeding the frame edge?
    def _at_frame_edge(bb):
        if frame_w <= 0 or frame_h <= 0:
            return False
        return (
            bb["x1"] <= EDGE_MARGIN_PX
            or bb["y1"] <= EDGE_MARGIN_PX
            or bb["x2"] >= frame_w - EDGE_MARGIN_PX
            or bb["y2"] >= frame_h - EDGE_MARGIN_PX
        )

    for ti, tr in enumerate(state.active[:original_count]):
        if ti in taken_tracks:
            continue
        # K4 · clamp the predicted bbox to frame bounds so a subject
        # whose extrapolated position would land off-frame is held
        # at the visible boundary instead. A box predicted at
        # x2 = frame_w + 200 is geometrically nonsense for IoU
        # matching and visually misleading on the bbox overlay.
        px1, py1, px2, py2 = predicted[ti]
        if frame_w > 0:
            px1 = max(0, min(frame_w, px1))
            px2 = max(0, min(frame_w, px2))
        if frame_h > 0:
            py1 = max(0, min(frame_h, py1))
            py2 = max(0, min(frame_h, py2))
        bbox_dict = {"x1": int(px1), "y1": int(py1), "x2": int(px2), "y2": int(py2)}
        last_detect_score = next(
            (
                s.get("score")
                for s in reversed(tr.samples)
                if s.get("source") == "detect" and s.get("score") is not None
            ),
            None,
        )
        pred_score = (
            max(0.05, float(last_detect_score) * 0.7) if last_detect_score is not None else 0.05
        )
        tr.add_sample(frame_idx, t_s, bbox_dict, pred_score, "predicted")
        state.samples_emitted += 1
        tr.missed_windows += 1
        # K4 · short grace when the track's LAST OBSERVED bbox sits
        # at the frame edge. The subject most likely walked out of
        # frame — continuing to extrapolate "behind" the boundary
        # for 8 s pins a stale box on the video and floods the
        # timeline with a long predicted tail. Cap effective grace
        # at EDGE_GRACE_SAMPLES so the track closes promptly.
        last_detect_bb = next(
            (s["bbox"] for s in reversed(tr.samples) if s.get("source") in ("detect", "track")),
            None,
        )
        effective_grace = grace
        if last_detect_bb is not None and _at_frame_edge(last_detect_bb):
            effective_grace = min(grace, EDGE_GRACE_SAMPLES)
        if tr.missed_windows >= effective_grace:
            tr.close("timeout", frame_w, frame_h)
    state.closed.extend([t for t in state.active if not t.active])
    state.active = [t for t in state.active if t.active]
    # J3 · per-frame dedup pass — fold parallel duplicate active
    # tracks (sustained co-location over the last MERGE_SUSTAIN
    # detect samples) into one canonical id. Conservative gates
    # (same-label + sustained overlap) keep two crossing people
    # safely separate. Runs AFTER age-out so a track about to be
    # closed by miss-grace doesn't get re-merged on its way out.
    _merge_active_duplicates(state)
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
        "camera_id",
        "state",
        "_frame_idx",
        "spawn_default",
        "floor",
        "grace_seconds",
        "iou_threshold",
    )

    def __init__(
        self,
        camera_id: str,
        *,
        spawn_default: float = TRACK_SPAWN_SCORE,
        floor: float = TRACK_FLOOR_SCORE,
        grace_seconds: float = MISS_GRACE_DEFAULT_SECONDS,
        iou_threshold: float = IOU_MATCH_THRESHOLD,
    ):
        self.camera_id = camera_id
        self.state = TrackerState()
        self._frame_idx = 0
        self.spawn_default = float(spawn_default)
        self.floor = float(floor)
        self.grace_seconds = float(grace_seconds)
        self.iou_threshold = float(iou_threshold)

    def configure(
        self,
        *,
        spawn_default: float,
        floor: float,
        grace_seconds: float,
        iou_threshold: float | None = None,
    ) -> None:
        """Replace the per-camera thresholds. Called on settings reload
        so a tweaked spawn / continue / grace / iou value takes effect
        without rebuilding the runtime. ``iou_threshold`` defaults to
        the module constant when omitted so older callers that pass
        only the three legacy fields keep working."""
        self.spawn_default = float(spawn_default)
        self.floor = float(floor)
        self.grace_seconds = float(grace_seconds)
        if iou_threshold is not None:
            self.iou_threshold = float(iou_threshold)

    def step(
        self, detections, *, t_s: float, fps: float, spawn_for: Callable[[str], float] | None = None
    ) -> list:
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
            self.state,
            list(detections),
            frame_idx=self._frame_idx,
            t_s=float(t_s),
            spawn_score=self.spawn_default,
            spawn_for=spawn_for,
            miss_grace_samples=grace,
            iou_threshold=self.iou_threshold,
        )
        # Return the detection objects (not the (di, track) tuples) in
        # input order so downstream pipeline stages see a clean list.
        matched_dets = [detections[di] for di, _tr in matches]
        return matched_dets

    def active_count(self) -> int:
        return len(self.state.active)

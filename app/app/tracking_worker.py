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
from .bbox_utils import iou as _iou
from .tracker_core import (
    MISS_GRACE_DEFAULT_SECONDS,
    TRACK_FLOOR_SCORE,
    TRACK_SPAWN_SCORE,
    TrackerState as _TrackerState,
    associate_detections as _associate_detections,
    resolve_track_thresholds as _resolve_track_thresholds,
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
#   v4 — K3 · adds top-level "gates" block recording the per-camera
#        TRACK_SPAWN_SCORE / TRACK_FLOOR_SCORE / miss-grace values
#        the worker actually applied. The Mediathek timeline panel
#        renders these inline when an indexed clip ends up with
#        tracks=[] so the user sees "Indexierung fertig · keine
#        Spuren bestätigt — kurze Sichtungen unter X % werden
#        gefiltert" instead of the ambiguous "Keine Track-Daten —
#        erscheinen sobald die Indexierung fertig ist" (which read
#        as "still running" when the indexer had in fact finished
#        and found nothing trackable).
TRACKS_SCHEMA = 4

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


def _open_video(video_path: Path, *, precision: str = "standard"):
    """Open the file and read its sampling cadence. Returns
    ``(capture, meta)``; capture is None on failure (and is released
    before returning so the caller doesn't have to). meta carries
    ``fps``, ``frame_count``, ``duration_s``, ``sample_interval``,
    ``frame_w``, ``frame_h``. The frame dimensions feed the per-track
    end-state diagnostics (last_bbox_frac_h / last_bbox_frac_area).

    ``precision`` controls the sampling cadence:
      * ``"standard"`` (default) — ~1 Hz, the historic post-clip
        behaviour. One inference per second of clip.
      * ``"precise"`` — ~2 Hz. Doubles the per-clip inference cost
        but halves the gap between samples so tracks reflect motion
        more faithfully. Same algorithm; just sees more samples."""
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
    if precision == "precise":
        sample_interval = max(1, int(round(fps / 2)))  # ~2 Hz
    else:
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


# K1 · gates for the static-false-positive sweep. A tracklet is
# DROPPED at payload build when ALL of these hold:
#   * has at least STATIC_FP_MIN_DETECTS detect samples (so the
#     stats are meaningful — a 2-sample blip is left alone),
#   * MEDIAN of its detect-source scores < the clip's spawn
#     threshold (the model never had real confidence in this
#     subject — best_score sometimes spikes once just above spawn
#     for a chair/pole, but the median stays low),
#   * net centroid displacement from first to last detect sample
#     is < STATIC_FP_DISP_FRAC × min(median_bw, median_bh) (it
#     didn't move enough to be a person walking),
#   * max single-frame centroid step is also < the same fraction
#     (no momentary motion in the middle either — fully static).
# Real persons standing still consistently score ≥ spawn, so the
# score gate alone protects them. Real persons who walk fail the
# displacement gate.
STATIC_FP_MIN_DETECTS = 3
STATIC_FP_DISP_FRAC = 0.5


def _is_static_false_positive(track, spawn_score: float):
    """Return ``(drop: bool, reason: str)`` per the static-FP gates."""
    det = [s for s in (track.samples or []) if s.get("source") in ("detect", "track")]
    if len(det) < STATIC_FP_MIN_DETECTS:
        return False, ""
    scores = sorted(float(s.get("score") or 0.0) for s in det)
    median_score = scores[len(scores) // 2]
    if median_score >= spawn_score:
        return False, ""  # genuinely confident → keep regardless of motion
    bb0 = det[0]["bbox"]
    bbN = det[-1]["bbox"]
    cx0 = (bb0["x1"] + bb0["x2"]) / 2.0
    cy0 = (bb0["y1"] + bb0["y2"]) / 2.0
    cxN = (bbN["x1"] + bbN["x2"]) / 2.0
    cyN = (bbN["y1"] + bbN["y2"]) / 2.0
    net_px = ((cxN - cx0) ** 2 + (cyN - cy0) ** 2) ** 0.5
    bws = sorted(s["bbox"]["x2"] - s["bbox"]["x1"] for s in det)
    bhs = sorted(s["bbox"]["y2"] - s["bbox"]["y1"] for s in det)
    med_bw = bws[len(bws) // 2]
    med_bh = bhs[len(bhs) // 2]
    med_dim = min(med_bw, med_bh)
    if med_dim <= 0:
        return False, ""
    motion_floor = STATIC_FP_DISP_FRAC * med_dim
    if net_px >= motion_floor:
        return False, ""  # walked enough to be a real subject
    # Maximum single-step displacement — if even ONE pair of
    # consecutive samples shifted significantly, treat as moving
    # (could be a partly-visible person who paused briefly).
    max_step = 0.0
    for i in range(1, len(det)):
        a = det[i - 1]["bbox"]
        b = det[i]["bbox"]
        ax = (a["x1"] + a["x2"]) / 2.0
        ay = (a["y1"] + a["y2"]) / 2.0
        bx = (b["x1"] + b["x2"]) / 2.0
        by = (b["y1"] + b["y2"]) / 2.0
        step = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        if step > max_step:
            max_step = step
    if max_step >= motion_floor:
        return False, ""
    reason = (
        f"static-fp · median_score={median_score:.2f}<spawn={spawn_score:.2f}, "
        f"net={net_px:.0f}px<{motion_floor:.0f}, max_step={max_step:.0f}px"
    )
    return True, reason


# K3 · global offline tracklet stitching parameters.
#
# Sequential stitch: tracklet A ends at time t_a_end, tracklet B
# starts at t_b_start. Linkable iff (same label) AND
# (gap ≤ STITCH_MAX_GAP_S) AND (centroid distance ≤
# STITCH_DIST_FACTOR × max(last_bw, last_bh, first_bw, first_bh))
# AND (size ratio between A.last and B.first ≤ STITCH_SIZE_RATIO).
#
# Parallel/overlap merge: two tracklets co-existing in time whose
# detect samples in the OVERLAP window have IoU ≥ STITCH_OVERLAP_IOU
# on every shared frame. Same label only.
STITCH_MAX_GAP_S = 6.0
STITCH_DIST_FACTOR = 1.6
STITCH_SIZE_RATIO = 1.8
STITCH_OVERLAP_IOU = 0.55


def _t_first_last_detect(track):
    """Return ``(t_first, t_last, bb_first, bb_last)`` for the first
    and LAST detect-source samples, or ``None`` when the track has
    no observed samples."""
    det = [s for s in (track.samples or []) if s.get("source") in ("detect", "track")]
    if not det:
        return None
    return (
        float(det[0].get("t", 0.0)),
        float(det[-1].get("t", 0.0)),
        det[0]["bbox"],
        det[-1]["bbox"],
    )


def _bb_tuple(bb):
    return (int(bb["x1"]), int(bb["y1"]), int(bb["x2"]), int(bb["y2"]))


def _bb_center(bb):
    return ((bb["x1"] + bb["x2"]) / 2.0, (bb["y1"] + bb["y2"]) / 2.0)


def _bb_dims(bb):
    return (bb["x2"] - bb["x1"], bb["y2"] - bb["y1"])


def _can_stitch_sequential(a, b) -> tuple[bool, str]:
    """Return ``(yes, reason)``. ``b`` must start AFTER ``a`` ends.
    Same-label, time gap small, spatial endpoints consistent.
    """
    if a.label != b.label:
        return False, "label-mismatch"
    a_meta = _t_first_last_detect(a)
    b_meta = _t_first_last_detect(b)
    if not a_meta or not b_meta:
        return False, "no-detect-samples"
    _, t_a_end, _, bb_a_end = a_meta
    t_b_start, _, bb_b_start, _ = b_meta
    if t_b_start < t_a_end - 0.01:
        return False, "b-starts-before-a-ends"
    gap = t_b_start - t_a_end
    if gap > STITCH_MAX_GAP_S:
        return False, f"gap={gap:.1f}>{STITCH_MAX_GAP_S}"
    aw, ah = _bb_dims(bb_a_end)
    bw, bh = _bb_dims(bb_b_start)
    sz_w = max(aw, bw) / max(1.0, float(min(aw, bw)))
    sz_h = max(ah, bh) / max(1.0, float(min(ah, bh)))
    if sz_w > STITCH_SIZE_RATIO or sz_h > STITCH_SIZE_RATIO:
        return False, f"size-ratio={max(sz_w, sz_h):.2f}>{STITCH_SIZE_RATIO}"
    acx, acy = _bb_center(bb_a_end)
    bcx, bcy = _bb_center(bb_b_start)
    dist = ((bcx - acx) ** 2 + (bcy - acy) ** 2) ** 0.5
    max_dim = max(aw, ah, bw, bh)
    max_dist = STITCH_DIST_FACTOR * max_dim
    if dist > max_dist:
        return False, f"dist={dist:.0f}>{max_dist:.0f}"
    return True, (
        f"gap={gap:.1f}s dist={dist:.0f}px max_dim={max_dim} " f"size_ratio={max(sz_w, sz_h):.2f}"
    )


def _overlap_iou_sustained(a, b) -> float:
    """Return the MEAN IoU of detect samples that share frame indices
    between tracklets a and b. 0.0 if they don't share any frame."""
    a_by_f = {
        int(s["f"]): s["bbox"] for s in (a.samples or []) if s.get("source") in ("detect", "track")
    }
    b_by_f = {
        int(s["f"]): s["bbox"] for s in (b.samples or []) if s.get("source") in ("detect", "track")
    }
    shared = a_by_f.keys() & b_by_f.keys()
    if not shared:
        return 0.0
    total = 0.0
    for f in shared:
        total += _iou(_bb_tuple(a_by_f[f]), _bb_tuple(b_by_f[f]))
    return total / float(len(shared))


def _absorb(into, donor) -> None:
    """Merge donor's samples into ``into``. Frame-deduped; sample
    list re-sorted. Aggregate fields refreshed from the unified set.
    ``donor`` is left empty + marked inactive — caller drops it."""
    existing_frames = {int(s.get("f", -1)) for s in (into.samples or [])}
    for s in donor.samples or []:
        if int(s.get("f", -1)) in existing_frames:
            continue
        into.samples.append(s)
    into.samples.sort(key=lambda s: int(s.get("f", 0)))
    if into.samples:
        into.first_frame = min(into.first_frame, donor.first_frame)
        into.last_frame = max(into.last_frame, donor.last_frame)
    for s in into.samples or []:
        sc = s.get("score")
        if sc is not None and float(sc) > float(into.best_score or 0.0):
            into.best_score = float(sc)
            into.best_frame_idx = int(s.get("f", 0))
    donor.samples = []
    donor.active = False
    donor.end_reason = "stitched"


def _stitch_tracklets_offline(state: _TrackerState) -> int:
    """Two-pass global stitcher run on ``state.closed`` before
    payload serialisation. Returns the number of tracklets absorbed.

    Pass 1 — sequential. Order tracklets by first detect t. For each
    later tracklet B, look back over earlier tracklets and link to
    the closest predecessor A that passes ``_can_stitch_sequential``.
    Iterate until no more links found (fragments collapse).

    Pass 2 — parallel overlap. Any pair (A, B) of same-label tracks
    that share detect frames AND those shared frames have mean IoU
    ≥ STITCH_OVERLAP_IOU → same object → merge B into A.

    Conservative: simultaneous, spatially-separate tracks are NEVER
    merged (the IoU gate would fail). Cross-label is gated out.
    Quality scoring picks the canonical winner.
    """
    closed = state.closed
    if len(closed) < 2:
        return 0
    absorbed_total = 0
    # ── Pass 1 · sequential stitch (multi-iteration so chains collapse)
    while True:
        # Build start-time index over CURRENT (post-merge) survivors.
        live = [t for t in closed if t.samples]
        if len(live) < 2:
            break
        live.sort(key=lambda t: _t_first_last_detect(t)[0] if _t_first_last_detect(t) else 0.0)
        merged_this_round = 0
        absorbed_set: set = set()
        for j, b in enumerate(live):
            if id(b) in absorbed_set:
                continue
            best_a = None
            best_gap = STITCH_MAX_GAP_S + 1.0
            for i in range(j):
                a = live[i]
                if id(a) in absorbed_set:
                    continue
                ok, _why = _can_stitch_sequential(a, b)
                if not ok:
                    continue
                a_meta = _t_first_last_detect(a)
                b_meta = _t_first_last_detect(b)
                if not a_meta or not b_meta:
                    continue
                gap = b_meta[0] - a_meta[1]
                if 0.0 <= gap < best_gap:
                    best_gap = gap
                    best_a = a
            if best_a is not None:
                log.info(
                    "[tracking] stitch tid=%s ← tid=%s · gap=%.1fs (sequential)",
                    best_a.track_id,
                    b.track_id,
                    best_gap,
                )
                _absorb(best_a, b)
                absorbed_set.add(id(b))
                merged_this_round += 1
        absorbed_total += merged_this_round
        if merged_this_round == 0:
            break
    # ── Pass 2 · overlap merge
    while True:
        live = [t for t in closed if t.samples]
        if len(live) < 2:
            break
        merged = 0
        for i in range(len(live)):
            a = live[i]
            if not a.samples:
                continue
            for k in range(i + 1, len(live)):
                b = live[k]
                if not b.samples or a.label != b.label:
                    continue
                if _overlap_iou_sustained(a, b) < STITCH_OVERLAP_IOU:
                    continue
                # Score-based winner so the canonical track keeps
                # going. More detect samples → higher; ties broken
                # toward higher best_score.
                a_n = sum(1 for s in a.samples if s.get("source") in ("detect", "track"))
                b_n = sum(1 for s in b.samples if s.get("source") in ("detect", "track"))
                if (b_n, b.best_score or 0.0) > (a_n, a.best_score or 0.0):
                    into, donor = b, a
                else:
                    into, donor = a, b
                log.info(
                    "[tracking] stitch tid=%s ← tid=%s · overlap-iou (parallel)",
                    into.track_id,
                    donor.track_id,
                )
                _absorb(into, donor)
                merged += 1
                break  # restart outer loop
            if merged:
                break
        absorbed_total += merged
        if merged == 0:
            break
    # Prune absorbed (empty + inactive) tracklets from the closed list.
    state.closed = [t for t in closed if t.samples]
    return absorbed_total


def _filter_static_false_positives(state: _TrackerState, spawn_score: float):
    """In-place purge of static-FP tracklets from ``state.closed``.
    Each drop logs one INFO line so the operator can audit which
    tracks were silenced and why.
    """
    survivors = []
    for tr in state.closed:
        drop, reason = _is_static_false_positive(tr, spawn_score)
        if drop:
            n = sum(1 for s in (tr.samples or []) if s.get("source") in ("detect", "track"))
            log.info(
                "[tracking] drop tid=%s n=%d best=%.2f label=%s · %s",
                tr.track_id,
                n,
                float(tr.best_score or 0.0),
                tr.label,
                reason,
            )
            continue
        survivors.append(tr)
    state.closed = survivors


def _samples_confirm_window(samples, n: int, secs: float) -> bool:
    """Sliding-window N-of-window confirmation check on detect samples.
    Mirrors the logic in ``_update_event_achievement`` so a track the
    user's confirmation_window would have promoted in the live path
    survives the ghost prune even when its peak score sat below the
    label spawn threshold (rare but real for big-but-faint subjects).
    """
    detect_samples = [s for s in (samples or []) if s.get("source") == "detect"]
    for i, s in enumerate(detect_samples):
        t0 = float(s.get("t", 0))
        in_win = 1
        for j in range(i + 1, len(detect_samples)):
            if float(detect_samples[j].get("t", 0)) - t0 > secs:
                break
            in_win += 1
        if in_win >= n:
            return True
    return False


def _prune_ghost_tracks(
    state: _TrackerState,
    *,
    cam_cfg: dict,
    detection_cfg: dict,
    camera_id: str,
) -> int:
    """L07 · drop tracks from the sidecar whose best_score never
    reached the per-label spawn threshold AND that were never
    confirmed by the confirmation window. These ghosts exist only
    because the IoU matcher held them across frames; they would
    never have triggered a real recording but the bbox renderer
    paints them anyway, leading to events where a stone gets
    labelled "Person 23%".

    Per-label spawn lookup mirrors the live path:
        1. cam_cfg.label_thresholds[label]   (non-zero)
        2. cam_cfg.detection_min_score       (non-zero)
        3. detection_cfg["min_score"]        (global default)
    Per-camera ``track_spawn_min_score`` (non-zero) sets a floor for
    the global SPAWN gate; max(per-label, per-cam-floor) is the
    actual threshold a track must clear. Tracks with ``best_score``
    at-or-above that threshold pass through unchanged.

    Idempotent: mutates ``state.closed`` in place and returns the
    drop count so the caller can summarise.
    """
    if not state.closed:
        return 0
    label_thresholds = cam_cfg.get("label_thresholds") or {}
    try:
        cam_dms = float(cam_cfg.get("detection_min_score") or 0.0)
    except (TypeError, ValueError):
        cam_dms = 0.0
    try:
        global_dms = float((detection_cfg or {}).get("min_score") or 0.55)
    except (TypeError, ValueError):
        global_dms = 0.55
    try:
        cam_spawn_floor = float(cam_cfg.get("track_spawn_min_score") or 0.0)
    except (TypeError, ValueError):
        cam_spawn_floor = 0.0

    def _per_label(lbl: str) -> float:
        v = label_thresholds.get(lbl)
        try:
            if v is not None:
                fv = float(v)
                if fv > 0:
                    return fv
        except (TypeError, ValueError):
            pass
        if cam_dms > 0:
            return cam_dms
        return global_dms

    cw_cfg = cam_cfg.get("confirmation_window") or {}
    global_cw = cw_cfg.get("global") or {}
    default_n = int(global_cw.get("n", 3))
    default_secs = float(global_cw.get("seconds", 5.0))

    survivors = []
    dropped = 0
    for tr in state.closed:
        lbl = tr.label or "unknown"
        per_lbl = _per_label(lbl)
        # The actual gate uses the higher of the per-label spawn and
        # the per-cam track_spawn_min_score floor — same rule the live
        # confirmer applies (label-specific) plus the spawn floor from
        # _resolve_track_thresholds (cam-wide).
        effective = max(per_lbl, cam_spawn_floor)
        best = float(tr.best_score or 0.0)
        if best >= effective:
            survivors.append(tr)
            continue
        # Below spawn threshold — confirmation window override. A
        # consistently-seen-but-faint subject (e.g. squirrel at dusk)
        # that the confirmer would have promoted in the live path is
        # NOT a ghost; keep it.
        cw = cw_cfg.get(lbl) or {"n": default_n, "seconds": default_secs}
        n = int(cw.get("n", default_n))
        secs = float(cw.get("seconds", default_secs))
        if _samples_confirm_window(tr.samples, n, secs):
            survivors.append(tr)
            continue
        log.info(
            "[tracking] cam=%s GHOST dropped: tid=%s label=%s best=%.2f < spawn=%.2f",
            camera_id,
            tr.track_id,
            lbl,
            best,
            effective,
        )
        dropped += 1

    if dropped:
        state.closed = survivors
    return dropped


# TODO: re-index existing events to retroactively drop ghost tracks
# from pre-L07 sidecars. Needs an admin endpoint that iterates
# storage/motion_detection/<cam>/<date>/*.tracks.json, re-applies
# _prune_ghost_tracks with each cam's CURRENT config, and rewrites
# the sidecar. Out of scope for the initial L07 commit — only NEW
# clips get the cleanup until that ships.


def _build_payload(
    state: _TrackerState,
    fps: float,
    frame_count: int,
    duration_s: float,
    allowed,
    video_path: Path,
    storage_root: Path,
    *,
    spawn_score: float = TRACK_SPAWN_SCORE,
    floor_score: float = TRACK_FLOOR_SCORE,
    grace_s: float = MISS_GRACE_DEFAULT_SECONDS,
) -> dict:
    """Assemble the tracks.json payload. The track-serialisation block
    iterates state.closed; the caller is responsible for flushing any
    still-active tracks into closed before this runs.

    K3 · the ``gates`` block surfaces the thresholds the worker
    actually applied for this clip. The Mediathek timeline panel
    renders these inline when an indexed clip ends up with tracks=[]
    so the user sees the WHY (e.g. "kurze Sichtungen unter 50 %
    werden gefiltert") rather than the ambiguous "Keine Track-
    Daten — erscheinen sobald die Indexierung fertig ist". Per-
    camera overrides are honoured via the same _resolve_track
    _thresholds() helper the live association loop uses."""
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
        # K3 (schema=4) · gate values the worker actually applied.
        # min_confidence is the spawn floor — detections below this
        # can only EXTEND an existing track via IoU, never spawn a
        # new one. raw_floor is the detector's per-frame threshold
        # (anything below isn't even returned for association).
        # miss_grace_s is the wall-clock window for a missed track
        # to recover before being closed.
        "gates": {
            "min_confidence": round(float(spawn_score), 3),
            "raw_floor": round(float(floor_score), 3),
            "miss_grace_s": round(float(grace_s), 2),
        },
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

    def __init__(
        self,
        *,
        storage_root: Path,
        detection_cfg_getter: Callable[[], dict] | None = None,
        cam_cfg_getter: Callable[[str], dict] | None = None,
    ):
        super().__init__(name="tracking-worker", daemon=True)
        self._q: queue.Queue[TrackingJob | None] = queue.Queue()
        self._stop = threading.Event()
        self._storage_root = Path(storage_root)
        self._cfg_getter = detection_cfg_getter or (lambda: {})
        # Per-camera live config lookup (typically settings.get_camera).
        # Used to pull each job's object_filter so the worker mirrors the
        # camera_runtime/_main_loop label filter exactly.
        self._cam_cfg_getter = cam_cfg_getter or (lambda _cam_id: {})
        self._detector = None  # built lazily on first job
        self._detector_cfg_id = None  # id() of cfg dict — rebuild on swap
        self._jobs_done = 0
        self._jobs_failed = 0
        # Bounded ring of recent per-event failures so the UI can tell
        # the user *why* a re-index didn't produce a fresh sidecar.
        # Keyed by event_id; oldest entries fall off when the cap is
        # exceeded. 32 is plenty for the polling UI to find the failure
        # before it ages out.
        self._recent_failures: collections.OrderedDict[str, dict] = collections.OrderedDict()
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
                log.error("[tracking] event=%s failed: %s", job.event_id, e, exc_info=True)
            finally:
                self._q.task_done()
        log.info(
            "[tracking] worker stopped (done=%d failed=%d)", self._jobs_done, self._jobs_failed
        )

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
            log.warning("[tracking] event=%s video missing: %s", job.event_id, job.video_path)
            return

        # Per-camera sampling cadence. "standard" = 1 Hz (historic
        # default); "precise" = 2 Hz for richer track samples at
        # double the inference cost. The knob lives in settings.json
        # only (no UI in this version).
        precision = "standard"
        try:
            _cfg = self._cam_cfg_getter(job.camera_id) if self._cam_cfg_getter else {}
            if isinstance(_cfg, dict):
                _p = str(_cfg.get("track_postclip_precision") or "").strip().lower()
                if _p == "precise":
                    precision = "precise"
        except Exception:
            precision = "standard"

        cap, meta = _open_video(job.video_path, precision=precision)
        if cap is None:
            log.warning(
                "[tracking] event=%s unreadable (fps=%.1f frames=%d)",
                job.event_id,
                meta.get("fps", 0.0),
                meta.get("frame_count", 0),
            )
            return

        try:
            detector = self._ensure_detector()
            allowed = _resolve_object_filter(self._cam_cfg_getter, job.camera_id)
            spawn_score, floor_score, grace_s, iou_thresh = _resolve_track_thresholds(
                self._cam_cfg_getter,
                job.camera_id,
            )
            # The live runtime needs spawn=0.5 to suppress false-trigger
            # notifications. The post-clip worker only writes a
            # visualization sidecar — every detection above the raw
            # floor is worth recording so the user sees WHAT the model
            # found, even at moderate confidence. CPU-fallback on
            # main-stream 4K frames frequently sits in [0.20, 0.50]
            # for clearly-visible subjects (the model is shape-trained
            # for 320×320 inputs); the live spawn threshold would
            # discard those entirely and produce tracks=[] sidecars.
            # Detections are still tagged via score so the renderer
            # can paint sub-original-spawn samples as tentative.
            effective_spawn = floor_score
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
                dets = _detect_and_filter(detector, frame, allowed, floor_score=floor_score)
                _associate_detections(
                    state,
                    dets,
                    frame_idx,
                    t_s,
                    frame_w=frame_w,
                    frame_h=frame_h,
                    spawn_score=effective_spawn,
                    iou_threshold=iou_thresh,
                )
                frame_idx += sample_interval

            # Flush any tracks still active at end-of-clip into closed so
            # _build_payload's serialisation comprehension picks them up.
            # close() populates the per-track end_reason + last_* fields
            # so the lightbox × tooltip has something to render.
            for tr in state.active:
                tr.close("ended_at_clip", frame_w, frame_h)
            state.closed.extend(state.active)
            state.active = []

            # K3 · global offline stitching pass. Re-joins
            # fragmented tracks of the same physical subject (the
            # back-and-forth-walker that ends up as many short
            # tracklets) into single identities via observed
            # endpoints — no extrapolated velocity. Runs BEFORE
            # the static-FP sweep so a stitched-back-together real
            # person's combined motion correctly fails the static
            # gate and survives.
            n_stitched = _stitch_tracklets_offline(state)
            if n_stitched:
                log.info("[tracking] stitched %d tracklet(s) (offline)", n_stitched)

            # K1 · global static-FP sweep on the closed tracklets
            # BEFORE payload build. Catches the chair/pole/lamp/
            # shadow-as-person cluster — sub-spawn median score AND
            # < 0.5 × bbox-dim net motion — that floods the timeline
            # with whole-clip lanes for objects that never moved.
            # Each drop emits one [tracking] INFO line.
            _filter_static_false_positives(state, spawn_score)

            # L07 · ghost-track filter. Drops tracks whose best_score
            # never reached the per-label spawn threshold AND were
            # never confirmed by the confirmation window. Opt-out via
            # cam_cfg.track_filter_ghosts=False; default True so
            # existing cameras pick up the cleanup on next save.
            # Pulls the live detection config + cam config once each
            # since _cam_cfg_getter / _cfg_getter are cheap dict reads
            # against the settings store.
            try:
                cam_cfg = self._cam_cfg_getter(job.camera_id) if self._cam_cfg_getter else {}
            except Exception:
                cam_cfg = {}
            ghost_filter_on = cam_cfg.get("track_filter_ghosts") is not False
            if ghost_filter_on:
                try:
                    det_cfg = self._cfg_getter() or {}
                except Exception:
                    det_cfg = {}
                n_ghosts = _prune_ghost_tracks(
                    state,
                    cam_cfg=cam_cfg,
                    detection_cfg=det_cfg,
                    camera_id=job.camera_id,
                )
                if n_ghosts:
                    log.info(
                        "[tracking] cam=%s pruned %d ghost track(s) from sidecar",
                        job.camera_id,
                        n_ghosts,
                    )

            # gates.min_confidence reflects the LIVE spawn threshold so
            # the timeline panel's "<spawn>% Spuren bestätigt" copy
            # stays aligned with what the runtime would have notified
            # on. The worker's permissive effective spawn (== floor) is
            # an internal detail; surfacing it would make the gate
            # values misleading.
            payload = _build_payload(
                state,
                fps,
                frame_count,
                meta["duration_s"],
                allowed,
                job.video_path,
                self._storage_root,
                spawn_score=spawn_score,
                floor_score=floor_score,
                grace_s=grace_s,
            )
            tracks_path = tracks_path_for(job.video_path)
            _write_payload_atomic(tracks_path, payload)

            elapsed = time.time() - t_start
            best_str = (
                f"best={payload['best_frame']['score']:.2f}" if payload["best_frame"] else "best=—"
            )
            log.info(
                "[tracking] event=%s dur=%.1fs tracks=%d samples=%d %s",
                job.event_id,
                elapsed,
                len(payload["tracks"]),
                state.samples_emitted,
                best_str,
            )
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
            log.warning(
                "[tracking] event=%s SLOW: processing %.1fs for clip %.1fs",
                job.event_id,
                elapsed,
                duration_s,
            )

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
            log.info("[tracking] event=%s achievement read skipped: %s", job.event_id, e)
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
            confirm_hits.append(
                {
                    "track_id": tr.get("track_id"),
                    "label": lbl,
                    "hit_count": hit_count,
                    "span_seconds": span_seconds,
                    "confirmed": confirmed,
                }
            )
        ach = dict(ev.get("achievement") or {})
        if tracks_by_class:
            ach["tracks_by_class"] = tracks_by_class
        # Round peaks to 4 decimals so the JSON stays compact and the
        # frontend can compare against per-class thresholds cleanly.
        if peak_score_by_class:
            ach["peak_score_by_class"] = {k: round(v, 4) for k, v in peak_score_by_class.items()}
        if confirm_hits:
            ach["confirm_hits_by_track"] = confirm_hits
        ev["achievement"] = ach
        try:
            store.update_event(job.camera_id, job.event_id, ev)
        except Exception as e:
            log.info("[tracking] event=%s achievement write skipped: %s", job.event_id, e)


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


def build_worker(
    *,
    storage_root: Path,
    detection_cfg_getter: Callable[[], dict] | None = None,
    cam_cfg_getter: Callable[[str], dict] | None = None,
) -> TrackingWorker:
    """Construct and start the singleton. Idempotent — second call
    returns the existing instance even if different getters are provided
    (both are captured on first build)."""
    global _worker
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return _worker
        _worker = TrackingWorker(
            storage_root=storage_root,
            detection_cfg_getter=detection_cfg_getter,
            cam_cfg_getter=cam_cfg_getter,
        )
        _worker.start()
        return _worker


def singleton() -> TrackingWorker | None:
    """Return the running worker if any. None until build_worker() runs."""
    return _worker


def tracks_path_for(video_path: Path) -> Path:
    """Conventional sidecar path: `<video>.tracks.json` next to the mp4."""
    return video_path.with_name(video_path.stem + ".tracks.json")

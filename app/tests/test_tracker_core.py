"""Tests for the shared two-tier tracker algorithm.

Covers the 5 invariants both callers (post-clip worker + live runtime)
rely on:
  1. Spawn happens only on confirmed score (≥ spawn).
  2. Tentative score does NOT spawn but DOES extend an IoU-matched track.
  3. IoU below threshold → no match (new track on confirmed; drop on tentative).
  4. predicted_bbox falls back to last bbox with < 2 detect samples.
  5. Miss-window aging closes a track after exactly N missed frames.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

# Same sys.path bootstrap the other tests in this folder use so
# `from app.tracker_core import ...` resolves whether pytest is run
# from the repo root or from app/tests/ directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.tracker_core import (  # noqa: E402
    IOU_MATCH_THRESHOLD,
    MISS_GRACE_DEFAULT_SECONDS,
    TRACK_FLOOR_SCORE,
    TRACK_MISS_WINDOWS,
    TRACK_SPAWN_SCORE,
    Track,
    TrackerState,
    associate_detections,
    classify_tier,
    compute_miss_grace_samples,
    predicted_bbox,
)


@dataclass
class FakeDet:
    """Minimal stand-in for Detection — associate_detections only reads
    .label, .score, .bbox so we keep the test fixture tiny."""
    label: str
    score: float
    bbox: tuple[int, int, int, int]


def _new_state() -> TrackerState:
    return TrackerState()


# ── Invariant 1 ────────────────────────────────────────────────────────────
def test_spawn_only_on_confirmed_score():
    state = _new_state()
    # Tentative-tier detection (score between FLOOR and SPAWN). No
    # existing track → drops, no spawn.
    associate_detections(
        state, [FakeDet("person", 0.30, (100, 100, 200, 200))],
        frame_idx=0, t_s=0.0,
    )
    assert len(state.active) == 0, "tentative det should NOT spawn a track"

    # Confirmed-tier detection → spawn.
    associate_detections(
        state, [FakeDet("person", 0.80, (100, 100, 200, 200))],
        frame_idx=1, t_s=1.0,
    )
    assert len(state.active) == 1
    assert state.active[0].label == "person"
    assert len(state.active[0].samples) == 1
    assert state.active[0].samples[0]["score"] == 0.8


# ── Invariant 2 ────────────────────────────────────────────────────────────
def test_tentative_extends_existing_track():
    state = _new_state()
    # First frame: confirmed → spawn.
    associate_detections(
        state, [FakeDet("cat", 0.80, (100, 100, 200, 200))],
        frame_idx=0, t_s=0.0,
    )
    assert len(state.active) == 1
    track_id = state.active[0].track_id

    # Second frame: tentative score on a heavily overlapping bbox.
    # Should NOT spawn a new track AND should extend the existing one
    # so its sample count goes from 1 → 2 with the same track id.
    associate_detections(
        state, [FakeDet("cat", 0.30, (102, 102, 200, 200))],
        frame_idx=1, t_s=1.0,
    )
    assert len(state.active) == 1, "tentative extends, never spawns"
    assert state.active[0].track_id == track_id
    assert len(state.active[0].samples) == 2
    assert state.active[0].samples[-1]["score"] == 0.3
    assert state.active[0].samples[-1]["source"] == "detect"


# ── Invariant 3 ────────────────────────────────────────────────────────────
def test_iou_below_threshold_no_match():
    """A confirmed detection with IoU < threshold against existing
    tracks spawns its own NEW track. A tentative detection with IoU
    below threshold is dropped entirely (no spawn, no extension)."""
    state = _new_state()
    # Seed track at top-left.
    associate_detections(
        state, [FakeDet("dog", 0.80, (0, 0, 100, 100))],
        frame_idx=0, t_s=0.0,
    )
    assert len(state.active) == 1
    seeded_id = state.active[0].track_id

    # Confirmed det far from existing track → IoU = 0 → SPAWN a new
    # track. Existing one keeps its id but ages (no IoU match).
    associate_detections(
        state, [FakeDet("dog", 0.80, (500, 500, 600, 600))],
        frame_idx=1, t_s=1.0,
    )
    assert len(state.active) == 2, "non-overlapping confirmed → new track"
    ids = {tr.track_id for tr in state.active}
    assert seeded_id in ids

    # Reset to single-track baseline for the tentative case.
    state = _new_state()
    associate_detections(
        state, [FakeDet("dog", 0.80, (0, 0, 100, 100))],
        frame_idx=0, t_s=0.0,
    )
    # Tentative det far from existing track → DROP (no spawn, no extend).
    associate_detections(
        state, [FakeDet("dog", 0.30, (500, 500, 600, 600))],
        frame_idx=1, t_s=1.0,
    )
    # Still exactly one track, and the seeded track aged one window.
    assert len(state.active) == 1
    assert state.active[0].missed_windows == 1


# ── Invariant 4 ────────────────────────────────────────────────────────────
def test_predicted_bbox_fallback_with_few_samples():
    """With fewer than two detect-source samples there's no velocity
    signal — predicted_bbox should return the last sample's bbox
    verbatim instead of extrapolating from zero."""
    state = _new_state()
    associate_detections(
        state, [FakeDet("person", 0.80, (10, 20, 110, 220))],
        frame_idx=0, t_s=0.0,
    )
    tr = state.active[0]
    # One detect sample so far — prediction at frame 50 must still
    # equal the seed bbox.
    assert predicted_bbox(tr, frame_idx=50) == (10, 20, 110, 220)

    # Add a second detect sample → velocity now resolves; the third
    # prediction should advance, NOT be the verbatim last bbox.
    associate_detections(
        state, [FakeDet("person", 0.80, (20, 30, 120, 230))],
        frame_idx=1, t_s=1.0,
    )
    pred = predicted_bbox(tr, frame_idx=2)
    assert pred != (20, 30, 120, 230), \
        "with 2 detect samples a non-zero velocity should advance the bbox"


# ── Invariant 5 ────────────────────────────────────────────────────────────
def test_miss_window_aging_closes_after_n_misses():
    """A track that misses ``miss_grace_samples`` consecutive frames
    must be closed exactly on the Nth miss — not the (N-1)th, not the
    (N+1)th."""
    state = _new_state()
    associate_detections(
        state, [FakeDet("bird", 0.80, (100, 100, 200, 200))],
        frame_idx=0, t_s=0.0,
    )
    assert len(state.active) == 1

    # Run N-1 frames without any matching detection. The track must
    # stay alive (missed_windows hasn't hit the cap yet).
    grace = 3
    for f in range(1, grace):
        associate_detections(
            state, [],  # empty dets — nothing matches
            frame_idx=f, t_s=float(f),
            miss_grace_samples=grace,
        )
        assert len(state.active) == 1, f"track aged too early on frame {f}"

    # One more miss — N total — closes the track.
    associate_detections(
        state, [],
        frame_idx=grace, t_s=float(grace),
        miss_grace_samples=grace,
    )
    assert len(state.active) == 0
    assert len(state.closed) == 1
    assert state.closed[0].end_reason == "timeout"


# ── Bonus: per-label spawn callable ─────────────────────────────────────────
def test_per_label_spawn_callable():
    """spawn_for callable lets the live runtime apply per-label
    thresholds — a 'person' detection at 0.55 with person-threshold
    0.72 should be classified as tentative, not confirmed."""
    state = _new_state()
    spawn_for = lambda lbl: 0.72 if lbl == "person" else 0.50  # noqa: E731
    # Person 0.55 below per-label 0.72 → tentative → drop (no
    # existing track to extend).
    associate_detections(
        state, [FakeDet("person", 0.55, (0, 0, 100, 100))],
        frame_idx=0, t_s=0.0,
        spawn_for=spawn_for,
    )
    assert len(state.active) == 0

    # Cat 0.55 above the default 0.50 spawn → confirmed → spawns.
    associate_detections(
        state, [FakeDet("cat", 0.55, (200, 200, 300, 300))],
        frame_idx=1, t_s=1.0,
        spawn_for=spawn_for,
    )
    assert len(state.active) == 1
    assert state.active[0].label == "cat"


# ── classify_tier + compute_miss_grace_samples ─────────────────────────────
def test_classify_tier():
    assert classify_tier(0.20, 0.50) == "tentative"
    assert classify_tier(0.50, 0.50) == "confirmed"
    assert classify_tier(0.99, 0.50) == "confirmed"


def test_compute_miss_grace_samples():
    # 4 seconds × 1 Hz = 4 samples (post-clip default).
    assert compute_miss_grace_samples(4.0, 1.0) == 4
    # 4 seconds × 3 Hz = 12 samples (live default).
    assert compute_miss_grace_samples(4.0, 3.0) == 12
    # Zero / negative inputs → safe default.
    assert compute_miss_grace_samples(0, 1.0) == TRACK_MISS_WINDOWS
    assert compute_miss_grace_samples(4.0, 0) == TRACK_MISS_WINDOWS
    # Below-1 sample rounds up to 1.
    assert compute_miss_grace_samples(0.2, 1.0) == 1


def test_module_constants_match_defaults():
    """The schema doc says 0.0 = 'use module default' for spawn/floor/grace.
    Pin the constants so a refactor can't silently drift them."""
    assert TRACK_FLOOR_SCORE == 0.20
    assert TRACK_SPAWN_SCORE == 0.50
    assert IOU_MATCH_THRESHOLD == 0.30
    assert TRACK_MISS_WINDOWS == 4
    assert MISS_GRACE_DEFAULT_SECONDS == 4.0

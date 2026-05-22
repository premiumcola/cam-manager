"""N13 · Tracker tunables.

All numeric constants the algorithm reads at runtime — IoU thresholds,
spawn floors, miss-grace windows, NMS gates. Pure data, no imports from
the rest of the package. Both the post-clip worker AND the live runtime
read these defaults through the higher-level resolve_track_thresholds()
helper; per-camera overrides flow through there.

Re-exported verbatim from ``tracker_core/__init__.py`` so existing
imports like ``from .tracker_core import IOU_MATCH_THRESHOLD`` keep
resolving.
"""

from __future__ import annotations


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



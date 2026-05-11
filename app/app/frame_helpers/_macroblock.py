"""Localised macroblock-corruption detector. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""
from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode


# ── Localised macroblock-corruption detector ────────────────────────────────
# H.264 P-frame chain corruption: a single lost slice produces a
# rectangular patch of garbage colour + checkerboard texture in an
# otherwise good frame. Existing whole-frame validators
# (horizontal_anomaly_band, dead_area, flat_gray) miss this — the
# corrupt patch is too small to dominate any global statistic.
#
# Detection: tile the frame into 16×16 blocks. Per tile, compute
# Laplacian magnitude (high-frequency energy) and chroma spread
# (max - min of channel means). Flag tiles where:
#   - Laplacian energy > 4× the median energy of the surrounding
#     5×5 tile neighbourhood (local outlier)
#   - chroma spread > 60 (saturated false colour, not real scene)
# Reject when ≥3 adjacent flagged tiles form a rectangular cluster
# (4-connectivity, bbox-fill > 0.5). A single isolated high-energy
# tile (a tree branch, a wire) is not enough.
# Chroma-spread is the primary signal: real H.264 slice-loss locks a
# tile to a wrong DC term, producing an unusually-saturated (single-
# channel-dominant) patch in an otherwise-correlated natural scene.
# Natural scenes have inter-channel correlation (foliage, sky, wood
# all have B≈G+offset, R≈G+offset relationships), so the per-tile
# max-min channel-mean spread sits in the 0–15 range. A corruption
# patch sits at 60+. The cluster requirement (≥3 adjacent tiles
# forming a rectangle, bbox-fill > 0.5) filters out individual
# saturated objects (a green-painted gate, a red door) that
# legitimately have high chroma in one tile.
_MB_TILE = 16
# Calibrated against the daytime sample frames: natural daytime
# scenes' per-tile spread caps at ~82 with 99th percentile ~65, while
# corruption patches sit at 90+ with peaks above 180. The 85 cutoff
# leaves a comfortable margin on both sides.
_MB_CHROMA_SPREAD_MIN = 85.0
_MB_MIN_CLUSTER = 3
_MB_BBOX_FILL_MIN = 0.5


def _macroblock_tile_features(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Return (laplace_energy_grid, chroma_spread_grid) — both H/_MB_TILE
    × W/_MB_TILE float32 grids of per-tile statistics.

    Laplacian energy = mean abs Laplacian inside the tile (a single
    cv2.Laplacian on the whole frame, then per-tile mean). Chroma
    spread = max(Bm, Gm, Rm) - min(Bm, Gm, Rm) per tile, where Bm /
    Gm / Rm are the per-channel means.
    """
    h, w = img.shape[:2]
    th, tw = h // _MB_TILE, w // _MB_TILE
    if th == 0 or tw == 0:
        return np.zeros((0, 0), dtype=np.float32), np.zeros((0, 0), dtype=np.float32)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    lap = np.abs(cv2.Laplacian(gray, cv2.CV_32F, ksize=3))
    # Per-tile mean by reshape + axis reductions — vastly cheaper than
    # a Python loop over h_tiles*w_tiles tiles.
    cropped = lap[: th * _MB_TILE, : tw * _MB_TILE]
    energy = cropped.reshape(th, _MB_TILE, tw, _MB_TILE).mean(axis=(1, 3))
    if img.ndim == 3 and img.shape[2] >= 3:
        bgr = img[: th * _MB_TILE, : tw * _MB_TILE].astype(np.float32)
        # per-channel per-tile mean
        per_ch = bgr.reshape(th, _MB_TILE, tw, _MB_TILE, 3).mean(axis=(1, 3))
        spread = per_ch.max(axis=2) - per_ch.min(axis=2)
    else:
        spread = np.zeros_like(energy)
    return energy.astype(np.float32), spread.astype(np.float32)


def _flagged_macroblock_grid(img: np.ndarray) -> np.ndarray:
    """Return a bool grid (H/_MB_TILE × W/_MB_TILE) marking tiles
    whose channel-mean spread exceeds ``_MB_CHROMA_SPREAD_MIN`` —
    the corruption signature is a single-channel-dominant patch
    against a low-chroma-variance natural scene. The cluster gate
    (``_largest_cluster_bbox`` + the bbox-fill rule in
    ``is_local_macroblock_anomaly``) filters out isolated saturated
    objects (a red door, a green-painted gate) that legitimately
    occupy a single tile."""
    _, spread = _macroblock_tile_features(img)
    if spread.size == 0:
        return np.zeros((0, 0), dtype=bool)
    return spread > _MB_CHROMA_SPREAD_MIN


def _largest_cluster_bbox(grid: np.ndarray) -> tuple[int, int, int, int, int] | None:
    """4-connected component labelling on a bool grid. Returns
    (count, ymin, xmin, ymax, xmax) of the largest cluster, or None
    when no cells are flagged. ``count`` is the number of flagged
    cells in the cluster; bbox is inclusive."""
    if grid.size == 0 or not bool(grid.any()):
        return None
    h, w = grid.shape
    seen = np.zeros_like(grid, dtype=bool)
    best: tuple[int, int, int, int, int] | None = None
    for y0 in range(h):
        for x0 in range(w):
            if not grid[y0, x0] or seen[y0, x0]:
                continue
            # BFS — small grids (max 80 × 60 at 1080p), no need for
            # scipy.ndimage.
            stack = [(y0, x0)]
            ys: list[int] = []
            xs: list[int] = []
            while stack:
                y, x = stack.pop()
                if y < 0 or x < 0 or y >= h or x >= w:
                    continue
                if seen[y, x] or not grid[y, x]:
                    continue
                seen[y, x] = True
                ys.append(y)
                xs.append(x)
                stack.extend(((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)))
            if not ys:
                continue
            ymin, ymax = min(ys), max(ys)
            xmin, xmax = min(xs), max(xs)
            count = len(ys)
            if best is None or count > best[0]:
                best = (count, ymin, xmin, ymax, xmax)
    return best


def is_local_macroblock_anomaly(img) -> tuple[bool, str]:
    """Detect a localised rectangular cluster of corrupted macroblocks
    in an otherwise-good frame. Reject when ≥ 3 adjacent flagged
    tiles form a rectangular cluster (4-connectivity, bbox-fill
    ratio > 0.5) — single isolated high-energy tiles (tree branch,
    power line) don't qualify."""
    img = _decode(img)
    if img is None or img.size == 0 or img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    if h < _MB_TILE * 4 or w < _MB_TILE * 4:
        return False, ""
    grid = _flagged_macroblock_grid(img)
    largest = _largest_cluster_bbox(grid)
    if largest is None:
        return False, ""
    count, ymin, xmin, ymax, xmax = largest
    if count < _MB_MIN_CLUSTER:
        return False, ""
    bbox_h = ymax - ymin + 1
    bbox_w = xmax - xmin + 1
    bbox_area = max(1, bbox_h * bbox_w)
    if (count / bbox_area) < _MB_BBOX_FILL_MIN:
        return False, ""
    return True, f"macroblock_anomaly(area={count} tiles)"

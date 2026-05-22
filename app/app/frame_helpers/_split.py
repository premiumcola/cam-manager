"""Half-corrupt / split-frame heuristic. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""

from __future__ import annotations

import numpy as np

from ._decode import _decode


def is_split_frame(img) -> tuple[bool, str]:
    """Detect "half-corrupt" frames where one quadrant or one half of
    the image is dead grey while the opposite half carries real
    chroma. Classic H.264 reference-frame corruption mode that slips
    past dead_area_score because only ~50 % of tiles are dead — under
    the global threshold but the visual result is unusable.

    Returns (True, reason) when one half's chroma activity is well
    below the other half's, with a wide gap (3.0 vs 12.0) so that
    legitimate compositional asymmetry (e.g. one half is a flat sky,
    the other is a textured tree line) doesn't trip. False on every
    other frame including IR/night (both halves equally chroma-flat
    → both scores low → no split detected)."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    if h < 80 or w < 80:
        return False, ""

    def _chroma_score(region):
        if region.size == 0:
            return 0.0
        b = region[:, :, 0].astype(np.int16)
        g = region[:, :, 1].astype(np.int16)
        r = region[:, :, 2].astype(np.int16)
        return float(np.abs(b - g).mean() + np.abs(b - r).mean())

    halves = {
        "left": img[:, : w // 2],
        "right": img[:, w // 2 :],
        "top": img[: h // 2, :],
        "bottom": img[h // 2 :, :],
    }
    scores = {k: _chroma_score(v) for k, v in halves.items()}
    # Split is declared when one side falls below the dead threshold
    # AND the opposite side clears the alive threshold. The wide gap
    # (3.0 vs 12.0) protects against legitimate asymmetry: a flat sky
    # half (~5-8) plus a textured ground half (~15) is NOT a split —
    # only when one half collapses well below 5 does the heuristic
    # trip.
    pairs = [("left", "right"), ("top", "bottom")]
    for a, b in pairs:
        sa, sb = scores[a], scores[b]
        if sa < 3.0 and sb > 12.0:
            return True, f"split_{a}_dead(scores={sa:.1f}/{sb:.1f})"
        if sb < 3.0 and sa > 12.0:
            return True, f"split_{b}_dead(scores={sa:.1f}/{sb:.1f})"
    return False, ""

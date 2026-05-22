"""Perceptual hash + near-duplicate detection. Carved out of the
original ``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""

from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode

# ── Perceptual hash + duplicate detection ───────────────────────────────────
# Active dedup at encode time AND at capture time. The former filters
# stuck-stream burst replicas out of an encoded MP4; the latter
# prevents the burst from hitting disk in the first place. Both use
# the same primitives so a tweak to the threshold lands consistently.
#
# pHash is the classic "downscale to 16×16 grayscale, threshold each
# pixel against the per-block mean, return 256 bits". Hamming
# distance between two pHashes is a fast similarity metric: identical
# pixel content → 0, JPEG-noise jitter → 1-2, slowly rotating scene
# → 6-15+, scene-change → 50+. The hamming-≤4 cutoff catches
# replicated buffers without collapsing a real timelapse to one
# frame. The mean-abs-diff guard on the full frame is the second
# leg: a slowly-rotating scene whose pHash happens to land within
# hamming-4 still has > 1.5 mean abs pixel delta, so it's preserved.
_PHASH_SIZE = 16
_PHASH_HAMMING_MAX = 4
_DEDUP_MEAN_ABS_DIFF_MAX = 1.5


def perceptual_hash(img) -> int:
    """Compute a 256-bit perceptual hash of an image.

    Returns an integer (Python supports arbitrary precision so 256
    bits fits a single int). Two frames are considered "near
    duplicate" when ``bin(a ^ b).count('1')`` ≤ ``_PHASH_HAMMING_MAX``
    AND their full-frame mean absolute difference ≤
    ``_DEDUP_MEAN_ABS_DIFF_MAX``. ``None`` on undecodable input.
    """
    img = _decode(img)
    if img is None or img.size == 0:
        return 0
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        small = cv2.resize(gray, (_PHASH_SIZE, _PHASH_SIZE), interpolation=cv2.INTER_AREA)
        threshold = float(small.mean())
        bits = (small > threshold).astype(np.uint8).flatten()
    except Exception:
        return 0
    h = 0
    for b in bits:
        h = (h << 1) | int(b)
    return h


def hamming_distance(a: int, b: int) -> int:
    """Population count of ``a XOR b`` — number of bit positions that
    differ. Pure-Python ``bin(...).count('1')`` is fast enough at the
    sizes we're dealing with (256 bits)."""
    return bin(a ^ b).count("1")


def is_near_duplicate(
    prev_phash: int,
    prev_frame,
    this_frame,
    hamming_max: int = _PHASH_HAMMING_MAX,
    mean_abs_diff_max: float = _DEDUP_MEAN_ABS_DIFF_MAX,
) -> bool:
    """True when ``this_frame`` is a near-duplicate of the kept
    reference (``prev_phash`` + ``prev_frame``). Both legs of the
    test must hold:

      • pHash hamming distance ≤ ``hamming_max`` — same coarse layout
      • full-frame mean absolute pixel diff ≤ ``mean_abs_diff_max``
        in 0-255 byte space

    Either alone produces false positives. A slowly-rotating scene
    can land within hamming-4 (coarse hash is intentionally
    coarse-grained) but its mean abs diff is well above 1.5. A
    pixel-identical replicated buffer trips both with margin.
    """
    if prev_frame is None or this_frame is None:
        return False
    this_phash = perceptual_hash(this_frame)
    if hamming_distance(prev_phash, this_phash) > hamming_max:
        return False
    try:
        # Take both as int16 to avoid uint8 underflow in subtraction.
        a = prev_frame.astype(np.int16)
        b = this_frame.astype(np.int16)
        if a.shape != b.shape:
            return False
        diff = float(np.abs(a - b).mean())
    except Exception:
        return False
    return diff <= mean_abs_diff_max

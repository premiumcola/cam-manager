"""Grey / flat-gray / dead-area heuristics. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""
from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode
from ._profile import (
    _FLAT_GRAY_BAND_MAX,
    _FLAT_GRAY_BAND_MIN,
    _FLAT_GRAY_STD_MAX,
    _GREY_CHANNEL_STD_SUM,
    _GREY_MIDBAND_MAX,
    _GREY_MIDBAND_MIN,
    _GREY_MIDBAND_TOTAL_STD,
    _TILE_BLUR_KSIZE,
    _TILE_CHROMA_STD_FLOOR,
    _TILE_DEAD_BLURRED_STD_FLOOR,
    _TILE_GREY_BAND_BLURRED_STD,
    _TILE_GREY_BAND_MAX,
    _TILE_GREY_BAND_MIN,
    _TILE_GRID_H,
    _TILE_GRID_W,
    FrameValidatorProfile,
)


def is_grey_frame(img, profile: "FrameValidatorProfile | None" = None) -> tuple[bool, str]:
    """True when the frame is a uniform mid-grey hickup. False on real imagery
    (including IR/night frames, which have plenty of noise across channels).
    ``profile`` lets the caller relax the mid-grey total-std threshold for
    night/twilight scenes where legitimate IR frames have less channel
    variance than a daytime scene.

    Reolink date OSDs render in the top-right corner and add enough
    channel std to push an otherwise-uniform-grey frame above the
    grey_uniform floor. Std is computed on a cropped working region
    that excludes the top 12 % of rows AND the right 25 % of columns
    so OSD text noise can't hide a grey hickup. Mean brightness
    still uses the full frame because the OSD is too small to
    materially shift overall brightness."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    cy = max(1, int(h * 0.12))
    cx = max(1, int(w * 0.75))
    # Fall back to the full frame on tiny inputs where the OSD-aware
    # crop would leave too little to measure.
    if (h - cy) > 8 and cx > 8:
        work = img[cy:, :cx]
    else:
        work = img
    std_b = float(work[:, :, 0].std())
    std_g = float(work[:, :, 1].std())
    std_r = float(work[:, :, 2].std())
    std_sum = std_b + std_g + std_r
    grey_channel_std_sum = (
        profile.grey_channel_std_sum if profile is not None else _GREY_CHANNEL_STD_SUM
    )
    grey_midband_total_std = (
        profile.grey_midband_total_std if profile is not None else _GREY_MIDBAND_TOTAL_STD
    )
    if std_sum < grey_channel_std_sum:
        return True, f"grey_uniform(std_sum={std_sum:.1f})"
    mean_brightness = float((img[:, :, 0].mean() + img[:, :, 1].mean() + img[:, :, 2].mean()) / 3.0)
    if (_GREY_MIDBAND_MIN <= mean_brightness <= _GREY_MIDBAND_MAX
            and std_sum < grey_midband_total_std):
        return True, f"grey_midband(brightness={mean_brightness:.0f},std_sum={std_sum:.1f})"
    return False, ""


def dead_area_score(img) -> tuple[float, int, int]:
    """Score a frame for "dead area" using a fixed tile grid.

    Returns (dead_fraction, dead_tile_count, total_tile_count). A tile is
    "dead" when ANY of:
      (1) blurred std < _TILE_DEAD_BLURRED_STD_FLOOR — no real texture
      (2) mid-grey band tile with low blurred std — flat grey block
      (3) mid-grey band tile with B≈G≈R chroma std < _TILE_CHROMA_STD_FLOOR
          — luma-structured but chroma-flat macroblock smear
    Genuine dark/IR frames have noisy texture in every tile and stay near
    zero; corrupted frames with a thin live strip on top score around
    0.85 (the strip has texture, everything below is dead). The chroma
    check (3) is gated to the mid-grey luma band so IR/dark tiles
    (legitimately monochrome) and bright sky tiles (also legitimately
    near-monochrome) never trip it."""
    img = _decode(img)
    if img is None or img.size == 0:
        return 1.0, 0, 0
    h, w = img.shape[:2]
    if h < _TILE_GRID_H * 4 or w < _TILE_GRID_W * 4:
        return 0.0, 0, 0  # too small to tile usefully — caller has other gates
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Blur once across the whole frame, then crop tiles. The blur kills
    # pixel-level noise (random or macroblock jitter) but preserves real
    # low-frequency structure, so std on the blurred tile is the cleanest
    # "is there real imagery in this tile" signal.
    blurred = cv2.blur(gray, (_TILE_BLUR_KSIZE, _TILE_BLUR_KSIZE))
    th, tw = h // _TILE_GRID_H, w // _TILE_GRID_W
    dead = 0
    total = 0
    for ty in range(_TILE_GRID_H):
        for tx in range(_TILE_GRID_W):
            y0, y1 = ty * th, (ty + 1) * th
            x0, x1 = tx * tw, (tx + 1) * tw
            blurred_tile = blurred[y0:y1, x0:x1]
            bstd = float(blurred_tile.std())
            tmean = float(blurred_tile.mean())
            tile_dead = False
            if bstd < _TILE_DEAD_BLURRED_STD_FLOOR or (_TILE_GREY_BAND_MIN <= tmean <= _TILE_GREY_BAND_MAX
                  and bstd < _TILE_GREY_BAND_BLURRED_STD):
                tile_dead = True
            elif _TILE_GREY_BAND_MIN <= tmean <= _TILE_GREY_BAND_MAX:
                # Chroma uniformity check — only fires inside the
                # mid-grey luma band where macroblock corruption lives.
                # IR/night/sky tiles (luma outside the band) skip this
                # branch and stay alive.
                tile_bgr = img[y0:y1, x0:x1]
                if tile_bgr.size > 0 and tile_bgr.ndim >= 3 and tile_bgr.shape[2] >= 3:
                    b = tile_bgr[:, :, 0].astype(np.int16)
                    g = tile_bgr[:, :, 1].astype(np.int16)
                    r = tile_bgr[:, :, 2].astype(np.int16)
                    chroma_std = float(
                        (np.abs(b - g).std() + np.abs(b - r).std()) / 2.0
                    )
                    if chroma_std < _TILE_CHROMA_STD_FLOOR:
                        tile_dead = True
            if tile_dead:
                dead += 1
            total += 1
    if total == 0:
        return 0.0, 0, 0
    return dead / total, dead, total


# ── Flat-gray full-frame corruption ──────────────────────────────────────────
# Whole-frame mid-grey decoder corruption: H.265 outputs a uniform
# mid-grey buffer (mean ∈ [115, 145], std < 10). dead_area also
# catches this case in practice — every tile passes the dead-tile
# test on a uniform frame — but giving it its own reason head means
# the per-reason _rejected/ folder splits the two failure modes
# cleanly. The thresholds match the picker's _is_flat_gray_corruption_sample
# so a sample that the picker treats as corruption is also rejected
# by the validator.
def is_flat_gray_full_frame(img) -> tuple[bool, str]:
    """Whole frame is flat mid-grey decoder corruption — H.265
    output a uniform mid-grey buffer with no scene structure.
    Distinct from dead_area because there's no spatial information
    at all, not just thin texture."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        m = float(gray.mean())
        s = float(gray.std())
    except Exception:
        return False, ""
    if (_FLAT_GRAY_BAND_MIN <= m <= _FLAT_GRAY_BAND_MAX
            and s < _FLAT_GRAY_STD_MAX):
        return True, f"flat_gray_full_frame(mean={m:.0f},std={s:.1f})"
    return False, ""

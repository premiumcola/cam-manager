"""Bright-outlier-dark-scene detector.

Catches the corruption cluster that every other detector misses: a
pure-white (or near-white) blowout patch in an otherwise dark scene.
Two real sunrise mp4s on 2026-05-12 showed 14 of 118 frames in a
single ~3-minute window flagged by hand inspection but waved through
by the full validator chain because:
  * chroma magenta detectors need chroma — the patch is grey (255,255,255).
  * macroblock anomaly needs chroma_spread > 85 — same problem.
  * dead_area needs > 35 % dead tiles — one bright patch leaves the
    rest of the frame untouched.
  * horizontal_anomaly_band needs row-delta spikes — a smooth bright
    patch carries no row-delta signal.
  * brightness ceiling fires at frame_mean > 253, way above a frame
    where one tile is saturated but the rest of the frame still reads
    dark/night.

The signal is unambiguous on a night scene: physically, a real camera
sees max-tile brightness around the scene baseline plus the brightest
real point of light (a security lamp, a star, the moon). A jump from
baseline-50 to 255 with the overall frame still mean-50 is a corrupt
patch — no real night scene produces it.
"""

from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode
from ._profile import _TILE_GRID_H, _TILE_GRID_W


def is_bright_outlier_dark_scene(img, profile) -> tuple[bool, str]:
    """Detect a saturated-bright tile against an otherwise-dark scene.

    Returns ``(True, reason)`` when ALL three hold:
      * the brightest tile mean is above
        ``profile.bright_outlier_max_tile_floor`` (default 240).
      * the difference between that brightest tile and the
        darkest-third tile-baseline exceeds
        ``profile.bright_outlier_dev_floor`` (default 100).
      * the overall frame mean is below
        ``profile.bright_outlier_frame_mean_max`` (NIGHT / TWILIGHT
        only — DAY_PROFILE has this at 0.0 so the detector early-
        returns without scanning, since bright daytime scenes
        legitimately hit 255 from sun / snow / lamps).

    Reuses the same 8 × 5 tile grid that ``dead_area_score`` builds —
    one ``cv2.cvtColor`` + one reshape, no second tile loop. Reason
    head ``bright_outlier_dark_scene(max=X,base=Y,dev=Z)``.
    """
    img = _decode(img)
    if img is None or img.size == 0 or img.ndim < 2:
        return False, ""
    h, w = img.shape[:2]
    if h < _TILE_GRID_H * 4 or w < _TILE_GRID_W * 4:
        return False, ""
    frame_mean_max = float(getattr(profile, "bright_outlier_frame_mean_max", 0.0) or 0.0)
    if frame_mean_max <= 0.0:
        return False, ""  # detector disabled for this profile (DAY).
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    overall_mean = float(gray.mean())
    if overall_mean >= frame_mean_max:
        return False, ""  # the scene is bright enough that 255 is plausible.
    th, tw = h // _TILE_GRID_H, w // _TILE_GRID_W
    cropped = gray[: th * _TILE_GRID_H, : tw * _TILE_GRID_W]
    # Per-tile mean by reshape + axis reductions — same shape as the
    # macroblock detector's tile-mean computation.
    tile_means = cropped.reshape(_TILE_GRID_H, th, _TILE_GRID_W, tw).mean(axis=(1, 3))
    flat = tile_means.flatten()
    max_tile = float(flat.max())
    max_tile_floor = float(getattr(profile, "bright_outlier_max_tile_floor", 240.0))
    if max_tile <= max_tile_floor:
        return False, ""
    # Require at least TWO saturated tiles. A real corruption patch in
    # the test corpus always spans 2+ adjacent tiles (a "pure-white
    # blowout patch" covers multiple macroblock tiles by definition).
    # A SINGLE saturated tile is overwhelmingly a legitimate point
    # light source — a porch lamp, street lamp, or IR-illuminator
    # reflection close to the camera — which mass-rejects night-scene
    # detection ticks if treated as corruption. The field data:
    # 2026-05-18 logs showed ~60 % of test-detection calls on the
    # Garten-Dachterrasse camera failing with this head when one
    # patio light filled a single tile to 248. Requiring 2+ saturated
    # tiles distinguishes corruption from legitimate point lights
    # without weakening the corruption signal (real blowouts cover
    # area).
    n_saturated = int(np.sum(flat > max_tile_floor))
    if n_saturated < 2:
        return False, ""
    # Darkest-third median as the scene baseline. Robust to a single
    # outlier tile (it doesn't lift the bottom third) and doesn't
    # require us to drop the max manually.
    flat_sorted = np.sort(flat)
    n_third = max(1, flat_sorted.size // 3)
    baseline = float(np.median(flat_sorted[:n_third]))
    dev = max_tile - baseline
    dev_floor = float(getattr(profile, "bright_outlier_dev_floor", 100.0))
    if dev <= dev_floor:
        return False, ""
    return True, (
        f"bright_outlier_dark_scene("
        f"max={int(round(max_tile))},"
        f"base={int(round(baseline))},"
        f"dev={int(round(dev))},"
        f"n_sat={n_saturated})"
    )

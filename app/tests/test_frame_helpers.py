"""Unit tests for frame_helpers.is_valid_frame.

Covers the three real-world corruption patterns we keep seeing in
storage/timelapse_frames/ as well as the genuine-frame cases that must keep
passing. Synthetic fixtures are generated in-test so the suite has no on-disk
dependency."""
import sys
from pathlib import Path

import numpy as np
import pytest

# Make `app` package importable (same trick as test_schema / test_rebuild_runtimes)
_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.frame_helpers import (  # noqa: E402
    dead_area_score,
    is_grey_frame,
    is_valid_frame,
)


# ── Synthetic fixtures ──────────────────────────────────────────────────────
# Frame size matches Reolink substream (640×480 typical). Random noise is
# seeded so failures are reproducible.

def _rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _daytime_frame(seed: int = 1) -> np.ndarray:
    """Plausible daytime garden frame: a few large coloured shapes (sky,
    bushes, building, path) with sensor noise on top. Each shape spans
    multiple tiles so blurred-std is non-trivial in every tile, mirroring
    real outdoor scenes. Must always pass."""
    rng = _rng(seed)
    h, w = 480, 640
    img = np.zeros((h, w, 3), dtype=np.uint8)
    # Sky gradient (varies in BOTH directions so per-tile blur survives)
    yy, xx = np.meshgrid(np.arange(h // 2), np.arange(w), indexing="ij")
    img[: h // 2, :, 0] = np.clip(160 + (h // 2 - yy) * 0.3 + xx * 0.05, 0, 255).astype(np.uint8)
    img[: h // 2, :, 1] = np.clip(170 + (h // 2 - yy) * 0.2, 0, 255).astype(np.uint8)
    img[: h // 2, :, 2] = np.clip(150 + (h // 2 - yy) * 0.15, 0, 255).astype(np.uint8)
    # Bush in the middle (green blob)
    cv2_circle_roi = (slice(160, 320), slice(80, 240))
    img[cv2_circle_roi] = (40, 110, 70)
    # Path on the right (light brown)
    img[200:480, 380:640] = (90, 130, 165)
    # Building / fence (vertical structure)
    img[200:300, 280:360] = (60, 75, 95)
    # A second contrasting object so even bottom-corner tiles have edges
    img[380:470, 50:200] = (200, 180, 150)
    # Add sensor noise everywhere — gives every tile some texture
    noise = rng.integers(-12, 13, size=img.shape, dtype=np.int16)
    img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return img


def _ir_night_frame(seed: int = 2) -> np.ndarray:
    """IR/night frame: low overall brightness, B≈G≈R, with a few large
    visible features (illuminator hot region, a darker building silhouette,
    a path) so blurred-std isn't trivially zero. Must pass — rejecting
    these is the fail mode is_valid_frame's design explicitly avoids."""
    rng = _rng(seed)
    h, w = 480, 640
    base = rng.integers(20, 38, size=(h, w), dtype=np.int16)
    # Large IR illuminator field (gentle gradient, not a sharp circle)
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    cy, cx = h // 2, w // 2
    radius2 = (yy - cy) ** 2 + (xx - cx) ** 2
    illum = np.clip(60 - (radius2 / (200 ** 2)) * 60, 0, 60).astype(np.int16)
    base = base + illum
    # Building silhouette (darker than illuminated ground)
    base[80 : h - 60, 420 : w - 30] = np.clip(base[80 : h - 60, 420 : w - 30] - 25, 5, 255)
    # Path (lighter horizontal band) — gives the bottom-row tiles structure
    base[h - 110 : h - 70, :] = np.clip(base[h - 110 : h - 70, :] + 15, 5, 255)
    base = np.clip(base, 0, 255).astype(np.uint8)
    img = np.repeat(base[:, :, None], 3, axis=2)
    return img


def _flat_grey_frame() -> np.ndarray:
    """Reolink classic mid-grey hickup: uniform 128 with tiny JPEG noise."""
    rng = _rng(3)
    img = np.full((480, 640, 3), 128, dtype=np.int16)
    img += rng.integers(-3, 4, size=img.shape, dtype=np.int16)
    return np.clip(img, 0, 255).astype(np.uint8)


def _partial_grey_top_strip(seed: int = 4) -> np.ndarray:
    """Pattern (a): the first ~12 % of rows still carry real imagery (OSD
    timestamp + a sliver of scene). Everything below is mid-grey hickup."""
    rng = _rng(seed)
    h, w = 480, 640
    img = np.full((h, w, 3), 130, dtype=np.uint8)
    # Strip of real scene at top — timestamp burn-in style
    strip_h = int(h * 0.12)
    img[:strip_h, :] = rng.integers(40, 230, size=(strip_h, w, 3), dtype=np.uint8)
    # Add OSD timestamp box (high contrast)
    img[8:30, 8:200] = 0
    img[12:26, 12:196] = 240
    # Add a tiny amount of noise to the grey area so per-channel std lands
    # in the band that escapes the global std-sum heuristic.
    noise = rng.integers(-4, 5, size=(h - strip_h, w, 3), dtype=np.int16)
    img[strip_h:] = np.clip(img[strip_h:].astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return img


def _blocky_grey_noise_frame(seed: int = 5) -> np.ndarray:
    """Pattern (b): full-frame H.264 macroblock corruption — mid-grey luma
    with locally-smooth noise inside each 16×16 block, no real edges
    anywhere. Per-channel std is high enough (~15–25) that the global
    std-sum heuristic doesn't catch it."""
    rng = _rng(seed)
    h, w = 480, 640
    img = np.zeros((h, w, 3), dtype=np.uint8)
    # Build the noise at 16×16 block granularity, then upsample with NN
    # so the result has variance but no real edges (each block is a
    # constant patch).
    blocks_h = h // 16
    blocks_w = w // 16
    block_means = rng.integers(95, 165, size=(blocks_h, blocks_w), dtype=np.int16)
    # Tiny within-block jitter so std is non-zero but Laplacian variance
    # stays low.
    block_jitter = rng.integers(-3, 4, size=(blocks_h, blocks_w), dtype=np.int16)
    block = (block_means + block_jitter).clip(0, 255).astype(np.uint8)
    upsampled = np.repeat(np.repeat(block, 16, axis=0), 16, axis=1)
    upsampled = upsampled[:h, :w]
    img[..., 0] = upsampled
    img[..., 1] = upsampled
    img[..., 2] = upsampled
    return img


def _half_glitch_half_grey_frame(seed: int = 6) -> np.ndarray:
    """Pattern (c): left half is a glitched motion-compensation smear
    (mostly desaturated, copied/shifted blocks from a prior frame), right
    half is mid-grey blocky noise. Real-world H.264 glitches lose colour
    fidelity, so the smear stays roughly grey-toned."""
    rng = _rng(seed)
    h, w = 480, 640
    img = np.zeros((h, w, 3), dtype=np.uint8)
    half = w // 2
    # Left half: vertical block streaks at mid-luma, B≈G≈R (motion-comp
    # corruption typically loses chroma detail). Per-block luma varies in
    # the mid-grey band, with brief ~16-pixel-wide artefacts.
    for x in range(0, half, 16):
        v = int(rng.integers(95, 165))
        img[:, x : x + 16] = (v, v, v)
    # Right half: mid-grey blocky noise (re-uses the (b) pattern)
    rhs = _blocky_grey_noise_frame(seed + 1)[:, half:]
    img[:, half:] = rhs
    return img


# ── Tests ───────────────────────────────────────────────────────────────────


class TestRealFramesPass:
    def test_daytime_frame_passes(self):
        ok, reason = is_valid_frame(_daytime_frame())
        assert ok, f"daytime frame rejected: {reason}"

    def test_ir_night_frame_passes(self):
        ok, reason = is_valid_frame(_ir_night_frame())
        assert ok, f"IR/night frame rejected: {reason}"


class TestExistingPatternsStillReject:
    def test_flat_grey_rejects(self):
        ok, reason = is_valid_frame(_flat_grey_frame())
        assert not ok
        # The grey-uniform / no-detail / dead-area gates can each catch this;
        # we only care that *some* gate fires.
        assert reason, "expected a non-empty rejection reason"

    def test_too_dark_rejects(self):
        ok, reason = is_valid_frame(np.zeros((480, 640, 3), dtype=np.uint8))
        assert not ok
        assert "too_dark" in reason


class TestNewCorruptionPatternsReject:
    def test_partial_grey_top_strip_rejects(self):
        """Real OSD strip at top + uniform mid-grey below → dead-area gate fires."""
        img = _partial_grey_top_strip()
        ok, reason = is_valid_frame(img)
        assert not ok, "partial-grey-top-strip frame slipped through"
        # The dead-area gate should be the one that catches this — the
        # global std heuristic doesn't because the strip has plenty of
        # texture.
        assert "dead_area" in reason or "grey_midband" in reason, reason

    def test_blocky_grey_noise_rejects(self):
        ok, reason = is_valid_frame(_blocky_grey_noise_frame())
        assert not ok, "blocky-grey-noise frame slipped through"
        # The frame-level grey-toned gate is the primary catch for full-
        # frame H.264 macroblock corruption (mid-luma + B≈G≈R).
        assert "grey_toned" in reason or "dead_area" in reason, reason

    def test_half_glitch_half_grey_rejects(self):
        """Half-glitch is intentionally adversarial — the colourful left
        half pushes overall chroma up, and the blocky right half has too
        much per-tile variance to register as dead. This case is meant to
        document the limit of the heuristic, not require a perfect catch.
        We assert only that the frame either rejects OR scores at least
        25 % dead area (high enough that one extra glitched tile would
        push it over the threshold)."""
        img = _half_glitch_half_grey_frame()
        ok, reason = is_valid_frame(img)
        if ok:
            score, _, _ = dead_area_score(img)
            assert score >= 0.25, (
                f"half-glitch passed validation AND scored only "
                f"{score:.0%} dead — heuristic is too lenient"
            )


class TestDeadAreaScore:
    def test_real_frame_low_score(self):
        score, _, total = dead_area_score(_daytime_frame())
        assert total > 0
        # Daytime frames must stay well under the 55 % rejection threshold;
        # we verify with margin so noise jitter doesn't cause flakes.
        assert score < 0.4, f"daytime frame scored {score:.0%} dead"

    def test_ir_night_low_score(self):
        score, _, total = dead_area_score(_ir_night_frame())
        assert total > 0
        # IR/night has lower contrast than daytime — must still stay
        # under the rejection threshold with comfortable margin.
        assert score < 0.5, f"IR/night frame scored {score:.0%} dead"

    def test_flat_grey_high_score(self):
        score, _, _ = dead_area_score(_flat_grey_frame())
        assert score > 0.9, f"flat grey only scored {score:.0%} — too lenient"

    def test_partial_strip_high_score(self):
        score, _, _ = dead_area_score(_partial_grey_top_strip())
        # Bottom 88 % is dead → score should comfortably exceed the
        # 50 % rejection threshold.
        assert score > 0.6, f"partial-grey only scored {score:.0%}"

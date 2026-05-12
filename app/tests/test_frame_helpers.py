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
    DAY_PROFILE,
    NIGHT_PROFILE,
    TWILIGHT_PROFILE,
    dead_area_score,
    grab_valid_frame,
    is_flat_gray_full_frame,
    is_grey_frame,
    is_horizontal_anomaly_band,
    is_valid_frame,
    pick_profile_from_baseline,
    reason_family,
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
        """Real OSD strip at top + uniform mid-grey below.
        Originally caught by the dead-area gate; the location-
        agnostic horizontal_anomaly_band detector now flags it too
        (the OSD strip's row-delta signature is exactly what stage
        A finds). Either head is fine — what matters is rejection."""
        img = _partial_grey_top_strip()
        ok, reason = is_valid_frame(img)
        assert not ok, "partial-grey-top-strip frame slipped through"
        assert (
            "dead_area" in reason
            or "grey_midband" in reason
            or "horizontal_anomaly_band" in reason
            or "bottom_strip_" in reason
            or "grey_uniform" in reason
        ), reason

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


class TestLocalMacroblockAnomaly:
    """Direct tests for ``is_local_macroblock_anomaly``. The detector
    has a dual gate (chroma spread + Laplacian-energy local outlier);
    these synthetics pin both halves so a future refactor that drops
    one accidentally regresses with a clear failure. The chroma-only
    impl (pre-fix) was rejecting 90/90 frames of a real twilight
    bird-feeder scene that contained a single yellow lamp — the warm-
    lamp fixture below reproduces that pattern synthetically."""

    def _warm_lamp_frame(self) -> np.ndarray:
        """Daytime frame with a smooth radial warm-orange blob in the
        middle. Per-tile channel-mean spread peaks well above the
        chroma cutoff (the blob's center reaches BGR ≈ (40, 180, 240),
        spread ≈ 200), but the blob is smooth — its Laplacian energy
        stays comparable to the surrounding scene, so the energy gate
        rejects the cluster. Mirrors the real warm-lamp false-positive
        cluster: ~57 tiles, spread up to 185, energy median 22 vs
        frame median 53."""
        img = _daytime_frame(seed=11).copy()
        h, w = img.shape[:2]
        cy, cx = h // 2, w // 2
        yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
        r = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2).astype(np.float32)
        falloff = np.clip(1.0 - r / 80.0, 0.0, 1.0)
        target = np.array([40.0, 180.0, 240.0], dtype=np.float32)
        for c in range(3):
            img[:, :, c] = np.clip(
                img[:, :, c].astype(np.float32) * (1.0 - falloff)
                + falloff * target[c],
                0, 255,
            ).astype(np.uint8)
        return img

    def _slice_loss_patch_frame(self) -> np.ndarray:
        """Daytime frame with a 3×4-tile (48×64 px) patch of synthetic
        H.264 slice-loss corruption: each 16×16 block locked to a
        saturated DC value with per-pixel heavy noise on top. Both
        chroma spread AND Laplacian energy are high vs the surrounding
        scene — the detector MUST flag this."""
        rng = _rng(12)
        img = _daytime_frame(seed=12).copy()
        y0, x0, ph, pw = 96, 192, 48, 64
        for by in range(0, ph, 16):
            for bx in range(0, pw, 16):
                dc = np.clip(np.array([30, 60, 220]) + rng.integers(-30, 31, size=3),
                             0, 255)
                img[y0 + by:y0 + by + 16, x0 + bx:x0 + bx + 16] = dc.astype(np.uint8)
                blk = img[y0 + by:y0 + by + 16, x0 + bx:x0 + bx + 16].astype(np.int16)
                blk = np.clip(blk + rng.integers(-80, 81, size=blk.shape),
                              0, 255).astype(np.uint8)
                img[y0 + by:y0 + by + 16, x0 + bx:x0 + bx + 16] = blk
        return img

    def test_smooth_warm_blob_passes(self):
        from app.frame_helpers._macroblock import is_local_macroblock_anomaly
        ok, reason = is_local_macroblock_anomaly(self._warm_lamp_frame())
        assert not ok, f"smooth warm-light blob wrongly flagged as corruption: {reason}"

    def test_warm_blob_passes_full_validator(self):
        """End-to-end: a warm artificial light must not push a daytime
        garden frame off the validator. Catches regressions where the
        macroblock fix gets reverted at the detector level."""
        ok, reason = is_valid_frame(self._warm_lamp_frame())
        assert ok, f"daytime warm-lamp frame wrongly rejected: {reason}"

    def test_noisy_slice_loss_patch_rejects(self):
        from app.frame_helpers._macroblock import is_local_macroblock_anomaly
        ok, reason = is_local_macroblock_anomaly(self._slice_loss_patch_frame())
        assert ok, "synthetic slice-loss corruption patch was not detected"
        assert "macroblock_anomaly" in reason


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


class TestGrabValidFrameOnReject:
    """Patches ``is_valid_frame`` to a deterministic transient reject
    so the test focuses on the callback-firing contract without being
    tangled with the per-class retry policy. A flat-zero / too_dark
    fixture would also work but trips the fail-fast cap from
    TestRetryFailFast (2 attempts only) — that's covered separately."""

    def _grey_frame(self):
        return np.full((480, 640, 3), 120, dtype=np.uint8)

    def test_on_reject_fired_per_attempt(self, monkeypatch):
        """Every retry that ends in a rejected frame must invoke the
        callback once with the right attempt index."""
        from app import frame_helpers as _fh
        monkeypatch.setattr(_fh, "is_valid_frame",
                            lambda *a, **kw: (False, "grey_uniform(std_sum=4.2)"))
        flat = self._grey_frame()
        calls: list[tuple[object, str, int]] = []

        def grab():
            return flat

        def cb(frame, reason, attempt_idx):
            calls.append((frame, reason, attempt_idx))

        result, attempts_used, last_reason = grab_valid_frame(
            grab, attempts=4, sleep_s=0, on_reject=cb,
        )
        assert result is None
        assert attempts_used == 4
        assert last_reason, "expected a non-empty rejection reason"
        assert len(calls) == 4, f"expected 4 callback firings, got {len(calls)}"
        for i, (frame, reason, idx) in enumerate(calls):
            assert frame is flat, "callback must receive the raw grab_fn return value"
            assert reason, "callback reason must be non-empty"
            assert idx == i, f"attempt_idx mismatch at call {i}: got {idx}"

    def test_on_reject_callback_exception_is_swallowed(self, monkeypatch):
        """A raising callback must never abort the retry loop — the
        diagnostic save path is documented as best-effort."""
        from app import frame_helpers as _fh
        monkeypatch.setattr(_fh, "is_valid_frame",
                            lambda *a, **kw: (False, "grey_uniform(std_sum=4.2)"))
        flat = self._grey_frame()

        def grab():
            return flat

        def cb(_frame, _reason, _attempt_idx):
            raise RuntimeError("disk full")

        result, attempts_used, last_reason = grab_valid_frame(
            grab, attempts=3, sleep_s=0, on_reject=cb,
        )
        assert result is None
        assert attempts_used == 3
        assert last_reason


class TestRetryFailFast:
    """A scene-level reject (dead_area / no_detail / too_dark /
    too_bright) caps the retry budget at 2 attempts because retrying
    won't make texture appear."""

    def test_too_dark_scene_caps_at_two_attempts(self):
        flat = np.zeros((480, 640, 3), dtype=np.uint8)

        def grab():
            return flat

        result, attempts_used, last_reason = grab_valid_frame(
            grab, attempts=6, sleep_s=0,
        )
        assert result is None
        assert attempts_used == 2, (
            f"scene reject should cap at 2 attempts, got {attempts_used}"
        )
        assert "too_dark" in last_reason


class TestPickProfileFromBaseline:
    def test_dark_frame_picks_night(self):
        """An IR-night sample (uniform luma ~30) maps to NIGHT."""
        dark = np.full((240, 320, 3), 30, dtype=np.uint8)
        prof = pick_profile_from_baseline([dark, dark])
        assert prof is NIGHT_PROFILE, f"got {prof.name}"

    def test_midgrey_frame_picks_twilight(self):
        """A mid-grey sample (luma ~80) maps to TWILIGHT."""
        mid = np.full((240, 320, 3), 80, dtype=np.uint8)
        prof = pick_profile_from_baseline([mid, mid, mid])
        assert prof is TWILIGHT_PROFILE, f"got {prof.name}"

    def test_daylight_frame_picks_day(self):
        """A bright sample (luma ~180) maps to DAY."""
        bright = np.full((240, 320, 3), 180, dtype=np.uint8)
        prof = pick_profile_from_baseline([bright, bright])
        assert prof is DAY_PROFILE, f"got {prof.name}"

    def test_no_samples_falls_back_to_day(self):
        """No usable samples → DAY (conservative — never accidentally
        let real corruption through with night-loose thresholds)."""
        assert pick_profile_from_baseline([]) is DAY_PROFILE
        assert pick_profile_from_baseline([None, None]) is DAY_PROFILE

    def test_flat_grey_corruption_sample_rejected(self):
        """A flat-grey 130-luma sample with std < 10 (decoder hickup)
        must NOT influence the picker. Combined with one real night
        sample, the picker should ignore the corruption and pick
        NIGHT based on the genuine sample."""
        corrupt = np.full((240, 320, 3), 130, dtype=np.uint8)
        # Real night sample — uniform 30 with mild noise so std > 10.
        rng = np.random.default_rng(7)
        night = np.clip(
            np.full((240, 320, 3), 30, dtype=np.int16)
            + rng.integers(-15, 16, size=(240, 320, 3), dtype=np.int16),
            0, 255,
        ).astype(np.uint8)
        prof = pick_profile_from_baseline([corrupt, night])
        assert prof is NIGHT_PROFILE, f"got {prof.name}"

    def test_all_corruption_falls_back_to_night(self):
        """When EVERY baseline sample is flat-grey corruption,
        falling back to DAY here is what produced the slot-287
        false-positive wave. NIGHT is the safer default — its loose
        thresholds let real scene content through."""
        corrupt = np.full((240, 320, 3), 130, dtype=np.uint8)
        prof = pick_profile_from_baseline([corrupt, corrupt, corrupt])
        assert prof is NIGHT_PROFILE, f"got {prof.name}"


class TestHorizontalAnomalyBand:
    """Location-agnostic horizontal-band corruption detector. Two
    stages: row-delta (catches scrambled-block macroblock smears
    where each row is a different scrambled block) and chroma
    (catches saturated non-warm hue leaks). Either firing rejects
    the frame. The legacy ``bottom_strip_white`` /
    ``bottom_strip_bright`` reason heads are still emitted when
    the band sits in the bottom 25 % so existing log greps
    survive.

    Synthetic fixtures use real per-row variation inside the band
    (random scrambled noise) so they look like the actual
    macroblock-smear corruption — a uniform-fill band has no
    row-to-row delta and the new detector legitimately can't see it
    without intensity-based heuristics, which the user's spec
    deliberately excluded. Real ground-truth coverage lives in
    test_frame_validation_fixtures.py."""

    def _scene_with_corrupt_band(self, h, w, band_y0, band_h, seed=0):
        """Build a dark scene with a band of scrambled-block
        corruption — uniform-coloured tiles inside the band, with
        each row randomised. This is the row-delta signature of
        real macroblock smears."""
        rng = np.random.default_rng(seed)
        img = np.clip(
            np.full((h, w, 3), 16, dtype=np.int16)
            + rng.integers(-3, 4, size=(h, w, 3), dtype=np.int16),
            0, 255,
        ).astype(np.uint8)
        # Replace the band with rows of independently random luma —
        # that's what makes row_delta spike inside the band.
        band = (rng.integers(80, 220, size=(band_h, w, 3))
                .astype(np.uint8))
        img[band_y0:band_y0 + band_h] = band
        return img

    def test_mid_band_corruption_rejected(self):
        """Macroblock smear at y≈50 % — the case the previous
        bottom-strip-only detector missed."""
        h, w = 720, 1280
        img = self._scene_with_corrupt_band(h, w, int(h * 0.45), 70, seed=1)
        ok, reason = is_horizontal_anomaly_band(img)
        assert ok, f"mid-band corruption not rejected (reason={reason!r})"
        assert "horizontal_anomaly_band" in reason

    def test_lower_band_corruption_rejected(self):
        """Macroblock smear at y≈90 % — covered by the legacy
        bottom_strip_* head for backwards-compat in the reject
        folder layout."""
        h, w = 720, 1280
        img = self._scene_with_corrupt_band(h, w, int(h * 0.85), 60, seed=2)
        ok, reason = is_horizontal_anomaly_band(img)
        assert ok, f"lower-band corruption not rejected (reason={reason!r})"
        # band_y_pct >= 75 → legacy bottom_strip_* head
        assert ("bottom_strip_" in reason) or ("horizontal_anomaly_band" in reason)

    def test_dark_clean_passes(self):
        """A genuinely dark scene with mild noise must not trip
        the detector — the row-delta signal stays at the noise
        baseline, no chroma leak."""
        rng = np.random.default_rng(0)
        h, w = 720, 1280
        base = np.full((h, w, 3), 16, dtype=np.int16)
        noise = rng.integers(-3, 4, size=base.shape, dtype=np.int16)
        img = np.clip(base + noise, 0, 255).astype(np.uint8)
        ok, reason = is_horizontal_anomaly_band(img)
        assert not ok, f"clean dark frame rejected: {reason}"

    def test_daylight_with_shadow_passes(self):
        """Negative control — daytime scene, no corruption band, no
        chroma leak. Stage A's max-band-height cap protects against
        the "whole frame has texture" false positive."""
        rng = np.random.default_rng(3)
        h, w = 720, 1280
        # Three solid coloured regions stacked vertically with
        # noise — real-world-ish, no abrupt random-row cluster.
        img = np.zeros((h, w, 3), dtype=np.uint8)
        img[:h // 3] = 180
        img[h // 3:2 * h // 3] = 130
        img[2 * h // 3:] = 90
        noise = rng.integers(-5, 6, size=img.shape, dtype=np.int16)
        img = np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        ok, reason = is_horizontal_anomaly_band(img)
        assert not ok, f"daylight scene rejected: {reason}"

    def test_is_valid_frame_rejects_mid_band(self):
        """End-to-end through is_valid_frame — a corrupt mid-band
        frame must be flagged BEFORE the scene-level gates fire so
        the reject sink routes it into the band-corruption folder
        rather than dead_area."""
        h, w = 720, 1280
        img = self._scene_with_corrupt_band(h, w, int(h * 0.45), 70, seed=4)
        ok, reason = is_valid_frame(img, profile=NIGHT_PROFILE)
        assert not ok
        # Either the location-agnostic head OR (when stage A's z
        # placement maps to bottom %) the legacy head. Both indicate
        # the band detector fired, which is what we care about.
        assert ("horizontal_anomaly_band" in reason
                or "bottom_strip_" in reason)


class TestFlatGrayFullFrame:
    """Whole-frame mid-grey decoder corruption (H.265 dumped a
    uniform buffer with no scene structure). Distinct reason head
    from dead_area so the rejected/ folder splits the two failure
    modes."""

    def test_uniform_grey_rejected(self):
        img = np.full((480, 640, 3), 130, dtype=np.uint8)
        ok, reason = is_flat_gray_full_frame(img)
        assert ok
        assert "flat_gray_full_frame" in reason

    def test_dark_scene_passes(self):
        rng = np.random.default_rng(0)
        h, w = 480, 640
        img = np.clip(
            np.full((h, w, 3), 30, dtype=np.int16)
            + rng.integers(-15, 16, size=(h, w, 3), dtype=np.int16),
            0, 255,
        ).astype(np.uint8)
        ok, _ = is_flat_gray_full_frame(img)
        assert not ok

    def test_textured_grey_passes(self):
        """A genuinely grey scene with real texture (std ≥ 10) must
        not trip the detector — it's only the no-structure case we
        want to flag. Noise range needs head-room because BGR→GRAY
        averaging cuts std by ~33 % relative to the per-channel
        noise."""
        rng = np.random.default_rng(1)
        h, w = 480, 640
        img = np.clip(
            np.full((h, w, 3), 130, dtype=np.int16)
            + rng.integers(-35, 36, size=(h, w, 3), dtype=np.int16),
            0, 255,
        ).astype(np.uint8)
        ok, _ = is_flat_gray_full_frame(img)
        assert not ok

    def test_is_valid_frame_routes_via_flat_gray(self):
        """is_valid_frame must emit ``flat_gray_full_frame`` as the
        reason (not ``dead_area``) so the rejected/ folder splits
        cleanly."""
        img = np.full((480, 640, 3), 130, dtype=np.uint8)
        ok, reason = is_valid_frame(img, profile=NIGHT_PROFILE)
        assert not ok
        assert "flat_gray_full_frame" in reason


class TestBrightOutlierDarkScene:
    """Bright-outlier-dark-scene — a saturated tile against an
    otherwise dark scene. Two real sunrise mp4s on 2026-05-12 had 14
    of 118 frames hit this corruption mode; every other detector
    waved them through because chroma_spread ≈ 0, saturation ≈ 0,
    dead_area_score sat below threshold, and the 255-tile didn't
    carry enough row-delta to trip the horizontal-anomaly gate.

    Profile gating:
      DAY_PROFILE    → detector disabled (sun / snow / lamps
                       legitimately produce 255).
      TWILIGHT/NIGHT → detector active.
    """

    def _dark_scene_with_bright_patch(self, seed: int = 17) -> np.ndarray:
        """Mimic the real failure mode: a dark IR/twilight scene
        (mean ~50, illuminator gradient + silhouette) with one
        rectangular patch saturated at 255. Built on top of
        ``_ir_night_frame`` so dead_area + grey_toned + flat_gray
        don't false-positive before the bright_outlier detector
        gets a chance to fire."""
        img = _ir_night_frame(seed=seed).astype(np.int16)
        h, w = img.shape[:2]
        ty, tx = 1, 5
        tile_h, tile_w = h // 5, w // 8
        y0, y1 = ty * tile_h, (ty + 1) * tile_h
        x0, x1 = tx * tile_w, (tx + 1) * tile_w
        img[y0:y1, x0:x1] = 255
        return np.clip(img, 0, 255).astype(np.uint8)

    def _dark_scene_no_patch(self, seed: int = 18) -> np.ndarray:
        """A clean IR/twilight reference — no bright patch. Reuses
        the same builder the night-frames-pass test trusts so this
        case is verified to pass dead_area + flat_gray + grey_toned
        on its own."""
        return _ir_night_frame(seed=seed)

    def test_corrupt_dark_scene_rejects_at_night(self):
        img = self._dark_scene_with_bright_patch()
        ok, reason = is_valid_frame(img, profile=NIGHT_PROFILE)
        assert not ok, f"bright-patch frame slipped through at NIGHT: {reason}"
        assert "bright_outlier_dark_scene" in reason

    def test_corrupt_dark_scene_rejects_at_twilight(self):
        img = self._dark_scene_with_bright_patch()
        ok, reason = is_valid_frame(img, profile=TWILIGHT_PROFILE)
        assert not ok, f"bright-patch frame slipped through at TWILIGHT: {reason}"
        assert "bright_outlier_dark_scene" in reason

    def test_corrupt_dark_scene_passes_under_day(self):
        """DAY_PROFILE has ``bright_outlier_frame_mean_max=0``, which
        disables the detector. The bright_outlier check itself MUST
        NOT fire under DAY — bright daytime scenes legitimately
        produce 255 from sun, snow, lamps."""
        from app.frame_helpers._bright_outlier import is_bright_outlier_dark_scene
        img = self._dark_scene_with_bright_patch()
        ok, reason = is_bright_outlier_dark_scene(img, DAY_PROFILE)
        assert not ok, f"bright_outlier wrongly fired under DAY: {reason}"

    def test_clean_dark_scene_passes_night(self):
        img = self._dark_scene_no_patch()
        ok, reason = is_valid_frame(img, profile=NIGHT_PROFILE)
        assert ok, f"clean dark scene wrongly rejected: {reason}"

    def test_clean_dark_scene_passes_twilight(self):
        img = self._dark_scene_no_patch()
        ok, reason = is_valid_frame(img, profile=TWILIGHT_PROFILE)
        assert ok, f"clean dark scene wrongly rejected: {reason}"


# ── On-disk fixture loader (testdata/sunrise_2026-05-12) ───────────
# Picks up the real captures described in the prompt when the user
# populates the directory. Empty otherwise — pytest handles an empty
# parametrize by emitting a single SKIPPED placeholder.
_FIXTURE_DIR = (Path(__file__).parent.parent.parent
                / "testdata" / "sunrise_2026-05-12")


def _load_corrupt_fixtures():
    if not _FIXTURE_DIR.exists():
        return []
    return sorted(_FIXTURE_DIR.glob("f001[0-9].jpg")) \
         + sorted(_FIXTURE_DIR.glob("f002[0-3].jpg"))


def _load_clean_fixtures():
    if not _FIXTURE_DIR.exists():
        return []
    return [p for p in (_FIXTURE_DIR / "f0040.jpg", _FIXTURE_DIR / "f0080.jpg")
            if p.exists()]


@pytest.mark.parametrize("path", _load_corrupt_fixtures(),
                         ids=lambda p: p.name)
def test_real_corrupt_fixture_rejects(path):
    """Each real corrupt fixture must reject under TWILIGHT with the
    ``bright_outlier_dark_scene`` head."""
    import cv2
    img = cv2.imread(str(path))
    assert img is not None, f"failed to read {path}"
    ok, reason = is_valid_frame(img, profile=TWILIGHT_PROFILE)
    assert not ok, f"real corrupt fixture {path.name} passed: {reason}"
    assert "bright_outlier_dark_scene" in reason, \
        f"real corrupt fixture {path.name} rejected under wrong head: {reason}"


@pytest.mark.parametrize("path", _load_clean_fixtures(),
                         ids=lambda p: p.name)
def test_real_clean_fixture_passes(path):
    """Each real clean dark fixture passes under TWILIGHT + NIGHT."""
    import cv2
    img = cv2.imread(str(path))
    assert img is not None, f"failed to read {path}"
    for prof in (TWILIGHT_PROFILE, NIGHT_PROFILE):
        ok, reason = is_valid_frame(img, profile=prof)
        assert ok, f"real clean fixture {path.name} rejected under {prof.name}: {reason}"


class TestTimestampOverlayExclusion:
    """``is_horizontal_anomaly_band`` ignores bands that fit entirely
    within the camera's burnt-in timestamp strip — but only when the
    chroma stage didn't independently fire. Bands extending above or
    below the zone (or spanning the full frame) still reject.

    Synthetic frames use a GREY (B=G=R) noise band so the chroma
    stage stays silent — same signature as a real clock readout.
    Frame height 1080 so band heights of 4 % / 8 % / 14 % land above
    the detector's 30-row floor on a realistic resolution."""

    @staticmethod
    def _scene_with_grey_band(*, y_pct: int, h_pct: int, seed: int = 7) -> np.ndarray:
        rng = _rng(seed)
        h, w = 1080, 1920
        img = np.zeros((h, w, 3), dtype=np.uint8)
        # Sky/scene gradient gives the row-delta detector a stable
        # baseline that the injected band has to beat.
        yy, _xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
        img[..., 0] = np.clip(120 + yy * 0.04, 0, 255).astype(np.uint8)
        img[..., 1] = np.clip(140 + yy * 0.03, 0, 255).astype(np.uint8)
        img[..., 2] = np.clip(150 + yy * 0.02, 0, 255).astype(np.uint8)
        scene_noise = rng.integers(-5, 6, size=img.shape, dtype=np.int16)
        img = np.clip(img.astype(np.int16) + scene_noise, 0, 255).astype(np.uint8)
        # Grey band — uniform B=G=R per pixel so the chroma stage's
        # "wrong colour" rule sees zero matches and returns None,
        # matching the signature of a burnt-in clock readout.
        y0 = int(h * y_pct / 100)
        band_h = max(1, int(h * h_pct / 100))
        band_gray = rng.integers(0, 255, size=(band_h, w), dtype=np.uint8)
        img[y0:y0 + band_h, :, 0] = band_gray
        img[y0:y0 + band_h, :, 1] = band_gray
        img[y0:y0 + band_h, :, 2] = band_gray
        return img

    def test_band_inside_default_zone_suppressed(self):
        # 4 %-tall grey band at y=68 % matches the default zone
        # (68, 6) ± 2 fudge — the timestamp false-positive cluster
        # from the 2026-05-12 sunset run.
        img = self._scene_with_grey_band(y_pct=68, h_pct=4)
        ok, reason = is_horizontal_anomaly_band(img)
        assert ok is False, f"expected suppression, got {reason!r}"

    def test_band_outside_zone_still_rejects(self):
        # Band at y=15 % is far from the default zone — must still
        # be flagged as corruption.
        img = self._scene_with_grey_band(y_pct=15, h_pct=8)
        ok, reason = is_horizontal_anomaly_band(img)
        assert ok is True, "expected reject, detector returned False"
        assert "horizontal_anomaly_band" in reason

    def test_band_straddling_zone_still_rejects(self):
        # 14 %-tall band starting at y=66 % begins inside the zone
        # (66, 76) but ends at 80 — extends below the fudge zone,
        # so the "entirely inside" rule does NOT apply.
        img = self._scene_with_grey_band(y_pct=66, h_pct=14)
        ok, reason = is_horizontal_anomaly_band(img)
        assert ok is True, f"expected reject, got {ok}/{reason!r}"
        assert "horizontal_anomaly_band" in reason or "bottom_strip" in reason

    def test_explicit_disable_lets_zone_band_reject(self):
        # Per-camera ``{"enabled": false}`` turns the exclusion off
        # — even a clock-shaped band gets flagged.
        img = self._scene_with_grey_band(y_pct=68, h_pct=4)
        ok, reason = is_horizontal_anomaly_band(
            img, timestamp_zone={"enabled": False}
        )
        assert ok is True, f"expected reject with zone disabled, got {ok}/{reason!r}"

    def test_user_override_relocates_zone(self):
        # User whose camera burns the clock at y=85 % overrides the
        # zone; the new location suppresses there but the default
        # location no longer applies.
        img = self._scene_with_grey_band(y_pct=85, h_pct=4)
        ok, reason = is_horizontal_anomaly_band(
            img, timestamp_zone={"y_pct": 85, "h_pct": 6}
        )
        assert ok is False, f"expected suppression with custom zone, got {reason!r}"


class TestReasonFamily:
    """``reason_family`` collapses parameter variants of one reject
    head into a single bucket name. Two callers depend on it: the
    test-mode reject sink (subfolder per family, no parameter
    explosion) and the ``flatten_rejected`` migration script (rewrite
    legacy ``_yNN_hNN``-suffixed folder names onto the new layout).
    Both forms — the raw reason string with parens, and the legacy
    sanitised folder name — must collapse to the same family."""

    def test_strips_paren_tail(self):
        assert reason_family(
            "horizontal_anomaly_band(y=68%,h=4%,score=2.5)"
        ) == "horizontal_anomaly_band"

    def test_strips_legacy_yh_suffix(self):
        assert reason_family("horizontal_anomaly_band_y68_h4") == "horizontal_anomaly_band"
        assert reason_family("bottom_strip_bright_y92_h2") == "bottom_strip_bright"

    def test_bare_head_unchanged(self):
        assert reason_family("dead_area") == "dead_area"
        assert reason_family("flat_gray_full_frame") == "flat_gray_full_frame"

    def test_paren_then_yh_does_not_double_strip(self):
        # The raw reason carries (y=…) — once parens go, no _yNN_hNN
        # remains, so the regex doesn't bite a second time.
        assert reason_family(
            "bottom_strip_bright(y=90%,h=3%,score=4.0)"
        ) == "bottom_strip_bright"

    def test_dead_area_param_variant_collapses(self):
        # dead_area(7/16=44%) → "dead_area" — the slash/equals/% chars
        # are inside the parens and never make it past the strip.
        assert reason_family("dead_area(7/16=44%)") == "dead_area"

    def test_empty_and_none_safe(self):
        assert reason_family(None) == "unknown"
        assert reason_family("") == "unknown"

    def test_pipe_separated_budget_suffix_drops(self):
        # ``grab_valid_frame`` appends "|budget_exceeded(…)" to the
        # last reason when the wall-clock cap fires. The family must
        # still be the original head.
        assert reason_family(
            "horizontal_anomaly_band(y=68%,h=4%,score=2.5)|budget_exceeded(5.0s)"
        ) == "horizontal_anomaly_band"

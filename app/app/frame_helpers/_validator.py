"""``is_valid_frame`` orchestrator + ``grab_valid_frame`` retry wrapper.
Carved out of the original ``frame_helpers.py`` during the modular
refactor; behaviour unchanged.

This module composes the per-heuristic siblings into one pipeline. The
reason classification (transient vs. scene) lives here too because
``grab_valid_frame`` consumes it to cap retries early on scene-level
rejects."""

from __future__ import annotations

import logging
import re
import time

import cv2
import numpy as np

from ._anomaly_bands import is_horizontal_anomaly_band
from ._bright_outlier import is_bright_outlier_dark_scene
from ._colorbar import is_colorbar
from ._decode import _MIN_FRAME_H, _MIN_FRAME_W, _decode
from ._grey import dead_area_score, is_flat_gray_full_frame, is_grey_frame
from ._macroblock import is_local_macroblock_anomaly
from ._profile import (
    _GREY_TONED_LUMA_MAX,
    _GREY_TONED_LUMA_MIN,
    _PATTERN_MAGENTA_B_MIN,
    _PATTERN_MAGENTA_DOMINANCE,
    _PATTERN_MAGENTA_DOWNSCALE,
    _PATTERN_MAGENTA_GREEN_MAX,
    _PATTERN_MAGENTA_R_MIN,
    DAY_PROFILE,
    FrameValidatorProfile,
)
from ._split import is_split_frame

log = logging.getLogger(__name__)


def is_valid_frame(
    img,
    profile: FrameValidatorProfile = DAY_PROFILE,
    *,
    timestamp_zone=None,
) -> tuple[bool, str]:
    """Bundled validity check used by every timelapse capture and build path.

    Returns (True, "") when the frame is suitable for inclusion in a
    timelapse, otherwise (False, "<reason>"). Conservative: night/dark/IR
    frames pass, only truly broken inputs (null, too small, blown-out
    brightness, pink corruption, flat fill, mid-grey hickup, colorbar) fail.

    ``profile`` lets the capture loop swap thresholds for IR-night /
    twilight scenes — the default keeps the historic daytime tunings.
    Per-call (not module-level) so a single process can run different
    profiles for different cameras at the same time.

    ``timestamp_zone`` (per-camera ``timestamp_overlay_zone`` setting)
    names the strip the camera burns its clock readout into; bands
    that fit entirely within it are suppressed in
    ``is_horizontal_anomaly_band`` so the clock isn't misread as a
    corruption stripe. ``None`` (the default) applies the module-level
    defaults of (y=68 %, h=6 %) — pass ``{"enabled": false}`` to opt
    out for a specific camera."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, "null/empty"
    h, w = img.shape[:2]
    if w < _MIN_FRAME_W or h < _MIN_FRAME_H:
        return False, "too_small"

    b = float(img[:, :, 0].mean())
    g = float(img[:, :, 1].mean())
    r = float(img[:, :, 2].mean())
    brightness = (b + g + r) / 3.0
    if brightness < profile.brightness_floor:
        return False, f"too_dark(brightness={brightness:.1f})"
    if brightness > profile.brightness_ceil:
        return False, f"too_bright(brightness={brightness:.1f})"

    # Full-frame pink/magenta H.265 artifact
    if (
        r > profile.pink_full_r_min
        and r > g * profile.pink_full_ratio
        and r > b * profile.pink_full_ratio
    ):
        return False, f"pink_artifact(r={r:.0f},g={g:.0f},b={b:.0f})"
    # Quadrant-level partial pink check
    qh, qw = h // 2, w // 2
    for qi, (rs, cs) in enumerate(
        [
            (slice(0, qh), slice(0, qw)),
            (slice(0, qh), slice(qw, None)),
            (slice(qh, None), slice(0, qw)),
            (slice(qh, None), slice(qw, None)),
        ]
    ):
        sub = img[rs, cs]
        sb = float(sub[:, :, 0].mean())
        sg = float(sub[:, :, 1].mean())
        sr = float(sub[:, :, 2].mean())
        if (
            sr > profile.pink_quad_r_min
            and sr > sg * profile.pink_quad_ratio
            and sr > sb * profile.pink_quad_ratio
        ):
            return False, f"partial_pink_q{qi}(r={sr:.0f},g={sg:.0f},b={sb:.0f})"

    # Patterned-magenta detector — counts the *fraction* of pixels in
    # the magenta wedge (high R + high B, low G) regardless of whether
    # those pixels form a smooth fill or a corruption pattern. Catches
    # H.265 partial-block-loss frames where the broken region carries
    # real spatial texture (variance survives) but the colour stays
    # locked in magenta. Downscaled first so the cost is bounded.
    if w > _PATTERN_MAGENTA_DOWNSCALE:
        scale = _PATTERN_MAGENTA_DOWNSCALE / float(w)
        small = cv2.resize(
            img, (_PATTERN_MAGENTA_DOWNSCALE, max(1, int(h * scale))), interpolation=cv2.INTER_AREA
        )
    else:
        small = img
    sb_ch = small[:, :, 0].astype("int16")
    sg_ch = small[:, :, 1].astype("int16")
    sr_ch = small[:, :, 2].astype("int16")
    # Per-pixel magenta mask. min(R,B) must beat G by the dominance
    # margin so dawn/dusk pinks (which lift G almost as high as R/B)
    # don't trigger. Numpy-vectorised — single pass.
    rb_min = np.minimum(sr_ch, sb_ch)
    mask = (
        (sr_ch >= _PATTERN_MAGENTA_R_MIN)
        & (sb_ch >= _PATTERN_MAGENTA_B_MIN)
        & (sg_ch <= _PATTERN_MAGENTA_GREEN_MAX)
        & ((rb_min - sg_ch) >= _PATTERN_MAGENTA_DOMINANCE)
    )
    total = mask.size
    if total > 0:
        mfrac = float(mask.sum()) / float(total)
        if mfrac >= profile.pattern_magenta_area_frac:
            return False, f"patterned_magenta(area={mfrac:.0%})"

    # Whole-frame flat-grey decoder corruption — H.265 dumped a
    # uniform mid-grey buffer with no scene structure. Catch this
    # FIRST so it gets its own reason head ("flat_gray_full_frame")
    # in the per-reason _rejected/ folder instead of being lumped
    # in with dead_area. dead_area would otherwise also fire on
    # this frame because every tile is uniform.
    fg, fg_reason = is_flat_gray_full_frame(img)
    if fg:
        return False, fg_reason

    # Horizontal anomaly band — H.265 NAL/slice loss produces a
    # contiguous run of corrupted rows ANYWHERE in the frame (top,
    # middle, lower, bottom). Has to run BEFORE the scene-level
    # gates (no_detail / dead_area) — those would otherwise let a
    # corrupt frame through on a low-texture night, where it could
    # become the "last_valid" backfill reference and infect adjacent
    # slots in the MP4. Reason head stays as the legacy
    # ``bottom_strip_*`` when the band is in the bottom 25 % so
    # existing log greps and reject-folder layouts keep working.
    # ``profile`` is threaded through so TWILIGHT's looser
    # ``horizontal_anomaly_band_min_z`` actually flows down into the
    # detector — without it the IR-cut transition during dawn/dusk
    # dominates the reject tally on a sun-timelapse window.
    bs, bs_reason = is_horizontal_anomaly_band(
        img,
        timestamp_zone=timestamp_zone,
        profile=profile,
    )
    if bs:
        return False, bs_reason

    # Truly flat frame (any solid color)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray_std = float(gray.std())
    if gray_std < profile.flat_gray_std_floor:
        return False, f"no_detail(std={gray_std:.2f})"

    # Mid-grey hickup specifically (catches encoder/IR-cut artefacts that
    # have just enough JPEG noise to clear gray_std but no real imagery).
    grey, grey_reason = is_grey_frame(img, profile=profile)
    if grey:
        return False, grey_reason

    # Tile-based dead-area scoring — catches partially-corrupt frames where
    # only a thin strip carries real imagery (the rest is mid-grey or
    # macroblock noise).
    dead_frac, dead_n, total_n = dead_area_score(img)
    if total_n > 0 and dead_frac > profile.tile_dead_fraction:
        return False, f"dead_area({dead_n}/{total_n}={dead_frac:.0%})"

    # Localised macroblock corruption — H.264 P-frame chain artefacts
    # produce a rectangular patch of garbage colour + checkerboard
    # texture that all whole-frame gates miss because the patch is
    # too small to dominate any global statistic. Runs AFTER
    # dead_area (so a fully-corrupt frame still rejects via the
    # global gate, with a clearer reason head) and BEFORE colorbar
    # (this is a corruption check too — group with the other
    # corruption gates).
    mb_ok, mb_reason = is_local_macroblock_anomaly(img)
    if mb_ok:
        return False, mb_reason

    # Bright-outlier-dark-scene — catches the saturated 255-grey
    # corruption patch that every detector above misses: no chroma
    # for the magenta + macroblock gates to bite, no row-delta for
    # the horizontal band, mostly-untouched-frame for dead_area to
    # ignore. Active only in NIGHT / TWILIGHT (profile sets
    # ``bright_outlier_frame_mean_max`` > 0 there); DAY_PROFILE
    # leaves it disabled because a sunlit daytime scene legitimately
    # hits 255 from sun, snow, lamps.
    bo_ok, bo_reason = is_bright_outlier_dark_scene(img, profile)
    if bo_ok:
        return False, bo_reason

    # Split-frame heuristic — catches the half-corrupt cluster where
    # exactly one half is dead grey and the other half is real
    # imagery. dead_area_score lands near 0.5 in that case, just under
    # the threshold above, but the visual is unusable.
    split, split_reason = is_split_frame(img)
    if split:
        return False, split_reason

    # Grey-toned mid-luma gate — frame-level fallback for blocky H.264
    # macroblock corruption. Such frames have inter-channel variance ≈ 0
    # (B=G=R from chroma drop-out) and luma stuck in the mid-grey band.
    # IR/night passes because it's dark; daytime passes because real
    # scenes carry chroma even under desaturated lighting.
    #
    # Chroma std uses a TRIMMED metric (drop the top 10 % of pixel-level
    # |B-G| and |B-R| differences before std) so a mostly-grey frame
    # with a small chroma island (e.g. the green LED of a clock or a
    # red OSD pixel) doesn't escape the gate via the bright outliers.
    # np.partition is O(n) — no full sort needed.
    luma = (b + g + r) / 3.0
    diff_bg = np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 1]).flatten()
    diff_br = np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 2]).flatten()

    def _trimmed_std(arr, drop_frac=0.10):
        if arr.size == 0:
            return 0.0
        cut = max(1, int(arr.size * (1.0 - drop_frac)))
        if cut >= arr.size:
            return float(arr.std())
        # partition keeps the smallest `cut` elements in the first slots
        # — order within the kept slice is undefined but std doesn't care.
        kept = np.partition(arr, cut - 1)[:cut]
        return float(kept.std())

    chroma_std = (_trimmed_std(diff_bg) + _trimmed_std(diff_br)) / 2.0
    if (
        _GREY_TONED_LUMA_MIN <= luma <= _GREY_TONED_LUMA_MAX
        and chroma_std < profile.grey_toned_chroma_std_max
    ):
        return False, (f"grey_toned(luma={luma:.0f},chroma_std={chroma_std:.1f})")

    # Test-pattern colorbar
    bar, bar_reason = is_colorbar(img)
    if bar:
        return False, bar_reason

    return True, ""


# ── Retry classification ─────────────────────────────────────────────────────
# Two reason buckets drive the retry strategy:
#   transient — encoder hickups, partial corruption, codec-state bugs.
#               Retrying ~0.4 s later genuinely helps because the next
#               frame is a fresh decode that won't carry the hickup.
#   scene     — the actual scene is empty / dark / blown out. Retrying
#               doesn't make texture appear; the camera is fine, the
#               scene is just like that. Cap retries at 2 for these so
#               an empty terrace at midnight doesn't burn the full
#               6-attempt budget for every slot.
_TRANSIENT_REASONS: frozenset[str] = frozenset(
    {
        "grey_uniform",
        "grey_midband",
        "colorbar",
        "pink_artifact",
        "patterned_magenta",
        "split_left_dead",
        "split_right_dead",
        "split_top_dead",
        "split_bottom_dead",
        "grey_toned",
        "bright_outlier_dark_scene",
        # H.265 horizontal-band corruption (encoder/decoder hickup) —
        # the next frame is usually clean, so retrying within the
        # wall-clock budget genuinely helps. ``horizontal_anomaly_band``
        # is the location-agnostic head; the legacy ``bottom_strip_*``
        # heads stay too because the validator still emits them when
        # the band sits in the bottom 25 % of the frame.
        "horizontal_anomaly_band",
        "bottom_strip_white",
        "bottom_strip_bright",
        # Whole-frame flat-grey corruption — same encoder/decoder
        # hickup family, retry within budget can recover.
        "flat_gray_full_frame",
    }
)
_SCENE_REASONS: frozenset[str] = frozenset(
    {
        "dead_area",
        "no_detail",
        "too_dark",
        "too_bright",
    }
)


def _classify_reason(reason: str) -> str:
    """Return ``"transient"`` / ``"scene"`` / ``"other"`` for a
    rejection reason. Strips diagnostic detail before lookup. ``other``
    covers grab_exception / grab_returned_none / null/empty / too_small
    — these get the full retry budget so a flaky single-shot grab can
    still recover."""
    if not reason:
        return "other"
    # Inline the head-extraction (also done by _normalise_rejection_reason
    # further down) so this helper can be called before that one is
    # defined in the module — both are module-level and resolved
    # lazily at call time, but inlining keeps the read-order intuitive.
    head = reason.split("|", 1)[0].split("(", 1)[0].strip()
    if head in _SCENE_REASONS:
        return "scene"
    if head in _TRANSIENT_REASONS:
        return "transient"
    return "other"


# ── Retry wrapper ────────────────────────────────────────────────────────────
def grab_valid_frame(
    grab_fn,
    attempts: int = 6,
    sleep_s: float = 0.4,
    max_total_seconds: float = 5.0,
    on_reject=None,
    profile: FrameValidatorProfile = DAY_PROFILE,
    *,
    timestamp_zone=None,
) -> tuple[object, int, str]:
    """Call ``grab_fn`` up to ``attempts`` times OR
    ``max_total_seconds`` wall-clock, whichever comes first.

    Returns (frame_or_None, attempt_index_used_or_final_attempts,
    last_reason). A first-attempt success returns
    attempt_index_used=0; the caller can use that to bump a "retry
    recoveries" counter when index > 0.

    Defaults bumped from 3 attempts × 0.7 s (2.1 s typical, no hard
    cap) to 6 attempts × 0.4 s (2.4 s typical) plus a 5 s wall-clock
    ceiling. The extra attempts catch cluster-E cases where the
    corrupt region wanders frame-to-frame; the wall-clock ceiling
    guarantees a single bad camera can never stall the entire
    capture loop for a full interval. If the budget fires before
    `attempts` is exhausted, last_reason gets a
    "budget_exceeded(<seconds>s)" suffix appended so the caller's
    diagnostics see why we gave up.

    grab_fn() may return either a decoded BGR ndarray or JPEG bytes
    — both are handled transparently by ``is_valid_frame``.

    The function intentionally stays stats-agnostic — callers fold
    the returned ``last_reason`` into a CaptureStats via
    ``stats.record_invalid(reason)`` so per-reason breakdowns
    bookkeep through a single path regardless of whether the caller
    uses this retry helper or its own loop.

    ``on_reject`` (optional) is fired once per rejected attempt with
    ``(frame, reason, attempt_idx)`` — the raw value returned by
    ``grab_fn`` (ndarray or JPEG bytes), the validator's reason
    string, and the zero-based attempt index. The callback is
    invoked for every retry that fails, including the final one.
    Default ``None`` keeps the current behaviour bit-identical for
    callers that don't opt in. Exceptions raised inside the
    callback are caught and logged at DEBUG so a flaky disk save
    can never abort the capture loop — the diagnostic save path is
    best-effort by design."""
    t0 = time.monotonic()
    last_reason = ""
    attempt = 0
    n = max(1, attempts)
    # Per-call effective cap. Starts at the caller's `attempts` value;
    # gets clamped down to 2 the moment a scene-level reject is observed
    # because retrying scene rejects (empty terrace, too dark, no detail)
    # never makes texture appear. Transient rejects keep the full budget.
    effective_cap = n
    while attempt < effective_cap:
        if time.monotonic() - t0 >= max_total_seconds:
            last_reason = (
                last_reason + "|" if last_reason else ""
            ) + f"budget_exceeded({max_total_seconds}s)"
            break
        try:
            frame = grab_fn()
        except Exception as e:
            last_reason = f"grab_exception:{e}"
            frame = None
        if frame is not None:
            ok, reason = is_valid_frame(frame, profile=profile, timestamp_zone=timestamp_zone)
            if ok:
                return frame, attempt, ""
            last_reason = reason or last_reason or "invalid"
        else:
            last_reason = last_reason or "grab_returned_none"
        # Best-effort diagnostic save — fire AFTER last_reason has been
        # finalised for this attempt so the caller sees the same string
        # we'd return at the end of the loop. ``frame`` may be None
        # (grab_fn returned None or raised) — the callback decides
        # whether None is worth persisting.
        if on_reject is not None:
            try:
                on_reject(frame, last_reason, attempt)
            except Exception as cb_exc:
                log.debug("[frame_helpers] on_reject callback raised: %s", cb_exc)
        # Scene-level rejects get capped at total=2 — one more attempt
        # past the first reject in case the camera was mid-AGC, then
        # we give up. The wall-clock cap still applies; this just
        # prevents a per-slot 5 s burn on empty IR night scenes.
        if _classify_reason(last_reason) == "scene":
            effective_cap = min(effective_cap, 2)
        attempt += 1
        if attempt < effective_cap:
            time.sleep(sleep_s)
    return None, attempt, last_reason


def _normalise_rejection_reason(reason: str | None) -> str:
    """Strip the diagnostic detail from a is_valid_frame / grab_valid_frame
    reason string so a per-reason tally stays readable. Reasons come back
    as "grey_uniform(std_sum=4.2)" or "split_left_dead(...)|budget_exceeded(5.0s)";
    we want bare keys like "grey_uniform" / "split_left_dead" for the
    breakdown.
    """
    if not reason:
        return "unknown"
    head = reason.split("|", 1)[0]
    head = head.split("(", 1)[0]
    return head.strip() or "unknown"


# Folder-name family suffix that older reject-sink versions appended:
# `horizontal_anomaly_band_y68_h4`, `bottom_strip_bright_y90_h3`. The
# regex strips it so a legacy folder name collapses to the same family
# as the new one. Conservative — only the trailing `_yNN_hNN` pair.
_BAND_LOC_SUFFIX_RE = re.compile(r"_y\d+_h\d+$")


def reason_family(reason: str | None) -> str:
    """Top-level family name for a reject reason.

    Strips the parameter tail ``(...)`` and any legacy band-location
    suffix ``_yNN_hNN`` that an older reject sink may have appended to
    the folder name. All parameter variants of one reason head collapse
    into a single bucket — used by the test-mode reject sink to pick
    its subfolder name, and by ``scripts.flatten_rejected`` to migrate
    pre-flatten run directories onto the new layout.

    Accepts either a full reason like
    ``horizontal_anomaly_band(y=68%,h=4%,score=2.5)`` or an already-
    sanitised folder name like ``horizontal_anomaly_band_y68_h4`` —
    both collapse to ``horizontal_anomaly_band``."""
    head = _normalise_rejection_reason(reason)
    return _BAND_LOC_SUFFIX_RE.sub("", head)

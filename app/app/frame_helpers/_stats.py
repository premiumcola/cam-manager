"""Per-session capture stats. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from ..io_utils import atomic_write_json
from ._validator import _classify_reason, _normalise_rejection_reason

log = logging.getLogger(__name__)


@dataclass
class CaptureStats:
    """Per-session frame-capture stats. One instance per timelapse window
    (legacy day folder, profile window, sun phase, weather event scratch).

    The flush() method is fault-tolerant — write failures degrade to a
    warning rather than crashing the capture loop, because no stats file
    is ever as important as keeping the capture running."""
    out_dir: Path
    expected_frames: int = 0
    started_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    captured_frames: int = 0
    invalid_frames: int = 0
    retry_recoveries: int = 0
    # Per-reason rejection tally. Keys are the bare reason heads
    # (grey_uniform / dead_area / split_left_dead / grey_toned /
    # no_detail / pink_artifact / colorbar / too_dark / too_bright /
    # budget_exceeded / grab_exception / grab_returned_none) — no
    # parenthesised detail. Lets per-timelapse logs answer "which
    # cluster dominated this window?" without re-parsing the raw
    # log lines.
    rejected_by_reason: dict = field(default_factory=dict)
    # Same shape, but sub-tally for slots that gave up early because the
    # reject was scene-level (dead_area / no_detail / too_dark /
    # too_bright). These don't represent camera failure — the scene
    # genuinely had nothing worth keeping. Surface separately so the
    # operator can read "23 dead_area" vs "23 dead_area (all scene-skip)"
    # at a glance.
    scene_skips_by_reason: dict = field(default_factory=dict)
    # First observed full reason string per reason head — keeps a
    # representative diagnostic blob (e.g. "dead_area(40/40=100%)") so
    # the UI can show a concrete number under the bare key. Populated
    # on the first hit per head; subsequent hits are ignored.
    rejected_by_reason_examples: dict = field(default_factory=dict)
    # Number of times the slot loop discarded its ``last_valid_jpg``
    # backfill cache because a strict re-validation flagged it after
    # > 3 consecutive uses — a self-defence guard against a corrupt
    # frame that slipped through the validator becoming the reference
    # for many adjacent slots. Surfaced on the live test panel so
    # the operator sees "we caught one" rather than wondering why a
    # block of slots ended up empty.
    backfill_cache_drops: int = 0
    # Optional capture-context metadata. Populated by the caller right
    # before flush() lands to ``_stats.json`` and surfaces in the UI.
    # All optional so the existing call sites that don't set them
    # produce the same _stats.json shape as before.
    validator_profile: str | None = None
    baseline_brightness: float | None = None
    phase_drift_min: int | None = None
    phase_drift_warning: str | None = None

    def record_capture(self, attempt_used: int = 0):
        """attempt_used==0 means first try succeeded; >0 means a retry saved it."""
        self.captured_frames += 1
        if attempt_used > 0:
            self.retry_recoveries += 1

    def record_invalid(self, reason: str | None = None):
        """Record a frame the capture loop gave up on. Optionally pass
        the last is_valid_frame reason so it aggregates into the
        per-reason breakdown. Scene-level rejects (dead_area /
        no_detail / too_dark / too_bright) also bump the
        ``scene_skips_by_reason`` mirror so the UI can distinguish
        "validator threw it away" from "scene was genuinely empty"."""
        self.invalid_frames += 1
        if reason:
            key = _normalise_rejection_reason(reason)
            self.rejected_by_reason[key] = self.rejected_by_reason.get(key, 0) + 1
            if _classify_reason(reason) == "scene":
                self.scene_skips_by_reason[key] = (
                    self.scene_skips_by_reason.get(key, 0) + 1
                )
            # Keep the FIRST full reason string per head — the value
            # carries the diagnostic detail (e.g. "(40/40=100%)") that
            # the UI shows alongside the bare key.
            if key not in self.rejected_by_reason_examples:
                self.rejected_by_reason_examples[key] = reason

    # ── Derived breakdown ───────────────────────────────────────────────
    # The user reads the panel and asks "how many slots in the MP4 are
    # actually fresh content?" — the raw counters answer half of that.
    # These properties decompose ``invalid_frames`` into:
    #   • backfilled_slots — invalid slots filled with a copy of the
    #     last valid frame (encoder-friendly continuity, but not
    #     "new" imagery)
    #   • skipped_slots    — scene-level rejects we deliberately gave
    #     up on early (empty terrace at midnight) — these stay empty
    #     in the MP4 sequence
    # ``total_written`` is fresh + backfilled. The MP4's slot count is
    # always at most ``total_written``; ffmpeg padding fills any gaps.
    @property
    def fresh_captures(self) -> int:
        return int(self.captured_frames)

    @property
    def scene_skips_total(self) -> int:
        return int(sum(self.scene_skips_by_reason.values()))

    @property
    def backfilled_slots(self) -> int:
        # Clamp at zero — defensive against a counter race we don't
        # currently have but might invent if the loop is rewritten.
        return max(0, int(self.invalid_frames) - self.scene_skips_total)

    @property
    def skipped_slots(self) -> int:
        return self.scene_skips_total

    @property
    def total_written(self) -> int:
        return self.fresh_captures + self.backfilled_slots

    def flush(self):
        try:
            path = Path(self.out_dir) / "_stats.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "started_at": self.started_at,
                "expected_frames": int(self.expected_frames),
                "captured_frames": int(self.captured_frames),
                "invalid_frames": int(self.invalid_frames),
                "retry_recoveries": int(self.retry_recoveries),
                "rejected_by_reason": dict(self.rejected_by_reason),
                "scene_skips_by_reason": dict(self.scene_skips_by_reason),
                "rejected_by_reason_examples": dict(self.rejected_by_reason_examples),
                "backfill_cache_drops": int(self.backfill_cache_drops),
                # Derived breakdown — denormalised here so consumers
                # don't have to recompute. fresh+backfilled+skipped is
                # the "how many slots in the MP4 are real content"
                # answer the user asks every time they read the panel.
                "fresh_captures":   self.fresh_captures,
                "backfilled_slots": self.backfilled_slots,
                "skipped_slots":    self.skipped_slots,
                "total_written":    self.total_written,
                "validator_profile": self.validator_profile,
                "baseline_brightness": self.baseline_brightness,
                "phase_drift_min": self.phase_drift_min,
                "phase_drift_warning": self.phase_drift_warning,
            }
            atomic_write_json(path, payload)
        except Exception as e:
            log.warning("[timelapse] could not write _stats.json in %s: %s", self.out_dir, e)
        # Per-flush log line so docker logs surface which cluster is
        # dominating an in-progress capture without waiting for the
        # window to close. Compact format keeps it grep-friendly.
        try:
            log.info(
                "[capture-stats] %s · captured=%d retries=%d invalid=%d rejected=%s scene_skips=%s",
                Path(self.out_dir).name,
                self.captured_frames, self.retry_recoveries,
                self.invalid_frames, dict(self.rejected_by_reason),
                dict(self.scene_skips_by_reason),
            )
        except Exception:
            pass


def read_capture_stats(frames_dir: Path) -> dict:
    """Return the per-session stats blob from frames_dir/_stats.json, or
    empty dict if missing/corrupt. Used by the build path to merge into the
    final MP4 manifest."""
    try:
        p = Path(frames_dir) / "_stats.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

"""F06 first-since detector — flag motion events that arrive after an
unusually long gap for their class.

Why a separate module:
    The check is small but cross-cuts the recording pipeline (read-side
    over EventStore + write-side onto the new event JSON + telegram
    formatting). Putting it next to `_recording.py` would couple
    encoding logic with index lookups; putting it in `event_logic.py`
    would mix real-time motion gating with archival queries. A
    dedicated helper keeps the surface tight.

Threshold semantics:
    Each class (label) has its own threshold in hours, configured under
    `processing.first_since.thresholds.<label>` in the effective config.
    Missing labels fall back to `thresholds.default`. Conservative
    defaults are baked in here so a fresh install never spams — the
    user can tighten them later via config.yaml.

Boot grace:
    A freshly-started process has no recent motion-event memory in the
    runtime path. To avoid every label firing as "first since forever"
    on the first event after a restart, the detector suppresses
    markers for `boot_grace_seconds` after process start (default
    24 h). The disk-side EventStore still has the history; the grace
    is purely about the operator-experience of redeploying.

Side-file `storage/first_since_records.json`:
    Tracks the maximum gap ever recorded per (camera, label). When the
    current gap exceeds it, `is_new_record=True` flips and the
    side-file is updated. Pure best-effort persistence — a corrupt or
    missing file resets the records, never blocks event creation.
"""

from __future__ import annotations

import json as _json_mod
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path

log = logging.getLogger("app.first_since")

# Conservative built-in defaults. Used when the effective config doesn't
# carry a per-label override AND no `default` value either. Tuned high
# rather than low — the spec's stop-condition explicitly warns that
# low thresholds spam the user.
_BUILTIN_THRESHOLDS_HOURS: dict[str, float] = {
    "default": 8.0,
    "person": 6.0,
    "bird": 4.0,
    "cat": 8.0,
    "dog": 12.0,
    "squirrel": 12.0,
    "fox": 24.0,
    "hedgehog": 24.0,
    "marten": 24.0,
    "deer": 48.0,
}

# Labels we never evaluate. "motion" is on every event (it's how the
# pipeline triggers in the first place); flagging it would mean every
# quiet stretch produces a "first motion in N h" alert. The other
# entries are non-class metadata.
_SKIP_LABELS: frozenset[str] = frozenset({"motion"})

_BOOT_TS = time.time()
_DEFAULT_BOOT_GRACE_S = 86400  # 24 h

_records_lock = threading.Lock()


def _parse_hours(val) -> float | None:
    """Accept '8h', '90m', '3600s' or a bare number (interpreted as
    hours). Returns None for anything unparseable so the caller can
    fall through to the built-in default rather than crashing."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    if not isinstance(val, str):
        return None
    s = val.strip().lower()
    if not s:
        return None
    try:
        if s.endswith("h"):
            return float(s[:-1])
        if s.endswith("m"):
            return float(s[:-1]) / 60.0
        if s.endswith("s"):
            return float(s[:-1]) / 3600.0
        return float(s)
    except ValueError:
        return None


class FirstSinceDetector:
    """Owns threshold lookup, gap calculation, and the records side-file.

    Constructed once per process; threading-safe across the recording
    threads thanks to the records-file lock. The instance is used
    inline from `_recording.py::_finalize_motion_clip`.
    """

    def __init__(self, store, settings, storage_root: Path, boot_ts: float | None = None):
        self.store = store
        self.settings = settings
        self.records_path = storage_root / "first_since_records.json"
        self.boot_ts = boot_ts if boot_ts is not None else _BOOT_TS

    # ── Config helpers ─────────────────────────────────────────────────
    def _cfg_block(self) -> dict:
        try:
            from . import app_state

            eff = self.settings.export_effective_config(app_state.base_cfg)
        except Exception:
            return {}
        return (eff.get("processing") or {}).get("first_since") or {}

    def _enabled(self) -> bool:
        # Default ON when not specified — the feature is opt-out.
        block = self._cfg_block()
        return bool(block.get("enabled", True))

    def _boot_grace_s(self) -> float:
        block = self._cfg_block()
        v = _parse_hours(block.get("boot_grace"))
        if v is not None:
            return v * 3600.0
        return float(_DEFAULT_BOOT_GRACE_S)

    def _threshold_hours(self, label: str) -> float:
        block = self._cfg_block()
        thresholds = block.get("thresholds") or {}
        # Per-label override → effective default → built-in label →
        # built-in default. Each step is parsed via _parse_hours so the
        # operator can write "12h" or 12 interchangeably.
        for source in (thresholds.get(label), thresholds.get("default")):
            v = _parse_hours(source)
            if v is not None:
                return v
        return _BUILTIN_THRESHOLDS_HOURS.get(
            label,
            _BUILTIN_THRESHOLDS_HOURS["default"],
        )

    # ── Records side-file ──────────────────────────────────────────────
    def _load_records(self) -> dict:
        if not self.records_path.exists():
            return {"schema": 1, "records": {}}
        try:
            d = _json_mod.loads(self.records_path.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                return {"schema": 1, "records": {}}
            d.setdefault("records", {})
            return d
        except Exception as e:
            log.debug("[first_since] records load failed (%s) — starting empty", e)
            return {"schema": 1, "records": {}}

    def _save_records(self, data: dict) -> None:
        try:
            tmp = self.records_path.with_suffix(self.records_path.suffix + ".tmp")
            tmp.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(str(tmp), str(self.records_path))
        except Exception as e:
            log.debug("[first_since] records save failed: %s", e)

    def _check_and_update_record(
        self, cam_id: str, label: str, gap_hours: float, event_id: str
    ) -> bool:
        """Returns True if `gap_hours` is the new max for (cam, label)."""
        with _records_lock:
            data = self._load_records()
            cam_block = data["records"].setdefault(cam_id, {})
            entry = cam_block.get(label) or {}
            prev_max = float(entry.get("max_gap_hours") or 0.0)
            if gap_hours > prev_max:
                cam_block[label] = {
                    "max_gap_hours": gap_hours,
                    "set_at": datetime.now().isoformat(timespec="seconds"),
                    "event_id": event_id,
                }
                self._save_records(data)
                return True
            return False

    # ── Main entry point ───────────────────────────────────────────────
    def evaluate(self, event: dict) -> dict | None:
        """Compute a first_since marker for `event` if any of its labels
        crossed its threshold. Returns the marker dict or None.

        The caller (recording pipeline) is responsible for merging the
        marker into the event before persisting. We only read.
        """
        if not self._enabled():
            return None
        # Boot grace: skip the first N seconds after process start so a
        # restart doesn't burn through the threshold table on every
        # label. The EventStore already has the history; the grace
        # protects the operator's inbox, not the data.
        if (time.time() - self.boot_ts) < self._boot_grace_s():
            return None

        cam_id = event.get("camera_id")
        event_id = event.get("event_id")
        ts_str = event.get("time")
        if not cam_id or not event_id or not ts_str:
            return None
        try:
            event_ts = datetime.fromisoformat(ts_str)
        except ValueError:
            return None

        # Walk every label and pick the one with the largest gap that
        # crossed its own threshold. A multi-class event (e.g.
        # ["motion", "squirrel", "bird"]) gets one marker, attached to
        # the most-anomalous class.
        labels = [l for l in (event.get("labels") or []) if l not in _SKIP_LABELS]
        if not labels:
            return None

        best_marker: dict | None = None
        best_gap_h: float = -1.0
        for label in labels:
            prev = self._previous_event(cam_id, label, before=ts_str, exclude_event_id=event_id)
            if prev is None:
                # First-ever event of this label on this camera. Skip
                # rather than fire — we have no baseline, and on a
                # fresh install every cam-label pair would emit on its
                # very first sighting. The spec calls this out as a
                # boot-time pitfall; same logic applies any time a
                # label appears for the first time.
                continue
            try:
                prev_ts = datetime.fromisoformat(prev.get("time", ""))
            except ValueError:
                continue
            gap_s = (event_ts - prev_ts).total_seconds()
            if gap_s <= 0:
                continue
            gap_h = gap_s / 3600.0
            threshold = self._threshold_hours(label)
            if gap_h < threshold:
                continue
            if gap_h > best_gap_h:
                best_gap_h = gap_h
                best_marker = {
                    "label": label,
                    "previous_event_id": prev.get("event_id"),
                    "previous_event_ts": prev.get("time"),
                    "gap_hours": round(gap_h, 1),
                    "threshold_hours": round(threshold, 1),
                    "is_new_record": False,
                }

        if best_marker is None:
            return None
        # New-record check is done last so a non-fired threshold doesn't
        # bump the side-file. Only bumps when we're emitting a marker.
        is_new = self._check_and_update_record(
            cam_id,
            best_marker["label"],
            best_marker["gap_hours"],
            event_id,
        )
        best_marker["is_new_record"] = is_new
        log.info(
            "[first_since] cam=%s label=%s gap=%.1fh threshold=%.1fh new_record=%s",
            cam_id,
            best_marker["label"],
            best_marker["gap_hours"],
            best_marker["threshold_hours"],
            is_new,
        )
        return best_marker

    def _previous_event(
        self, cam_id: str, label: str, before: str, exclude_event_id: str | None
    ) -> dict | None:
        """Most recent event of `label` on `cam_id` strictly before
        `before` (ISO ts). Excludes the just-finalized event by id so
        we don't compare an event against itself when the JSON has
        already been written by the time the hook fires."""
        try:
            evs = self.store.list_events(cam_id, label=label, end=before, limit=10)
        except Exception as e:
            log.debug("[first_since] list_events failed: %s", e)
            return None
        for ev in evs:
            if ev.get("event_id") == exclude_event_id:
                continue
            t = ev.get("time", "")
            # `end` is inclusive in EventStore — guard against returning
            # the just-written event with a future timestamp.
            if t >= before:
                continue
            return ev
        return None

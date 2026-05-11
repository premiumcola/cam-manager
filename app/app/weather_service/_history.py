from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — some symbols are unused in this
# mixin but kept identical across mixins so methods can move between them
# without import bookkeeping. See service.py for the canonical import list.
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import requests

from ..io_utils import atomic_write_json
from ._consts import (
    EVENT_ICON_HEX,
    EVENT_LABEL_DE,
    HISTORY_FIELDS,
    HISTORY_FIELD_TO_EVENT,
    HISTORY_LABELS_DE,
    HISTORY_MAXLEN,
    HISTORY_UNITS,
    _atomic_write_json,
    _is_quiet_now,
    _safe_dt,
    _safe_subset,
    log,
)


class HistoryMixin:
    """Wetterstatistik chart history: persist samples + serve /api/weather/history.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _history_path(self) -> Path:
        """Resolve `<storage_root>/weather_history.json` from settings_store."""
        try:
            root = self.settings_store.base_config.get("storage", {}).get("root", "/app/storage")
        except Exception:
            root = "/app/storage"
        return Path(root) / "weather_history.json"

    def _load_history(self):
        path = self._history_path()
        if not path.exists():
            return
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning("[weather] history file unparseable, starting fresh: %s", e)
            return
        items = payload.get("samples") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            log.warning("[weather] history file has unexpected shape, starting fresh")
            return
        kept = 0
        with self._history_lock:
            self._history.clear()
            for row in items[-HISTORY_MAXLEN:]:
                if not isinstance(row, dict):
                    continue
                ts = row.get("ts")
                values = row.get("values")
                if not isinstance(ts, str) or not isinstance(values, dict):
                    continue
                # Migration: drop fields no longer in HISTORY_FIELDS, fill
                # missing ones with None — never crash on old/extra keys.
                clean = {k: values.get(k) for k in HISTORY_FIELDS}
                self._history.append({"ts": ts, "values": clean})
                kept += 1
        log.info("[weather] history loaded: %d samples from %s", kept, path)

    def _save_history(self):
        """Atomic write to .tmp + os.replace so a kill -9 mid-write cannot
        leave a half-written history.json on disk."""
        path = self._history_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            log.warning("[weather] history dir mkdir failed: %s", e)
            return
        with self._history_lock:
            samples = list(self._history)
        payload = {
            "version": 1,
            "saved_at": datetime.now().isoformat(timespec="seconds"),
            "samples": samples,
        }
        # fsync=True — history is the source of truth for the weather
        # chart; an OS-level crash mid-write would lose the rolling
        # window without the explicit flush + fsync.
        try:
            atomic_write_json(path, payload, fsync=True)
        except Exception as e:
            log.warning("[weather] history write failed: %s", e)

    def _record_sample(self, latest: dict, sun: dict):
        """Append the latest poll's numeric values to the ring buffer.
        Called from _poll_once after a successful API response. Stores
        `None` for any field the API didn't return so the chart can show a
        gap instead of pretending to have data."""
        values = {}
        for key in HISTORY_FIELDS:
            if key == "sun_altitude":
                values[key] = sun.get("altitude") if isinstance(sun, dict) else None
            else:
                v = latest.get(key) if isinstance(latest, dict) else None
                values[key] = float(v) if isinstance(v, (int, float)) else None
        ts_iso = datetime.now().isoformat(timespec="seconds")
        with self._history_lock:
            self._history.append({"ts": ts_iso, "values": values})
        # Update the live status snapshot so /api/weather/status carries the
        # last polled slice without a separate fetch.
        with self._lock:
            self._status["current_values"] = dict(values)
        self._save_history()

    def history(self, hours: int = 24) -> dict:
        """Backing call for /api/weather/history."""
        hours = max(1, min(720, int(hours or 24)))
        cutoff = datetime.now() - timedelta(hours=hours)
        with self._history_lock:
            samples = list(self._history)
        # Filter to time window. Tolerate parse failures by falling back to
        # "include the row" — a malformed timestamp shouldn't shrink the
        # visible window.
        out: list[dict] = []
        for row in samples:
            ts_str = row.get("ts") or ""
            try:
                if datetime.fromisoformat(ts_str) >= cutoff:
                    out.append(row)
            except Exception:
                out.append(row)
        # Thresholds from configured event settings. Always emit the
        # configured threshold value regardless of the enabled toggle —
        # the chart needs to draw the boundary even for events that are
        # currently off so the user can see what the trigger SHOULD fire
        # at. The parallel `events_enabled` map lets the renderer dim
        # disabled-event ticks instead of hiding them. Fields without an
        # associated event (cloud_cover, wind_gusts_10m, sun_altitude)
        # still emit thresholds[k]=None / events_enabled[k]=None.
        events_cfg = (self.cfg.get("events") or {})
        thresholds: dict[str, float | None] = {k: None for k in HISTORY_FIELDS}
        events_enabled: dict[str, bool | None] = {k: None for k in HISTORY_FIELDS}
        for key in HISTORY_FIELDS:
            evt = HISTORY_FIELD_TO_EVENT.get(key)
            if not evt:
                continue
            ev_cfg = events_cfg.get(evt) or {}
            events_enabled[key] = bool(ev_cfg.get("enabled", False))
            thr = ev_cfg.get("threshold")
            try:
                thresholds[key] = float(thr) if thr is not None else None
            except (TypeError, ValueError):
                thresholds[key] = None
        poll_interval_s = int(self.cfg.get("poll_interval", 300) or 300)
        return {
            "hours":           hours,
            "samples":         out,
            "thresholds":      thresholds,
            "events_enabled":  events_enabled,
            "units":           dict(HISTORY_UNITS),
            "labels_de":       dict(HISTORY_LABELS_DE),
            "fields":          list(HISTORY_FIELDS),
            "poll_interval_s": poll_interval_s,
        }

    # ── Telegram push (Phase 3) ─────────────────────────────────────────────


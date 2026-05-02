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


class ManifestsMixin:
    """Sighting + recap CRUD endpoints + service status.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _sightings_dir(self) -> Path:
        # The settings_store doesn't have a clean "storage_root" accessor;
        # we read it the same way camera_runtime does — through the global
        # cfg block exposed by export_effective_config. Falls back to /app.
        try:
            return Path(self.settings_store.base_config.get("storage", {}).get("root", "/app/storage")) / "weather"
        except Exception:
            return Path("/app/storage/weather")

    def list_sightings(self, cam_id: str | None = None, event_type: str | None = None,
                       since_iso: str | None = None, until_iso: str | None = None,
                       page: int = 0, page_size: int = 50) -> dict:
        """Walk the sightings directory tree and return a paginated list +
        a counts-per-event-type aggregate for filter pills."""
        root = self._sightings_dir()
        items: list[dict] = []
        counts: dict[str, int] = {k: 0 for k in EVENT_LABEL_DE}
        if not root.exists():
            return {"items": [], "counts": counts, "total": 0,
                    "page": page, "page_size": page_size}
        since_dt = _safe_dt(since_iso) if since_iso else None
        until_dt = _safe_dt(until_iso) if until_iso else None
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir():
                continue
            if cam_id and cam_dir.name != cam_id:
                continue
            for evt_dir in cam_dir.iterdir():
                if not evt_dir.is_dir():
                    continue
                # Skip recap dir + scratch dirs leaked from a crashed encode.
                if evt_dir.name == "recaps" or evt_dir.name.startswith(".scratch_"):
                    continue
                # Pre-filter by directory name when the requested event_type
                # has a 1:1 dir mapping. Sun-Timelapse subtypes share one
                # dir ("sun_timelapse") and event_timelapse triggers share
                # the "event_timelapse" dir, so we always recurse those and
                # filter post-translation.
                _is_sun_request = event_type in ("sun_timelapse_rise", "sun_timelapse_set", "sun_timelapse")
                _is_evt_tl_request = event_type in ("thunder_rising", "front_passing", "storm_front", "event_timelapse")
                if event_type and not _is_sun_request and not _is_evt_tl_request and evt_dir.name != event_type:
                    continue
                for jf in evt_dir.glob("*.json"):
                    try:
                        m = json.loads(jf.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    started = _safe_dt(m.get("started_at", "")) or datetime.min
                    if since_dt and started < since_dt:
                        continue
                    if until_dt and started > until_dt:
                        continue
                    et = m.get("event_type") or evt_dir.name
                    # Sun-Timelapse: collapse the generic "sun_timelapse"
                    # event_type onto the phase-specific display type so the
                    # frontend's WEATHER_TYPES map (sun_timelapse_rise /
                    # sun_timelapse_set) drives both pills and card badges
                    # without any special-casing on the JS side.
                    if et == "sun_timelapse":
                        sp = (m.get("sun_phase") or "").lower()
                        if sp == "sunrise":
                            et = "sun_timelapse_rise"
                        elif sp == "sunset":
                            et = "sun_timelapse_set"
                        m["event_type"] = et
                    elif et == "event_timelapse":
                        # Trigger field carries the WEATHER_TYPES key
                        # (thunder_rising / front_passing / storm_front);
                        # surface that as the display type.
                        trig = (m.get("trigger") or "").lower()
                        if trig in ("thunder_rising", "front_passing", "storm_front"):
                            et = trig
                        m["event_type"] = et
                    if event_type and et != event_type and not (
                        event_type == "sun_timelapse" and et.startswith("sun_timelapse")
                    ) and not (
                        event_type == "event_timelapse" and et in ("thunder_rising", "front_passing", "storm_front")
                    ):
                        continue
                    counts[et] = counts.get(et, 0) + 1
                    items.append(m)
        items.sort(key=lambda m: m.get("started_at", ""), reverse=True)
        total = len(items)
        start = max(0, page) * page_size
        end = start + page_size
        return {"items": items[start:end], "counts": counts, "total": total,
                "page": page, "page_size": page_size}

    def get_sighting(self, sighting_id: str) -> dict | None:
        path = self._manifest_path_for(sighting_id)
        if not path or not path.exists():
            return None
        try:
            m = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        # Mirror list_sightings: collapse the on-disk generic type onto the
        # phase-specific display value the frontend WEATHER_TYPES map uses.
        et = m.get("event_type")
        if et == "sun_timelapse":
            sp = (m.get("sun_phase") or "").lower()
            if sp == "sunrise":
                m["event_type"] = "sun_timelapse_rise"
            elif sp == "sunset":
                m["event_type"] = "sun_timelapse_set"
        elif et == "event_timelapse":
            trig = (m.get("trigger") or "").lower()
            if trig in ("thunder_rising", "front_passing", "storm_front"):
                m["event_type"] = trig
        return m

    def delete_sighting(self, sighting_id: str) -> bool:
        path = self._manifest_path_for(sighting_id)
        if not path or not path.exists():
            return False
        stem = path.with_suffix("")
        for ext in (".json", ".mp4", ".jpg"):
            p = stem.with_suffix(ext)
            try:
                if p.exists():
                    p.unlink()
            except Exception as e:
                log.warning("[weather] delete %s: %s", p.name, e)
        return True

    def _manifest_path_for(self, sighting_id: str) -> Path | None:
        # ID shape: <cam_id>__<event>__<ts_label>
        try:
            cam_id, evt, ts = sighting_id.split("__", 2)
        except ValueError:
            return None
        # Sun-Timelapse: per-phase dirs (sunrise_timelapse/sunset_timelapse)
        # are the new on-disk layout; the legacy shared "sun_timelapse/"
        # is still accepted as a fallback so manifests written before the
        # boot migration ran (or recovered from backup) keep resolving.
        sun_rise_aliases = ("sun_timelapse_rise", "sun_timelapse_sunrise")
        sun_set_aliases  = ("sun_timelapse_set", "sun_timelapse_sunset")
        sun_dir_lookup = None
        if evt in sun_rise_aliases:
            sun_dir_lookup = ("sunrise_timelapse", "sun_timelapse")
        elif evt in sun_set_aliases:
            sun_dir_lookup = ("sunset_timelapse", "sun_timelapse")
        elif evt == "sun_timelapse":
            sun_dir_lookup = ("sunrise_timelapse", "sunset_timelapse",
                              "sun_timelapse")
        if sun_dir_lookup:
            cam_root = self._sightings_dir() / cam_id
            for d in sun_dir_lookup:
                p = cam_root / d / f"{ts}.json"
                if p.exists():
                    return p
            # Nothing exists — return the canonical (new) path so callers
            # that only rely on .exists() get a clean False.
            return cam_root / sun_dir_lookup[0] / f"{ts}.json"
        # Event-Timelapse: id encodes the trigger kind (thunder_rising /
        # front_passing / storm_front) but all live in event_timelapse/.
        if evt in ("thunder_rising", "front_passing", "storm_front"):
            evt = "event_timelapse"
        return self._sightings_dir() / cam_id / evt / f"{ts}.json"

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    # ── History (Wetterstatistik) ──────────────────────────────────────────
    def list_recaps(self) -> list[dict]:
        root = self._recaps_dir()
        if not root.exists():
            return []
        items: list[dict] = []
        for jf in root.glob("*.json"):
            try:
                items.append(json.loads(jf.read_text(encoding="utf-8")))
            except Exception:
                continue
        items.sort(key=lambda m: m.get("period_end", m.get("built_at", "")), reverse=True)
        return items

    def get_recap(self, recap_id: str) -> dict | None:
        path = self._recaps_dir() / f"{recap_id}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    # ── Sonnen-Timelapse (Phase: Sun-TL) ────────────────────────────────────


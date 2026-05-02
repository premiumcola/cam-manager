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


class DetectionMixin:
    """Per-event detector logic (thunder/rain/fog/sunset) + sun position helper.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _latest_slice(self, payload: dict) -> dict:
        """Pick the most recent 15-minute time slot whose data is non-null.
        Open-Meteo returns parallel arrays under `minutely_15`; we walk back
        from the end until we find a row that actually has values."""
        m = (payload or {}).get("minutely_15") or {}
        times = m.get("time") or []
        if not times:
            return {}
        keys = [k for k in m if k != "time"]
        # Walk from newest to oldest until we find a slot with at least one
        # non-null measurement.
        for i in range(len(times) - 1, -1, -1):
            slot = {"time": times[i]}
            any_val = False
            for k in keys:
                arr = m.get(k) or []
                v = arr[i] if i < len(arr) else None
                slot[k] = v
                if v is not None:
                    any_val = True
            if any_val:
                return slot
        return {"time": times[-1]}

    def _sun_position(self) -> dict:
        """Cached sun altitude/azimuth for the configured location.
        Cache TTL = 60s — astral.sun calls are cheap but we don't need
        sub-minute precision for sunset detection."""
        now = time.time()
        cached_ts, cached = self._sun_cache
        if now - cached_ts < 60.0 and cached:
            return cached
        loc = self.server_cfg.get("location") or {}
        lat, lon = loc.get("lat"), loc.get("lon")
        try:
            from astral import Observer
            from astral.sun import azimuth, elevation
            obs = Observer(latitude=float(lat), longitude=float(lon),
                           elevation=float(loc.get("elevation") or 0.0))
            # astral wants a tz-aware UTC datetime; passing naive
            # datetime.now() makes it interpret local-clock-as-UTC and
            # the resulting altitude/azimuth are off by the local UTC
            # offset (visible as a 2 h sunset-time error in CEST).
            now_dt = datetime.now(tz=UTC)
            data = {
                "altitude": float(elevation(obs, now_dt)),
                "azimuth":  float(azimuth(obs, now_dt)),
            }
        except Exception as e:
            log.debug("[weather] sun position failed: %s", e)
            data = {"altitude": None, "azimuth": None}
        self._sun_cache = (now, data)
        return data

    # ── Detectors ───────────────────────────────────────────────────────────

    def _detect(self, evt: str, cfg: dict, d: dict, sun: dict) -> tuple[bool, float]:
        """Dispatch to the per-event detector. Returns (active, severity)."""
        if evt == "thunder":
            return self._detect_thunder(cfg, d)
        if evt == "heavy_rain":
            return self._detect_rain_or_snow(cfg, d, "heavy_rain", "precipitation", scale=20.0)
        if evt == "snow":
            return self._detect_rain_or_snow(cfg, d, "snow", "snowfall", scale=5.0)
        if evt == "fog":
            return self._detect_fog(cfg, d)
        if evt == "sunset":
            return self._detect_sunset(cfg, sun, d)
        return False, 0.0

    def _detect_thunder(self, cfg: dict, d: dict) -> tuple[bool, float]:
        lp = d.get("lightning_potential")
        if lp is None:
            return False, 0.0
        thr = float(cfg.get("threshold", 1000.0))
        if float(lp) >= thr:
            return True, min(1.0, float(lp) / 3000.0)
        return False, 0.0

    def _detect_rain_or_snow(self, cfg: dict, d: dict, evt: str, field: str,
                             scale: float) -> tuple[bool, float]:
        """Hysteresis: trigger only on off→on transition. Stays "on" until
        the value drops below `hysteresis` (or 0 if unset)."""
        val = d.get(field)
        if val is None:
            return False, 0.0
        val = float(val)
        thr = float(cfg.get("threshold", 0.0) or 0.0)
        hys = float(cfg.get("hysteresis", 0.0) or 0.0)
        # Hysteresis is per-event (not per-cam) — weather is global. The
        # state lookup uses a synthetic cam_id "_global_" so the same
        # tracker class works for both flavours.
        cur_state = self._hyst.get("_global_", evt)
        triggered = False
        if cur_state == "off" and val >= thr:
            self._hyst.set("_global_", evt, "on")
            triggered = True
        elif cur_state == "on" and val < hys:
            self._hyst.set("_global_", evt, "off")
        sev = min(1.0, val / scale) if triggered else 0.0
        return triggered, sev

    def _detect_fog(self, cfg: dict, d: dict) -> tuple[bool, float]:
        vis = d.get("visibility")
        if vis is None:
            return False, 0.0
        if float(vis) >= float(cfg.get("vis_max_m", 1000)):
            return False, 0.0
        # Frame-based confirmation: average contrast on the most recent
        # sub-stream frame of any opted-in camera. Open-Meteo's visibility
        # is a model estimate; the camera frame is ground truth.
        contrast = self._average_frame_contrast()
        if contrast is None:
            # No frame to confirm — be conservative, don't trigger.
            return False, 0.0
        if contrast > float(cfg.get("contrast_max", 0.25)):
            return False, 0.0
        sev = max(0.0, min(1.0, 1.0 - contrast * 4.0))
        return True, sev

    def _detect_sunset(self, cfg: dict, sun: dict, d: dict) -> tuple[bool, float]:
        alt = sun.get("altitude")
        if alt is None:
            return False, 0.0
        alt_min = float(cfg.get("alt_min", -2))
        alt_max = float(cfg.get("alt_max",  5))
        in_window = alt_min <= float(alt) <= alt_max
        # Once-per-day enforcement: once we've fired today, sit out until
        # midnight even if altitude is still in range.
        today = date.today()
        if self._sunset_last_trigger_day == today:
            return False, 0.0
        if not in_window:
            self._sunset_in_window_since = None
            return False, 0.0
        # Track entry timestamp so we can require min_duration_min before firing.
        if self._sunset_in_window_since is None:
            self._sunset_in_window_since = time.time()
            return False, 0.0
        in_window_for_min = (time.time() - self._sunset_in_window_since) / 60.0
        if in_window_for_min < float(cfg.get("min_duration_min", 12) or 12):
            return False, 0.0
        # Fire — record the day so we don't re-fire.
        self._sunset_last_trigger_day = today
        self._sunset_in_window_since = None
        cloud = d.get("cloud_cover") or 0
        sev = 0.5 + 0.5 * (1.0 - float(cloud) / 100.0)
        return True, max(0.0, min(1.0, sev))

    def _average_frame_contrast(self) -> float | None:
        """Mean per-cam contrast of the latest preview frame, normalised 0..1.
        Used as a sanity check for the fog detector."""
        import cv2
        vals = []
        for cam_id in self._enabled_cam_ids():
            rt = self.runtimes.get(cam_id)
            if rt is None:
                continue
            try:
                with rt.lock:
                    frame = rt._preview_frame
                if frame is None:
                    continue
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                vals.append(float(gray.std()) / 128.0)
            except Exception:
                continue
        if not vals:
            return None
        return sum(vals) / len(vals)

    # ── Trigger + clip writer ───────────────────────────────────────────────


"""WeatherService — public API. Lifecycle + state shared via mixins.

`from .weather_service import WeatherService` keeps working byte-for-byte.
"""
from __future__ import annotations

import threading
from collections import deque
from datetime import date

# Re-export public mappings + module helpers from _consts so external
# callers can still write `from app.weather_service import EVENT_LABEL_DE`.
from ._consts import (  # noqa: F401
    EVENT_ICON_HEX,
    EVENT_LABEL_DE,
    HISTORY_FIELDS,
    HISTORY_FIELD_TO_EVENT,
    HISTORY_LABELS_DE,
    HISTORY_MAXLEN,
    HISTORY_UNITS,
    _CooldownTracker,
    _HysteresisState,
    _atomic_write_json,
    _is_quiet_now,
    _safe_dt,
    _safe_subset,
    log,
    migrate_sun_timelapse_layout,
)
from ._clip import ClipMixin
from ._detection import DetectionMixin
from ._event_tl import EventTimelapseMixin
from ._history import HistoryMixin
from ._lifecycle import LifecycleMixin
from ._manifests import ManifestsMixin
from ._recaps import RecapsMixin
from ._sun_tl import SunTimelapseMixin


class WeatherService(
    LifecycleMixin,
    DetectionMixin,
    ClipMixin,
    ManifestsMixin,
    RecapsMixin,
    HistoryMixin,
    SunTimelapseMixin,
    EventTimelapseMixin,
):
    """Lifecycle mirror of TelegramService — start/shutdown/reload, idempotent.

    The polling job is owned by APScheduler; clip encoding runs in worker
    threads so a long ffmpeg call never starves the polling cadence.

    Methods are split across the mixins listed in the bases. __init__ stays
    here so all instance state assignments live in a single visible block.
    """

    def __init__(self, cfg: dict, runtimes: dict, settings_store, server_cfg: dict,
                 telegram_getter=None):
        self.cfg = cfg or {}
        # NEVER do `runtimes or {}` here: an empty dict is falsy, so that
        # idiom returns a fresh `{}` instead of the live reference. We need
        # the live reference so cameras added later (rebuild_runtimes adds
        # them AFTER service init) become visible to subsequent polls.
        self.runtimes = runtimes if runtimes is not None else {}
        self.settings_store = settings_store
        self.server_cfg = server_cfg or {}
        # Lambda returning the current TelegramService — passed as a getter
        # so the WeatherService doesn't pin a stale reference across a
        # telegram reload (Phase-1 reload swaps the service in place).
        self.telegram_getter = telegram_getter
        self._scheduler = None
        self._stopped = False
        self._cooldown = _CooldownTracker()
        self._hyst = _HysteresisState()
        self._sun_cache: tuple[float, dict] = (0.0, {})  # (ts_sec, data)
        # Sunset detector needs to know how long altitude has been in range
        # to enforce min_duration_min.
        self._sunset_in_window_since: float | None = None
        self._sunset_last_trigger_day: date | None = None
        self._fail_streak = 0
        # Status snapshot exposed via /api/weather/status — touched only
        # under self._lock to avoid the "current state" tearing.
        self._lock = threading.Lock()
        self._status: dict = {
            "enabled":      bool(self.cfg.get("enabled", True)),
            "last_poll_at": None,
            "last_api_ok":  None,
            "current_state": {k: False for k in EVENT_LABEL_DE},
            "current_values": {k: None for k in HISTORY_FIELDS},
            "location": {
                "lat": (self.server_cfg.get("location") or {}).get("lat"),
                "lon": (self.server_cfg.get("location") or {}).get("lon"),
            },
        }
        # History buffer for the Wetterstatistik chart. Loaded from disk on
        # startup so the chart isn't blank for ~5 minutes after every
        # restart. Survives reload() — it's diagnostic data, not config.
        self._history_lock = threading.Lock()
        self._history: deque = deque(maxlen=HISTORY_MAXLEN)
        try:
            self._load_history()
        except Exception as e:
            log.warning("[weather] history load failed (starting fresh): %s", e)

    # ── Lifecycle ───────────────────────────────────────────────────────────


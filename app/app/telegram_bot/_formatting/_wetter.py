from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — kept identical across mixins so
# methods can move between them without import bookkeeping. See
# service.py for the canonical import list.
import asyncio
import logging
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from threading import Lock, Thread

from telegram import (
    Bot,
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
)
from telegram.error import Conflict, NetworkError, TimedOut
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ...telegram_helpers import (
    DULL_BIRDS,
    LABEL_DE,
    LABEL_WEIGHT,
    OBJECT_LABELS,
    is_night,
    is_quiet_now,
    most_specific_label,
    truncate_caption,
)
from .._consts import (
    _MUTE_DEFAULT_S,
    _MUTE_EXTEND_S,
    _NOTIFY_COOLDOWN_DEFAULTS,
    _PHOTO_LIMIT_BYTES,
    _VIDEO_LIMIT_BYTES,
    ACTION_CAMS,
    ACTION_CLIP,
    ACTION_LIVE,
    ACTION_MENU,
    ACTION_MUTE,
    ACTION_STATUS,
    ANCHOR_KEY,
    BOT_COMMANDS,
    PERSISTENT_KB_KEY,
    PERSISTENT_KEYBOARD,
    _parse_hhmm,
    log,
)


class _WetterMixin:
    """⛅ Wetter tile + drilldown rendered from WeatherService.status()."""

    def _wetter_tile_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """⛅ Wetter — live snapshot from WeatherService.status() with
        threshold-aware status icons + sun position + active-event list."""
        from .. import server as _srv

        wsvc = getattr(_srv, "weather_service", None)
        now = datetime.now()
        lines = [f"⛅ <b>Wetter</b> · Stand {now.strftime('%H:%M')}", "─────────────"]
        if wsvc is None:
            lines.append("Wetter-Service nicht aktiv.")
            return (
                "\n".join(lines),
                InlineKeyboardMarkup(
                    [[InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root")]]
                ),
            )
        try:
            stat = wsvc.status() or {}
        except Exception:
            stat = {}
        try:
            hist = wsvc.history(hours=1) or {}
        except Exception:
            hist = {}
        cur = stat.get("current_values") or {}
        cur_state = stat.get("current_state") or {}
        thresholds = hist.get("thresholds") or {}
        units = hist.get("units") or {}
        # Mapping from event_type → (icon, label, value-key, unit-fallback)
        rows_def = [
            ("heavy_rain", "🌧 Regen", "precipitation", "mm/h"),
            ("thunder", "⚡ Gewitter", "lightning_potential", "J/kg"),
            ("snow", "❄ Schnee", "snowfall", "cm/h"),
            ("fog", "🌫 Sicht", "visibility", "m"),
        ]
        for evt, label, key, unit_fb in rows_def:
            v = cur.get(key)
            thr = thresholds.get(key)
            unit = units.get(key, unit_fb)
            active = bool(cur_state.get(evt))
            if v is None:
                vstr, pct, status_icon = "—", "—", "⚪"
            else:
                vstr = f"{v:.1f}" if abs(v) < 100 else f"{v:.0f}"
                if thr is None or thr <= 0:
                    pct, status_icon = "—", "⚪"
                else:
                    # Visibility uses INVERSE thresholds (active when v < thr),
                    # so the percentage is inverted vs the others.
                    if evt == "fog":
                        # below threshold → high "active-ness"
                        pct_v = max(0, min(100, int(100 * (1 - v / max(1, thr * 2))))) if thr else 0
                        ratio = 1 - min(1.0, v / max(1.0, thr))
                    else:
                        pct_v = int(100 * (v / thr))
                        ratio = v / thr
                    pct = f"{int(round(pct_v))} %"
                    if active:
                        status_icon = "🔴"
                    elif ratio >= 0.7:
                        status_icon = "🟡"
                    else:
                        status_icon = "🟢"
            if thr is None:
                thr_str = "—"
            else:
                thr_str = f"{thr:.1f}" if abs(thr) < 100 else f"{thr:.0f}"
            # Precipitation row: append the DWD intensity band so a
            # 0.1 mm/h reading reads as "Nieselregen" instead of being
            # nameless. Single source of truth in
            # weather_service.precipitation_label so the gallery + the
            # Telegram menu agree on the wording.
            band_suffix = ""
            if evt == "heavy_rain" and v is not None and float(v) > 0:
                from ...weather_service import precipitation_label as _pl

                band_suffix = f" · {_pl(v)}"
            lines.append(
                f"{label:<11s} {status_icon} {vstr} / {thr_str} {unit}  ({pct}){band_suffix}"
            )
        # Wind + sun extras (no threshold concept).
        wind = cur.get("wind_gusts_10m")
        if wind is not None:
            lines.append(f"💨 Wind     🟢 {wind:.0f} km/h")
        sun_alt = cur.get("sun_altitude")
        sun_extra = ""
        try:
            sun_times = wsvc.sun_times_today() if hasattr(wsvc, "sun_times_today") else {}
            sunset_iso = (sun_times or {}).get("sunset")
            if sunset_iso:
                sunset_dt = datetime.fromisoformat(sunset_iso)
                if sunset_dt > now:
                    delta_min = int((sunset_dt - now).total_seconds() / 60)
                    h, m = divmod(delta_min, 60)
                    sun_extra = f" · sunset in {h} h {m:02d} min" if h else f" · sunset in {m} min"
        except Exception:
            pass
        if sun_alt is not None:
            lines.append(f"☀ Sonne     {sun_alt:.0f}° hoch{sun_extra}")
        # Active events line
        from ...weather_service import EVENT_LABEL_DE

        active_evs = [EVENT_LABEL_DE.get(e, e) for e, on in cur_state.items() if on]
        lines.append("")
        lines.append("Aktive Ereignisse: " + (", ".join(active_evs) if active_evs else "keine"))
        rows = [
            [
                InlineKeyboardButton("🔄 Aktualisieren", callback_data="menu:wetter"),
                InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root"),
            ],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    # Keep the old name as an alias so the existing `menu:wetter` route
    # in _handle_menu_cb keeps resolving — phase 1 wired it up via that
    # method name. No external callers rely on the helper name itself.
    def _wetter_view(self) -> tuple[str, InlineKeyboardMarkup]:
        return self._wetter_tile_view()

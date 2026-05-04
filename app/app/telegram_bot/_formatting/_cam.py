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
    _MUTE_DEFAULT_S,
    _MUTE_EXTEND_S,
    _NOTIFY_COOLDOWN_DEFAULTS,
    _PHOTO_LIMIT_BYTES,
    _VIDEO_LIMIT_BYTES,
    _parse_hhmm,
    log,
)


class _CamMixin:
    """Per-camera drilldown views + the runtime-restart helper called
    when a button targets a fallback (runtime-not-bound) camera."""

    def _cam_drilldown_view(self, cam_id: str) -> tuple[str, InlineKeyboardMarkup]:
        """Per-cam drilldown rendered by ``menu:cams`` → cam:<id>:drilldown.

        Layout (phase-1 spec):
          📹 <name>
          🟢 scharf · 14 fps · letzter Frame vor 2 s
          Heute: 12 Events · 3,1 GB belegt
          ─────────────
          [ 🔄 Neues Live-Bild ]
          [ 🎬 5 s ] [ 🎬 15 s ] [ 🎬 30 s ]
          [ 🔇 Pause 1 h ] [ 📊 Mehr Status ]
          [ « Andere Kamera ] [ 🏠 Hauptmenü ]

        For a fallback camera (runtime not bound), the live-stats line is
        replaced by "Runtime nicht aktiv – wird gestartet …" and the
        action buttons are still emitted but the click-time handlers
        attempt a runtime restart (existing _try_restart_runtime path)."""
        info = next((c for c in self._active_cams() if c["cam_id"] == cam_id), None)
        if info is None:
            return ("Kamera nicht gefunden.",
                    InlineKeyboardMarkup([[InlineKeyboardButton("« Andere Kamera",
                                                                 callback_data="menu:cams"),
                                            InlineKeyboardButton("🏠 Hauptmenü",
                                                                 callback_data="menu:root")]]))
        body = "\n".join(["📹 " + line if i == 0 else line
                          for i, line in enumerate(self._render_camera_block(info))])
        rows = [
            [InlineKeyboardButton("🔄 Neues Live-Bild",
                                  callback_data=f"cam:{cam_id}:livebild"[:64])],
            [InlineKeyboardButton("🎬 5 s",  callback_data=f"cam:{cam_id}:clip:5"[:64]),
             InlineKeyboardButton("🎬 15 s", callback_data=f"cam:{cam_id}:clip:15"[:64]),
             InlineKeyboardButton("🎬 30 s", callback_data=f"cam:{cam_id}:clip:30"[:64])],
            [InlineKeyboardButton("🔇 Pause 1 h",  callback_data=f"cam:{cam_id}:mute1h"[:64]),
             InlineKeyboardButton("📊 Mehr Status", callback_data=f"cam:{cam_id}:status"[:64])],
            [InlineKeyboardButton("« Andere Kamera", callback_data="menu:cams"),
             InlineKeyboardButton("🏠 Hauptmenü",     callback_data="menu:root")],
        ]
        return body, InlineKeyboardMarkup(rows)

    def _cam_deep_view(self, cam_id: str) -> tuple[str, InlineKeyboardMarkup]:
        """📊 Mehr Status — per-cam deep view: cam header + today's
        detections (filtered to this cam) + cam-only storage breakdown +
        applicable health rows."""
        from html import escape as _esc
        info = next((c for c in self._active_cams() if c["cam_id"] == cam_id), None)
        if info is None:
            return ("Kamera nicht gefunden.",
                    InlineKeyboardMarkup([[
                        InlineKeyboardButton("« Zurück", callback_data="menu:cams"),
                        InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root"),
                    ]]))
        # Header (reuse the cam block formatter from phase-1).
        lines = list(self._render_camera_block(info))
        lines.insert(0, "📊 <b>Status</b>")
        lines.append("─────────────")
        # Today's events for this cam — first 6 entries.
        today_iso = datetime.now().strftime("%Y-%m-%d")
        try:
            evs = self.store.list_events(cam_id, start=today_iso, limit=20) if self.store else []
        except Exception:
            evs = []
        evs.sort(key=lambda e: e.get("time", ""), reverse=True)
        if evs:
            lines.append("Letzte Erkennungen heute:")
            for ev in evs[:6]:
                hm = (ev.get("time") or "")[11:16]
                lines.append(f"  <code>{hm}</code> {self._event_icon(ev)} {_esc(self._event_primary_label(ev) or '?')}")
            if len(evs) > 6:
                lines.append(f"  … +{len(evs) - 6} weitere heute")
        else:
            lines.append("Heute noch keine Erkennungen.")
        lines.append("")
        # Per-cam storage breakdown
        root = self._storage_root()
        parts = []
        row_total = 0
        for sub_label, sub in [("Events", "motion_detection"),
                                ("TL", "timelapse"),
                                ("Frames", "timelapse_frames")]:
            p = root / sub / cam_id
            bs = 0
            if p.exists():
                try:
                    for f in p.rglob("*"):
                        if f.is_file():
                            try:
                                bs += f.stat().st_size
                            except OSError:
                                pass
                except Exception:
                    pass
            row_total += bs
            parts.append(f"{sub_label} {self._fmt_bytes(bs)}")
        lines.append(f"Speicher: {self._fmt_bytes(row_total)}  ({' · '.join(parts)})")
        # Health rows (per-cam subset)
        st = info.get("status") or {}
        n24 = st.get("reconnect_count_24h")
        if isinstance(n24, int):
            lines.append("")
            if n24 > 3:
                lines.append(f"⚠️ {n24} Reconnects letzte 24 h")
            else:
                lines.append(f"✅ {n24} Reconnects letzte 24 h")
        infer = st.get("inference_avg_ms")
        if isinstance(infer, (int, float)) and infer > 0:
            lines.append(f"✅ Coral · {infer:.0f} ms ø")

        rows = [
            [InlineKeyboardButton("🔄 Aktualisieren",
                                   callback_data=f"cam:{cam_id}:status"[:64])],
            [InlineKeyboardButton("« Zurück zur Kamera",
                                   callback_data=f"cam:{cam_id}:drilldown"[:64]),
             InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root")],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _try_restart_runtime(self, cam_id: str) -> bool:
        """Lazy-import + invoke ``server.restart_single_camera`` so a cam
        whose runtime fell out of self.runtimes can recover without the
        user having to leave the chat. Returns True iff the runtime is
        live afterwards."""
        try:
            from .. import server as _srv
            _srv.restart_single_camera(cam_id)
        except Exception as e:
            log.warning("[tg] restart_single_camera(%s) failed: %s", cam_id, e)
            return False
        return cam_id in (self.runtimes or {})

    def _other_cam_nav_row(self, current_cam_id: str, action: str) -> list:
        """Build a one-tap navigation row pointing at every OTHER camera.

        ``action`` is the verb appended after ``cam:<id>:`` — currently
        ``"livebild"`` for snapshots and ``"clip:5"`` for ad-hoc clips.

        - 0 other cams → empty list (caller skips the row entirely).
        - 1–3 other cams → one button per cam, status-icon + short name.
          Names get truncated to the first word if Telegram's 64-byte
          callback_data ceiling threatens to clip the cam id.
        - 4+ other cams → a single "🔁 Andere Kamera" button that re-opens
          the existing /menu cam picker (which routes through
          ``menu:livebild`` / ``menu:clip``)."""
        others: list[tuple[str, dict]] = []
        for other_id, rt in (self.runtimes or {}).items():
            if other_id == current_cam_id:
                continue
            try:
                st = rt.status() if hasattr(rt, "status") else {}
            except Exception:
                st = {}
            others.append((other_id, st))
        if not others:
            return []
        if len(others) >= 4:
            menu_target = "menu:livebild" if action == "livebild" else "menu:clip"
            return [InlineKeyboardButton("🔁 Andere Kamera", callback_data=menu_target)]
        row = []
        for other_id, st in others:
            icon = self._cam_status_icon(st)
            name = st.get("name") or other_id
            short = name.split()[0] if name else other_id
            label = f"{icon} {short}"[:24]  # Telegram visible label is fine; cap defensively
            cb = f"cam:{other_id}:{action}"[:64]
            row.append(InlineKeyboardButton(label, callback_data=cb))
        return row

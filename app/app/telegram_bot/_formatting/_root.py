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


class _RootMixin:
    """Top-level menu bubble + cam/clip-duration pickers + Zeitraffer,
    Statistik and Logs drilldowns reachable from the root view."""

    def _root_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """Anchor's root view. Compact menu header; per-camera detail lives
        in 📊 Statistik (events) and 📹 Kameras / 🛠 System (status). The
        entry point reads as a menu of actions, not a briefing."""
        hh = datetime.now().strftime("%H:%M")
        lines = [f"🏠 <b>Menü</b> · {hh}"]
        # Optional one-line aggregate, only shown when it stays compact.
        cams = self._active_cams()
        n_cams = len(cams)
        if n_cams and self.store:
            today_iso = datetime.now().strftime("%Y-%m-%d")
            total = 0
            for info in cams:
                try:
                    total += len(
                        self.store.list_events(info["cam_id"], start=today_iso, limit=5000)
                    )
                except Exception:
                    pass
            kam = "Kamera" if n_cams == 1 else "Kameras"
            summary = f"{n_cams} {kam} · {total} Events heute"
            if len(summary) <= 40:
                lines.append(summary)
        elif not n_cams:
            lines.append("(keine Kameras konfiguriert)")
        # Mute toggle button: "off" → "Alles still 1 h"; on → "Stumm bis HH:MM".
        mute_until = 0.0
        if self.settings_store:
            try:
                mute_until = float(self.settings_store.runtime_get("global_mute_until") or 0)
            except Exception:
                mute_until = 0.0
        if mute_until and time.time() < mute_until:
            mute_label = (
                f"🔊 Stumm bis "
                f"{datetime.fromtimestamp(mute_until).strftime('%H:%M')} — wieder anschalten"
            )
            mute_cb = "mute:end"
        else:
            mute_label = "🔇 Alles still 1 h"
            mute_cb = "menu:muteall"
        rows = [
            [
                InlineKeyboardButton("📷 Live-Bild", callback_data="menu:livebild"),
                InlineKeyboardButton("🎬 Clip", callback_data="menu:clip"),
            ],
            [
                InlineKeyboardButton("📋 Erkennungen", callback_data="menu:erkennungen"),
                InlineKeyboardButton("📊 Statistik", callback_data="menu:stats"),
            ],
            [
                InlineKeyboardButton("🐦 Tier-Log", callback_data="menu:tierlog"),
                InlineKeyboardButton("⛅ Wetter", callback_data="menu:wetter"),
            ],
            [
                InlineKeyboardButton("📹 Kameras", callback_data="menu:cams"),
                InlineKeyboardButton("🛠 System", callback_data="menu:system"),
            ],
            [InlineKeyboardButton(mute_label, callback_data=mute_cb)],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _cam_picker(self, action: str) -> tuple[str, InlineKeyboardMarkup]:
        """One button per camera; clicking emits cam:<id>:<action>.

        Pulls from ``_active_cams()`` so cameras with a missing/failed
        runtime still appear (with a yellow icon) and the user can drill
        into them rather than seeing "(keine Kameras)" while a perfectly
        configured camera is just slow to start."""
        rows = []
        for info in self._active_cams():
            icon = self._cam_status_icon_for(info)
            rows.append(
                [
                    InlineKeyboardButton(
                        f"{icon} {info['name']}",
                        callback_data=f"cam:{info['cam_id']}:{action}"[:64],
                    )
                ]
            )
        if not rows:
            rows.append([InlineKeyboardButton("(keine Kameras)", callback_data="noop")])
        rows.append([self._back_btn()])
        return f"Kamera wählen — {action}", InlineKeyboardMarkup(rows)

    def _clip_dur_picker(self, cam_id: str) -> tuple[str, InlineKeyboardMarkup]:
        rt = self.runtimes.get(cam_id)
        name = rt.status().get("name", cam_id) if rt else cam_id
        rows = [
            [
                InlineKeyboardButton("5 s", callback_data=f"cam:{cam_id}:clip:5"),
                InlineKeyboardButton("15 s", callback_data=f"cam:{cam_id}:clip:15"),
                InlineKeyboardButton("30 s", callback_data=f"cam:{cam_id}:clip:30"),
            ],
            [self._back_btn("menu:clip")],
        ]
        return f"🎬 Clip-Dauer für <b>{name}</b>", InlineKeyboardMarkup(rows)

    def _list_recent_timelapses(self, limit: int = 5) -> list[dict]:
        """Newest mp4s under storage/timelapse/<cam>/, sorted by mtime desc."""
        root = self._storage_root() / "timelapse"
        if not root.exists():
            return []
        items = []
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir():
                continue
            for mp4 in cam_dir.glob("*.mp4"):
                try:
                    st = mp4.stat()
                except Exception:
                    continue
                meta = {}
                meta_path = mp4.with_suffix(".json")
                if meta_path.exists():
                    try:
                        import json as _j

                        meta = _j.loads(meta_path.read_text(encoding="utf-8"))
                    except Exception:
                        pass
                items.append(
                    {
                        "cam_id": cam_dir.name,
                        "filename": mp4.name,
                        "relpath": f"timelapse/{cam_dir.name}/{mp4.name}",
                        "size_mb": round(st.st_size / 1024 / 1024, 1),
                        "mtime": st.st_mtime,
                        "profile": meta.get("profile", ""),
                        "target_s": int(meta.get("target_s", 0) or 0),
                    }
                )
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items[:limit]

    def _zeitraffer_view(self) -> tuple[str, InlineKeyboardMarkup]:
        items = self._list_recent_timelapses(limit=5)
        if not items:
            return "⏱ <b>Keine Zeitraffer vorhanden.</b>", InlineKeyboardMarkup(
                [[self._back_btn()]]
            )
        cam_name_map = {c["id"]: c.get("name", c["id"]) for c in self._cfg().get("cameras", [])}
        profile_de = {"daily": "Tag", "weekly": "Woche", "monthly": "Monat", "custom": "Custom"}
        lines = ["⏱ <b>Verfügbare Zeitraffer</b>", ""]
        rows = []
        for it in items:
            cam = cam_name_map.get(it["cam_id"], it["cam_id"])
            prof = profile_de.get(it["profile"], it["profile"] or "Tag")
            date_label = datetime.fromtimestamp(it["mtime"]).strftime("%d.%m.")
            lines.append(
                f"• <b>{cam}</b> · {prof} · {date_label}  ({it['target_s']}s, {it['size_mb']} MB)"
            )
            rows.append(
                [
                    InlineKeyboardButton(
                        f"📥 {cam} · {date_label}",
                        callback_data=f"tl:send:{it['cam_id']}/{it['filename']}"[:64],
                    )
                ]
            )
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _stats_view(self, days: int) -> tuple[str, InlineKeyboardMarkup]:
        period = "Heute" if days == 1 else ("Diese Woche" if days == 7 else "Diesen Monat")
        summary = self.store.aggregate_summary(days=days) if self.store else {"total_events": 0}
        total = summary.get("total_events", 0)
        # Bucket counts from top_objects (label, count) tuples
        per_label = dict(summary.get("top_objects", []) or [])
        WILD = {"squirrel", "fox", "hedgehog", "bird", "cat", "dog"}
        wild_count = sum(per_label.get(l, 0) for l in WILD)
        # "Falsch" = events the user marked wrong via Telegram callbacks.
        feedback = (
            self.settings_store.runtime_get("event_feedback") if self.settings_store else {}
        ) or {}
        cutoff_ts = (datetime.now() - timedelta(days=days)).timestamp()
        wrong = 0
        for v in feedback.values():
            try:
                if v.get("verdict") == "no" and float(v.get("ts", 0)) >= cutoff_ts:
                    wrong += 1
            except Exception:
                pass
        lines = [
            f"📊 <b>Statistik · {period}</b>",
            "",
            f"Events gesamt: <b>{total}</b>",
            f"Person: <b>{per_label.get('person', 0)}</b> · "
            f"Wildtier: <b>{wild_count}</b> · "
            f"Falsch: <b>{wrong}</b>",
        ]
        if summary.get("per_camera"):
            lines.append("")
            for cam, cnt in summary["per_camera"].items():
                lines.append(f"• {cam}: {cnt}")
        rows = [
            [
                InlineKeyboardButton(
                    "📅 Heute" if days != 1 else "—",
                    callback_data="menu:stats" if days != 1 else "noop",
                ),
                InlineKeyboardButton(
                    "📅 Diese Woche" if days != 7 else "—",
                    callback_data="menu:stats:week" if days != 7 else "noop",
                ),
                InlineKeyboardButton(
                    "📅 Diesen Monat" if days != 30 else "—",
                    callback_data="menu:stats:month" if days != 30 else "noop",
                ),
            ],
        ]
        base = self._dashboard_url().rstrip("/") if self._dashboard_url() else ""
        if base:
            rows.append([InlineKeyboardButton("🌐 Im Web ↗", url=f"{base}/#statistik")])
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _logs_view(self) -> tuple[str, InlineKeyboardMarkup]:
        # Last 10 WARNING/ERROR lines from the in-memory log buffer in server.py.
        try:
            from .. import server as _srv

            recs = [r for r in _srv.log_buffer.get(0) if r.get("level") in ("WARNING", "ERROR")][
                -10:
            ]
        except Exception:
            recs = []
        if not recs:
            body = "Keine Warnungen / Fehler in der jüngeren Historie."
        else:
            lines = []
            for r in recs:
                msg = (r.get("msg") or "").replace("<", "&lt;").replace(">", "&gt;")
                lines.append(f"<code>{r.get('ts','')}</code> [{r.get('level','')}] {msg[:140]}")
            body = "\n".join(lines)
        return f"📋 <b>Letzte Warnungen / Fehler</b>\n\n{body}", InlineKeyboardMarkup(
            [[self._back_btn()]]
        )

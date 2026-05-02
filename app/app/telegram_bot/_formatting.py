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

from ..telegram_helpers import (
    DULL_BIRDS,
    LABEL_DE,
    LABEL_WEIGHT,
    OBJECT_LABELS,
    is_night,
    is_quiet_now,
    most_specific_label,
    truncate_caption,
)
from ._consts import (
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


class FormattingMixin:
    """Inline-keyboard view builders, render-text helpers, anchor message management.

    Mixin for TelegramService. Methods access shared state via `self.*`
    (cfg, bot, store, runtimes, scheduler, etc.) which live on the
    concrete class.
    """

    @staticmethod
    def _back_btn(target: str = "menu:root") -> InlineKeyboardButton:
        return InlineKeyboardButton("« Zurück", callback_data=target)

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
                    total += len(self.store.list_events(
                        info["cam_id"], start=today_iso, limit=5000))
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
            mute_label = (f"🔊 Stumm bis "
                          f"{datetime.fromtimestamp(mute_until).strftime('%H:%M')} — wieder anschalten")
            mute_cb = "mute:end"
        else:
            mute_label = "🔇 Alles still 1 h"
            mute_cb = "menu:muteall"
        rows = [
            [InlineKeyboardButton("📷 Live-Bild",  callback_data="menu:livebild"),
             InlineKeyboardButton("🎬 Clip",        callback_data="menu:clip")],
            [InlineKeyboardButton("📋 Erkennungen", callback_data="menu:erkennungen"),
             InlineKeyboardButton("📊 Statistik",   callback_data="menu:stats")],
            [InlineKeyboardButton("🐦 Tier-Log",    callback_data="menu:tierlog"),
             InlineKeyboardButton("⛅ Wetter",       callback_data="menu:wetter")],
            [InlineKeyboardButton("📹 Kameras",     callback_data="menu:cams"),
             InlineKeyboardButton("🛠 System",       callback_data="menu:system")],
            [InlineKeyboardButton(mute_label,       callback_data=mute_cb)],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _cam_status_icon(self, st: dict) -> str:
        s = st.get("status", "")
        if s == "active":
            return "🟢"
        if s == "starting":
            return "🟡"
        return "🔴"

    def _cam_picker(self, action: str) -> tuple[str, InlineKeyboardMarkup]:
        """One button per camera; clicking emits cam:<id>:<action>.

        Pulls from ``_active_cams()`` so cameras with a missing/failed
        runtime still appear (with a yellow icon) and the user can drill
        into them rather than seeing "(keine Kameras)" while a perfectly
        configured camera is just slow to start."""
        rows = []
        for info in self._active_cams():
            icon = self._cam_status_icon_for(info)
            rows.append([InlineKeyboardButton(
                f"{icon} {info['name']}",
                callback_data=f"cam:{info['cam_id']}:{action}"[:64],
            )])
        if not rows:
            rows.append([InlineKeyboardButton("(keine Kameras)", callback_data="noop")])
        rows.append([self._back_btn()])
        return f"Kamera wählen — {action}", InlineKeyboardMarkup(rows)

    def _clip_dur_picker(self, cam_id: str) -> tuple[str, InlineKeyboardMarkup]:
        rt = self.runtimes.get(cam_id)
        name = rt.status().get("name", cam_id) if rt else cam_id
        rows = [
            [InlineKeyboardButton("5 s",  callback_data=f"cam:{cam_id}:clip:5"),
             InlineKeyboardButton("15 s", callback_data=f"cam:{cam_id}:clip:15"),
             InlineKeyboardButton("30 s", callback_data=f"cam:{cam_id}:clip:30")],
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
                items.append({
                    "cam_id":   cam_dir.name,
                    "filename": mp4.name,
                    "relpath":  f"timelapse/{cam_dir.name}/{mp4.name}",
                    "size_mb":  round(st.st_size / 1024 / 1024, 1),
                    "mtime":    st.st_mtime,
                    "profile":  meta.get("profile", ""),
                    "target_s": int(meta.get("target_s", 0) or 0),
                })
        items.sort(key=lambda x: x["mtime"], reverse=True)
        return items[:limit]

    def _zeitraffer_view(self) -> tuple[str, InlineKeyboardMarkup]:
        items = self._list_recent_timelapses(limit=5)
        if not items:
            return "⏱ <b>Keine Zeitraffer vorhanden.</b>", InlineKeyboardMarkup([[self._back_btn()]])
        cam_name_map = {c["id"]: c.get("name", c["id"]) for c in self._cfg().get("cameras", [])}
        profile_de = {"daily": "Tag", "weekly": "Woche", "monthly": "Monat", "custom": "Custom"}
        lines = ["⏱ <b>Verfügbare Zeitraffer</b>", ""]
        rows = []
        for it in items:
            cam = cam_name_map.get(it["cam_id"], it["cam_id"])
            prof = profile_de.get(it["profile"], it["profile"] or "Tag")
            date_label = datetime.fromtimestamp(it["mtime"]).strftime("%d.%m.")
            lines.append(f"• <b>{cam}</b> · {prof} · {date_label}  ({it['target_s']}s, {it['size_mb']} MB)")
            rows.append([InlineKeyboardButton(
                f"📥 {cam} · {date_label}",
                callback_data=f"tl:send:{it['cam_id']}/{it['filename']}"[:64],
            )])
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    # _erkennungen_view replaced by the phase-2 tile implementation
    # below; the old "Letzte Erkennungen" feedback list (24-h window
    # with ev:<eid>:ok / no buttons) was removed because the new tile
    # spec asks for a today-only filterable log. Per-event feedback
    # callbacks (ev:*) are still reachable from the original alert
    # bubbles in chat — only the menu route changed.

    def _stats_view(self, days: int) -> tuple[str, InlineKeyboardMarkup]:
        period = "Heute" if days == 1 else ("Diese Woche" if days == 7 else "Diesen Monat")
        summary = self.store.aggregate_summary(days=days) if self.store else {"total_events": 0}
        total = summary.get("total_events", 0)
        # Bucket counts from top_objects (label, count) tuples
        per_label = dict(summary.get("top_objects", []) or [])
        WILD = {"squirrel", "fox", "hedgehog", "bird", "cat", "dog"}
        wild_count = sum(per_label.get(l, 0) for l in WILD)
        # "Falsch" = events the user marked wrong via Telegram callbacks.
        feedback = (self.settings_store.runtime_get("event_feedback") if self.settings_store else {}) or {}
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
            [InlineKeyboardButton("📅 Heute" if days != 1 else "—", callback_data="menu:stats" if days != 1 else "noop"),
             InlineKeyboardButton("📅 Diese Woche" if days != 7 else "—", callback_data="menu:stats:week" if days != 7 else "noop"),
             InlineKeyboardButton("📅 Diesen Monat" if days != 30 else "—", callback_data="menu:stats:month" if days != 30 else "noop")],
        ]
        base = self._dashboard_url().rstrip("/") if self._dashboard_url() else ""
        if base:
            rows.append([InlineKeyboardButton("🌐 Im Web ↗", url=f"{base}/#statistik")])
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _status_view(self) -> tuple[str, InlineKeyboardMarkup]:
        lines = ["🛠 <b>Kamera-Status</b>", ""]
        rows = []
        cam_cfgs = {c["id"]: c for c in self._cfg().get("cameras", [])}
        today_iso = datetime.now().strftime("%Y-%m-%d")
        for cam_id, rt in self.runtimes.items():
            try:
                st = rt.status()
            except Exception:
                st = {}
            icon = self._cam_status_icon(st)
            name = st.get("name", cam_id)
            armed = bool((cam_cfgs.get(cam_id) or {}).get("armed", st.get("armed", True)))
            arm_label = "scharf" if armed else "stumm"
            extra = ""
            if st.get("status") not in ("active", "starting"):
                fa = st.get("frame_age_s")
                if isinstance(fa, (int, float)) and fa > 0:
                    extra = f" · offline {int(fa // 60)} min"
                else:
                    extra = " · offline"
            n_today = "?"
            if self.store:
                try:
                    n_today = len(self.store.list_events(
                        cam_id, start=today_iso, limit=5000))
                except Exception:
                    n_today = "?"
            lines.append(
                f"{icon} <b>{name}</b> · {arm_label}{extra} · {n_today} Events heute")
            rows.append([
                InlineKeyboardButton(("🔇 Stumm" if armed else "🛡 Scharf") + f" {name[:10]}", callback_data=f"cam:{cam_id}:arm"),
                InlineKeyboardButton("🔄 Reconnect", callback_data=f"cam:{cam_id}:reconnect"),
            ])
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _logs_view(self) -> tuple[str, InlineKeyboardMarkup]:
        # Last 10 WARNING/ERROR lines from the in-memory log buffer in server.py.
        try:
            from . import server as _srv
            recs = [r for r in _srv.log_buffer.get(0)
                    if r.get("level") in ("WARNING", "ERROR")][-10:]
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
        return f"📋 <b>Letzte Warnungen / Fehler</b>\n\n{body}", InlineKeyboardMarkup([[self._back_btn()]])

    async def _render_view(self, q, view: tuple[str, InlineKeyboardMarkup]):
        text, markup = view
        try:
            await q.edit_message_text(text, reply_markup=markup, parse_mode="HTML")
        except Exception as e:
            log.debug("[tg] edit failed (%s); sending new message", e)
            await q.message.reply_text(text, reply_markup=markup, parse_mode="HTML")

    # ── Anchor message lifecycle ──────────────────────────────────────────
    # The bot keeps a single "anchor" message per chat — the root menu
    # bubble. Every navigation step is an edit_message_text on that
    # bubble; the chat history only grows for actual deliverables
    # (snapshot, clip, mute confirm). The (chat_id, message_id) survives
    # bot restarts because it's persisted in settings.runtime.
    def _get_anchor(self) -> tuple[int, int] | None:
        if not self.settings_store:
            return None
        try:
            data = self.settings_store.runtime_get(ANCHOR_KEY)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        cid = data.get("chat_id")
        mid = data.get("message_id")
        try:
            return (int(cid), int(mid)) if cid and mid else None
        except (TypeError, ValueError):
            return None

    def _save_anchor(self, chat_id: int, message_id: int):
        if not self.settings_store:
            return
        try:
            self.settings_store.runtime_set(ANCHOR_KEY,
                                            {"chat_id": int(chat_id),
                                             "message_id": int(message_id)})
        except Exception as e:
            log.warning("[tg] anchor save failed: %s", e)

    def _drop_anchor(self):
        if not self.settings_store:
            return
        try:
            self.settings_store.runtime_set(ANCHOR_KEY, {})
        except Exception:
            pass

    async def _ensure_persistent_kb(self, bot, chat_id: int):
        """Attach the persistent reply keyboard to this chat exactly once.

        A Telegram message can carry only one reply_markup at a time —
        either ReplyKeyboardMarkup (the under-the-input pad) or
        InlineKeyboardMarkup (the in-bubble buttons). The previous
        implementation sent the anchor with the reply keyboard and then
        round-tripped an edit_message_reply_markup to swap in inline
        buttons; if the edit failed, the user got a button-less bubble.

        We side-step that race by sending the reply keyboard once in a
        tiny standalone message, recording the chat_id, and from then on
        sending menu bubbles with inline markup directly — guaranteed to
        arrive with buttons attached on the first API call."""
        if not self.settings_store:
            return False
        already = self.settings_store.runtime_get_subkey(
            PERSISTENT_KB_KEY, str(chat_id))
        if already:
            return True
        try:
            await bot.send_message(
                chat_id=chat_id, text="🏠",
                reply_markup=PERSISTENT_KEYBOARD,
            )
            self.settings_store.runtime_set_subkey(
                PERSISTENT_KB_KEY, str(chat_id), True)
            return True
        except Exception as e:
            log.warning("[tg] persistent-kb attach failed for chat=%s: %s",
                        chat_id, e)
            return False

    async def _anchor_send_or_edit(self, bot, chat_id: int,
                                   view: tuple[str, InlineKeyboardMarkup]):
        """Edit the persisted anchor in chat_id; on failure (anchor
        deleted, expired, or owned by a different chat) send a fresh one
        and persist its id.

        Fresh-send path is a single send_message with inline_markup —
        buttons attach atomically with the bubble, no edit round-trip
        and no silent failure mode that yields a button-less menu. The
        persistent reply keyboard is attached separately and idempotently
        via _ensure_persistent_kb (one-shot per chat).

        Logs the stale-anchor transition once at INFO so a steady stream
        of churn is easy to spot in the log tail."""
        text, inline_markup = view
        anchor = self._get_anchor()
        if anchor and anchor[0] == int(chat_id):
            try:
                await bot.edit_message_text(
                    chat_id=chat_id, message_id=anchor[1],
                    text=text, reply_markup=inline_markup, parse_mode="HTML",
                )
                return anchor[1]
            except Exception as e:
                log.info("[tg] anchor stale for chat=%s (%s) — sending fresh",
                         chat_id, e)
                self._drop_anchor()
        kb_ready = await self._ensure_persistent_kb(bot, chat_id)
        if kb_ready or self.settings_store:
            msg = await bot.send_message(
                chat_id=chat_id, text=text, parse_mode="HTML",
                reply_markup=inline_markup,
            )
        else:
            # No settings_store → can't track the per-chat flag. Best we
            # can do is the legacy two-call path so the user still gets
            # the persistent keyboard. This branch is theoretical in
            # production (settings_store is always wired up).
            msg = await bot.send_message(
                chat_id=chat_id, text=text, parse_mode="HTML",
                reply_markup=PERSISTENT_KEYBOARD,
            )
            try:
                await bot.edit_message_reply_markup(
                    chat_id=chat_id, message_id=msg.message_id,
                    reply_markup=inline_markup,
                )
            except Exception as e:
                log.warning("[tg] anchor inline-kb attach failed: %s", e)
        self._save_anchor(chat_id, msg.message_id)
        return msg.message_id

    def _active_cams(self) -> list[dict]:
        """Single source of truth for "which cameras can the user act on".

        Returns a list of info dicts (one per cam):

            cam_id        camera id
            name          display name
            source        "runtime" — backed by a live CameraRuntime
                          "settings" — fallback, no runtime in self.runtimes
            runtime       the rt object (None for fallback)
            cfg           the cam dict from settings (None when source="runtime")
            status_kind   "active" | "starting" | "error" | "fallback"
            status        the rt.status() dict (empty for fallback)

        Fallback rule: when an enabled camera has no live runtime (recent
        boot crash, restart in progress, …), it still appears in this list
        so the Telegram bot can show it with a yellow icon instead of
        replying "Keine Kameras konfiguriert" — which historically led
        users to think the camera was lost when really the runtime just
        failed to construct."""
        out: list[dict] = []
        seen: set[str] = set()
        for cam_id, rt in (self.runtimes or {}).items():
            try:
                st = rt.status() if hasattr(rt, "status") else {}
            except Exception:
                st = {}
            kind = st.get("status") or "starting"
            out.append({
                "cam_id":      cam_id,
                "name":        st.get("name") or cam_id,
                "source":      "runtime",
                "runtime":     rt,
                "cfg":         None,
                "status_kind": kind,
                "status":      st,
            })
            seen.add(cam_id)
        for cam_cfg in (self._cfg().get("cameras", []) or []):
            cid = cam_cfg.get("id")
            if not cid or cid in seen:
                continue
            if not cam_cfg.get("enabled", True):
                continue
            out.append({
                "cam_id":      cid,
                "name":        cam_cfg.get("name") or cid,
                "source":      "settings",
                "runtime":     None,
                "cfg":         cam_cfg,
                "status_kind": "fallback",
                "status":      {},
            })
        return out

    def _cam_status_icon_for(self, info: dict) -> str:
        """🟢 active · 🟡 starting/fallback · 🔴 error. Used by the picker
        and the per-cam status block."""
        kind = info.get("status_kind") or "starting"
        if kind == "active":
            return "🟢"
        if kind == "error":
            return "🔴"
        return "🟡"  # starting, fallback, or anything else unknown

    # Per-cam disk usage cache. Walking three sub-trees per call is too
    # expensive to do on every /status tap, so we cache for 60 s. Cleared
    # automatically because the dict is bound to the TelegramService
    # instance — restart_telegram_service() builds a fresh instance and
    # the cache starts empty again.
    _DISK_CACHE_TTL_S = 60.0

    def _cam_disk_usage_bytes(self, cam_id: str) -> int:
        cache = getattr(self, "_disk_cache", None)
        if cache is None:
            cache = {}
            self._disk_cache = cache
        ent = cache.get(cam_id)
        now = time.time()
        if ent and (now - ent[0]) < self._DISK_CACHE_TTL_S:
            return int(ent[1])
        root = self._storage_root()
        total = 0
        for sub in ("motion_detection", "timelapse", "timelapse_frames"):
            p = root / sub / cam_id
            if not p.exists():
                continue
            try:
                for f in p.rglob("*"):
                    if f.is_file():
                        try:
                            total += f.stat().st_size
                        except OSError:
                            pass
            except Exception:
                pass
        cache[cam_id] = (now, total)
        return total

    @staticmethod
    def _fmt_bytes(n: int) -> str:
        if n is None:
            return "—"
        n = int(n)
        if n >= 1024 ** 3:
            return f"{n / 1024 ** 3:.1f} GB"
        if n >= 1024 ** 2:
            return f"{n / 1024 ** 2:.0f} MB"
        if n >= 1024:
            return f"{n / 1024:.0f} KB"
        return f"{n} B"

    def _render_camera_block(self, info: dict) -> list[str]:
        """Render the per-cam multi-line block used by both the global
        /status bubble and the per-cam drilldown. Returns a list of
        already-formatted lines so the caller controls separators."""
        from html import escape as _esc
        today_iso = datetime.now().strftime("%Y-%m-%d")
        cam_id = info["cam_id"]
        name = _esc(info["name"])
        icon = self._cam_status_icon_for(info)
        st = info.get("status") or {}
        cam_cfg = info.get("cfg") or self._camera_cfg(cam_id) or {}
        armed = bool(cam_cfg.get("armed", st.get("armed", True)))
        arm_label = "scharf" if armed else "stumm"
        out = [f"{icon} <b>{name}</b>  · {arm_label}"]
        if info["source"] == "runtime" and st:
            kind = info.get("status_kind") or "starting"
            fps = st.get("preview_fps")
            age = st.get("frame_age_s")
            if kind == "active":
                rtsp_label = "stabil"
            elif kind == "starting":
                rtsp_label = "verbindet"
            else:
                rtsp_label = "getrennt"
            fps_str = f"{fps:.0f} fps" if isinstance(fps, (int, float)) and fps > 0 else "—"
            age_str = (f"letzter Frame vor {int(age)} s"
                       if isinstance(age, (int, float)) and age >= 0 else "kein Frame")
            out.append(f"   RTSP: {rtsp_label} · {fps_str} · {age_str}")
        else:
            out.append("   Runtime nicht aktiv — wird gestartet …")
        # Per-cam disk usage (cached) + today event count
        n_today = "?"
        if self.store:
            try:
                n_today = len(self.store.list_events(cam_id, start=today_iso, limit=5000))
            except Exception:
                n_today = "?"
        try:
            disk = self._fmt_bytes(self._cam_disk_usage_bytes(cam_id))
        except Exception:
            disk = "—"
        out.append(f"   Heute: {n_today} Events · {disk} belegt")
        # Per-cam mute hint
        cam_mute = 0.0
        if self.settings_store:
            try:
                cam_mute = float(self.settings_store.runtime_get_subkey(
                    "cam_mute_until", cam_id, 0) or 0)
            except Exception:
                cam_mute = 0.0
        if cam_mute and time.time() < cam_mute:
            end_local = datetime.fromtimestamp(cam_mute).strftime("%H:%M")
            out.append(f"   🔇 stumm bis {end_local}")
        return out

    def _render_system_status_text(self) -> str:
        """Build the /status bubble. Defensive — any single source
        missing falls back to a question mark instead of crashing the
        whole render. Layout (from spec):

            📊 System-Status
            ━━━━━━━━━━━
            <per-cam block>     <— from _render_camera_block
            <per-cam block>
            ────
            Telegram   …
            Coral      …
            Wetter     …
            ────
            Speicher: free + sum of cam-belegt
            🔇 Pushes pausiert bis HH:MM   (only when muted)
        """
        import shutil as _sh
        cfg = self._cfg()
        lines = ["📊 <b>System-Status</b>", "━━━━━━━━━━━━━━", ""]
        cams_info = self._active_cams()
        cam_disk_total = 0
        for info in cams_info:
            try:
                lines.extend(self._render_camera_block(info))
                lines.append("")
            except Exception as e:
                log.warning("[tg] cam block render failed for %s: %s",
                            info.get("cam_id"), e)
                continue
            try:
                cam_disk_total += self._cam_disk_usage_bytes(info["cam_id"])
            except Exception:
                pass
        if not cams_info:
            lines.append("(keine Kameras konfiguriert)")
            lines.append("")
        lines.append("────")
        # Telegram polling
        try:
            ps = self.get_polling_status() if hasattr(self, "get_polling_status") else {}
        except Exception:
            ps = {}
        ps_state = ps.get("state", "?")
        ps_icon = {"active": "🟢", "conflict": "🟡",
                   "starting": "🟡", "off": "⚪"}.get(ps_state, "⚪")
        ps_dur_min = (ps.get("since_seconds", 0) or 0) // 60
        lines.append(f"Telegram   {ps_icon} Polling {ps_dur_min} min")
        # Coral state + rolling-average inference latency from any active cam
        det_mode = (cfg.get("processing", {}).get("detection") or {}).get("mode", "none")
        coral_icon = "🟢" if det_mode == "coral" else "⚪"
        avg_inferences = []
        for info in cams_info:
            v = (info.get("status") or {}).get("inference_avg_ms")
            if isinstance(v, (int, float)) and v > 0:
                avg_inferences.append(v)
        infer_str = (f" · {sum(avg_inferences)/len(avg_inferences):.0f} ms ø"
                     if avg_inferences else "")
        lines.append(f"Coral      {coral_icon} {det_mode}{infer_str}")
        # Weather — last poll age + summary of active event triggers
        weather_line = "Wetter     ⚪ kein Poll bekannt"
        try:
            from . import server as _srv
            wsvc = getattr(_srv, "weather_service", None)
        except Exception:
            wsvc = None
        try:
            if wsvc and hasattr(wsvc, "status"):
                wstat = wsvc.status() or {}
                last_iso = wstat.get("last_poll_at")
                age_min = None
                if last_iso:
                    try:
                        age_min = int((datetime.now() - datetime.fromisoformat(last_iso)).total_seconds() / 60)
                    except Exception:
                        age_min = None
                cur = wstat.get("current_state") or {}
                # Compact event chip list — only the events the user has
                # turned on (dot icon + label).
                from ..weather_service import EVENT_LABEL_DE
                ev_chips = []
                for evt, lbl in EVENT_LABEL_DE.items():
                    active = bool(cur.get(evt))
                    ev_chips.append(f"{lbl} {'🟡' if active else '⚪'}")
                age_str = f"letzter Poll vor {age_min} min" if age_min is not None else "kein Poll bekannt"
                weather_line = f"Wetter     🟢 {age_str} · {' · '.join(ev_chips)}"
        except Exception as e:
            log.debug("[tg] weather row render failed: %s", e)
        lines.append(weather_line)
        lines.append("────")
        # Storage: free disk + sum of per-cam belegt
        try:
            root = str(self._storage_root())
            free_gb = _sh.disk_usage(root).free / (1024 ** 3)
            cam_total_str = self._fmt_bytes(cam_disk_total) if cam_disk_total else "—"
            lines.append(
                f"Speicher:  <b>{free_gb:.1f} GB</b> frei · {cam_total_str} von Cams belegt"
            )
        except Exception:
            pass
        # Global mute hint
        if self.settings_store:
            try:
                mute_until = float(self.settings_store.runtime_get("global_mute_until") or 0)
            except Exception:
                mute_until = 0
            if mute_until and time.time() < mute_until:
                end_local = datetime.fromtimestamp(mute_until).strftime("%H:%M")
                lines.append(f"🔇 Pushes pausiert bis {end_local}")
        return "\n".join(lines)

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

    # ── Stub views for phase-1 navigation (filled in phase-2) ─────────────
    # ── Phase-2 tile helpers ──────────────────────────────────────────────
    # Label → emoji map. Mirrors the JS `_STAT_LABEL_ICONS` in app.js so
    # the bot and the web UI agree on iconography. Unknown labels fall
    # through to "❓" via `_label_icon` — never crash the renderer on a
    # new label name.
    _LABEL_ICONS: dict[str, str] = {
        "person":    "👤",
        "cat":       "🐱",
        "bird":      "🐦",
        "dog":       "🐕",
        "fox":       "🦊",
        "hedgehog":  "🦔",
        "squirrel":  "🐿️",
        "horse":     "🐴",
        "deer":      "🦌",
        "car":       "🚗",
        "motion":    "👁",
    }
    # Kind classifier for the Erkennungen filter. The user's filter has
    # only 4 buckets (Vögel / Katzen / Personen / Wildtiere) plus "alle";
    # this dict maps the granular label to the bucket.
    _LABEL_KIND: dict[str, str] = {
        "bird":     "vogel",
        "cat":      "katze",
        "person":   "person",
        "dog":      "wildtier",
        "fox":      "wildtier",
        "hedgehog": "wildtier",
        "squirrel": "wildtier",
        "deer":     "wildtier",
        "horse":    "wildtier",
    }

    def _label_icon(self, label: str) -> str:
        return self._LABEL_ICONS.get((label or "").lower(), "❓")

    def _event_primary_label(self, ev: dict) -> str:
        """Pick the most informative label for a row: bird species name when
        available, else cat name (the re-id label), else the top label."""
        species = (ev.get("bird_species") or "").strip()
        if species:
            return species
        cat_name = (ev.get("cat_name") or "").strip()
        if cat_name:
            return cat_name
        top = ev.get("top_label") or ""
        labels = ev.get("labels") or []
        return top or (labels[0] if labels else "")

    def _event_kind(self, ev: dict) -> str:
        """Return the filter bucket for an event: vogel / katze / person /
        wildtier / sonstiges."""
        if (ev.get("bird_species") or "").strip():
            return "vogel"
        if (ev.get("cat_name") or "").strip():
            return "katze"
        for lbl in [ev.get("top_label")] + list(ev.get("labels") or []):
            if not lbl:
                continue
            kind = self._LABEL_KIND.get(str(lbl).lower())
            if kind:
                return kind
        return "sonstiges"

    def _event_icon(self, ev: dict) -> str:
        """Pick the icon: species → 🐦, cat name → 🐱, else map top_label."""
        if (ev.get("bird_species") or "").strip():
            return "🐦"
        if (ev.get("cat_name") or "").strip():
            return "🐱"
        for lbl in [ev.get("top_label")] + list(ev.get("labels") or []):
            if not lbl:
                continue
            icon = self._LABEL_ICONS.get(str(lbl).lower())
            if icon:
                return icon
        return "❓"

    # In-memory filter state per chat. Survives navigation, resets on
    # bot restart — matches the user's "session-only" requirement and
    # avoids touching the persistent settings store on every filter tap.
    _tile_state: dict[int, dict] = {}

    def _tile_state_for(self, chat_id: int | None) -> dict:
        if chat_id is None:
            return {}
        return self._tile_state.setdefault(int(chat_id), {})

    def _erkennungen_view(self, *, filter_cam: str | None = None,
                          filter_kind: str | None = None,
                          page: int = 0) -> tuple[str, InlineKeyboardMarkup]:
        """📋 Erkennungen — today's detection log, newest first.

        Filter labels:
          filter_cam   None / a cam id  ("alle Kameras" if None)
          filter_kind  None / "vogel"/"katze"/"person"/"wildtier" ("alle Typen" if None)

        10 entries per page; pagination via det:page:N callback. The
        filter sub-view sits behind det:filter."""
        from html import escape as _esc
        today_iso = datetime.now().strftime("%Y-%m-%d")
        cam_cfgs = {c.get("id"): c for c in (self._cfg().get("cameras", []) or [])}
        all_events: list[dict] = []
        cam_iter = ([filter_cam] if filter_cam else list(cam_cfgs.keys()))
        for cam_id in cam_iter:
            if not cam_id or not self.store:
                continue
            try:
                evs = self.store.list_events(cam_id, start=today_iso, limit=500)
            except Exception:
                evs = []
            for e in evs:
                e = dict(e)
                e["_cam_name"] = (cam_cfgs.get(cam_id) or {}).get("name") or cam_id
                e["_kind"] = self._event_kind(e)
                if filter_kind and e["_kind"] != filter_kind:
                    continue
                all_events.append(e)
        all_events.sort(key=lambda e: e.get("time", ""), reverse=True)

        page = max(0, int(page))
        page_size = 10
        n_total = len(all_events)
        n_pages = max(1, (n_total + page_size - 1) // page_size)
        if page >= n_pages:
            page = n_pages - 1
        slice_ = all_events[page * page_size:(page + 1) * page_size]

        cam_label = (cam_cfgs.get(filter_cam) or {}).get("name", filter_cam) if filter_cam else "alle Kameras"
        kind_label = {"vogel": "🐦 Vögel", "katze": "🐱 Katzen",
                      "person": "👤 Personen", "wildtier": "🦌 Wildtiere"}.get(
                      filter_kind, "alle Typen")
        head = ["📋 <b>Erkennungen heute</b>",
                f"Filter: {_esc(str(cam_label))} · {_esc(kind_label)}",
                "─────────────", ""]

        if not slice_:
            head.append("Heute noch keine Erkennungen.")
            rows = [
                [InlineKeyboardButton("🔍 Filter", callback_data="det:filter")],
                [InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root")],
            ]
            return "\n".join(head), InlineKeyboardMarkup(rows)

        for ev in slice_:
            time_hm = (ev.get("time") or "")[11:16]
            icon = self._event_icon(ev)
            name = self._event_primary_label(ev) or "?"
            cam = ev.get("_cam_name") or ev.get("camera_id") or "?"
            head.append(f"<code>{time_hm}</code>  {icon} {_esc(name):<14s} · {_esc(cam)}")
        head.append("─────────────")
        head.append(f"Seite {page + 1} / {n_pages}")

        # Pagination row: « N (prev) and (next) ».
        nav_row = []
        if page > 0:
            nav_row.append(InlineKeyboardButton(f"« {page}",
                                                 callback_data=f"det:page:{page - 1}"))
        if page < n_pages - 1:
            nav_row.append(InlineKeyboardButton(f"{page + 2} »",
                                                 callback_data=f"det:page:{page + 1}"))
        rows: list[list[InlineKeyboardButton]] = []
        if nav_row:
            rows.append(nav_row)
        rows.append([InlineKeyboardButton("🔍 Filter", callback_data="det:filter")])
        rows.append([InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root")])
        return "\n".join(head), InlineKeyboardMarkup(rows)

    def _erkennungen_filter_view(self, chat_id: int | None) -> tuple[str, InlineKeyboardMarkup]:
        """Sub-view: Filter pickers for the Erkennungen tile. Selections
        update self._tile_state and the user is bounced back to the list
        via det:apply."""
        st = self._tile_state_for(chat_id)
        cur_cam = st.get("det_cam")
        cur_kind = st.get("det_kind")
        cam_cfgs = (self._cfg().get("cameras", []) or [])
        cam_row = []
        for c in cam_cfgs:
            cid = c.get("id"); name = c.get("name") or cid
            if not cid:
                continue
            label = ("● " if cur_cam == cid else "") + (name[:14])
            cam_row.append(InlineKeyboardButton(label,
                                                 callback_data=f"det:setcam:{cid}"[:64]))
        cam_row.append(InlineKeyboardButton(("● " if cur_cam is None else "") + "alle",
                                             callback_data="det:setcam:_all"))
        kind_opts = [
            ("🐦 Vögel",      "vogel"),
            ("🐱 Katzen",     "katze"),
            ("👤 Personen",   "person"),
            ("🦌 Wildtiere",  "wildtier"),
            ("alle",          "_all"),
        ]
        kind_row = []
        for lbl, val in kind_opts:
            sel = (cur_kind == val) or (val == "_all" and cur_kind is None)
            kind_row.append(InlineKeyboardButton(("● " if sel else "") + lbl,
                                                  callback_data=f"det:setkind:{val}"[:64]))
        # Buttons-per-row clamp so iPhone-narrow rows wrap.
        def _chunk(row, n=3):
            return [row[i:i + n] for i in range(0, len(row), n)]
        rows = []
        for r in _chunk(cam_row, 3):
            rows.append(r)
        for r in _chunk(kind_row, 3):
            rows.append(r)
        rows.append([InlineKeyboardButton("✓ Anwenden", callback_data="det:apply"),
                     InlineKeyboardButton("« Zurück",   callback_data="det:apply")])
        return ("📋 <b>Filter</b>\n\nKamera und Erkennungstyp wählen.",
                InlineKeyboardMarkup(rows))

    def _tier_log_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """🐦 Tier-Log — top species (7 d) + cat registry sightings (today)."""
        from html import escape as _esc
        lines = ["🐦 <b>Tier-Log</b> · letzte 7 Tage", "─────────────"]
        # Section A — top bird species + top cat names.
        try:
            summary = self.store.aggregate_summary(days=7) if self.store else {}
        except Exception:
            summary = {}
        top_birds = (summary.get("top_bird_species") or [])[:5]
        top_cats = (summary.get("top_cat_names") or [])[:5]
        if top_birds:
            lines.append("Vogelarten:")
            medals = ["🥇", "🥈", "🥉", "  ", "  "]
            for i, item in enumerate(top_birds):
                # item may be a tuple or a {label, count} dict
                if isinstance(item, dict):
                    label, n = item.get("label", "?"), int(item.get("count", 0))
                else:
                    label, n = (item[0] if len(item) else "?"), int(item[1] if len(item) > 1 else 0)
                medal = medals[i] if i < len(medals) else "  "
                lines.append(f"  {medal} {_esc(str(label)):<14s} {n}×")
            lines.append("")
        # Section B — known cats (re-id) with today's sightings + last_seen.
        today_iso = datetime.now().strftime("%Y-%m-%d")
        cat_rows = []
        try:
            profiles = self.cat_registry.list_profiles() if hasattr(self, "cat_registry") and self.cat_registry else []
        except Exception:
            profiles = []
        # Re-id registry isn't passed into TelegramService directly, so
        # fall back to cat_name occurrences from today's events as a
        # poor-man's roster when no explicit registry is available.
        seen_today: dict[str, dict] = {}
        if self.store:
            for cam in (self._cfg().get("cameras", []) or []):
                cid = cam.get("id")
                if not cid:
                    continue
                try:
                    evs = self.store.list_events(cid, start=today_iso, limit=500)
                except Exception:
                    evs = []
                for ev in evs:
                    cn = (ev.get("cat_name") or "").strip()
                    if not cn:
                        continue
                    rec = seen_today.setdefault(cn, {"count": 0, "last_ts": ""})
                    rec["count"] += 1
                    t = ev.get("time") or ""
                    if t > rec["last_ts"]:
                        rec["last_ts"] = t
        if profiles or seen_today:
            lines.append("Bekannte Katzen:")
            names = sorted(set([p.get("name", "") for p in profiles] + list(seen_today.keys())))
            now = datetime.now()
            for name in names:
                if not name:
                    continue
                rec = seen_today.get(name, {"count": 0, "last_ts": ""})
                count = rec["count"]
                last_str = "—"
                if rec["last_ts"]:
                    try:
                        delta_min = int((now - datetime.fromisoformat(rec["last_ts"])).total_seconds() / 60)
                        if delta_min < 60:
                            last_str = f"vor {delta_min} min"
                        elif delta_min < 1440:
                            last_str = f"vor {delta_min // 60} h"
                        else:
                            last_str = f"vor {delta_min // 1440} d"
                    except Exception:
                        last_str = "?"
                else:
                    last_str = "noch nicht heute"
                lines.append(f"  🐱 {_esc(name):<10s} · {count}× heute · {last_str}")
                cat_rows.append(name)
            lines.append("")
        # Empty state
        if not top_birds and not top_cats and not cat_rows:
            lines.append("Noch keine Tier-Aktivität in den letzten 7 Tagen.")

        rows = [
            [InlineKeyboardButton("📋 Alle Erkennungen", callback_data="menu:erkennungen"),
             InlineKeyboardButton("🏠 Hauptmenü",       callback_data="menu:root")],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _wetter_tile_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """⛅ Wetter — live snapshot from WeatherService.status() with
        threshold-aware status icons + sun position + active-event list."""
        from . import server as _srv
        wsvc = getattr(_srv, "weather_service", None)
        now = datetime.now()
        lines = [f"⛅ <b>Wetter</b> · Stand {now.strftime('%H:%M')}", "─────────────"]
        if wsvc is None:
            lines.append("Wetter-Service nicht aktiv.")
            return ("\n".join(lines),
                    InlineKeyboardMarkup([[InlineKeyboardButton("🏠 Hauptmenü",
                                                                  callback_data="menu:root")]]))
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
            ("heavy_rain", "🌧 Regen",     "precipitation",       "mm/h"),
            ("thunder",    "⚡ Gewitter",  "lightning_potential", "J/kg"),
            ("snow",       "❄ Schnee",    "snowfall",            "cm/h"),
            ("fog",        "🌫 Sicht",    "visibility",          "m"),
        ]
        for evt, label, key, unit_fb in rows_def:
            v = cur.get(key)
            thr = thresholds.get(key)
            unit = units.get(key, unit_fb)
            active = bool(cur_state.get(evt))
            if v is None:
                vstr, pct, status_icon = "—", "—", "⚪"
            else:
                vstr = (f"{v:.1f}" if abs(v) < 100 else f"{v:.0f}")
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
                thr_str = (f"{thr:.1f}" if abs(thr) < 100 else f"{thr:.0f}")
            lines.append(
                f"{label:<11s} {status_icon} {vstr} / {thr_str} {unit}  ({pct})"
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
                    sun_extra = f" · Untergang in {h} h {m:02d} min" if h else f" · Untergang in {m} min"
        except Exception:
            pass
        if sun_alt is not None:
            lines.append(f"☀ Sonne     {sun_alt:.0f}° hoch{sun_extra}")
        # Active events line
        from ..weather_service import EVENT_LABEL_DE
        active_evs = [EVENT_LABEL_DE.get(e, e) for e, on in cur_state.items() if on]
        lines.append("")
        lines.append("Aktive Ereignisse: " + (", ".join(active_evs) if active_evs else "keine"))
        rows = [
            [InlineKeyboardButton("🔄 Aktualisieren", callback_data="menu:wetter"),
             InlineKeyboardButton("🏠 Hauptmenü",     callback_data="menu:root")],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    # Keep the old name as an alias so the existing `menu:wetter` route
    # in _handle_menu_cb keeps resolving — phase 1 wired it up via that
    # method name. No external callers rely on the helper name itself.
    def _wetter_view(self) -> tuple[str, InlineKeyboardMarkup]:
        return self._wetter_tile_view()

    def _system_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """🛠 System — per-cam disk breakdown + global health checks."""
        import shutil as _sh
        from html import escape as _esc
        lines = ["🛠 <b>System</b>", "─────────────"]
        # Per-cam storage breakdown
        cams_info = self._active_cams()
        cam_disk_total = 0
        if cams_info:
            lines.append("Speicher pro Kamera:")
            for info in cams_info:
                cam_id = info["cam_id"]
                name = _esc(info["name"])
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
                cam_disk_total += row_total
                lines.append(f"  {name:<12s} {self._fmt_bytes(row_total):>8s}  ({' · '.join(parts)})")
            lines.append("")
        # Free disk
        try:
            usage = _sh.disk_usage(str(self._storage_root()))
            free_gb = usage.free / (1024 ** 3)
            total_gb = usage.total / (1024 ** 3)
            lines.append(f"Gesamt frei: <b>{free_gb:.1f} GB</b> von {total_gb:.0f} GB")
        except Exception:
            free_gb = None
            lines.append("Speicher: nicht ermittelbar")
        lines.append("")
        # Health rows
        lines.append("Health:")
        # Cam state
        n_runtime = sum(1 for c in cams_info if c["source"] == "runtime")
        n_fallback = sum(1 for c in cams_info if c["source"] == "settings")
        if n_fallback == 0 and n_runtime > 0:
            lines.append("  ✅ Alle Kameras online")
        elif n_fallback > 0:
            lines.append(f"  ⚠️ {n_fallback} im Fallback (Runtime nicht aktiv)")
        elif n_runtime == 0:
            lines.append("  ⚠️ Keine Kamera-Runtime aktiv")
        # Reconnects 24h
        for info in cams_info:
            n24 = (info.get("status") or {}).get("reconnect_count_24h")
            if isinstance(n24, int) and n24 > 3:
                lines.append(f"  ⚠️ {_esc(info['name'])}: {n24} Reconnects letzte 24 h")
        # Coral
        cfg = self._cfg()
        det_mode = (cfg.get("processing", {}).get("detection") or {}).get("mode", "none")
        if det_mode == "coral":
            avg_inferences = []
            for info in cams_info:
                v = (info.get("status") or {}).get("inference_avg_ms")
                if isinstance(v, (int, float)) and v > 0:
                    avg_inferences.append(v)
            if avg_inferences:
                lines.append(f"  ✅ Coral · {sum(avg_inferences) / len(avg_inferences):.0f} ms ø")
            else:
                lines.append("  ✅ Coral aktiv")
        else:
            lines.append(f"  ⚠️ Coral inaktiv (Modus: {det_mode})")
        # Disk
        if free_gb is not None:
            if free_gb < 10:
                lines.append(f"  🔴 Speicher: nur {free_gb:.1f} GB frei")
            elif free_gb < 25:
                lines.append(f"  ⚠️ Speicher: {free_gb:.1f} GB frei")
            else:
                lines.append(f"  ✅ Speicher: {free_gb:.0f} GB frei")
        # Telegram polling
        try:
            ps = self.get_polling_status() if hasattr(self, "get_polling_status") else {}
        except Exception:
            ps = {}
        ps_state = ps.get("state", "?")
        if ps_state == "active":
            lines.append("  ✅ Telegram-Polling aktiv")
        elif ps_state in ("starting", "conflict"):
            lines.append(f"  ⚠️ Telegram-Polling {ps_state}")
        else:
            lines.append(f"  🔴 Telegram-Polling {ps_state}")

        rows = [
            [InlineKeyboardButton("🔄 Aktualisieren", callback_data="menu:system"),
             InlineKeyboardButton("🏠 Hauptmenü",     callback_data="menu:root")],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

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
            from . import server as _srv
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


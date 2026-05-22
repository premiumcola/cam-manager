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


class InboundMixin:
    """Slash-command dispatchers + callback_query handlers + per-action helpers.

    Mixin for TelegramService. Methods access shared state via `self.*`
    (cfg, bot, store, runtimes, scheduler, etc.) which live on the
    concrete class.
    """

    async def cmd_menu(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Open or refresh the anchor bubble. /start, /menu, and the
        '🏠 Menü' reply-keyboard text all flow through here. No textual
        follow-up — the persistent keyboard sticks server-side once the
        first anchor has been sent with it attached."""
        self.log_action("menu_open")
        chat_id = update.effective_chat.id if update.effective_chat else self.chat_id
        try:
            await self._anchor_send_or_edit(context.bot, chat_id, self._root_view())
        except Exception as e:
            log.warning("[tg] anchor open failed: %s", e)
            text, markup = self._root_view()
            await update.message.reply_text(
                text,
                reply_markup=markup,
                parse_mode="HTML",
            )

    async def cmd_today(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text, markup = self._stats_view(days=1)
        await update.message.reply_text(text, reply_markup=markup, parse_mode="HTML")

    async def cmd_week(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        text, markup = self._stats_view(days=7)
        await update.message.reply_text(text, reply_markup=markup, parse_mode="HTML")

    # ── Reply-keyboard + slash-command action handlers ────────────────────
    # Single source of truth for the four top-level actions: each helper
    # accepts (update, context) and is reachable from BOTH the persistent
    # keyboard text dispatch (on_text) and the slash commands. The cam-
    # picker variants reuse the existing "cam:<id>:livebild" / "cam:<id>:
    # clip:5" dispatch in _handle_camera_cb so there is no second
    # implementation of snapshot / clip.

    async def _handle_livebild(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Send a snapshot or — when there are multiple cams — an inline
        cam picker. The picker buttons route through cam:<id>:livebild
        which the existing dispatcher already handles."""
        log.info(
            "[tg] /live invoked by chat=%s",
            update.effective_chat.id if update.effective_chat else "?",
        )
        cams = self._active_cams()
        if not cams:
            await update.message.reply_text(
                "Keine Kameras konfiguriert.", reply_markup=PERSISTENT_KEYBOARD
            )
            return
        if len(cams) == 1:
            info = cams[0]
            icon = self._cam_status_icon_for(info)
            text, markup = (
                "📷 Kamera wählen — livebild",
                InlineKeyboardMarkup(
                    [
                        [
                            InlineKeyboardButton(
                                f"{icon} {info['name']}",
                                callback_data=f"cam:{info['cam_id']}:livebild"[:64],
                            )
                        ],
                    ]
                ),
            )
            await update.message.reply_text(text, reply_markup=markup)
            return
        text, markup = self._cam_picker("livebild")
        await update.message.reply_text(text, reply_markup=markup, parse_mode="HTML")

    async def _handle_clip5(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """5-s clip cam picker. We deliberately don't offer 'all cams' —
        running 4 ad-hoc ffmpeg recordings in parallel pegs the host."""
        log.info(
            "[tg] /clip invoked by chat=%s",
            update.effective_chat.id if update.effective_chat else "?",
        )
        cams = self._active_cams()
        if not cams:
            await update.message.reply_text(
                "Keine Kameras konfiguriert.", reply_markup=PERSISTENT_KEYBOARD
            )
            return
        rows = []
        for info in cams:
            icon = self._cam_status_icon_for(info)
            rows.append(
                [
                    InlineKeyboardButton(
                        f"{icon} 🎬 {info['name']}",
                        callback_data=f"cam:{info['cam_id']}:clip:5"[:64],
                    )
                ]
            )
        await update.message.reply_text(
            "🎬 Kamera wählen — 5 s Clip",
            reply_markup=InlineKeyboardMarkup(rows),
        )

    async def _handle_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Compact system overview: cams + Telegram polling + Coral + weather + storage."""
        log.info(
            "[tg] /status invoked by chat=%s",
            update.effective_chat.id if update.effective_chat else "?",
        )
        try:
            text = self._render_system_status_text()
        except Exception as e:
            log.warning("[tg] status render failed: %s", e)
            text = "Status nicht verfügbar."
        await update.message.reply_text(text, parse_mode="HTML", reply_markup=PERSISTENT_KEYBOARD)

    async def _handle_mute_all(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Set runtime.global_mute_until = now + 1 h and reply with a confirm
        bubble carrying two inline buttons (end-now / extend-to-4h)."""
        log.info(
            "[tg] /mute invoked by chat=%s",
            update.effective_chat.id if update.effective_chat else "?",
        )
        until = time.time() + _MUTE_DEFAULT_S
        if self.settings_store:
            self.settings_store.runtime_set("global_mute_until", until)
        end_local = datetime.fromtimestamp(until).strftime("%H:%M")
        log.info("[tg] mute_all activated until %s (epoch=%d)", end_local, int(until))
        markup = InlineKeyboardMarkup(
            [
                [
                    InlineKeyboardButton("Sofort beenden", callback_data="mute:end"),
                    InlineKeyboardButton("Auf 4 h verlängern", callback_data="mute:ext4h"),
                ],
            ]
        )
        await update.message.reply_text(
            f"🔇 Alle Pushes pausiert bis <b>{end_local}</b>",
            parse_mode="HTML",
            reply_markup=markup,
        )

    async def _handle_cameras(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Per-cam drilldown picker. Tapping the persistent ``📹 Kameras``
        row sends an inline keyboard with one button per camera; tapping
        a camera opens its drilldown view via cam:<id>:drilldown."""
        log.info(
            "[tg] /cameras invoked by chat=%s",
            update.effective_chat.id if update.effective_chat else "?",
        )
        cams = self._active_cams()
        if not cams:
            await update.message.reply_text(
                "Keine Kameras konfiguriert.",
                reply_markup=PERSISTENT_KEYBOARD,
            )
            return
        rows = []
        for info in cams:
            icon = self._cam_status_icon_for(info)
            rows.append(
                [
                    InlineKeyboardButton(
                        f"{icon} {info['name']}",
                        callback_data=f"cam:{info['cam_id']}:drilldown"[:64],
                    )
                ]
            )
        await update.message.reply_text(
            "📹 Kamera wählen",
            reply_markup=InlineKeyboardMarkup(rows),
        )

    async def on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """MessageHandler for free-form text. The persistent keyboard now has
        only one button (🏠 Menü) which routes through cmd_menu; legacy
        button labels (still occasionally surfaced by old chat clients)
        keep their handlers as a courtesy."""
        if not update.message or not update.message.text:
            return
        txt = update.message.text.strip()
        if txt == ACTION_MENU:
            await self.cmd_menu(update, context)
            return
        # Legacy button labels — kept reachable so old clients with the
        # 5-button keyboard cached don't suddenly see "💡 Tipp" replies.
        legacy_map = {
            ACTION_LIVE: self._handle_livebild,
            ACTION_CLIP: self._handle_clip5,
            ACTION_STATUS: self._handle_status,
            ACTION_MUTE: self._handle_mute_all,
            ACTION_CAMS: self._handle_cameras,
        }
        handler = legacy_map.get(txt)
        if handler:
            await handler(update, context)
            return
        # Anything else: silent. The user explicitly didn't want a
        # "💡 Tipp" follow-up cluttering the chat for arbitrary text.

    # ── Callback router ───────────────────────────────────────────────────
    async def on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        q = update.callback_query
        data = q.data or ""
        if data == "noop":
            await q.answer()
            return
        # Push-system prefixes (Phase 1)
        if data.startswith("ev:"):
            await self._handle_event_cb(q, data)
            return
        if data.startswith("hi:") or data.startswith("share:"):
            await self._handle_highlight_cb(q, data)
            return
        # Global mute control (set from /mute or the "Alles still 1 h" button).
        if data.startswith("mute:"):
            await self._handle_mute_cb(q, data)
            return
        # Timelapse: tl:send:<rel>  or  tl:save:<rel>
        if data.startswith("tl:"):
            await self._handle_timelapse_cb(q, data, context)
            return
        # Camera actions: cam:<id>:<verb>[:arg]
        if data.startswith("cam:"):
            await self._handle_camera_cb(q, data, context)
            return
        # Multi-level menu navigation
        if data.startswith("menu:"):
            await self._handle_menu_cb(q, data)
            return
        # Erkennungen tile (phase-2): pagination, filter sub-view, filter
        # setters, apply. Routed through _handle_menu_cb because the
        # tile renders edit-in-place via the same anchor pattern as
        # menu:* views.
        if data.startswith("det:"):
            await self._handle_menu_cb(q, data)
            return
        await q.answer()

    async def _set_badge(self, q, label: str):
        """Replace the entire reply markup with a single grey badge button."""
        try:
            mk = InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data="noop")]])
            await q.edit_message_reply_markup(reply_markup=mk)
        except Exception as e:
            log.debug("[tg] badge edit failed: %s", e)

    async def _handle_event_cb(self, q, data: str):
        # Telegram only accepts ONE answerCallbackQuery per query, so each
        # branch answers exactly once at its end.
        parts = data.split(":")
        if len(parts) < 3:
            await q.answer()
            return
        eid = parts[1]
        verb = parts[2]
        ss = self.settings_store

        if verb in ("ok", "no"):
            existing = ss.runtime_get_subkey("event_feedback", eid) if ss else None
            if existing:
                await q.answer("Bereits bewertet")
                return
            verdict = "ok" if verb == "ok" else "no"
            ss.runtime_set_subkey(
                "event_feedback",
                eid,
                {
                    "verdict": verdict,
                    "by": "telegram",
                    "ts": time.time(),
                },
            )
            ts_str = datetime.now().strftime("%H:%M")
            badge = f"✅ Gültig · {ts_str}" if verdict == "ok" else f"❌ Falsch · {ts_str}"
            await self._set_badge(q, badge)
            await q.answer(badge)
            return

        if verb == "m1h":
            idx = ss.runtime_get_subkey("alert_index", eid) if ss else None
            cam = (idx or {}).get("cam")
            label = (idx or {}).get("label")
            if not cam or not label:
                await q.answer("Daten zur Erkennung fehlen.")
                return
            until = time.time() + 3600
            suppress = ss.runtime_get("suppress") or {}
            if not isinstance(suppress, dict):
                suppress = {}
            suppress[f"{cam}|{label}"] = until
            ss.runtime_set("suppress", suppress)
            until_dt = (datetime.now() + timedelta(hours=1)).strftime("%H:%M")
            await self._set_badge(q, f"🔇 Stumm bis {until_dt}")
            await q.answer(f"🔇 1 h still für {LABEL_DE.get(label, label)}")
            return

        if verb == "siren":
            idx = ss.runtime_get_subkey("alert_index", eid) if ss else None
            cam = (idx or {}).get("cam")
            rt = self.runtimes.get(cam) if cam else None
            triggered = False
            if rt and hasattr(rt, "trigger_siren"):
                try:
                    triggered = bool(rt.trigger_siren())
                except Exception as e:
                    log.warning("[tg] trigger_siren failed: %s", e)
            await self._set_badge(q, "🚨 Sirene")
            if triggered:
                await q.answer("🚨 Sirene aktiviert")
            else:
                # Reolink siren API isn't wired yet — log + acknowledge.
                log.info("[tg] siren requested for %s — not implemented", cam)
                await q.answer("🚨 Sirene angefordert (nicht unterstützt)")
            return

        await q.answer("Unbekannte Aktion")

    async def _handle_mute_cb(self, q, data: str):
        """mute:end → clear global mute. mute:ext4h → push end-time to now+4h."""
        if not self.settings_store:
            await q.answer()
            return
        verb = data.split(":", 1)[1] if ":" in data else ""
        if verb == "end":
            self.settings_store.runtime_set("global_mute_until", 0)
            log.info("[tg] mute_all cleared by chat=%s", q.message.chat_id if q.message else "?")
            await self._set_badge(q, "✅ Pushes wieder aktiv")
            await q.answer("✅ Pushes wieder aktiv")
            return
        if verb == "ext4h":
            until = time.time() + _MUTE_EXTEND_S
            self.settings_store.runtime_set("global_mute_until", until)
            end_local = datetime.fromtimestamp(until).strftime("%H:%M")
            log.info("[tg] mute_all extended to 4 h (until=%s)", end_local)
            await self._set_badge(q, f"🔇 Stumm bis {end_local}")
            await q.answer(f"🔇 Stumm bis {end_local}")
            return
        await q.answer()

    async def _handle_highlight_cb(self, q, data: str):
        # hi:<eid>     → original-resolution snapshot (uncompressed sendDocument)
        # share:<eid>  → forward-friendly photo + plain caption (no buttons)
        parts = data.split(":", 1)
        kind = parts[0]
        eid = parts[1] if len(parts) > 1 else ""
        ss = self.settings_store
        if not eid or not ss:
            await q.answer()
            return
        idx = ss.runtime_get_subkey("alert_index", eid) or {}
        cam_id = idx.get("cam") or ""
        snap_path = None
        if cam_id and self.store:
            ev = self.store.get_event(cam_id, eid) if hasattr(self.store, "get_event") else None
            rel = (ev or {}).get("snapshot_relpath")
            if rel:
                p = self._storage_root() / rel
                if p.exists():
                    snap_path = p
        if not snap_path:
            await q.answer("Original nicht mehr vorhanden.")
            return
        await q.answer("Wird gesendet…")
        try:
            with open(snap_path, "rb") as f:
                if kind == "hi":
                    # sendDocument keeps full resolution (sendPhoto would
                    # downscale to 1280 long-edge).
                    await q.message.reply_document(
                        document=f, filename=snap_path.name, caption=f"🖼 {snap_path.name}"
                    )
                else:
                    await q.message.reply_photo(photo=f, caption=f"📤 {snap_path.name}")
        except Exception as e:
            log.warning("[tg] highlight send failed: %s", e)

    async def _handle_timelapse_cb(self, q, data: str, context):
        # tl:send:<cam>/<filename>  → reply with the mp4
        # tl:save:<rel>             → ack (Telegram retains it in chat history)
        rest = data[3:]  # strip "tl:"
        if rest.startswith("send:"):
            rel = rest[5:]
            full = self._storage_root() / "timelapse" / rel
            if not full.exists():
                await q.answer("Datei nicht mehr vorhanden")
                return
            await q.answer("Wird gesendet…")
            try:
                with open(full, "rb") as f:
                    await context.bot.send_video(
                        chat_id=q.message.chat_id,
                        video=f,
                        caption=f"⏱ {rel}",
                    )
            except Exception as e:
                log.warning("[tg] tl send failed: %s", e)
                await q.message.reply_text(f"Senden fehlgeschlagen: {e}")
            return
        if rest.startswith("save:"):
            await q.answer("Bereits im Chat-Verlauf gespeichert.")
            return
        await q.answer()

    async def _handle_camera_cb(self, q, data: str, context):
        # cam:<cid>:<verb>[:<arg>]
        parts = data.split(":")
        if len(parts) < 3:
            await q.answer()
            return
        cam_id, verb = parts[1], parts[2]
        # Drilldown / status / mute1h work even when the runtime is down
        # (they don't need to talk to the camera). Render-only verbs first.
        if verb == "drilldown":
            await self._render_view(q, self._cam_drilldown_view(cam_id))
            await q.answer()
            return
        if verb == "status":
            # Phase-2 deep view replaces the phase-1 stub: cam header +
            # today's events + cam-only storage breakdown + applicable
            # health rows. Renders in-place inside the same anchor.
            await self._render_view(q, self._cam_deep_view(cam_id))
            await q.answer()
            return
        if verb == "mute1h":
            until = time.time() + _MUTE_DEFAULT_S
            if self.settings_store:
                try:
                    self.settings_store.runtime_set_subkey("cam_mute_until", cam_id, until)
                except Exception as e:
                    log.warning("[tg] per-cam mute write failed: %s", e)
            end_local = datetime.fromtimestamp(until).strftime("%H:%M")
            log.info("[tg] mute_cam %s activated until %s", cam_id, end_local)
            await self._render_view(q, self._cam_drilldown_view(cam_id))
            await q.answer(f"🔇 stumm bis {end_local}")
            return

        # Verbs that DO need a live runtime — try a restart once if missing.
        rt = self.runtimes.get(cam_id)
        if not rt:
            recovered = self._try_restart_runtime(cam_id)
            rt = self.runtimes.get(cam_id) if recovered else None
            if not rt:
                await q.answer("Kamera nicht erreichbar — Runtime startet noch.", show_alert=True)
                return
        cam_name = rt.status().get("name", cam_id)
        if verb == "livebild":
            await self._cam_send_snapshot(q, context, cam_id, rt, cam_name)
            return
        if verb == "clip":
            if len(parts) >= 4:
                # cam:<id>:clip:<sec>
                try:
                    sec = int(parts[3])
                except ValueError:
                    sec = 5
                await self._cam_send_clip(q, context, cam_id, rt, cam_name, sec)
                return
            # cam:<id>:clip → show duration picker
            await self._render_view(q, self._clip_dur_picker(cam_id))
            return
        if verb == "arm":
            await self._cam_toggle_armed(q, cam_id, cam_name)
            return
        if verb == "reconnect":
            try:
                rt.stop()
                time.sleep(0.5)
                rt.start()
                await q.answer(f"🔄 {cam_name}: Neuverbindung gestartet")
            except Exception as e:
                log.warning("[tg] reconnect failed: %s", e)
                await q.answer("Reconnect fehlgeschlagen")
            return
        await q.answer()

    async def _cam_send_snapshot(self, q, context, cam_id, rt, cam_name):
        await q.answer("📷 Snapshot wird geholt…")
        log.info(
            "[tg] cam:%s:livebild triggered by chat=%s",
            cam_id,
            q.message.chat_id if q.message else "?",
        )
        jpeg = rt.snapshot_jpeg() if hasattr(rt, "snapshot_jpeg") else None
        if not jpeg:
            await q.message.reply_text(f"Kein Live-Bild für {cam_name} verfügbar.")
            return
        bio = BytesIO(jpeg)
        bio.name = f"{cam_id}.jpg"
        rows = [
            [
                InlineKeyboardButton("🔄 Neu", callback_data=f"cam:{cam_id}:livebild"),
                InlineKeyboardButton("🎬 5 s Clip", callback_data=f"cam:{cam_id}:clip:5"),
            ]
        ]
        nav_row = self._other_cam_nav_row(cam_id, "livebild")
        if nav_row:
            rows.append(nav_row)
        markup = InlineKeyboardMarkup(rows)
        ts_hm = datetime.now().strftime("%H:%M")
        try:
            # reply_to_message_id threads the snapshot under the originating
            # alert bubble in the Telegram client, so the user can scroll back
            # and see the alert + their requested follow-ups together.
            await context.bot.send_photo(
                chat_id=q.message.chat_id,
                photo=bio,
                caption=f"📷 <b>{cam_name}</b> · {ts_hm}",
                parse_mode="HTML",
                reply_markup=markup,
                reply_to_message_id=q.message.message_id if q.message else None,
            )
        except Exception as e:
            log.warning("[tg] snapshot send failed: %s", e)
        # Snap the anchor back to the cam drilldown view so the user
        # lands on the same control surface they just acted from. The
        # delivered photo is a separate message; the anchor is edited
        # in place and stays at top of the chat-state.
        try:
            await self._anchor_send_or_edit(
                context.bot, q.message.chat_id, self._cam_drilldown_view(cam_id)
            )
        except Exception:
            pass

    async def _cam_send_clip(self, q, context, cam_id, rt, cam_name, sec):
        await q.answer(f"🎬 {sec}-s Clip wird aufgenommen…")
        log.info(
            "[tg] cam:%s:clip:%d triggered by chat=%s",
            cam_id,
            sec,
            q.message.chat_id if q.message else "?",
        )
        # The blocking ffmpeg subprocess runs in a worker thread via run_in_executor
        # so it doesn't pin the asyncio loop while the recording is in progress.
        loop = asyncio.get_running_loop()
        try:
            path = await loop.run_in_executor(None, rt.record_adhoc_clip, sec)
        except Exception as e:
            log.warning("[tg] adhoc clip exception: %s", e)
            path = None
        if not path:
            await q.message.reply_text(
                f"Clip-Aufnahme für {cam_name} fehlgeschlagen "
                f"(ffmpeg/RTSP-Problem). Snapshot stattdessen verfügbar."
            )
            return
        ts_hm = datetime.now().strftime("%H:%M")
        # Same nav layout as snapshots: same-cam refresh / snapshot row,
        # plus a row of OTHER cameras (or a single "Andere Kamera" picker
        # when there are too many to fit).
        rows = [
            [
                InlineKeyboardButton("🔄 Neuer Clip", callback_data=f"cam:{cam_id}:clip:5"),
                InlineKeyboardButton("📷 Live-Bild", callback_data=f"cam:{cam_id}:livebild"),
            ]
        ]
        nav_row = self._other_cam_nav_row(cam_id, "clip:5")
        if nav_row:
            rows.append(nav_row)
        markup = InlineKeyboardMarkup(rows)
        try:
            with open(path, "rb") as f:
                await context.bot.send_video(
                    chat_id=q.message.chat_id,
                    video=f,
                    caption=f"🎬 <b>{cam_name}</b> · {sec} s · {ts_hm}",
                    parse_mode="HTML",
                    reply_markup=markup,
                    reply_to_message_id=q.message.message_id if q.message else None,
                )
        except Exception as e:
            log.warning("[tg] clip send failed: %s", e)
            await q.message.reply_text(f"Senden fehlgeschlagen: {e}")
        # Anchor snaps back to the cam drilldown — same UX rule as the
        # snapshot path so the user keeps a single control surface.
        try:
            await self._anchor_send_or_edit(
                context.bot, q.message.chat_id, self._cam_drilldown_view(cam_id)
            )
        except Exception:
            pass

    async def _cam_toggle_armed(self, q, cam_id, cam_name):
        if not self.settings_store:
            await q.answer()
            return
        current = self.settings_store.get_camera(cam_id)
        if not current:
            await q.answer("Kamera nicht in Settings.")
            return
        new_armed = not bool(current.get("armed", True))
        current["armed"] = new_armed
        self.settings_store.upsert_camera(current)
        # Refresh the status view in place so the user sees the change.
        await self._render_view(q, self._status_view())
        await q.answer(f"🛡 {cam_name}: {'scharf' if new_armed else 'stumm'}")

    async def _handle_menu_cb(self, q, data: str):
        """Routes every menu:* callback. View functions return (text, markup);
        we render in the same bubble via edit_message_text."""
        self.log_action("menu_" + data.split(":", 1)[1])
        if data == "menu:root":
            await self._render_view(q, self._root_view())
            await q.answer()
            return
        if data == "menu:livebild":
            await self._render_view(q, self._cam_picker("livebild"))
            await q.answer()
            return
        if data == "menu:clip":
            await self._render_view(q, self._cam_picker("clip"))
            await q.answer()
            return
        if data == "menu:cams":
            await self._render_view(q, self._cam_picker("drilldown"))
            await q.answer()
            return
        if data == "menu:zeitraffer":
            await self._render_view(q, self._zeitraffer_view())
            await q.answer()
            return
        if data == "menu:zeitraffer:today":
            # Pick the newest of today's timelapses across cameras.
            today_pref = datetime.now().strftime("%Y-%m-%d")
            tls = [
                t
                for t in self._list_recent_timelapses(limit=20)
                if datetime.fromtimestamp(t["mtime"]).strftime("%Y-%m-%d") == today_pref
            ]
            if not tls:
                await q.answer("Heute kein Zeitraffer vorhanden.")
                return
            top = tls[0]
            full = self._storage_root() / "timelapse" / top["cam_id"] / top["filename"]
            try:
                with open(full, "rb") as f:
                    await q.message.reply_video(video=f, caption=f"⏱ {top['cam_id']} · heute")
            except Exception as e:
                log.warning("[tg] today timelapse send failed: %s", e)
            await q.answer()
            return
        if data == "menu:erkennungen":
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            await self._render_view(
                q,
                self._erkennungen_view(
                    filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=0
                ),
            )
            await q.answer()
            return
        # Erkennungen pagination + filter sub-view + filter-state setters.
        if data.startswith("det:page:"):
            try:
                page = int(data.split(":")[-1])
            except ValueError:
                page = 0
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            await self._render_view(
                q,
                self._erkennungen_view(
                    filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=page
                ),
            )
            await q.answer()
            return
        if data == "det:filter":
            chat_id = q.message.chat_id if q.message else None
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer()
            return
        if data.startswith("det:setcam:"):
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            sel = data.split(":", 2)[2]
            st["det_cam"] = None if sel == "_all" else sel
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer()
            return
        if data.startswith("det:setkind:"):
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            sel = data.split(":", 2)[2]
            st["det_kind"] = None if sel == "_all" else sel
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer()
            return
        if data == "det:apply":
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            await self._render_view(
                q,
                self._erkennungen_view(
                    filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=0
                ),
            )
            await q.answer()
            return
        if data == "menu:stats" or data == "menu:stats:today":
            await self._render_view(q, self._stats_view(days=1))
            await q.answer()
            return
        if data == "menu:stats:week":
            await self._render_view(q, self._stats_view(days=7))
            await q.answer()
            return
        if data == "menu:stats:month":
            await self._render_view(q, self._stats_view(days=30))
            await q.answer()
            return
        if data == "menu:status":
            await self._render_view(q, self._status_view())
            await q.answer()
            return
        if data == "menu:logs":
            await self._render_view(q, self._logs_view())
            await q.answer()
            return
        # Phase-1 stubs: tiles routed end-to-end so the navigation feels
        # complete even though the detail content lands in phase-2.
        if data == "menu:tierlog":
            await self._render_view(q, self._tier_log_view())
            await q.answer()
            return
        if data == "menu:wetter":
            await self._render_view(q, self._wetter_view())
            await q.answer()
            return
        if data == "menu:system":
            await self._render_view(q, self._system_view())
            await q.answer()
            return
        if data == "menu:muteall":
            # Same effect as the /mute command, but renders inside the
            # anchor and snaps back to root afterwards.
            until = time.time() + _MUTE_DEFAULT_S
            if self.settings_store:
                try:
                    self.settings_store.runtime_set("global_mute_until", until)
                except Exception:
                    pass
            end_local = datetime.fromtimestamp(until).strftime("%H:%M")
            log.info("[tg] mute_all activated until %s via menu", end_local)
            await self._render_view(q, self._root_view())
            await q.answer(f"🔇 Alle Pushes pausiert bis {end_local}")
            return
        await q.answer()

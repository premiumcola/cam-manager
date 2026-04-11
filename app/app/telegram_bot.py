from __future__ import annotations
from io import BytesIO
from threading import Thread
from datetime import datetime
import asyncio
import logging
from telegram import Bot, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, ContextTypes

log = logging.getLogger(__name__)


class TelegramService:
    def __init__(self, cfg: dict, store=None, runtimes=None, global_cfg=None, timelapse_builder=None, settings_store=None):
        self.cfg = cfg or {}
        self.enabled = bool(self.cfg.get("enabled") and self.cfg.get("token") and self.cfg.get("chat_id"))
        self.chat_id = str(self.cfg.get("chat_id", ""))
        self.token = self.cfg.get("token", "")
        self.bot = Bot(self.token) if self.enabled else None
        if not self.enabled:
            reasons = []
            if not self.cfg.get("enabled"): reasons.append("enabled=false")
            if not self.cfg.get("token"): reasons.append("token leer")
            if not self.cfg.get("chat_id"): reasons.append("chat_id leer")
            log.info("[Telegram] Deaktiviert: %s", ", ".join(reasons) if reasons else "unbekannt")
        else:
            log.info("[Telegram] Aktiv: chat_id=%s token=%s…", self.chat_id, self.token[:8] if self.token else "")
        self.store = store
        self.runtimes = runtimes or {}
        self.global_cfg = global_cfg
        self.timelapse_builder = timelapse_builder
        self.settings_store = settings_store
        self.thread = None

    def _cfg(self):
        return self.global_cfg() if callable(self.global_cfg) else (self.global_cfg or {})

    def start_polling(self):
        if not self.enabled or (self.thread and self.thread.is_alive()):
            return
        self.thread = Thread(target=self._run_polling, daemon=True)
        self.thread.start()

    def _run_polling(self):
        try:
            app = ApplicationBuilder().token(self.token).build()
            app.add_handler(CommandHandler("start", self.cmd_menu))
            app.add_handler(CommandHandler("menu", self.cmd_menu))
            app.add_handler(CommandHandler("status", self.cmd_status))
            app.add_handler(CommandHandler("today", self.cmd_today))
            app.add_handler(CommandHandler("week", self.cmd_week))
            app.add_handler(CommandHandler("stats", self.cmd_today))
            app.add_handler(CallbackQueryHandler(self.on_callback))
            app.run_polling(drop_pending_updates=True, close_loop=False, stop_signals=None)
        except Exception as e:
            print(f"Telegram polling konnte nicht starten: {e}")

    def log_action(self, action: str, camera_id: str | None = None, extra: dict | None = None):
        if self.settings_store:
            self.settings_store.log_action({
                "time": datetime.now().isoformat(timespec="seconds"),
                "action": action,
                "camera_id": camera_id,
                "extra": extra or {},
            })

    def _dashboard_url(self):
        return self._cfg().get("server", {}).get("public_base_url", "")

    def _camera_menu(self, action: str):
        rows = []
        row = []
        for idx, (cam_id, rt) in enumerate(self.runtimes.items(), start=1):
            row.append(InlineKeyboardButton(rt.status().get("name", cam_id), callback_data=f"{action}:{cam_id}"))
            if idx % 2 == 0:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton("⬅️ Hauptmenü", callback_data="menu:root")])
        return InlineKeyboardMarkup(rows)

    def _main_menu(self):
        return InlineKeyboardMarkup([
            [InlineKeyboardButton("📷 Live-Bild", callback_data="menu:snapshot"), InlineKeyboardButton("🎥 Live 5s Clip", callback_data="menu:clip")],
            [InlineKeyboardButton("⏱ Letzte 24h Zeitraffer", callback_data="menu:timelapse"), InlineKeyboardButton("🕘 Letzte Erkennungen", callback_data="menu:detections")],
            [InlineKeyboardButton("📊 Statistiken", callback_data="menu:stats"), InlineKeyboardButton("🛡 Scharf / Unscharf", callback_data="menu:arm")],
            [InlineKeyboardButton("🖥 Dashboard", url=self._dashboard_url() or "https://example.invalid")],
        ])

    def _summary_text(self, days: int):
        summary = self.store.aggregate_summary(days=days) if self.store else {"days": days, "total_events": 0}
        head = f"📊 Statistik {'heute' if days == 1 else f'letzte {days} Tage'}\n"
        head += f"Gesamt-Events: {summary.get('total_events', 0)}\n"
        if summary.get("per_camera"):
            head += "\nKameras:\n" + "\n".join(f"• {cam}: {cnt}" for cam, cnt in summary["per_camera"].items())
        if summary.get("top_objects"):
            head += "\n\nTop Objekte:\n" + "\n".join(f"• {lab}: {cnt}" for lab, cnt in summary["top_objects"][:5])
        return head

    async def cmd_menu(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        self.log_action("menu_open")
        await update.message.reply_text("Garden Monitor Menü", reply_markup=self._main_menu())

    async def cmd_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        lines = ["🟢 Garden Monitor Status"]
        for cam_id, rt in self.runtimes.items():
            s = rt.status()
            lines.append(f"• {s['name']}: {s['status']} · heute {s['today_events']} · {'armed' if s.get('armed') else 'disarmed'}")
        await update.message.reply_text("\n".join(lines), reply_markup=self._main_menu())

    async def cmd_today(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await update.message.reply_text(self._summary_text(days=1), reply_markup=self._main_menu())

    async def cmd_week(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        await update.message.reply_text(self._summary_text(days=7), reply_markup=self._main_menu())

    async def on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        q = update.callback_query
        await q.answer()
        data = q.data or ""
        if data == "menu:root":
            self.log_action("menu_root")
            await q.edit_message_text("Garden Monitor Menü", reply_markup=self._main_menu())
            return
        if data.startswith("menu:"):
            action = data.split(":", 1)[1]
            self.log_action(f"menu_{action}")
            if action in {"snapshot", "clip", "timelapse", "detections", "arm"}:
                await q.edit_message_text(f"Kamera wählen · {action}", reply_markup=self._camera_menu(action))
                return
            if action == "stats":
                await q.edit_message_text(self._summary_text(days=1), reply_markup=self._main_menu())
                return
        if ":" not in data:
            return
        action, cam_id = data.split(":", 1)
        rt = self.runtimes.get(cam_id)
        if not rt:
            await q.edit_message_text("Kamera nicht verfügbar.", reply_markup=self._main_menu())
            return
        self.log_action(action, cam_id)
        if action == "snapshot":
            jpeg = rt.snapshot_jpeg()
            if not jpeg:
                await q.edit_message_text("Kein Live-Bild verfügbar.", reply_markup=self._main_menu())
                return
            bio = BytesIO(jpeg); bio.name = f"{cam_id}.jpg"
            await context.bot.send_photo(chat_id=q.message.chat_id, photo=bio, caption=f"📷 {rt.status().get('name', cam_id)}")
            return
        if action == "clip":
            url = f"{self._dashboard_url().rstrip('/')}/api/camera/{cam_id}/stream.mjpg" if self._dashboard_url() else ""
            await q.edit_message_text(f"🎥 5s Live-Clip Placeholder\n{rt.status().get('name', cam_id)}\n{url}", reply_markup=self._main_menu())
            return
        if action == "timelapse":
            day = datetime.now().strftime("%Y-%m-%d")
            path = self.timelapse_builder.build_for_day(cam_id, day, fps=int(((self._cfg().get('cameras') or [{}])[0].get('timelapse') or {}).get('fps', 12)), force=False) if self.timelapse_builder else None
            if not path:
                await q.edit_message_text(f"Kein Zeitraffer für {cam_id} verfügbar.", reply_markup=self._main_menu())
                return
            rel = str(path).split("/app/storage/")[-1]
            base = self._dashboard_url().rstrip("/")
            await q.edit_message_text(f"⏱ Letzte 24h Zeitraffer\n{rt.status().get('name', cam_id)}\n{base}/media/{rel}", reply_markup=self._main_menu())
            return
        if action == "detections":
            ev = self.store.list_events(cam_id, limit=5)
            text = [f"🕘 Letzte Erkennungen · {rt.status().get('name', cam_id)}"]
            for e in ev:
                text.append(f"• {e.get('time','')} · {', '.join(e.get('labels', []))} · {e.get('alarm_level', 'info')}")
            await q.edit_message_text("\n".join(text), reply_markup=self._main_menu())
            return
        if action == "arm":
            cam = next((c for c in self._cfg().get("cameras", []) if c.get("id") == cam_id), None)
            if cam:
                cam["armed"] = not bool(cam.get("armed", True))
            if self.settings_store:
                current = self.settings_store.get_camera(cam_id)
                if current:
                    current["armed"] = not bool(current.get("armed", True))
                    self.settings_store.upsert_camera(current)
            await q.edit_message_text(f"🛡 {rt.status().get('name', cam_id)} ist jetzt {'armed' if (self.settings_store.get_camera(cam_id) or {}).get('armed', True) else 'disarmed'}.", reply_markup=self._main_menu())

    async def send_alert(self, caption: str, jpeg_bytes: bytes | None = None, snapshot_url: str | None = None, dashboard_url: str | None = None, camera_id: str | None = None):
        if not self.enabled or not self.bot:
            log.debug("[Telegram] send_alert übersprungen (enabled=%s, bot=%s)", self.enabled, self.bot is not None)
            return
        buttons = [[
            InlineKeyboardButton("📷 Live-Bild", callback_data=f"snapshot:{camera_id}" if camera_id else "menu:snapshot"),
            InlineKeyboardButton("🎥 Live 5s Clip", callback_data=f"clip:{camera_id}" if camera_id else "menu:clip"),
        ], [
            InlineKeyboardButton("⏱ Letzte 24h Zeitraffer", callback_data=f"timelapse:{camera_id}" if camera_id else "menu:timelapse"),
            InlineKeyboardButton("🕘 Last detections", callback_data=f"detections:{camera_id}" if camera_id else "menu:detections"),
        ]]
        if dashboard_url:
            buttons.append([InlineKeyboardButton("🖥 Dashboard", url=dashboard_url)])
        markup = InlineKeyboardMarkup(buttons)
        self.log_action("alert_sent", camera_id)
        log.info("[Telegram] Alert senden → chat_id=%s caption=%s…", self.chat_id, caption[:60])
        try:
            if jpeg_bytes:
                bio = BytesIO(jpeg_bytes); bio.name = "alert.jpg"
                await self.bot.send_photo(chat_id=self.chat_id, photo=bio, caption=caption, reply_markup=markup)
            else:
                await self.bot.send_message(chat_id=self.chat_id, text=caption, reply_markup=markup)
            log.info("[Telegram] Alert erfolgreich gesendet (camera_id=%s)", camera_id)
        except Exception as e:
            log.error("[Telegram] Alert FEHLER (camera_id=%s): %s", camera_id, e)
            raise

    def send_alert_sync(self, *args, **kwargs):
        if not self.enabled:
            log.debug("[Telegram] send_alert_sync übersprungen (nicht aktiv)")
            return
        try:
            asyncio.run(self.send_alert(*args, **kwargs))
        except Exception as e:
            log.error("[Telegram] send_alert_sync Fehler: %s", e)

from __future__ import annotations
from io import BytesIO
from threading import Thread, Lock
from datetime import datetime, timedelta
from pathlib import Path
import asyncio
import logging
import time

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

from .telegram_helpers import (
    LABEL_DE,
    LABEL_WEIGHT,
    OBJECT_LABELS,
    DULL_BIRDS,
    most_specific_label,
    is_quiet_now,
    is_night,
    truncate_caption,
)

log = logging.getLogger(__name__)

# Telegram limits enforced before send. sendPhoto rejects > 10 MB; sendVideo
# tops out at 50 MB; both fall through to sendDocument when exceeded.
_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024
_VIDEO_LIMIT_BYTES = 50 * 1024 * 1024

# ── Persistent reply keyboard (4 buttons in 2 rows) ──────────────────────────
# Telegram persists this server-side after the first message that includes it,
# so it stays visible under the input field across sessions. Every plain
# outbound send (no inline buttons) reattaches it as reply_markup so a user
# who installs the bot fresh sees the keyboard on the very first message.
ACTION_MENU = "🏠 Menü"
# Legacy text actions — no longer on the persistent keyboard but kept
# as constants because the slash-command handlers (/live, /clip, …)
# and the inline-button callbacks reuse the same _handle_* methods.
ACTION_LIVE = "📷 Live-Bild"
ACTION_CLIP = "🎬 5 s Clip"
ACTION_STATUS = "📊 Status"
ACTION_MUTE = "🔇 Alles still 1 h"
ACTION_CAMS = "📹 Kameras"

PERSISTENT_KEYBOARD = ReplyKeyboardMarkup(
    keyboard=[
        # Single row, single button — every navigation step now happens via
        # inline-button callbacks that edit the anchor message in place.
        # The chat history only grows when the user actually requests
        # deliverable content (snapshot, clip, mute confirm); navigation
        # is invisible to the chat log.
        [KeyboardButton(ACTION_MENU)],
    ],
    resize_keyboard=True,
    is_persistent=True,
    one_time_keyboard=False,
)

# Runtime store key for the per-chat anchor message (chat_id + message_id).
ANCHOR_KEY = "telegram_anchor"
# Runtime store key for the set of chat_ids that already have the persistent
# reply keyboard cached client-side. Telegram persists ReplyKeyboardMarkup on
# the device after one delivery, so we attach it exactly once per chat in a
# tiny one-shot message; every subsequent menu render carries inline markup
# only and arrives with buttons in a single API call.
PERSISTENT_KB_KEY = "telegram_persistent_kb_chats"

# ── Slash-command catalogue (sent to Telegram via setMyCommands) ─────────────
BOT_COMMANDS = [
    BotCommand("live", "Live-Bild aller / einer Kamera"),
    BotCommand("clip", "5-s-Clip einer Kamera"),
    BotCommand("status", "System- und Kamera-Status"),
    BotCommand("mute", "Alle Pushes 1 h still"),
    BotCommand("menu", "Hauptmenü mit Drilldowns"),
]

# Mute durations in seconds (referenced by the 4-h-extend inline button).
_MUTE_DEFAULT_S = 3600
_MUTE_EXTEND_S = 4 * 3600


class TelegramService:
    def __init__(self, cfg: dict, store=None, runtimes=None, global_cfg=None,
                 timelapse_builder=None, settings_store=None):
        self.cfg = cfg or {}
        self.push_cfg: dict = self.cfg.get("push") or {}
        self.enabled = bool(self.cfg.get("enabled") and self.cfg.get("token") and self.cfg.get("chat_id"))
        self.chat_id = str(self.cfg.get("chat_id", ""))
        self.token = self.cfg.get("token", "")
        self.bot = Bot(self.token) if self.enabled else None
        if not self.enabled:
            reasons = []
            if not self.cfg.get("enabled"): reasons.append("enabled=false")
            if not self.cfg.get("token"): reasons.append("token leer")
            if not self.cfg.get("chat_id"): reasons.append("chat_id leer")
            log.info("[tg] Deaktiviert: %s", ", ".join(reasons) if reasons else "unbekannt")
        else:
            log.info("[tg] Aktiv: chat_id=%s token=%s…", self.chat_id, self.token[:8] if self.token else "")
        self.store = store
        # Preserve identity of the caller's runtimes dict — `runtimes or {}`
        # would replace an empty-but-non-None dict (which is falsy) with a
        # fresh local {}, severing the live reference. The bot was then
        # stuck with a permanently empty registry while the server kept
        # populating its own dict, causing every cam:*:livebild callback
        # to fall through to "Kamera nicht erreichbar — Runtime startet noch."
        self.runtimes = runtimes if runtimes is not None else {}
        self.global_cfg = global_cfg
        self.timelapse_builder = timelapse_builder
        self.settings_store = settings_store
        # ── Threads & loop ─────────────────────────────────────────────────
        # Two asyncio loops live in this process for telegram:
        #   - send-loop: ours, dedicated thread, used by self.send() so 100
        #     sends in a row never recreate a loop nor hit "loop is closed".
        #   - polling-loop: also ours (no longer PTB's run_polling), so we
        #     can signal a clean shutdown cross-thread via _polling_stop_event
        #     and tear down updater/app via the documented coroutines. This
        #     is the only safe way to free Telegram's getUpdates slot before
        #     a fresh instance starts polling against the same bot token.
        self._poll_thread: Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: Thread | None = None
        self._polling_app = None
        self._polling_loop: asyncio.AbstractEventLoop | None = None
        self._polling_stop_event: asyncio.Event | None = None
        self._polling_active_since: float | None = None
        self._last_conflict_ts: float | None = None
        self._scheduler = None
        self._lifecycle_lock = Lock()
        self._stopped = False
        # ── Rate limit (in-memory, per-cam) ────────────────────────────────
        self._rate_lock = Lock()
        self._rate_cache: dict[str, float] = {}
        self._RATE_CACHE_MAX = 100

    # ── Config plumbing ───────────────────────────────────────────────────
    def _cfg(self):
        return self.global_cfg() if callable(self.global_cfg) else (self.global_cfg or {})

    def _camera_cfg(self, cam_id: str) -> dict | None:
        for c in self._cfg().get("cameras", []) or []:
            if c.get("id") == cam_id:
                return c
        return None

    def _dashboard_url(self):
        return self._cfg().get("server", {}).get("public_base_url", "")

    def _event_deep_link_url(self, event_id: str | None) -> str:
        """Build a #/event/<id> deep-link into the web-UI lightbox.
        Returns "" when public_base_url is unset or event_id is missing —
        callers should drop the button silently in that case."""
        if not event_id:
            return ""
        base = (self._dashboard_url() or "").rstrip("/")
        if not base:
            return ""
        from urllib.parse import quote
        return f"{base}/#/event/{quote(str(event_id), safe='')}"

    def _sighting_deep_link_url(self, sighting_id: str | None) -> str:
        if not sighting_id:
            return ""
        base = (self._dashboard_url() or "").rstrip("/")
        if not base:
            return ""
        from urllib.parse import quote
        return f"{base}/#/sighting/{quote(str(sighting_id), safe='')}"

    def _recap_deep_link_url(self, recap_id: str | None) -> str:
        if not recap_id:
            return ""
        base = (self._dashboard_url() or "").rstrip("/")
        if not base:
            return ""
        from urllib.parse import quote
        return f"{base}/#/recap/{quote(str(recap_id), safe='')}"

    def _storage_root(self) -> Path:
        return Path(self._cfg().get("storage", {}).get("root", "/app/storage"))

    # ── Lifecycle ─────────────────────────────────────────────────────────
    # Lifecycle contract: TelegramService instances are started exactly once
    # via start(), stopped exactly once via stop(). To apply new config
    # (token, chat, push schedule), the ONLY supported path is constructing
    # a new instance — see server._reload_telegram_service(). There is no
    # in-place reload(), because in-place token swaps cannot reliably free
    # Telegram's getUpdates slot before the new poll starts, which is the
    # source of the "Conflict: terminated by other getUpdates" loop.
    def start(self):
        """Boot polling, dedicated send-loop, scheduler, and default jobs.

        Idempotent: a second call while already running is a no-op."""
        with self._lifecycle_lock:
            if self._stopped:
                log.warning("[tg] Start ignored: instance already stopped")
                return
            if self._loop_thread and self._loop_thread.is_alive():
                log.debug("[tg] Start ignored: already running")
                return
            if not self.enabled:
                log.info("[tg] Start skipped — service disabled")
                return
            log.info("[tg] Starting (token=%s…)", self.token[:8] if self.token else "")
            # Send loop on dedicated thread — owned by us, not by PTB.
            self._loop = asyncio.new_event_loop()
            self._loop_thread = Thread(target=self._run_send_loop, daemon=True, name="tg-send-loop")
            self._loop_thread.start()
            # Polling thread (we drive Application's lifecycle manually so
            # we can stop it cross-thread).
            self._poll_thread = Thread(target=self._run_polling, daemon=True, name="tg-polling")
            self._poll_thread.start()
            # Scheduler
            try:
                from apscheduler.schedulers.background import BackgroundScheduler
                self._scheduler = BackgroundScheduler(daemon=True)
                self._scheduler.start()
                log.info("[tg] Scheduler started")
            except Exception as e:
                log.error("[tg] Scheduler start failed: %s", e)
                self._scheduler = None
            # Default push jobs
            self.register_default_jobs()

    # Back-compat alias — kept for any caller that historically used it.
    def start_polling(self):
        self.start()

    def stop(self, *, reason: str = "manual"):
        """Synchronous teardown. Stops polling first (so Telegram's getUpdates
        slot is freed before any successor instance starts), then scheduler,
        then send loop. Blocks up to ~15s total.

        After stop(), the instance is dead — call sites must build a fresh
        TelegramService to resume."""
        with self._lifecycle_lock:
            if self._stopped:
                return
            self._stopped = True
            log.info("[tg] Stopping (reason: %s)", reason)
            # 1. Polling: signal the polling loop's stop event, then join.
            if self._polling_loop is not None and self._polling_stop_event is not None:
                try:
                    loop = self._polling_loop
                    ev = self._polling_stop_event
                    loop.call_soon_threadsafe(ev.set)
                except Exception as e:
                    log.warning("[tg] polling stop signal failed: %s", e)
            if self._poll_thread and self._poll_thread.is_alive():
                self._poll_thread.join(timeout=10)
                if self._poll_thread.is_alive():
                    log.warning("[tg] Polling thread did not exit within 10s")
            self._poll_thread = None
            self._polling_app = None
            self._polling_loop = None
            self._polling_stop_event = None
            self._polling_active_since = None
            # 2. Scheduler
            try:
                if self._scheduler:
                    self._scheduler.shutdown(wait=False)
                    log.info("[tg] Scheduler stopped")
            except Exception as e:
                log.warning("[tg] scheduler shutdown failed: %s", e)
            self._scheduler = None
            # 3. Send loop
            try:
                if self._loop and self._loop.is_running():
                    self._loop.call_soon_threadsafe(self._loop.stop)
            except Exception as e:
                log.warning("[tg] send loop stop failed: %s", e)
            if self._loop_thread and self._loop_thread.is_alive():
                self._loop_thread.join(timeout=5)
            self._loop = None
            self._loop_thread = None
            log.info("[tg] Stopped")

    # Back-compat alias for any old callers.
    def shutdown(self):
        self.stop(reason="shutdown")

    def get_polling_status(self) -> dict:
        """Snapshot of the polling state for /api/telegram/status.

        States:
          off       — service disabled or polling not running
          starting  — thread alive, getUpdates not yet confirmed
          active    — getUpdates running, no recent conflict
          conflict  — Telegram returned Conflict in the last 30s
        """
        if not self.enabled:
            return {"state": "off", "since_seconds": 0, "enabled": False}
        if not (self._poll_thread and self._poll_thread.is_alive()):
            return {"state": "off", "since_seconds": 0, "enabled": True}
        now = time.time()
        if self._last_conflict_ts and (now - self._last_conflict_ts) < 30:
            return {
                "state": "conflict",
                "since_seconds": int(now - self._last_conflict_ts),
                "enabled": True,
            }
        if self._polling_active_since:
            return {
                "state": "active",
                "since_seconds": int(now - self._polling_active_since),
                "enabled": True,
            }
        return {"state": "starting", "since_seconds": 0, "enabled": True}

    def _run_send_loop(self):
        try:
            asyncio.set_event_loop(self._loop)
            self._loop.run_forever()
        except Exception as e:
            log.error("[tg] send loop crashed: %s", e)
        finally:
            try:
                self._loop.close()
            except Exception:
                pass

    def _run_polling(self):
        """Owns its own asyncio loop and runs Application's full lifecycle
        manually (initialize / start / updater.start_polling / wait / teardown),
        so stop() can signal a clean shutdown cross-thread via the stop event."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._polling_loop = loop
        self._polling_stop_event = asyncio.Event()
        try:
            loop.run_until_complete(self._polling_main())
        except Exception as e:
            log.error("[tg] polling thread crashed: %s", e, exc_info=True)
        finally:
            try:
                loop.close()
            except Exception:
                pass
            self._polling_active_since = None
            log.info("[tg] Polling thread exited")

    async def _polling_main(self):
        app = ApplicationBuilder().token(self.token).build()
        self._polling_app = app
        # Slash commands shown in the "/" picker. /status now renders the
        # system overview (was: cam picker) — the cam-arm UI lives behind
        # /menu → 🛠 Kamera-Status.
        app.add_handler(CommandHandler("start", self.cmd_menu))
        app.add_handler(CommandHandler("menu", self.cmd_menu))
        app.add_handler(CommandHandler("status", self._handle_status))
        app.add_handler(CommandHandler("live", self._handle_livebild))
        app.add_handler(CommandHandler("clip", self._handle_clip5))
        app.add_handler(CommandHandler("mute", self._handle_mute_all))
        app.add_handler(CommandHandler("today", self.cmd_today))
        app.add_handler(CommandHandler("week", self.cmd_week))
        app.add_handler(CommandHandler("stats", self.cmd_today))
        # Reply-keyboard text dispatch — anything that's not a /command
        # routes through on_text, which matches the four button labels.
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self.on_text))
        app.add_handler(CallbackQueryHandler(self.on_callback))
        app.add_error_handler(self._on_polling_error)
        try:
            await app.initialize()
            await app.start()
            await app.updater.start_polling(drop_pending_updates=True)
            self._polling_active_since = time.time()
            log.info("[tg] Polling active")
            # Register the slash-command catalogue serverside. Idempotent —
            # Telegram dedups by command name. Failure here is non-fatal:
            # the handlers still work, the user just doesn't see auto-
            # complete in the "/" picker.
            try:
                await app.bot.set_my_commands(BOT_COMMANDS)
                log.info("[tg] Bot commands registered: %s",
                         ", ".join(c.command for c in BOT_COMMANDS))
            except Exception as e:
                log.warning("[tg] set_my_commands failed: %s", e)
            await self._polling_stop_event.wait()
        finally:
            log.info("[tg] Polling shutting down")
            try:
                if app.updater and app.updater.running:
                    await app.updater.stop()
            except Exception as e:
                log.warning("[tg] updater.stop failed: %s", e)
            try:
                if app.running:
                    await app.stop()
            except Exception as e:
                log.warning("[tg] app.stop failed: %s", e)
            try:
                await app.shutdown()
            except Exception as e:
                log.warning("[tg] app.shutdown failed: %s", e)

    async def _on_polling_error(self, update, context):
        """Catches polling errors and decides log severity.

        - Conflict: stale-instance race; log warn + back off 10 s.
        - NetworkError / TimedOut (and their subclasses): transient httpx
          drops, DNS hiccups, ``Server disconnected without sending a
          response``. PTB retries internally — we just log a one-liner at
          WARNING so the operator can spot a sustained outage in the log
          tail without drowning in stack traces from ten-second blips.
        - Anything else: keep the ERROR + stack trace (real bug)."""
        err = context.error
        if isinstance(err, Conflict):
            self._last_conflict_ts = time.time()
            log.warning("[tg] Polling conflict (likely stale instance). Backing off 10 s.")
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                return
            return
        if isinstance(err, (NetworkError, TimedOut)):
            log.warning("[tg] Transient polling network error: %s", err)
            return
        log.error("[tg] Update error: %s", err, exc_info=True)

    # ── Scheduler API ─────────────────────────────────────────────────────
    def schedule_daily(self, hh: int, mm: int, key: str, callback):
        if not self._scheduler:
            return
        from apscheduler.triggers.cron import CronTrigger
        self._scheduler.add_job(
            callback, CronTrigger(hour=hh, minute=mm),
            id=key, replace_existing=True, max_instances=1, coalesce=True,
        )

    def schedule_interval(self, seconds: int, key: str, callback):
        if not self._scheduler:
            return
        from apscheduler.triggers.interval import IntervalTrigger
        self._scheduler.add_job(
            callback, IntervalTrigger(seconds=int(seconds)),
            id=key, replace_existing=True, max_instances=1, coalesce=True,
        )

    def schedule_at(self, when_dt: datetime, key: str, callback):
        if not self._scheduler:
            return
        from apscheduler.triggers.date import DateTrigger
        self._scheduler.add_job(
            callback, DateTrigger(run_date=when_dt),
            id=key, replace_existing=True,
        )

    def cancel_all_jobs(self):
        if not self._scheduler:
            return
        try:
            self._scheduler.remove_all_jobs()
        except Exception as e:
            log.warning("[tg] cancel_all_jobs failed: %s", e)

    def register_default_jobs(self):
        """(Re-)register the standard push schedule.

        Called from start() and after every reload — cancel_all_jobs first
        guarantees no stale duplicates fire. Each job re-checks its own
        enabled flag inside the callback, so re-registration is cheap and
        always reflects the current settings.
        """
        if not self._scheduler:
            return
        self.cancel_all_jobs()
        pcfg = self.push_cfg
        if not pcfg.get("enabled", True):
            log.info("[tg] Push disabled — no default jobs registered")
            return
        if pcfg.get("daily_report", {}).get("enabled", True):
            hh, mm = _parse_hhmm(pcfg["daily_report"].get("time", "22:00"))
            self.schedule_daily(hh, mm, "tg_daily_report", self._job_daily_report)
        if pcfg.get("highlight", {}).get("enabled", True):
            hh, mm = _parse_hhmm(pcfg["highlight"].get("time", "19:00"))
            self.schedule_daily(hh, mm, "tg_highlight", self._job_highlight)
        if pcfg.get("system", {}).get("enabled", True):
            self.schedule_interval(60, "tg_watchdog", self._job_watchdog)
        try:
            jobs = [j.id for j in self._scheduler.get_jobs()]
            log.info("[tg] Registered jobs: %s", jobs)
        except Exception:
            pass

    # ── Action log helper ─────────────────────────────────────────────────
    def log_action(self, action: str, camera_id: str | None = None, extra: dict | None = None):
        if self.settings_store:
            self.settings_store.log_action({
                "time": datetime.now().isoformat(timespec="seconds"),
                "action": action,
                "camera_id": camera_id,
                "extra": extra or {},
            })

    # ── Send API ──────────────────────────────────────────────────────────
    def send(self, text: str, **kwargs):
        """Sync entry point — schedules send_alert on the dedicated loop.

        Returns the concurrent.futures.Future so callers can wait if they
        care; most fire-and-forget code ignores it."""
        if not self.enabled or not self._loop:
            log.debug("[tg] send skipped (enabled=%s, loop=%s)", self.enabled, bool(self._loop))
            return None
        try:
            return asyncio.run_coroutine_threadsafe(self.send_alert(text, **kwargs), self._loop)
        except Exception as e:
            log.error("[tg] send dispatch failed: %s", e)
            return None

    def _build_markup(self, buttons) -> InlineKeyboardMarkup | None:
        """Buttons spec: list[list[(label, data_or_url)]] → InlineKeyboardMarkup.

        URLs are detected by 'http://' / 'https://' prefix on the second
        tuple element; everything else becomes callback_data."""
        if not buttons:
            return None
        rows = []
        for row in buttons:
            built_row = []
            for entry in row:
                if not entry or len(entry) < 2:
                    continue
                label, payload = entry[0], entry[1]
                if isinstance(payload, str) and (payload.startswith("http://") or payload.startswith("https://")):
                    built_row.append(InlineKeyboardButton(label, url=payload))
                else:
                    # Telegram callback_data hard limit: 64 bytes.
                    cb = str(payload)[:64]
                    built_row.append(InlineKeyboardButton(label, callback_data=cb))
            if built_row:
                rows.append(built_row)
        return InlineKeyboardMarkup(rows) if rows else None

    @staticmethod
    def _prepare_input(src, default_name: str):
        """Accept bytes OR a filesystem path; return something send_photo
        / send_video / send_document can swallow."""
        if isinstance(src, (bytes, bytearray)):
            bio = BytesIO(bytes(src)); bio.name = default_name
            return bio
        if isinstance(src, (str, Path)):
            return open(str(src), "rb")
        return src

    @staticmethod
    def _src_size_bytes(src) -> int:
        if isinstance(src, (bytes, bytearray)):
            return len(src)
        if isinstance(src, (str, Path)):
            try:
                return Path(str(src)).stat().st_size
            except Exception:
                return 0
        return 0

    async def send_alert(self, text: str = "", *, photo=None, video=None,
                         buttons=None, parse_mode: str = "HTML",
                         silent: bool = False, dark: bool = False,
                         reply_to: int | None = None):
        """Unified send. `photo`/`video` accept bytes or a filesystem path.
        Auto-falls-back to sendDocument when limits are exceeded."""
        if not self.enabled or not self.bot:
            log.info("[tg] send_alert skipped (enabled=%s, bot=%s)", self.enabled, self.bot is not None)
            return
        if dark:
            log.info("[tg] dark/night alert")
        # Inline buttons win — Telegram only allows one reply_markup per
        # message, so when an alert carries Gültig/Falsch/Stumm we send those
        # and the persistent reply keyboard stays visible from the previous
        # message. When no inline buttons are present, reattach the
        # persistent keyboard so it always appears under the input field.
        markup = self._build_markup(buttons)
        if markup is None:
            markup = PERSISTENT_KEYBOARD
        common = dict(chat_id=self.chat_id, reply_markup=markup, disable_notification=bool(silent))
        if parse_mode:
            common["parse_mode"] = parse_mode
        if reply_to:
            common["reply_to_message_id"] = reply_to
        caption = truncate_caption(text or "")
        try:
            if video is not None:
                size = self._src_size_bytes(video)
                src = self._prepare_input(video, "video.mp4")
                if size and size > _VIDEO_LIMIT_BYTES:
                    log.info("[tg] video > 50MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_video(video=src, caption=caption, **common)
            elif photo is not None:
                size = self._src_size_bytes(photo)
                src = self._prepare_input(photo, "photo.jpg")
                if size and size > _PHOTO_LIMIT_BYTES:
                    log.info("[tg] photo > 10MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_photo(photo=src, caption=caption, **common)
            else:
                msg = await self.bot.send_message(text=text or "", **common)
            log.info("[tg] send_alert ok (chat=%s silent=%s)", self.chat_id, silent)
            return msg
        except Exception as e:
            log.error("[tg] send_alert failed: %s", e)
            return None

    # Legacy sync wrapper (kept for the achievement push and the test endpoint).
    # Footer buttons used to include "24 h Zeitraffer" and "Last detections"
    # but those are reachable via /menu and only added clutter to event
    # bubbles. Callback strings now match the cam:<id>:* dispatcher so the
    # buttons actually route — the old "snapshot:<id>" / "clip:<id>" prefixes
    # were never registered and silently no-op'd on click.
    def send_alert_sync(self, caption: str, jpeg_bytes: bytes | None = None,
                        snapshot_url: str | None = None,
                        dashboard_url: str | None = None,
                        camera_id: str | None = None):
        if not self.enabled:
            return
        buttons = []
        if camera_id:
            buttons.append([
                ("📷 Livebild", f"cam:{camera_id}:livebild"[:64]),
                ("🎬 5 s Clip", f"cam:{camera_id}:clip:5"[:64]),
            ])
        if dashboard_url:
            buttons.append([("🖥 Dashboard", dashboard_url)])
        self.send(caption, photo=jpeg_bytes, buttons=buttons, parse_mode=None)

    # ── Push pipeline ─────────────────────────────────────────────────────
    def _is_suppressed(self, cam_id: str, label: str) -> bool:
        key = f"{cam_id}|{label}"
        suppress = self.settings_store.runtime_get("suppress") if self.settings_store else None
        if not isinstance(suppress, dict):
            return False
        until = suppress.get(key, 0) or 0
        return time.time() < float(until)

    def _is_rate_limited(self, cam_id: str) -> bool:
        rl = float(self.push_cfg.get("rate_limit_seconds", 30) or 0)
        if rl <= 0:
            return False
        with self._rate_lock:
            last = self._rate_cache.get(cam_id, 0.0)
            return (time.time() - last) < rl

    def _record_rate_limit(self, cam_id: str):
        with self._rate_lock:
            self._rate_cache[cam_id] = time.time()
            # LRU-bound the cache so a long list of camera ids can't grow forever.
            while len(self._rate_cache) > self._RATE_CACHE_MAX:
                self._rate_cache.pop(next(iter(self._rate_cache)))

    def _is_night_for_camera(self, cam_id: str | None) -> bool:
        return is_night(self.push_cfg.get("night_alert") or {})

    def _is_quiet_now(self) -> bool:
        return is_quiet_now(self.push_cfg.get("quiet_hours") or {})

    def send_event_alert(self, meta: dict, camera_id: str, snapshot_path: str | Path | None = None):
        """Push entry point used by the camera runtime after an event is finalized.

        Decides — based on push.labels[primary], suppress, rate-limit and
        quiet/night state — whether and how to alert. Caller is expected
        to have already written the event to disk."""
        if not self.enabled:
            return
        pcfg = self.push_cfg or {}
        if not pcfg.get("enabled", True):
            log.debug("[tg] push: disabled")
            return
        # Global + per-camera mute. Both gates honour the same "_until"
        # epoch contract: 0 / past = no mute, future = active. Daily
        # reports / highlights / watchdog go through their own jobs and
        # stay silent-by-design — they bypass this gate entirely.
        if self.settings_store:
            try:
                global_mute = float(self.settings_store.runtime_get("global_mute_until") or 0)
            except Exception:
                global_mute = 0
            if global_mute and time.time() < global_mute:
                log.info("[tg] skip: global mute active until epoch=%d", int(global_mute))
                return
            try:
                cam_mute = float(self.settings_store.runtime_get_subkey(
                    "cam_mute_until", camera_id, 0) or 0)
            except Exception:
                cam_mute = 0
            if cam_mute and time.time() < cam_mute:
                log.info("[tg] skip: cam %s muted until epoch=%d",
                         camera_id, int(cam_mute))
                return
        labels = meta.get("labels") or []
        primary = most_specific_label(labels)
        label_cfg = (pcfg.get("labels") or {}).get(primary, {})
        if not label_cfg.get("push", False):
            log.warning("[tg] skip: %s push disabled (cam=%s)", primary, camera_id)
            return
        # Top score for the primary label specifically — fall back to the
        # event's overall top detection if the primary isn't a CV label.
        detections = meta.get("detections") or []
        top_score = max(
            (float(d.get("score", 0.0)) for d in detections if d.get("label") == primary),
            default=0.0,
        )
        if top_score == 0.0 and detections:
            top_score = max((float(d.get("score", 0.0)) for d in detections), default=0.0)
        threshold = float(label_cfg.get("threshold", 0.0) or 0.0)
        if top_score < threshold:
            log.warning("[tg] skip: %s score=%.2f < threshold=%.2f (cam=%s)",
                        primary, top_score, threshold, camera_id)
            return
        if self._is_suppressed(camera_id, primary):
            log.warning("[tg] skip: suppressed %s/%s", camera_id, primary)
            return
        if self._is_rate_limited(camera_id):
            log.warning("[tg] skip: rate-limited %s", camera_id)
            return

        cam_cfg = self._camera_cfg(camera_id) or {}
        # Per-camera notification schedule gate. Outside the configured
        # schedule_notify window the push is suppressed. Daily reports /
        # highlights / watchdog are system-level and are not gated by
        # this — they go through their own jobs. Falls back to the
        # legacy schedule.actions.telegram check for cameras that
        # haven't been migrated yet (the boot-time
        # _migrate_alerting_schedules in settings_store catches them on
        # next start).
        from .event_logic import is_schedule_window_active, schedule_action_active as _sched_act
        sch_notify = cam_cfg.get("schedule_notify")
        if isinstance(sch_notify, dict) and sch_notify:
            if not is_schedule_window_active(sch_notify):
                log.warning("[tg] skip: schedule_notify blocks telegram (cam=%s)", camera_id)
                return
        else:
            if not _sched_act(cam_cfg.get("schedule") or {}, "telegram"):
                log.warning("[tg] skip: legacy schedule blocks telegram (cam=%s)", camera_id)
                return
        cam_name = cam_cfg.get("name") or camera_id
        is_armed = bool(cam_cfg.get("armed", True))
        is_night_now = self._is_night_for_camera(camera_id)
        is_quiet = self._is_quiet_now()
        night_cfg = pcfg.get("night_alert") or {}
        night_wakeup = (
            bool(night_cfg.get("enabled", True))
            and is_night_now
            and (not night_cfg.get("armed_only", True) or is_armed)
        )
        # Quiet hours → silent push, unless the alert qualifies as a
        # "wakeup at night" — those must always ring through.
        silent = is_quiet and not night_wakeup

        eid = meta.get("event_id") or datetime.now().strftime("%Y%m%d-%H%M%S")
        score_pct = int(round(top_score * 100))
        caption = f"<b>{LABEL_DE.get(primary, primary)}</b> · {score_pct}% · {cam_name}"

        buttons = [
            [("✅ Gültig", f"ev:{eid}:ok"),
             ("❌ Falsch", f"ev:{eid}:no")],
            [("🔇 1 h still", f"ev:{eid}:m1h")],
        ]
        if night_wakeup and is_armed:
            buttons[1].append(("🚨 Sirene", f"ev:{eid}:siren"))
        # Live-action row: snapshot now / 5 s clip now. Re-uses the same
        # cam:<id>:livebild and cam:<id>:clip:5 callbacks the /menu picker
        # already routes — single source of truth, no parallel dispatcher.
        buttons.append([
            ("📷 Livebild", f"cam:{camera_id}:livebild"[:64]),
            ("🎬 5 s Clip", f"cam:{camera_id}:clip:5"[:64]),
        ])
        # Deep-link to the lightbox in the web UI — only when public_base_url
        # is configured AND the event has a stored event_id. Lets the user
        # jump straight to the persisted event without hunting through the
        # mediathek. URL buttons are detected by the http(s):// prefix in
        # _build_markup; no callback_data needed.
        deep_link = self._event_deep_link_url(eid)
        if deep_link:
            buttons.append([("🌐 In App öffnen", deep_link)])

        if self.settings_store:
            self.settings_store.runtime_alert_index_set(eid, {
                "cam":   camera_id,
                "label": primary,
                "ts":    time.time(),
            })

        photo = meta.get("thumb_bytes")
        if photo is None and snapshot_path:
            photo = str(snapshot_path)
        self.send(caption, photo=photo, buttons=buttons, silent=silent, dark=is_night_now)
        self._record_rate_limit(camera_id)
        log.info("[tg] event alert: cam=%s label=%s score=%.2f silent=%s dark=%s",
                 camera_id, primary, top_score, silent, is_night_now)

    def send_timelapse_alert(self, video_path: str | Path, cam_name: str,
                             profile_de: str, duration_s: int, rel_path: str):
        """Fired by camera_runtime after a successful timelapse encode."""
        if not self.enabled:
            return
        if not (self.push_cfg.get("timelapse") or {}).get("enabled", True):
            return
        caption = (f"<b>Zeitraffer fertig</b>\n"
                   f"{cam_name} · {profile_de} · {duration_s}s")
        buttons = [[("💾 Speichern", f"tl:save:{rel_path}"[:64])]]
        self.send(caption, video=str(video_path), buttons=buttons, silent=True)

    # ── Scheduled jobs ────────────────────────────────────────────────────
    def _job_daily_report(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("daily_report") or {}).get("enabled", True):
                return
            cfg = self._cfg()
            cameras = cfg.get("cameras", []) or []
            today_iso = datetime.now().strftime("%Y-%m-%d")
            date_de = datetime.now().strftime("%d.%m.%Y")
            per_cam: list[tuple[str, dict]] = []
            object_set = set(OBJECT_LABELS)
            for cam in cameras:
                cam_id = cam.get("id")
                if not cam_id or not self.store:
                    continue
                events = self.store.list_events(cam_id, start=today_iso, limit=5000)
                counts: dict[str, int] = {}
                for ev in events:
                    labels = ev.get("labels") or []
                    primary = next((l for l in labels if l in object_set), None)
                    if primary is None and "motion" in labels:
                        primary = "motion"
                    if primary:
                        counts[primary] = counts.get(primary, 0) + 1
                if counts:
                    per_cam.append((cam.get("name") or cam_id, counts))
            per_cam.sort(key=lambda kv: -sum(kv[1].values()))
            lines = [f"<b>Tagesreport · {date_de}</b>", ""]
            if per_cam:
                for name, counts in per_cam:
                    chips = " · ".join(
                        f"<code>{n}</code> {LABEL_DE.get(l, l)}"
                        for l, n in sorted(counts.items(), key=lambda x: -x[1])
                        if n > 0
                    )
                    lines.append(f"{name}: {chips}")
            else:
                lines.append("Keine Erkennungen heute.")
            try:
                delta_gb = self._storage_today_delta_gb()
                if delta_gb is not None:
                    lines.append("")
                    lines.append(f"Speicher heute: + {delta_gb:.1f} GB")
            except Exception:
                pass
            buttons = [
                [("📊 Detail-Statistik", "menu:stats:today")],
                [("🎞 Tageszeitraffer", "menu:zeitraffer:today")],
            ]
            self.send("\n".join(lines), buttons=buttons, silent=True)
            log.info("[tg] daily report sent")
        except Exception as e:
            log.error("[tg] daily report job failed: %s", e)

    def _job_highlight(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("highlight") or {}).get("enabled", True):
                return
            cfg = self._cfg()
            cameras = cfg.get("cameras", []) or []
            cands = []
            cutoff_ts = time.time() - 24 * 3600
            object_set = set(OBJECT_LABELS)
            for cam in cameras:
                cam_id = cam.get("id")
                if not cam_id or not self.store:
                    continue
                events = self.store.list_events(cam_id, limit=400)
                for ev in events:
                    try:
                        ev_dt = datetime.fromisoformat(ev.get("time", ""))
                    except Exception:
                        continue
                    if ev_dt.timestamp() < cutoff_ts:
                        continue
                    labels = ev.get("labels") or []
                    primary = next((l for l in labels if l in object_set), None)
                    if not primary:
                        continue
                    if primary == "bird":
                        species = (ev.get("bird_species") or "").lower()
                        if any(d in species for d in DULL_BIRDS):
                            continue
                    detections = ev.get("detections") or []
                    top = max(
                        (float(d.get("score", 0.0)) for d in detections if d.get("label") == primary),
                        default=0.0,
                    )
                    if top < 0.70:
                        continue
                    daylight = 0.5 if ev.get("after_hours") else 1.0
                    score = top * LABEL_WEIGHT.get(primary, 1.0) * daylight
                    cands.append({
                        "score":    score,
                        "eid":      ev.get("event_id"),
                        "cam_id":   cam_id,
                        "cam_name": cam.get("name") or cam_id,
                        "label":    primary,
                        "time_hm":  ev_dt.strftime("%H:%M"),
                        "snap_rel": ev.get("snapshot_relpath"),
                    })
            if not cands:
                log.info("[tg] highlight: no candidates")
                return
            pick = max(cands, key=lambda c: c["score"])
            caption = (f"<b>✨ Highlight des Tages</b>\n"
                       f"{LABEL_DE.get(pick['label'], pick['label'])} · {pick['cam_name']} · {pick['time_hm']}")
            photo = None
            if pick["snap_rel"]:
                full = self._storage_root() / pick["snap_rel"]
                if full.exists():
                    photo = str(full)
            buttons = [
                [("🖼 Hochauflösend", f"hi:{pick['eid']}"[:64])],
                [("📤 Teilen",          f"share:{pick['eid']}"[:64])],
            ]
            if self.settings_store and pick["eid"]:
                self.settings_store.runtime_alert_index_set(pick["eid"], {
                    "cam":   pick["cam_id"],
                    "label": pick["label"],
                    "ts":    time.time(),
                })
            self.send(caption, photo=photo, buttons=buttons, silent=True)
            log.info("[tg] highlight sent: %s/%s score=%.2f",
                     pick["cam_id"], pick["eid"], pick["score"])
        except Exception as e:
            log.error("[tg] highlight job failed: %s", e)

    def _job_watchdog(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("system") or {}).get("enabled", True):
                return
            ss = self.settings_store
            if not ss:
                return
            now = time.time()
            state = ss.runtime_get("system_state") or {}
            for cam_id, rt in (self.runtimes or {}).items():
                try:
                    status = rt.status() if hasattr(rt, "status") else {}
                except Exception:
                    status = {}
                cam_name = status.get("name") or cam_id
                # Treat 'error' or stale frames as offline; 'active' / 'starting' as online.
                online = status.get("status") in ("active", "starting")
                cam_state = state.setdefault(cam_id, {"online": True, "since": now, "alert_sent": False})
                # Transition: online → offline
                if not online and cam_state.get("online", True):
                    cam_state["online"] = False
                    cam_state["since"] = now
                    cam_state["alert_sent"] = False
                # Still offline → push once after 5 min
                elif not online and not cam_state.get("alert_sent"):
                    offline_for = now - float(cam_state.get("since", now))
                    if offline_for >= 300:
                        self.send(
                            f"<b>{cam_name} offline</b> seit {int(offline_for/60)} Min · keine RTSP-Antwort",
                            buttons=[[("🔄 Neu verbinden", f"cam:{cam_id}:reconnect"[:64])],
                                     [("📋 Logs", "menu:logs")]],
                        )
                        cam_state["alert_sent"] = True
                # Recovery: offline → online
                elif online and not cam_state.get("online", True):
                    offline_for = now - float(cam_state.get("since", now))
                    if cam_state.get("alert_sent"):
                        self.send(
                            f"{cam_name} wieder online (Ausfall {int(offline_for/60)} Min)",
                            silent=True,
                        )
                    cam_state["online"] = True
                    cam_state["since"] = now
                    cam_state["alert_sent"] = False
            ss.runtime_set("system_state", state)
            # Storage check — once per 24 h while < 2 GB free.
            try:
                import shutil as _sh
                root = str(self._storage_root())
                free_gb = _sh.disk_usage(root).free / (1024 ** 3)
                last_warn = float(ss.runtime_get("last_storage_warn_ts") or 0)
                if free_gb < 2.0 and (now - last_warn) > 86400:
                    self.send(f"<b>⚠ Speicher knapp</b>: nur noch {free_gb:.1f} GB frei")
                    ss.runtime_set("last_storage_warn_ts", now)
            except Exception as e:
                log.debug("[tg] storage check failed: %s", e)
        except Exception as e:
            log.error("[tg] watchdog failed: %s", e)

    def _storage_today_delta_gb(self) -> float | None:
        """Sum bytes of media files modified today (best-effort, never raises)."""
        root = self._storage_root()
        if not root.exists():
            return None
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        total = 0
        for sub in ("motion_detection", "timelapse"):
            base = root / sub
            if not base.exists():
                continue
            for p in base.rglob("*"):
                try:
                    st = p.stat()
                    if st.st_mtime >= today_start and p.is_file():
                        total += st.st_size
                except Exception:
                    continue
        return total / (1024 ** 3)

    # ── Menu helpers — view builders ──────────────────────────────────────
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
                InlineKeyboardButton(f"🔄 Reconnect", callback_data=f"cam:{cam_id}:reconnect"),
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
                text, reply_markup=markup, parse_mode="HTML",
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

    async def _handle_livebild(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Send a snapshot or — when there are multiple cams — an inline
        cam picker. The picker buttons route through cam:<id>:livebild
        which the existing dispatcher already handles."""
        log.info("[tg] /live invoked by chat=%s", update.effective_chat.id if update.effective_chat else "?")
        cams = self._active_cams()
        if not cams:
            await update.message.reply_text("Keine Kameras konfiguriert.",
                                            reply_markup=PERSISTENT_KEYBOARD)
            return
        if len(cams) == 1:
            info = cams[0]
            icon = self._cam_status_icon_for(info)
            text, markup = ("📷 Kamera wählen — livebild",
                            InlineKeyboardMarkup([
                                [InlineKeyboardButton(f"{icon} {info['name']}",
                                                      callback_data=f"cam:{info['cam_id']}:livebild"[:64])],
                            ]))
            await update.message.reply_text(text, reply_markup=markup)
            return
        text, markup = self._cam_picker("livebild")
        await update.message.reply_text(text, reply_markup=markup, parse_mode="HTML")

    async def _handle_clip5(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """5-s clip cam picker. We deliberately don't offer 'all cams' —
        running 4 ad-hoc ffmpeg recordings in parallel pegs the host."""
        log.info("[tg] /clip invoked by chat=%s", update.effective_chat.id if update.effective_chat else "?")
        cams = self._active_cams()
        if not cams:
            await update.message.reply_text("Keine Kameras konfiguriert.",
                                            reply_markup=PERSISTENT_KEYBOARD)
            return
        rows = []
        for info in cams:
            icon = self._cam_status_icon_for(info)
            rows.append([InlineKeyboardButton(
                f"{icon} 🎬 {info['name']}",
                callback_data=f"cam:{info['cam_id']}:clip:5"[:64],
            )])
        await update.message.reply_text(
            "🎬 Kamera wählen — 5 s Clip",
            reply_markup=InlineKeyboardMarkup(rows),
        )

    async def _handle_status(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Compact system overview: cams + Telegram polling + Coral + weather + storage."""
        log.info("[tg] /status invoked by chat=%s", update.effective_chat.id if update.effective_chat else "?")
        try:
            text = self._render_system_status_text()
        except Exception as e:
            log.warning("[tg] status render failed: %s", e)
            text = "Status nicht verfügbar."
        await update.message.reply_text(text, parse_mode="HTML",
                                        reply_markup=PERSISTENT_KEYBOARD)

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
                from .weather_service import EVENT_LABEL_DE
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

    async def _handle_mute_all(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Set runtime.global_mute_until = now + 1 h and reply with a confirm
        bubble carrying two inline buttons (end-now / extend-to-4h)."""
        log.info("[tg] /mute invoked by chat=%s", update.effective_chat.id if update.effective_chat else "?")
        until = time.time() + _MUTE_DEFAULT_S
        if self.settings_store:
            self.settings_store.runtime_set("global_mute_until", until)
        end_local = datetime.fromtimestamp(until).strftime("%H:%M")
        log.info("[tg] mute_all activated until %s (epoch=%d)", end_local, int(until))
        markup = InlineKeyboardMarkup([
            [InlineKeyboardButton("Sofort beenden", callback_data="mute:end"),
             InlineKeyboardButton("Auf 4 h verlängern", callback_data="mute:ext4h")],
        ])
        await update.message.reply_text(
            f"🔇 Alle Pushes pausiert bis <b>{end_local}</b>",
            parse_mode="HTML", reply_markup=markup,
        )

    async def _handle_cameras(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Per-cam drilldown picker. Tapping the persistent ``📹 Kameras``
        row sends an inline keyboard with one button per camera; tapping
        a camera opens its drilldown view via cam:<id>:drilldown."""
        log.info("[tg] /cameras invoked by chat=%s",
                 update.effective_chat.id if update.effective_chat else "?")
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
            rows.append([InlineKeyboardButton(
                f"{icon} {info['name']}",
                callback_data=f"cam:{info['cam_id']}:drilldown"[:64],
            )])
        await update.message.reply_text(
            "📹 Kamera wählen", reply_markup=InlineKeyboardMarkup(rows),
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
            ACTION_LIVE:   self._handle_livebild,
            ACTION_CLIP:   self._handle_clip5,
            ACTION_STATUS: self._handle_status,
            ACTION_MUTE:   self._handle_mute_all,
            ACTION_CAMS:   self._handle_cameras,
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
            ss.runtime_set_subkey("event_feedback", eid, {
                "verdict": verdict,
                "by": "telegram",
                "ts": time.time(),
            })
            ts_str = datetime.now().strftime("%H:%M")
            badge = (f"✅ Gültig · {ts_str}" if verdict == "ok"
                     else f"❌ Falsch · {ts_str}")
            await self._set_badge(q, badge)
            await q.answer(badge)
            return

        if verb == "m1h":
            idx = ss.runtime_get_subkey("alert_index", eid) if ss else None
            cam = (idx or {}).get("cam"); label = (idx or {}).get("label")
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
            log.info("[tg] mute_all cleared by chat=%s",
                     q.message.chat_id if q.message else "?")
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
                    await q.message.reply_document(document=f, filename=snap_path.name,
                                                   caption=f"🖼 {snap_path.name}")
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
                        chat_id=q.message.chat_id, video=f,
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
        from .weather_service import EVENT_LABEL_DE
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
        lines.insert(0, f"📊 <b>Status</b>")
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
                rt.stop(); time.sleep(0.5); rt.start()
                await q.answer(f"🔄 {cam_name}: Neuverbindung gestartet")
            except Exception as e:
                log.warning("[tg] reconnect failed: %s", e)
                await q.answer("Reconnect fehlgeschlagen")
            return
        await q.answer()

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

    async def _cam_send_snapshot(self, q, context, cam_id, rt, cam_name):
        await q.answer("📷 Snapshot wird geholt…")
        log.info("[tg] cam:%s:livebild triggered by chat=%s",
                 cam_id, q.message.chat_id if q.message else "?")
        jpeg = rt.snapshot_jpeg() if hasattr(rt, "snapshot_jpeg") else None
        if not jpeg:
            await q.message.reply_text(f"Kein Live-Bild für {cam_name} verfügbar.")
            return
        bio = BytesIO(jpeg); bio.name = f"{cam_id}.jpg"
        rows = [[
            InlineKeyboardButton("🔄 Neu", callback_data=f"cam:{cam_id}:livebild"),
            InlineKeyboardButton("🎬 5 s Clip", callback_data=f"cam:{cam_id}:clip:5"),
        ]]
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
                chat_id=q.message.chat_id, photo=bio,
                caption=f"📷 <b>{cam_name}</b> · {ts_hm}",
                parse_mode="HTML", reply_markup=markup,
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
        log.info("[tg] cam:%s:clip:%d triggered by chat=%s",
                 cam_id, sec, q.message.chat_id if q.message else "?")
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
                f"(ffmpeg/RTSP-Problem). Snapshot stattdessen verfügbar.")
            return
        ts_hm = datetime.now().strftime("%H:%M")
        # Same nav layout as snapshots: same-cam refresh / snapshot row,
        # plus a row of OTHER cameras (or a single "Andere Kamera" picker
        # when there are too many to fit).
        rows = [[
            InlineKeyboardButton("🔄 Neuer Clip", callback_data=f"cam:{cam_id}:clip:5"),
            InlineKeyboardButton("📷 Live-Bild", callback_data=f"cam:{cam_id}:livebild"),
        ]]
        nav_row = self._other_cam_nav_row(cam_id, "clip:5")
        if nav_row:
            rows.append(nav_row)
        markup = InlineKeyboardMarkup(rows)
        try:
            with open(path, "rb") as f:
                await context.bot.send_video(
                    chat_id=q.message.chat_id, video=f,
                    caption=f"🎬 <b>{cam_name}</b> · {sec} s · {ts_hm}",
                    parse_mode="HTML", reply_markup=markup,
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
            await self._render_view(q, self._root_view()); await q.answer(); return
        if data == "menu:livebild":
            await self._render_view(q, self._cam_picker("livebild")); await q.answer(); return
        if data == "menu:clip":
            await self._render_view(q, self._cam_picker("clip")); await q.answer(); return
        if data == "menu:cams":
            await self._render_view(q, self._cam_picker("drilldown")); await q.answer(); return
        if data == "menu:zeitraffer":
            await self._render_view(q, self._zeitraffer_view()); await q.answer(); return
        if data == "menu:zeitraffer:today":
            # Pick the newest of today's timelapses across cameras.
            today_pref = datetime.now().strftime("%Y-%m-%d")
            tls = [t for t in self._list_recent_timelapses(limit=20)
                   if datetime.fromtimestamp(t["mtime"]).strftime("%Y-%m-%d") == today_pref]
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
            await self._render_view(q, self._erkennungen_view(
                filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=0))
            await q.answer(); return
        # Erkennungen pagination + filter sub-view + filter-state setters.
        if data.startswith("det:page:"):
            try:
                page = int(data.split(":")[-1])
            except ValueError:
                page = 0
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            await self._render_view(q, self._erkennungen_view(
                filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=page))
            await q.answer(); return
        if data == "det:filter":
            chat_id = q.message.chat_id if q.message else None
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer(); return
        if data.startswith("det:setcam:"):
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            sel = data.split(":", 2)[2]
            st["det_cam"] = None if sel == "_all" else sel
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer(); return
        if data.startswith("det:setkind:"):
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            sel = data.split(":", 2)[2]
            st["det_kind"] = None if sel == "_all" else sel
            await self._render_view(q, self._erkennungen_filter_view(chat_id))
            await q.answer(); return
        if data == "det:apply":
            chat_id = q.message.chat_id if q.message else None
            st = self._tile_state_for(chat_id)
            await self._render_view(q, self._erkennungen_view(
                filter_cam=st.get("det_cam"), filter_kind=st.get("det_kind"), page=0))
            await q.answer(); return
        if data == "menu:stats" or data == "menu:stats:today":
            await self._render_view(q, self._stats_view(days=1)); await q.answer(); return
        if data == "menu:stats:week":
            await self._render_view(q, self._stats_view(days=7)); await q.answer(); return
        if data == "menu:stats:month":
            await self._render_view(q, self._stats_view(days=30)); await q.answer(); return
        if data == "menu:status":
            await self._render_view(q, self._status_view()); await q.answer(); return
        if data == "menu:logs":
            await self._render_view(q, self._logs_view()); await q.answer(); return
        # Phase-1 stubs: tiles routed end-to-end so the navigation feels
        # complete even though the detail content lands in phase-2.
        if data == "menu:tierlog":
            await self._render_view(q, self._tier_log_view()); await q.answer(); return
        if data == "menu:wetter":
            await self._render_view(q, self._wetter_view()); await q.answer(); return
        if data == "menu:system":
            await self._render_view(q, self._system_view()); await q.answer(); return
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


def _parse_hhmm(s: str | None) -> tuple[int, int]:
    if not s or ":" not in s:
        return 0, 0
    try:
        h, m = s.split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0

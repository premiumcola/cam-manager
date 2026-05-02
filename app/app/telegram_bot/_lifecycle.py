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


class LifecycleMixin:
    """Service lifecycle: start/stop/polling-main + APScheduler wiring + URL helpers.

    Mixin for TelegramService. Methods access shared state via `self.*`
    (cfg, bot, store, runtimes, scheduler, etc.) which live on the
    concrete class.
    """

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

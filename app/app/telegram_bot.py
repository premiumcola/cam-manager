from __future__ import annotations
from io import BytesIO
from threading import Thread, Lock
from datetime import datetime, timedelta
from pathlib import Path
import asyncio
import logging
import time

from telegram import Bot, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ApplicationBuilder, CommandHandler, CallbackQueryHandler, ContextTypes

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
            log.info("[Telegram] Deaktiviert: %s", ", ".join(reasons) if reasons else "unbekannt")
        else:
            log.info("[Telegram] Aktiv: chat_id=%s token=%s…", self.chat_id, self.token[:8] if self.token else "")
        self.store = store
        self.runtimes = runtimes or {}
        self.global_cfg = global_cfg
        self.timelapse_builder = timelapse_builder
        self.settings_store = settings_store
        # ── Threads & loop ─────────────────────────────────────────────────
        # Polling owns its own loop (run inside python-telegram-bot). The
        # send-loop is ours: a single asyncio loop on a dedicated thread, so
        # 100 sends in a row never recreate a loop and never hit
        # "loop is closed" after the first call.
        self._poll_thread: Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: Thread | None = None
        self._scheduler = None
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

    def _storage_root(self) -> Path:
        return Path(self._cfg().get("storage", {}).get("root", "/app/storage"))

    # ── Lifecycle ─────────────────────────────────────────────────────────
    def start(self):
        """Boot polling, dedicated send-loop, scheduler, and default jobs.

        Replaces the old start_polling() entry point — still callable for
        compatibility. Idempotent: subsequent calls return without effect."""
        if not self.enabled:
            return
        if self._loop_thread and self._loop_thread.is_alive():
            return
        # Send loop on dedicated thread
        self._loop = asyncio.new_event_loop()
        self._loop_thread = Thread(target=self._run_send_loop, daemon=True, name="tg-send-loop")
        self._loop_thread.start()
        # Polling thread (PTB owns its own loop here)
        self._poll_thread = Thread(target=self._run_polling, daemon=True, name="tg-polling")
        self._poll_thread.start()
        # Scheduler
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            self._scheduler = BackgroundScheduler(daemon=True)
            self._scheduler.start()
            log.info("[Telegram] Scheduler started")
        except Exception as e:
            log.error("[Telegram] Scheduler start failed: %s", e)
            self._scheduler = None
        # Default push jobs
        self.register_default_jobs()

    # Back-compat alias — server.py historically calls start_polling().
    def start_polling(self):
        self.start()

    def shutdown(self):
        """Stop scheduler + send loop. Polling thread is intentionally NOT
        torn down here — Telegram only allows one getUpdates connection per
        bot token, and PTB's polling app cannot be cleanly stopped from
        another thread. Use reload() instead of replace-on-config-change."""
        if self._stopped:
            return
        self._stopped = True
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
                log.info("[Telegram] Scheduler stopped")
        except Exception as e:
            log.warning("[Telegram] scheduler shutdown failed: %s", e)
        self._scheduler = None
        try:
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception as e:
            log.warning("[Telegram] loop stop failed: %s", e)

    def reload(self, new_cfg: dict):
        """Apply new telegram config without restarting the polling thread.

        Re-cycles the send loop and scheduler so updated push settings take
        effect immediately, but leaves the bot/polling alone — Telegram
        rejects a second concurrent getUpdates against the same token, so
        recreating the polling thread on every settings save would produce
        the famous "Conflict: terminated by other getUpdates request".
        Token changes therefore require a full container restart (logged)."""
        new_cfg = new_cfg or {}
        new_token = new_cfg.get("token", "")
        if new_token and self.token and new_token != self.token:
            log.warning("[Telegram] token changed — container restart required for new token to take effect")
        # Refresh config snapshots
        self.cfg = new_cfg
        self.push_cfg = new_cfg.get("push") or {}
        self.chat_id = str(new_cfg.get("chat_id", ""))
        new_enabled = bool(new_cfg.get("enabled") and new_cfg.get("token") and new_cfg.get("chat_id"))
        # Swap the send-side cleanly: stop scheduler + send loop, then start fresh
        # so updated push schedule (e.g. new daily-report time) takes hold
        # without ever spawning a second polling thread.
        was_enabled = self.enabled
        self.enabled = new_enabled
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
        except Exception as e:
            log.warning("[Telegram] scheduler shutdown (reload) failed: %s", e)
        self._scheduler = None
        try:
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._loop.stop)
        except Exception as e:
            log.warning("[Telegram] loop stop (reload) failed: %s", e)
        self._loop = None
        self._loop_thread = None
        self._stopped = False
        # Bot stays bound to the original token; nothing to do for it.
        if not new_enabled:
            log.info("[Telegram] reloaded — disabled (sends suspended)")
            return
        # Restart send loop + scheduler
        self._loop = asyncio.new_event_loop()
        self._loop_thread = Thread(target=self._run_send_loop, daemon=True, name="tg-send-loop")
        self._loop_thread.start()
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            self._scheduler = BackgroundScheduler(daemon=True)
            self._scheduler.start()
            log.info("[Telegram] Scheduler restarted (reload)")
        except Exception as e:
            log.error("[Telegram] Scheduler restart failed: %s", e)
            self._scheduler = None
        self.register_default_jobs()
        if not was_enabled:
            log.info("[Telegram] reloaded — newly enabled, polling stays from prior instance" if self._poll_thread and self._poll_thread.is_alive() else "[Telegram] reloaded — newly enabled, starting polling")
            if not (self._poll_thread and self._poll_thread.is_alive()):
                self._poll_thread = Thread(target=self._run_polling, daemon=True, name="tg-polling")
                self._poll_thread.start()
        else:
            log.info("[Telegram] reload applied")

    def _run_send_loop(self):
        try:
            asyncio.set_event_loop(self._loop)
            self._loop.run_forever()
        except Exception as e:
            log.error("[Telegram] send loop crashed: %s", e)
        finally:
            try:
                self._loop.close()
            except Exception:
                pass

    def _run_polling(self):
        try:
            # python-telegram-bot 22's ApplicationBuilder.build() expects a
            # usable event loop bound to the current thread. Spawned daemon
            # threads don't have one by default, so we install a fresh loop
            # here before constructing the Application.
            asyncio.set_event_loop(asyncio.new_event_loop())
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
            log.error("[Telegram] polling failed: %s", e)

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
            log.warning("[Telegram] cancel_all_jobs failed: %s", e)

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
            log.info("[Telegram] Push disabled — no default jobs registered")
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
            log.info("[Telegram] Registered jobs: %s", jobs)
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
            log.debug("[Telegram] send skipped (enabled=%s, loop=%s)", self.enabled, bool(self._loop))
            return None
        try:
            return asyncio.run_coroutine_threadsafe(self.send_alert(text, **kwargs), self._loop)
        except Exception as e:
            log.error("[Telegram] send dispatch failed: %s", e)
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
            log.debug("[Telegram] send_alert skipped (enabled=%s, bot=%s)", self.enabled, self.bot is not None)
            return
        if dark:
            log.info("[Telegram] dark/night alert")
        markup = self._build_markup(buttons)
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
                    log.info("[Telegram] video > 50MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_video(video=src, caption=caption, **common)
            elif photo is not None:
                size = self._src_size_bytes(photo)
                src = self._prepare_input(photo, "photo.jpg")
                if size and size > _PHOTO_LIMIT_BYTES:
                    log.info("[Telegram] photo > 10MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_photo(photo=src, caption=caption, **common)
            else:
                msg = await self.bot.send_message(text=text or "", **common)
            log.info("[Telegram] send_alert ok (chat=%s silent=%s)", self.chat_id, silent)
            return msg
        except Exception as e:
            log.error("[Telegram] send_alert failed: %s", e)
            return None

    # Legacy sync wrapper (kept for the achievement push and the test endpoint).
    def send_alert_sync(self, caption: str, jpeg_bytes: bytes | None = None,
                        snapshot_url: str | None = None,
                        dashboard_url: str | None = None,
                        camera_id: str | None = None):
        if not self.enabled:
            return
        buttons = [[
            ("📷 Live-Bild", f"snapshot:{camera_id}" if camera_id else "menu:snapshot"),
            ("🎥 Live 5s Clip", f"clip:{camera_id}" if camera_id else "menu:clip"),
        ], [
            ("⏱ Letzte 24h Zeitraffer", f"timelapse:{camera_id}" if camera_id else "menu:timelapse"),
            ("🕘 Last detections", f"detections:{camera_id}" if camera_id else "menu:detections"),
        ]]
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
            log.debug("[Telegram] push: disabled")
            return
        labels = meta.get("labels") or []
        primary = most_specific_label(labels)
        label_cfg = (pcfg.get("labels") or {}).get(primary, {})
        if not label_cfg.get("push", False):
            log.warning("[Telegram] skip: %s push disabled (cam=%s)", primary, camera_id)
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
            log.warning("[Telegram] skip: %s score=%.2f < threshold=%.2f (cam=%s)",
                        primary, top_score, threshold, camera_id)
            return
        if self._is_suppressed(camera_id, primary):
            log.warning("[Telegram] skip: suppressed %s/%s", camera_id, primary)
            return
        if self._is_rate_limited(camera_id):
            log.warning("[Telegram] skip: rate-limited %s", camera_id)
            return

        cam_cfg = self._camera_cfg(camera_id) or {}
        # Per-camera schedule gate (telegram action). Outside the configured
        # window, or when actions.telegram is off, suppress the push. Daily
        # reports / highlights / watchdog are system-level and are not
        # gated by this — they go through their own jobs.
        from .event_logic import schedule_action_active as _sched_act
        if not _sched_act(cam_cfg.get("schedule") or {}, "telegram"):
            log.warning("[Telegram] skip: schedule blocks telegram (cam=%s)", camera_id)
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
        log.info("[Telegram] event alert: cam=%s label=%s score=%.2f silent=%s dark=%s",
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
            log.info("[Telegram] daily report sent")
        except Exception as e:
            log.error("[Telegram] daily report job failed: %s", e)

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
                log.info("[Telegram] highlight: no candidates")
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
            log.info("[Telegram] highlight sent: %s/%s score=%.2f",
                     pick["cam_id"], pick["eid"], pick["score"])
        except Exception as e:
            log.error("[Telegram] highlight job failed: %s", e)

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
                log.debug("[Telegram] storage check failed: %s", e)
        except Exception as e:
            log.error("[Telegram] watchdog failed: %s", e)

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

    # ── Menu helpers (legacy commands) ────────────────────────────────────
    def _camera_menu(self, action: str):
        rows = []; row = []
        for idx, (cam_id, rt) in enumerate(self.runtimes.items(), start=1):
            row.append(InlineKeyboardButton(rt.status().get("name", cam_id), callback_data=f"{action}:{cam_id}"))
            if idx % 2 == 0:
                rows.append(row); row = []
        if row:
            rows.append(row)
        rows.append([InlineKeyboardButton("⬅️ Hauptmenü", callback_data="menu:root")])
        return InlineKeyboardMarkup(rows)

    def _main_menu(self):
        return InlineKeyboardMarkup([
            [InlineKeyboardButton("📷 Live-Bild", callback_data="menu:snapshot"),
             InlineKeyboardButton("🎥 Live 5s Clip", callback_data="menu:clip")],
            [InlineKeyboardButton("⏱ Letzte 24h Zeitraffer", callback_data="menu:timelapse"),
             InlineKeyboardButton("🕘 Letzte Erkennungen", callback_data="menu:detections")],
            [InlineKeyboardButton("📊 Statistiken", callback_data="menu:stats"),
             InlineKeyboardButton("🛡 Scharf / Unscharf", callback_data="menu:arm")],
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

    # ── Callback router ───────────────────────────────────────────────────
    async def on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        q = update.callback_query
        data = q.data or ""
        if data == "noop":
            await q.answer()
            return
        # New push-system prefixes
        if data.startswith("ev:"):
            await self._handle_event_cb(q, data)
            return
        if data.startswith("hi:") or data.startswith("share:"):
            await self._handle_highlight_cb(q, data)
            return
        if data.startswith("tl:save:"):
            await self._handle_timelapse_cb(q, data)
            return
        if data.startswith("cam:"):
            await self._handle_camera_cb(q, data)
            return
        # Phase 2 stub for menu actions that don't exist yet
        if data in ("menu:stats:today", "menu:zeitraffer:today", "menu:logs"):
            await q.answer("Menü-Funktion folgt in Update.")
            return
        # Fallthrough: legacy menu/snapshot/clip/etc handlers
        await self._handle_legacy_cb(update, context)

    async def _set_badge(self, q, label: str):
        """Replace the entire reply markup with a single grey badge button."""
        try:
            mk = InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data="noop")]])
            await q.edit_message_reply_markup(reply_markup=mk)
        except Exception as e:
            log.debug("[Telegram] badge edit failed: %s", e)

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
                    log.warning("[Telegram] trigger_siren failed: %s", e)
            await self._set_badge(q, "🚨 Sirene")
            if triggered:
                await q.answer("🚨 Sirene aktiviert")
            else:
                # Reolink siren API isn't wired yet — log + acknowledge.
                log.info("[Telegram] siren requested for %s — not implemented", cam)
                await q.answer("🚨 Sirene angefordert (nicht unterstützt)")
            return

        await q.answer("Unbekannte Aktion")

    async def _handle_highlight_cb(self, q, data: str):
        kind = data.split(":", 1)[0]
        if kind == "hi":
            await q.answer("Hochauflösung folgt in Update.")
        elif kind == "share":
            await q.answer("Teilen folgt in Update.")
        else:
            await q.answer()

    async def _handle_timelapse_cb(self, q, data: str):
        await q.answer("Speichern folgt in Update.")

    async def _handle_camera_cb(self, q, data: str):
        # cam:<cid>:reconnect
        parts = data.split(":")
        if len(parts) < 3:
            await q.answer()
            return
        cam_id = parts[1]
        verb = parts[2]
        rt = self.runtimes.get(cam_id)
        if verb == "reconnect" and rt and hasattr(rt, "stop") and hasattr(rt, "start"):
            try:
                rt.stop(); time.sleep(0.5); rt.start()
                await q.answer("🔄 Neuverbindung gestartet")
            except Exception as e:
                log.warning("[Telegram] reconnect failed: %s", e)
                await q.answer("Reconnect fehlgeschlagen")
            return
        await q.answer()

    # ── Legacy callbacks (unchanged behaviour) ────────────────────────────
    async def _handle_legacy_cb(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
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
            await context.bot.send_photo(chat_id=q.message.chat_id, photo=bio,
                                         caption=f"📷 {rt.status().get('name', cam_id)}")
            return
        if action == "clip":
            url = f"{self._dashboard_url().rstrip('/')}/api/camera/{cam_id}/stream.mjpg" if self._dashboard_url() else ""
            await q.edit_message_text(
                f"🎥 5s Live-Clip Placeholder\n{rt.status().get('name', cam_id)}\n{url}",
                reply_markup=self._main_menu())
            return
        if action == "timelapse":
            day = datetime.now().strftime("%Y-%m-%d")
            path = self.timelapse_builder.build_for_day(
                cam_id, day,
                fps=int(((self._cfg().get('cameras') or [{}])[0].get('timelapse') or {}).get('fps', 25)),
                force=False) if self.timelapse_builder else None
            if not path:
                await q.edit_message_text(f"Kein Zeitraffer für {cam_id} verfügbar.", reply_markup=self._main_menu())
                return
            rel = str(path).split("/app/storage/")[-1]
            base = self._dashboard_url().rstrip("/")
            await q.edit_message_text(
                f"⏱ Letzte 24h Zeitraffer\n{rt.status().get('name', cam_id)}\n{base}/media/{rel}",
                reply_markup=self._main_menu())
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
            await q.edit_message_text(
                f"🛡 {rt.status().get('name', cam_id)} ist jetzt "
                f"{'armed' if (self.settings_store.get_camera(cam_id) or {}).get('armed', True) else 'disarmed'}.",
                reply_markup=self._main_menu())


def _parse_hhmm(s: str | None) -> tuple[int, int]:
    if not s or ":" not in s:
        return 0, 0
    try:
        h, m = s.split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0

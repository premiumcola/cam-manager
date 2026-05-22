"""TelegramService — public API. Lifecycle + state shared via mixins.

`from .telegram_bot import TelegramService` keeps working byte-for-byte.
"""

from __future__ import annotations

import asyncio
from threading import Lock, Thread

from telegram import Bot

# Re-export module-level constants + helpers so external callers can
# still write `from app.telegram_bot import PERSISTENT_KEYBOARD` etc.
from ._consts import (  # noqa: F401
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
from ._formatting import FormattingMixin
from ._inbound import InboundMixin
from ._lifecycle import LifecycleMixin
from ._outbound import OutboundMixin


class TelegramService(
    LifecycleMixin,
    OutboundMixin,
    InboundMixin,
    FormattingMixin,
):
    """Telegram bot service. Two-loop runtime (polling + send queue),
    APScheduler-driven jobs (daily report, highlight, watchdog), and
    inline-button menu rendering. Methods are split across the mixins
    listed in the bases. __init__ stays here so all instance state
    assignments live in a single visible block."""

    def __init__(
        self,
        cfg: dict,
        store=None,
        runtimes=None,
        global_cfg=None,
        timelapse_builder=None,
        settings_store=None,
    ):
        self.cfg = cfg or {}
        self.push_cfg: dict = self.cfg.get("push") or {}
        self.enabled = bool(
            self.cfg.get("enabled") and self.cfg.get("token") and self.cfg.get("chat_id")
        )
        self.chat_id = str(self.cfg.get("chat_id", ""))
        self.token = self.cfg.get("token", "")
        self.bot = Bot(self.token) if self.enabled else None
        if not self.enabled:
            reasons = []
            if not self.cfg.get("enabled"):
                reasons.append("enabled=false")
            if not self.cfg.get("token"):
                reasons.append("token leer")
            if not self.cfg.get("chat_id"):
                reasons.append("chat_id leer")
            log.info("[tg] Deaktiviert: %s", ", ".join(reasons) if reasons else "unbekannt")
        else:
            log.info(
                "[tg] Aktiv: chat_id=%s token=%s…",
                self.chat_id,
                self.token[:8] if self.token else "",
            )
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
        # If stop()'s join times out, capture the orphan thread here so
        # start() can refuse a fresh polling thread (a second
        # getUpdates loop against the same token = sustained Conflict
        # spam) and so get_polling_status() can surface the failure.
        self._stale_poll_thread: Thread | None = None
        self._stale_since: float | None = None
        # Most-recent successful send_alert timestamp (epoch seconds).
        # Set by send() on a successful Telegram API response; read by
        # the /api/system/telegram health endpoint to drive the
        # cam-edit Alerting-tab status strip "letzte Push vor X" line.
        self._last_push_ts: float | None = None
        # Per-class cooldown bookkeeping — (camera_id, label) →
        # monotonic timestamp of the last accepted push. send_event_alert
        # consults this against the camera's notification_cooldown dict
        # before forwarding to send(), and skips the push silently when
        # the elapsed time is below the configured cooldown. Recording
        # and archiving are never gated by this — only the user-facing
        # push.
        self._last_notify: dict[tuple[str, str], float] = {}
        self._scheduler = None
        self._lifecycle_lock = Lock()
        self._stopped = False
        # ── Rate limit (in-memory, per-cam) ────────────────────────────────
        self._rate_lock = Lock()
        self._rate_cache: dict[str, float] = {}
        self._RATE_CACHE_MAX = 100

    # ── Config plumbing ───────────────────────────────────────────────────

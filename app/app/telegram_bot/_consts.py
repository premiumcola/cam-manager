"""Module-level constants, imports, and helpers for telegram_bot.

Lives in its own file so mixin modules import these without creating a
circular dependency with service.py (which imports the mixins).
"""

from __future__ import annotations

import logging

from telegram import (
    BotCommand,
    KeyboardButton,
    ReplyKeyboardMarkup,
)

# Pinned logger name so log filters and grep keep matching the legacy
# module path after the package split.
log = logging.getLogger("app.telegram_bot")

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


# Per-class notification cooldown defaults (seconds). Used when the
# camera's notification_cooldown dict has no entry for the label.
# Birds and squirrels get the longest cooldown because they trigger
# detections faster than humans want to read them; person/car get a
# tight cooldown so a real intruder isn't gated. Motion is rare in
# practice (severity=off by default in soft profile) so 30 s.
_NOTIFY_COOLDOWN_DEFAULTS = {
    "person": 60,
    "cat": 120,
    "bird": 300,
    "squirrel": 300,
    "dog": 120,
    "car": 30,
    "motion": 30,
}


# Re-export from the shared module so every existing
# `from ._consts import _parse_hhmm` consumer keeps working unchanged.
from ..time_utils import parse_hhmm as _parse_hhmm  # noqa: E402, F401

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


class _AnchorMixin:
    """Anchor-bubble mechanics — get/save/drop the anchor message id and
    render views into it. Infrastructure layer the other mixins call into."""

    @staticmethod
    def _back_btn(target: str = "menu:root") -> InlineKeyboardButton:
        return InlineKeyboardButton("« Zurück", callback_data=target)

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
            self.settings_store.runtime_set(
                ANCHOR_KEY, {"chat_id": int(chat_id), "message_id": int(message_id)}
            )
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
        already = self.settings_store.runtime_get_subkey(PERSISTENT_KB_KEY, str(chat_id))
        if already:
            return True
        try:
            await bot.send_message(
                chat_id=chat_id,
                text="🏠",
                reply_markup=PERSISTENT_KEYBOARD,
            )
            self.settings_store.runtime_set_subkey(PERSISTENT_KB_KEY, str(chat_id), True)
            return True
        except Exception as e:
            log.warning("[tg] persistent-kb attach failed for chat=%s: %s", chat_id, e)
            return False

    async def _anchor_send_or_edit(self, bot, chat_id: int, view: tuple[str, InlineKeyboardMarkup]):
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
                    chat_id=chat_id,
                    message_id=anchor[1],
                    text=text,
                    reply_markup=inline_markup,
                    parse_mode="HTML",
                )
                return anchor[1]
            except Exception as e:
                log.info("[tg] anchor stale for chat=%s (%s) — sending fresh", chat_id, e)
                self._drop_anchor()
        kb_ready = await self._ensure_persistent_kb(bot, chat_id)
        if kb_ready or self.settings_store:
            msg = await bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                reply_markup=inline_markup,
            )
        else:
            # No settings_store → can't track the per-chat flag. Best we
            # can do is the legacy two-call path so the user still gets
            # the persistent keyboard. This branch is theoretical in
            # production (settings_store is always wired up).
            msg = await bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode="HTML",
                reply_markup=PERSISTENT_KEYBOARD,
            )
            try:
                await bot.edit_message_reply_markup(
                    chat_id=chat_id,
                    message_id=msg.message_id,
                    reply_markup=inline_markup,
                )
            except Exception as e:
                log.warning("[tg] anchor inline-kb attach failed: %s", e)
        self._save_anchor(chat_id, msg.message_id)
        return msg.message_id

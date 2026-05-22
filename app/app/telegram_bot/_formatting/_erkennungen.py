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

# _erkennungen_view replaced the old "Letzte Erkennungen" feedback list
# (24-h window with ev:<eid>:ok / no buttons). The new tile spec asks
# for a today-only filterable log. Per-event feedback callbacks (ev:*)
# are still reachable from the original alert bubbles in chat — only
# the menu route changed.


class _ErkennungenMixin:
    """📋 Erkennungen list view + filter sub-view + 🐦 Tier-Log + the
    per-event icon/label/kind helpers shared across views."""

    # ── Stub views for phase-1 navigation (filled in phase-2) ─────────────
    # ── Phase-2 tile helpers ──────────────────────────────────────────────
    # Label → emoji map. Mirrors the JS `_STAT_LABEL_ICONS` in app.js so
    # the bot and the web UI agree on iconography. Unknown labels fall
    # through to "❓" via `_label_icon` — never crash the renderer on a
    # new label name.
    _LABEL_ICONS: dict[str, str] = {
        "person": "👤",
        "cat": "🐱",
        "bird": "🐦",
        "dog": "🐕",
        "fox": "🦊",
        "hedgehog": "🦔",
        "squirrel": "🐿️",
        "horse": "🐴",
        "deer": "🦌",
        "car": "🚗",
        "motion": "👁",
    }
    # Kind classifier for the Erkennungen filter. The user's filter has
    # only 4 buckets (Vögel / Katzen / Personen / Wildtiere) plus "alle";
    # this dict maps the granular label to the bucket.
    _LABEL_KIND: dict[str, str] = {
        "bird": "vogel",
        "cat": "katze",
        "person": "person",
        "dog": "wildtier",
        "fox": "wildtier",
        "hedgehog": "wildtier",
        "squirrel": "wildtier",
        "deer": "wildtier",
        "horse": "wildtier",
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

    def _erkennungen_view(
        self, *, filter_cam: str | None = None, filter_kind: str | None = None, page: int = 0
    ) -> tuple[str, InlineKeyboardMarkup]:
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
        cam_iter = [filter_cam] if filter_cam else list(cam_cfgs.keys())
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
        slice_ = all_events[page * page_size : (page + 1) * page_size]

        cam_label = (
            (cam_cfgs.get(filter_cam) or {}).get("name", filter_cam)
            if filter_cam
            else "alle Kameras"
        )
        kind_label = {
            "vogel": "🐦 Vögel",
            "katze": "🐱 Katzen",
            "person": "👤 Personen",
            "wildtier": "🦌 Wildtiere",
        }.get(filter_kind, "alle Typen")
        head = [
            "📋 <b>Erkennungen heute</b>",
            f"Filter: {_esc(str(cam_label))} · {_esc(kind_label)}",
            "─────────────",
            "",
        ]

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
            nav_row.append(InlineKeyboardButton(f"« {page}", callback_data=f"det:page:{page - 1}"))
        if page < n_pages - 1:
            nav_row.append(
                InlineKeyboardButton(f"{page + 2} »", callback_data=f"det:page:{page + 1}")
            )
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
        cam_cfgs = self._cfg().get("cameras", []) or []
        cam_row = []
        for c in cam_cfgs:
            cid = c.get("id")
            name = c.get("name") or cid
            if not cid:
                continue
            label = ("● " if cur_cam == cid else "") + (name[:14])
            cam_row.append(InlineKeyboardButton(label, callback_data=f"det:setcam:{cid}"[:64]))
        cam_row.append(
            InlineKeyboardButton(
                ("● " if cur_cam is None else "") + "alle", callback_data="det:setcam:_all"
            )
        )
        kind_opts = [
            ("🐦 Vögel", "vogel"),
            ("🐱 Katzen", "katze"),
            ("👤 Personen", "person"),
            ("🦌 Wildtiere", "wildtier"),
            ("alle", "_all"),
        ]
        kind_row = []
        for lbl, val in kind_opts:
            sel = (cur_kind == val) or (val == "_all" and cur_kind is None)
            kind_row.append(
                InlineKeyboardButton(
                    ("● " if sel else "") + lbl, callback_data=f"det:setkind:{val}"[:64]
                )
            )

        # Buttons-per-row clamp so iPhone-narrow rows wrap.
        def _chunk(row, n=3):
            return [row[i : i + n] for i in range(0, len(row), n)]

        rows = []
        for r in _chunk(cam_row, 3):
            rows.append(r)
        for r in _chunk(kind_row, 3):
            rows.append(r)
        rows.append(
            [
                InlineKeyboardButton("✓ Anwenden", callback_data="det:apply"),
                InlineKeyboardButton("« Zurück", callback_data="det:apply"),
            ]
        )
        return ("📋 <b>Filter</b>\n\nKamera und Erkennungstyp wählen.", InlineKeyboardMarkup(rows))

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
            profiles = (
                self.cat_registry.list_profiles()
                if hasattr(self, "cat_registry") and self.cat_registry
                else []
            )
        except Exception:
            profiles = []
        # Re-id registry isn't passed into TelegramService directly, so
        # fall back to cat_name occurrences from today's events as a
        # poor-man's roster when no explicit registry is available.
        seen_today: dict[str, dict] = {}
        if self.store:
            for cam in self._cfg().get("cameras", []) or []:
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
                        delta_min = int(
                            (now - datetime.fromisoformat(rec["last_ts"])).total_seconds() / 60
                        )
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
            [
                InlineKeyboardButton("📋 Alle Erkennungen", callback_data="menu:erkennungen"),
                InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root"),
            ],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

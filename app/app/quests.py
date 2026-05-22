"""Seasonal quests — progress-based achievements layered on the existing
species `achievements.json` file.

Why a separate module:
    The legacy achievement system in `routes/sichtungen.py` is binary
    (species seen yes/no). Quests need a counter, a window, and richer
    criteria (label sets, hour windows, distinct-species counts, weather
    overlap). Putting that next to the species code would either bloat the
    route file or muddy the data shape. Instead, the route file owns
    persistence (`_load_achievements` / `_save_achievements`) and this
    module owns the evaluation logic; the on-disk JSON gains a `quests`
    top-level key alongside the existing per-species entries.

Persistence shape (extends, doesn't break, the existing layout):

    {
      "robin": { "date": ..., "count": 47, ... },          # unchanged
      "quests": {
        "wintervorrat_2026": {
          "id": "wintervorrat_2026",
          "title": "Wintervorrat",
          "icon": "🐿️",
          "description": "50 Eichhörnchen-Sichtungen im Dezember",
          "target": 50,
          "progress": 23,
          "window": {"from": "...", "to": "..."},
          "criteria": {"label": "squirrel"},
          "completed_at": null,
          "notified_at": null
        },
        ...
      }
    }

Evaluation runs at three trigger points (see CLAUDE.md feature doc F09):
    a) inline after every motion event finalize (best-effort, full eval)
    b) hourly background timer in server.py
    c) manual "Re-Eval" button → POST /api/achievements/quests/reevaluate

`evaluate_quests` is idempotent — running it twice in a row produces the
same dict — so trigger (a) and (b) cannot diverge.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger("app.quests")


# ── Quest catalogue ────────────────────────────────────────────────────────
# Hardcoded by design — V1 has no user-editable quests. Adding a new entry
# here + a window type below is enough to ship one.
QUESTS: list[dict] = [
    # ── Kept from v1 (already realistic for a garden install). ────────
    {
        "id": "wintervorrat",
        "title": "Wintervorrat",
        "icon": "🐿️",
        "description": "50 Eichhörnchen-Sichtungen im Dezember",
        "target": 50,
        "window": "december",
        "criteria": {"label": "squirrel"},
    },
    {
        "id": "fruehlingschor",
        "title": "Frühlingschor",
        "icon": "🌸",
        "description": "10 verschiedene Vogelarten in einer Aprilwoche",
        "target": 10,
        "window": "april_rolling_week",
        "criteria": {"label": "bird", "count_distinct_species": True},
    },
    # ── Monthly diversity — achievable in central Europe with a feeder.
    {
        "id": "vogelvielfalt",
        "title": "Vogelvielfalt",
        "icon": "🐦",
        "description": "8 verschiedene Vogelarten im laufenden Monat",
        "target": 8,
        "window": "current_calendar_month",
        "criteria": {"label": "bird", "count_distinct_species": True},
    },
    # ── Weekly counter for the most-common garden visitor class. ──────
    {
        "id": "eichhoernchen_wache",
        "title": "Eichhörnchen-Wache",
        "icon": "🌰",
        "description": "12 Eichhörnchen-Sichtungen in einer Woche",
        "target": 12,
        "window": "current_rolling_week",
        "criteria": {"label": "squirrel"},
    },
    # ── Time-of-day quest — last hour before sunset. Fixed window
    # 18:00–19:00 covers the German evening golden hour from
    # late-summer through autumn; we accept that the window drifts
    # against the actual sun (the operator gets a quieter quest in
    # December as opposed to a perpetually-unachievable one). ──
    {
        "id": "goldene_stunde",
        "title": "Goldene Stunde",
        "icon": "🌅",
        "description": "15 Sichtungen in der Abendstunde (18:00–19:00) im Monat",
        "target": 15,
        "window": "current_calendar_month",
        "criteria": {"hour_in": [18]},
    },
    # ── Consistency — sightings spread across many days. ──────────────
    {
        "id": "stammgast",
        "title": "Stammgast",
        "icon": "📅",
        "description": "An 15 Tagen des Monats mindestens eine Sichtung",
        "target": 15,
        "window": "current_calendar_month",
        "criteria": {"count_distinct_days": True},
    },
    # ── Morning routine — generic 05:00–08:00 window. Replaces the
    # weather-coupled "Nebelmorgen" idea with something that works
    # without weather_history overlap. ──────────────────────────
    {
        "id": "morgenrunde",
        "title": "Morgenrunde",
        "icon": "☕",
        "description": "8 Sichtungen am frühen Morgen (05:00–08:00) im Monat",
        "target": 8,
        "window": "current_calendar_month",
        "criteria": {"hour_in": [5, 6, 7]},
    },
]


# ── Window resolver ────────────────────────────────────────────────────────
def _resolve_window(name: str, now: datetime) -> tuple[datetime | None, datetime | None]:
    """Map a quest window name to a concrete (start_dt, end_dt) pair.

    Returns (None, None) when the window is currently inactive — e.g.
    `april_rolling_week` outside April. The evaluator treats that as
    "skip this quest until the window opens again", so progress freezes
    rather than silently zeroing out.

    Window vocabulary:
      december               — 1.–31. December of the current year
      april_rolling_week     — last 7 days, clamped to April
      year_to_date           — Jan 1 of the current year through now
      current_calendar_month — 1. of the current month through now
                               (rolls automatically on the 1st)
      current_rolling_week   — last 7 days, every day of the year
    """
    year = now.year
    if name == "december":
        if now.month != 12:
            return (None, None)
        return (datetime(year, 12, 1, 0, 0, 0), now)
    if name == "april_rolling_week":
        if now.month != 4:
            return (None, None)
        start = max(datetime(year, 4, 1, 0, 0, 0), now - timedelta(days=7))
        return (start, now)
    if name == "year_to_date":
        return (datetime(year, 1, 1, 0, 0, 0), now)
    if name == "current_calendar_month":
        return (datetime(year, now.month, 1, 0, 0, 0), now)
    if name == "current_rolling_week":
        return (now - timedelta(days=7), now)
    log.warning("[quests] unknown window: %s", name)
    return (None, None)


def _next_window_start(name: str, now: datetime) -> datetime | None:
    """Return the NEXT window-open datetime for ``name`` after ``now``,
    or None when the window is either always active (``year_to_date``,
    ``current_calendar_month``, ``current_rolling_week``) or unknown.

    Used by ``preview_upcoming_quests`` to surface seasonal quests
    before their window opens. We only care about windows that have a
    distinct future "opens at" date the user can plan around — a
    rolling-week window is always-on, so it has no "next" opening."""
    year = now.year
    if name == "december":
        opens = datetime(year, 12, 1, 0, 0, 0)
        if now >= opens:
            opens = datetime(year + 1, 12, 1, 0, 0, 0)
        return opens
    if name == "april_rolling_week":
        opens = datetime(year, 4, 1, 0, 0, 0)
        if now >= datetime(year, 5, 1, 0, 0, 0):
            opens = datetime(year + 1, 4, 1, 0, 0, 0)
        elif now >= opens:
            # We're inside April — the window is currently active, so
            # this quest is on the active pinboard, not the preview.
            return None
        return opens
    return None


def _next_window_close(name: str, opens_at: datetime) -> datetime | None:
    """Return the close datetime corresponding to the next opening of
    ``name``. Used purely for the preview UI's "läuft bis DD.MM." label
    — never feeds the evaluator."""
    if name == "december":
        return datetime(opens_at.year, 12, 31, 23, 59, 59)
    if name == "april_rolling_week":
        return datetime(opens_at.year, 4, 30, 23, 59, 59)
    return None


def _window_logical_end(name: str, stored_from: datetime | None) -> datetime | None:
    """Return the LOGICAL end of a window given the stored start. This
    is the date AFTER which a stored quest is considered "from a past
    period" and eligible for archiving — distinct from the (start, now)
    snapshot the evaluator persists.

      december               → Dec 31 of the stored year
      april_rolling_week     → April 30 of the stored year
      year_to_date           → Dec 31 of the stored year
      current_calendar_month → last day of the stored month
      current_rolling_week   → None (always rolling, never logically closes)
    """
    if stored_from is None:
        return None
    year = stored_from.year
    if name == "december":
        return datetime(year, 12, 31, 23, 59, 59)
    if name == "april_rolling_week":
        return datetime(year, 4, 30, 23, 59, 59)
    if name == "year_to_date":
        return datetime(year, 12, 31, 23, 59, 59)
    if name == "current_calendar_month":
        # last day of month: jump to next month's day 1 minus 1 second
        if stored_from.month == 12:
            next_first = datetime(year + 1, 1, 1, 0, 0, 0)
        else:
            next_first = datetime(year, stored_from.month + 1, 1, 0, 0, 0)
        return next_first - timedelta(seconds=1)
    return None


def _quest_id_with_year(base_id: str, now: datetime, window: str) -> str:
    """Append a window-specific year suffix so each season's quest is its
    own historical entry. December and april windows are anchored to a
    single calendar year; year_to_date is too. All three suffix with the
    current year — we never re-use a completed quest id across years."""
    return f"{base_id}_{now.year}"


# ── Event matcher ──────────────────────────────────────────────────────────
def _event_matches(ev: dict, criteria: dict) -> bool:
    """Does a motion-event dict match the quest's criteria?

    Supported criteria keys:
      - "label":  single label that must appear in event.labels
      - "labels": list of labels — match if ANY appears in event.labels
      - "hour_in": list of ints (0–23) — match only when the event hour
                   is one of them
      - "event_type": handled separately (in evaluator) — never reaches
                      this matcher
      - "count_distinct_species": handled separately

    `criteria` keys not listed here are ignored.
    """
    ev_labels = set(ev.get("labels", []) or [])
    if "label" in criteria:
        if criteria["label"] not in ev_labels:
            return False
    if "labels" in criteria:
        wanted = set(criteria["labels"] or [])
        if not (wanted & ev_labels):
            return False
    if "hour_in" in criteria:
        try:
            ev_hour = int((ev.get("time") or "")[11:13])
        except ValueError:
            return False
        if ev_hour not in criteria["hour_in"]:
            return False
    return True


def _all_motion_events_in_window(
    store, start_dt: datetime, end_dt: datetime, cam_ids: list[str]
) -> list[dict]:
    """Pull every motion event across all cameras within the window.

    Done once per evaluation pass and reused for every quest, so the
    expensive disk walk happens at most once per call. limit=10000 is a
    safety bound — even on a busy multi-cam install we never approach
    that within a single year window.
    """
    out: list[dict] = []
    start_iso = start_dt.isoformat(timespec="seconds")
    end_iso = end_dt.isoformat(timespec="seconds")
    for cam_id in cam_ids:
        try:
            evs = store.list_events(cam_id, start=start_iso, end=end_iso, limit=10000)
        except Exception as e:
            log.debug("[quests] list_events(%s) failed: %s", cam_id, e)
            continue
        out.extend(evs)
    return out


# ── Special event-type evaluators ──────────────────────────────────────────
# The original v1 catalogue had two weather/astronomy-coupled evaluators
# (sun_tl_through_thunderstorm, sun_tl_full_moon_with_wildlife). Both
# were dropped in the realism pass because they were effectively
# unachievable on a typical garden install. No special evaluators in
# the new catalogue — every quest goes through the generic
# _all_motion_events_in_window + _event_matches path. The function
# slot stays so a future "rare but achievable" event-type criterion
# (e.g. a Recap-completion quest) drops in without a new file.


# ── Main evaluator ─────────────────────────────────────────────────────────
def evaluate_quests(
    store,
    achievements_data: dict,
    cam_ids: list[str],
    storage_root: Path,
    now: datetime | None = None,
    notify: Callable[[dict], None] | None = None,
) -> tuple[dict, list[str]]:
    """Re-evaluate every quest against the current event index.

    Args:
        store:               EventStore — used to list motion events.
        achievements_data:   Existing achievements dict (loaded by caller,
                             saved by caller — this fn does NOT touch disk).
        cam_ids:             Every configured camera id; quests aggregate
                             across all of them.
        storage_root:        Path used for weather sightings + history.
        now:                 Override "now" for tests. Defaults to
                             `datetime.now()`.
        notify:              Optional callback(quest_dict) fired exactly
                             once per quest as it transitions to
                             completed (completed_at just set, notified_at
                             still None). The callback is responsible for
                             marking notified_at on the returned dict —
                             we do that here so a caller that fails to
                             persist the dict gets a re-notify on the
                             next eval.

    Returns: (updated_achievements, newly_completed_ids).
    """
    now = now or datetime.now()
    data = dict(achievements_data) if achievements_data else {}
    quests = dict(data.get("quests") or {})
    newly_completed: list[str] = []

    for quest_def in QUESTS:
        window_name = quest_def["window"]
        start_dt, end_dt = _resolve_window(window_name, now)
        qid = _quest_id_with_year(quest_def["id"], now, window_name)
        existing = quests.get(qid) or {}
        # Window inactive (e.g., april_rolling_week in May) — keep any
        # prior progress as-is, don't recount, don't reset.
        if start_dt is None or end_dt is None:
            quests[qid] = {
                **existing,
                "id": qid,
                "title": quest_def["title"],
                "icon": quest_def["icon"],
                "description": quest_def["description"],
                "target": quest_def["target"],
                "progress": existing.get("progress", 0),
                "window": existing.get("window", {"from": None, "to": None}),
                "criteria": quest_def["criteria"],
                "completed_at": existing.get("completed_at"),
                "notified_at": existing.get("notified_at"),
            }
            continue

        criteria = quest_def["criteria"]
        progress = 0

        events = _all_motion_events_in_window(store, start_dt, end_dt, cam_ids)
        if criteria.get("count_distinct_species"):
            species_seen: set[str] = set()
            for ev in events:
                if not _event_matches(ev, criteria):
                    continue
                sp = (ev.get("bird_species") or "").strip()
                if sp:
                    species_seen.add(sp.lower())
            progress = len(species_seen)
        elif criteria.get("count_distinct_days"):
            # "Stammgast" — sightings on distinct calendar days
            # within the window. Any event counts (no label filter),
            # but a label filter still applies if present.
            days_seen: set[str] = set()
            for ev in events:
                if criteria.get("label") or criteria.get("labels") or criteria.get("hour_in"):
                    if not _event_matches(ev, criteria):
                        continue
                t = ev.get("time") or ""
                day = t[:10]  # "YYYY-MM-DD"
                if len(day) == 10:
                    days_seen.add(day)
            progress = len(days_seen)
        else:
            for ev in events:
                if _event_matches(ev, criteria):
                    progress += 1

        progress = min(progress, quest_def["target"])
        was_completed = bool(existing.get("completed_at"))
        completed_at = existing.get("completed_at")
        if not was_completed and progress >= quest_def["target"]:
            completed_at = now.isoformat(timespec="seconds")
            newly_completed.append(qid)

        quests[qid] = {
            "id": qid,
            "title": quest_def["title"],
            "icon": quest_def["icon"],
            "description": quest_def["description"],
            "target": quest_def["target"],
            "progress": progress,
            "window": {
                "from": start_dt.isoformat(timespec="seconds"),
                "to": end_dt.isoformat(timespec="seconds"),
            },
            "criteria": criteria,
            "completed_at": completed_at,
            "notified_at": existing.get("notified_at"),
        }

    # Notification pass — call the callback for every quest that just
    # completed AND hasn't been notified yet. We mark notified_at here
    # so a successful caller-save persists it; if the caller crashes
    # before writing, the next eval re-fires.
    if notify:
        for qid in list(quests.keys()):
            q = quests[qid]
            if q.get("completed_at") and not q.get("notified_at"):
                try:
                    notify(q)
                    q["notified_at"] = now.isoformat(timespec="seconds")
                except Exception as e:
                    log.warning("[quests] notify callback failed for %s: %s", qid, e)

    data["quests"] = quests
    return data, newly_completed


# ── Archive ────────────────────────────────────────────────────────────────
def archive_closed_quests(
    achievements_data: dict,
    now: datetime | None = None,
) -> tuple[dict, list[dict]]:
    """Move window-closed quests with progress > 0 to ``quests_archive``;
    drop window-closed quests with progress == 0 silently.

    Rules (applied to every quest in ``data["quests"]``):
      * ``completed_at`` set → leave alone (the 30-day pinboard rule in
        the frontend handles eventual disappearance).
      * Catalog entry no longer exists (id base not in QUESTS):
          - progress > 0 → archive, reason ``catalog_removed``
          - progress == 0 → drop
      * Window's `to` field is in the past AND quest not completed:
          - progress > 0 → archive, reason ``window_closed_incomplete``
          - progress == 0 → drop

    Returns ``(updated_data, archived_summaries)`` where each summary is
    ``{id, title, progress, target, window, archived_reason}`` — the
    caller (reevaluate_and_save) logs them.
    """
    now = now or datetime.now()
    data = dict(achievements_data) if achievements_data else {}
    quests = dict(data.get("quests") or {})
    archive = dict(data.get("quests_archive") or {})
    archived_summaries: list[dict] = []
    catalogue = {q["id"]: q for q in QUESTS}

    for qid, q in list(quests.items()):
        if q.get("completed_at"):
            continue
        # Strip the year suffix (`wintervorrat_2026` → `wintervorrat`)
        # so we can compare to the catalogue's base ids.
        base_id = qid.rsplit("_", 1)[0]
        try:
            int(qid.rsplit("_", 1)[-1])
        except ValueError:
            base_id = qid  # no year suffix — use whole id
        progress = int(q.get("progress") or 0)
        reason: str | None = None

        if base_id not in catalogue:
            reason = "catalog_removed"
        else:
            # A window is considered logically closed when `now` is past
            # the END-of-period date (Dec 31 / last-of-month / etc.).
            # The stored {from, to} pair is just a snapshot — the `to`
            # field always equals the eval timestamp and would
            # incorrectly mark every window as closed-on-next-tick.
            window_name = catalogue[base_id]["window"]
            stored_from_str = (q.get("window") or {}).get("from")
            try:
                stored_from = datetime.fromisoformat(stored_from_str) if stored_from_str else None
            except ValueError:
                stored_from = None
            logical_end = _window_logical_end(window_name, stored_from)
            if logical_end is not None and now > logical_end:
                reason = "window_closed_incomplete"

        if reason is None:
            continue

        # Pop from active quests in either case.
        quests.pop(qid, None)
        if progress > 0:
            entry = {
                **q,
                "archived_at": now.isoformat(timespec="seconds"),
                "archived_reason": reason,
            }
            archive[qid] = entry
            archived_summaries.append(
                {
                    "id": qid,
                    "title": q.get("title"),
                    "progress": progress,
                    "target": q.get("target"),
                    "window": q.get("window"),
                    "archived_reason": reason,
                }
            )
            log.info(
                "[quests] archived %s (%d/%s) reason=%s window=%s..%s",
                qid,
                progress,
                q.get("target"),
                reason,
                (q.get("window") or {}).get("from"),
                (q.get("window") or {}).get("to"),
            )
        else:
            log.debug("[quests] dropped %s (progress=0, reason=%s)", qid, reason)

    data["quests"] = quests
    data["quests_archive"] = archive
    return data, archived_summaries


# ── Upcoming-quests preview ────────────────────────────────────────────────
def preview_upcoming_quests(
    now: datetime | None = None,
    horizon_days: int = 60,
) -> list[dict]:
    """Walk QUESTS and return the entries whose NEXT window opens within
    ``horizon_days``. Skips quests whose current window is already active
    (those are on the active pinboard, not the preview). Result is
    sorted soonest-first."""
    now = now or datetime.now()
    horizon = now + timedelta(days=int(horizon_days))
    out: list[dict] = []
    for q in QUESTS:
        # Quests whose window resolves to a concrete (start, end) at
        # `now` are already active — skip from the preview.
        start_now, _end_now = _resolve_window(q["window"], now)
        if start_now is not None:
            continue
        opens_at = _next_window_start(q["window"], now)
        if opens_at is None or opens_at > horizon:
            continue
        closes_at = _next_window_close(q["window"], opens_at)
        out.append(
            {
                "id": q["id"],
                "title": q["title"],
                "icon": q["icon"],
                "description": q["description"],
                "opens_at": opens_at.isoformat(timespec="seconds"),
                "closes_at": closes_at.isoformat(timespec="seconds") if closes_at else None,
                "opens_in_days": max(0, (opens_at - now).days),
            }
        )
    out.sort(key=lambda x: x["opens_at"])
    return out


def reevaluate_and_save(now: datetime | None = None, *, is_rollover: bool = False) -> dict:
    """One-call helper: load achievements, evaluate, archive, save,
    return summary. Used by the hourly background job, the daily
    rollover timer, the inline post-event hook, and the manual
    /api/achievements/quests/reevaluate API.

    ``is_rollover`` triggers an extra INFO line summarising the
    archive churn at week/month boundary so the operator sees the
    rotation in `docker logs`.
    """
    from . import app_state
    from .routes.sichtungen import (
        _ach_lock,
        _load_achievements,
        _save_achievements,
    )

    settings = app_state.settings
    storage_root = app_state.storage_root
    if settings is None or storage_root is None:
        return {"ok": False, "error": "app_state not initialised"}
    cams = settings.export_effective_config(app_state.base_cfg).get("cameras", []) or []
    cam_ids = [c["id"] for c in cams if c.get("id")]

    def _notify(q: dict):
        tg = app_state.telegram_service
        if tg is None or not getattr(tg, "enabled", False):
            return
        send = getattr(tg, "send_quest_completed", None)
        if callable(send):
            send(q)

    with _ach_lock:
        existing = _load_achievements()
        updated, newly = evaluate_quests(
            store=app_state.store,
            achievements_data=existing,
            cam_ids=cam_ids,
            storage_root=storage_root,
            now=now,
            notify=_notify,
        )
        # Archive any closed-window or catalog-removed entries the eval
        # just produced. archive_closed_quests is idempotent — running
        # twice yields the same dict.
        updated, archived = archive_closed_quests(updated, now=now)
        _save_achievements(updated)
    log.info(
        "[quests] re-evaluated %d quests, %d newly completed, %d archived: %s",
        len(updated.get("quests") or {}),
        len(newly),
        len(archived),
        newly,
    )
    if is_rollover:
        log.info(
            "[quests] rollover: archived=%d new_active=%d",
            len(archived),
            len(updated.get("quests") or {}),
        )
    return {
        "ok": True,
        "evaluated": len(updated.get("quests") or {}),
        "newly_completed": newly,
        "archived": [a["id"] for a in archived],
    }

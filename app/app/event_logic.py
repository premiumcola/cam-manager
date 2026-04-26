from __future__ import annotations
from datetime import datetime


def _parse_hhmm(s: str) -> tuple[int, int]:
    try:
        h, m = (s or "").split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0


def _window_keys(schedule: dict) -> tuple[str, str]:
    """Read the start/end pair from either the new (from/to) or legacy
    (start/end) shape. Migration writes from/to; this dual lookup is only
    here so a hand-edited config that still uses start/end keeps working
    long enough to fall through the migration path on next save."""
    s = schedule.get("from") if "from" in schedule else schedule.get("start", "22:00")
    e = schedule.get("to")   if "to"   in schedule else schedule.get("end",   "06:00")
    return s, e


def is_in_schedule(schedule: dict, now: datetime | None = None) -> bool:
    """True iff `now` falls inside the configured window. Wraps over
    midnight when from > to (e.g. 21:00 → 06:00). enabled=False → False."""
    if not schedule or not schedule.get("enabled"):
        return False
    now = now or datetime.now()
    sh, sm = _parse_hhmm(_window_keys(schedule)[0])
    eh, em = _parse_hhmm(_window_keys(schedule)[1])
    cur = now.hour * 60 + now.minute
    start = sh * 60 + sm
    end = eh * 60 + em
    if start == end:
        # Equal endpoints = "always" inside the window — matches the prior
        # behaviour and avoids a silent dead zone.
        return True
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def schedule_action_active(schedule: dict, action: str, now: datetime | None = None) -> bool:
    """Resolve a single action gate (record / telegram / hard).

    schedule.enabled=False → action is always active (24/7).
    schedule.enabled=True  → active only when in_window AND actions[action] is True.
    """
    if not schedule:
        return True
    if not schedule.get("enabled"):
        return True
    actions = schedule.get("actions") or {}
    if not actions.get(action, True):
        return False
    return is_in_schedule(schedule, now)


def choose_alarm_level(profile, labels: list[str], hard_active: bool, whitelisted: bool) -> tuple[str, bool]:
    """Decide (alarm_level, notify) for an event.

    `hard_active` (NEW) — True when the per-camera schedule's "hard"
    action is currently in effect. While active, ANY person detection
    is upgraded to alarm regardless of the alarm profile. Replaces the
    previous after_hours+profile gate.

    `profile` is a string — "hard", "medium", "soft", or "info". For
    backward compatibility we also accept a dict with an "alarm_profile"
    key, which was the old signature (group dict).
    """
    if isinstance(profile, dict):
        profile = profile.get("alarm_profile", "soft")
    profile = (profile or "soft").strip() or "soft"
    labels = labels or ["motion"]
    if whitelisted:
        return "logged", False
    # Hart-Modus override — person → alarm regardless of profile while active.
    if hard_active and "person" in labels:
        return "alarm", True
    if any(x in labels for x in ["person", "car"]) and profile == "hard":
        return "alarm", True
    if any(x in labels for x in ["person", "car", "cat", "bird", "dog", "squirrel"]) and profile == "medium":
        return "info", True
    if any(x in labels for x in ["cat", "bird", "dog", "squirrel"]) and profile == "info":
        return "info", True
    if profile == "soft":
        return "info", True
    # motion-only events still notify for hard/medium profiles
    if "motion" in labels and profile in {"hard", "medium"}:
        return "info", True
    return "logged", False


# ── Smoke tests (run with `python -m app.event_logic`) ─────────────────────
if __name__ == "__main__":
    from datetime import datetime as _dt
    def _at(hh, mm):
        return _dt.now().replace(hour=hh, minute=mm, second=0, microsecond=0)

    # Case A: from < to (08:00 → 18:00)
    sch = {"enabled": True, "from": "08:00", "to": "18:00",
           "actions": {"record": True, "telegram": True, "hard": True}}
    assert is_in_schedule(sch, _at(7, 59)) is False
    assert is_in_schedule(sch, _at(8,  0)) is True
    assert is_in_schedule(sch, _at(17, 59)) is True
    assert is_in_schedule(sch, _at(18,  0)) is False

    # Case B: from > to (21:00 → 06:00, midnight wrap)
    sch = {"enabled": True, "from": "21:00", "to": "06:00",
           "actions": {"record": True, "telegram": True, "hard": True}}
    assert is_in_schedule(sch, _at(20, 59)) is False
    assert is_in_schedule(sch, _at(21,  0)) is True
    assert is_in_schedule(sch, _at(0,   0)) is True
    assert is_in_schedule(sch, _at(5,  59)) is True
    assert is_in_schedule(sch, _at(6,   0)) is False

    # Case C: from == to (treated as always-on)
    sch = {"enabled": True, "from": "12:00", "to": "12:00",
           "actions": {"record": True, "telegram": True, "hard": True}}
    assert is_in_schedule(sch, _at(0, 0)) is True
    assert is_in_schedule(sch, _at(23, 59)) is True

    # disabled → always False (the gate's job is the action helper)
    sch = {"enabled": False, "from": "08:00", "to": "18:00", "actions": {}}
    assert is_in_schedule(sch, _at(12, 0)) is False
    # but action helper returns True (24/7 fallback)
    assert schedule_action_active(sch, "record", _at(12, 0)) is True
    assert schedule_action_active(sch, "telegram", _at(3, 0)) is True

    # Action gate respects per-action toggle
    sch = {"enabled": True, "from": "21:00", "to": "06:00",
           "actions": {"record": True, "telegram": False, "hard": True}}
    assert schedule_action_active(sch, "record",   _at(22, 0)) is True
    assert schedule_action_active(sch, "telegram", _at(22, 0)) is False
    assert schedule_action_active(sch, "hard",     _at(22, 0)) is True
    # Outside window: actions never fire (record/telegram fall back to off)
    assert schedule_action_active(sch, "record",   _at(12, 0)) is False
    print("event_logic smoke tests OK")

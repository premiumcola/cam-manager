from __future__ import annotations
from datetime import datetime


def _parse_hhmm(s: str) -> tuple[int, int]:
    try:
        h, m = s.split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0


def is_in_schedule(schedule: dict, now: datetime | None = None) -> bool:
    if not schedule or not schedule.get("enabled"):
        return False
    now = now or datetime.now()
    sh, sm = _parse_hhmm(schedule.get("start", "22:00"))
    eh, em = _parse_hhmm(schedule.get("end", "06:00"))
    cur = now.hour * 60 + now.minute
    start = sh * 60 + sm
    end = eh * 60 + em
    if start == end:
        return True
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def choose_alarm_level(group: dict, labels: list[str], after_hours: bool, whitelisted: bool) -> tuple[str, bool]:
    profile = (group or {}).get("alarm_profile", "soft")
    labels = labels or ["motion"]
    if whitelisted:
        return "logged", False
    if "person" in labels and after_hours and profile in {"hard", "medium"}:
        return "alarm", True
    if any(x in labels for x in ["person", "car"]) and profile == "hard":
        return "alarm", True
    if any(x in labels for x in ["cat", "bird"]) and profile == "info":
        return "info", True
    if profile == "soft":
        return "info", True
    return "logged", False

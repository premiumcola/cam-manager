"""Shared helpers for the Telegram push system.

Single source of truth for German label names, scoring weights, quiet/night
detection and the most-specific label rule used both by the alert pipeline
and the daily report.
"""
from __future__ import annotations
from datetime import datetime
import logging

log = logging.getLogger(__name__)

# Mirror of OBJ_LABEL in app/web/static/app.js — keep in sync.
LABEL_DE: dict[str, str] = {
    "person":       "Person",
    "cat":          "Katze",
    "bird":         "Vogel",
    "car":          "Auto",
    "dog":          "Hund",
    "squirrel":     "Eichhörnchen",
    "fox":          "Fuchs",
    "hedgehog":     "Igel",
    "motion":       "Bewegung",
    "alarm":        "Alarm",
    "timelapse":    "Timelapse",
    "object":       "Objekt",
    "notification": "Benachrichtigung",
}

# Object labels (more specific than motion). Order matters: when an event
# carries multiple labels we pick the highest-priority one as "primary".
OBJECT_LABELS: tuple[str, ...] = (
    "person", "car", "dog", "cat", "squirrel", "fox", "hedgehog", "bird",
)

# Highlight-of-the-day scoring weights — wildlife wins over routine pets/people.
LABEL_WEIGHT: dict[str, float] = {
    "squirrel": 1.5,
    "fox":      1.5,
    "hedgehog": 1.5,
    "bird":     1.2,
    "cat":      1.1,
    "person":   1.0,
    "dog":      1.0,
    "car":      0.8,
}

# Birds that are routine in this region and shouldn't win highlight-of-the-day.
DULL_BIRDS = {"spatz", "haussperling", "amsel"}

# Sun elevation (deg) at and below which we treat the scene as "night".
NIGHT_ELEV_DEG: float = -6.0


def most_specific_label(labels: list[str] | tuple[str, ...] | None) -> str:
    """Return the single most-specific label for an event, mirroring the
    Mediathek's most-specific counting rule. Object labels win over motion;
    falls back to 'motion' when no recognised label is present."""
    if not labels:
        return "motion"
    label_set = set(labels)
    for cand in OBJECT_LABELS:
        if cand in label_set:
            return cand
    if "motion" in label_set:
        return "motion"
    return next(iter(label_set))


def _parse_hhmm(s: str | None) -> tuple[int, int]:
    if not s or ":" not in s:
        return 0, 0
    try:
        h, m = s.split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0


def is_quiet_now(quiet_hours: dict | None, now: datetime | None = None) -> bool:
    """True when current local time falls within the configured quiet window
    (wraps midnight). Empty/missing config = never quiet."""
    if not quiet_hours:
        return False
    now = now or datetime.now()
    sh, sm = _parse_hhmm(quiet_hours.get("start"))
    eh, em = _parse_hhmm(quiet_hours.get("end"))
    cur = now.hour * 60 + now.minute
    start = sh * 60 + sm
    end = eh * 60 + em
    if start == end:
        return False
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def is_night(night_cfg: dict | None, now: datetime | None = None) -> bool:
    """Determine night via astral sun elevation (preferred) or a fixed
    start/end window fallback. Returns False if night_alert is disabled."""
    if not night_cfg or not night_cfg.get("enabled", True):
        return False
    now = now or datetime.now()
    use_sun = bool(night_cfg.get("use_sun", True))
    lat = night_cfg.get("lat")
    lon = night_cfg.get("lon")
    if use_sun and lat is not None and lon is not None:
        try:
            from astral import LocationInfo
            from astral.sun import elevation
            loc = LocationInfo(latitude=float(lat), longitude=float(lon))
            elev = elevation(loc.observer, now)
            return elev < NIGHT_ELEV_DEG
        except Exception as e:
            log.debug("[night] astral failed, falling back to clock: %s", e)
    # Fallback: fixed hh:mm window (defaults to 22:00–07:00).
    return is_quiet_now({
        "start": night_cfg.get("start", "22:00"),
        "end":   night_cfg.get("end",   "07:00"),
    }, now)


def truncate_caption(text: str, limit: int = 1024) -> str:
    """Telegram caption hard limit is 1024 chars."""
    if not text or len(text) <= limit:
        return text or ""
    return text[: limit - 1] + "…"

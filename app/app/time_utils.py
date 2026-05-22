"""Time / date helpers shared across services.

Hosts ``parse_hhmm`` — previously copy-pasted into three modules
(telegram_bot/_consts, telegram_helpers, event_logic). Future
time-of-day helpers belong here too.
"""

from __future__ import annotations


def parse_hhmm(s: str | None) -> tuple[int, int]:
    """Parse a ``HH:MM`` clock string into ``(hour, minute)``.

    None, empty, missing colon, or any int() failure collapses to
    ``(0, 0)`` so callers can safely feed user-edited config without
    branching on every possible malformed input. The schedule /
    quiet-hours code interprets ``(0, 0)`` as midnight, which is
    the same "do nothing" default that an empty string used to
    produce before consolidation.
    """
    if not s or ":" not in s:
        return 0, 0
    try:
        h, m = s.split(":", 1)
        return int(h), int(m)
    except Exception:
        return 0, 0

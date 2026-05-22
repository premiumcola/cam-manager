"""Single source of truth for "what kind of rain is this" labels.

The weather event-type "heavy_rain" is named after the trigger threshold,
not the current value: an event card showing 0.1 mm/h must NOT label
itself "Starkregen". DWD-style intensity bands give a per-value label
that callers (UI, Telegram, MQTT) all share so the wording is consistent
across surfaces.

Bands (mm/h):
    0.0           → "Trocken"
    0.0 < x ≤ 0.5 → "Nieselregen"
    0.5 < x ≤ 2.5 → "Leichter Regen"
    2.5 < x ≤ 7.5 → "Mäßiger Regen"
    7.5 < x ≤ 15  → "Starker Regen"
    > 15          → "Starkregen"

Note: this is for the *current observed rate*. The
`EVENT_LABEL_DE["heavy_rain"]` mapping over in _consts.py stays as-is —
that one names the event TYPE, not the instantaneous reading.
"""

from __future__ import annotations


def precipitation_label(mm_per_hour) -> str:
    """Return the DWD intensity band label for a precipitation rate.

    `None` and unparseable inputs collapse to "Trocken" — choosing
    silence over a wrong loud label. Callers that want to distinguish
    "no data" from "no rain" should check the input themselves first.
    """
    if mm_per_hour is None:
        return "Trocken"
    try:
        v = float(mm_per_hour)
    except (TypeError, ValueError):
        return "Trocken"
    if v <= 0.0:
        return "Trocken"
    if v <= 0.5:
        return "Nieselregen"
    if v <= 2.5:
        return "Leichter Regen"
    if v <= 7.5:
        return "Mäßiger Regen"
    if v <= 15.0:
        return "Starker Regen"
    return "Starkregen"

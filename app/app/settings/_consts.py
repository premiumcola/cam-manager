"""Constants shared between settings.defaults and settings.migrations.

These are pure data — kept in their own module so neither the defaults
builder nor the migration helpers carry the other's import. SettingsStore
itself does not import from here; consumers go through the merged
runtime view (export_effective_config / runtime_*)."""
from __future__ import annotations


# Default Telegram push schema. Single source of truth feeding both
# fresh installs (build_defaults) and the additive backfill on existing
# data (migrate_telegram_push_defaults).
TELEGRAM_PUSH_DEFAULTS: dict = {
    "enabled": True,
    "rate_limit_seconds": 30,
    "quiet_hours": {"start": "22:00", "end": "07:00"},
    "night_alert": {
        "enabled":    True,
        "armed_only": True,
        "use_sun":    True,
        "lat":        None,
        "lon":        None,
        # Fallback window when use_sun is off or lat/lon missing.
        "start": "22:00",
        "end":   "07:00",
    },
    "labels": {
        "person":   {"push": True,  "threshold": 0.85},
        "cat":      {"push": False, "threshold": 0.80},
        "dog":      {"push": True,  "threshold": 0.80},
        "bird":     {"push": False, "threshold": 0.90},
        "car":      {"push": True,  "threshold": 0.85},
        "squirrel": {"push": True,  "threshold": 0.80},
        "motion":   {"push": False, "threshold": 0.0},
    },
    "daily_report": {"enabled": True, "time": "22:00"},
    "highlight":    {"enabled": True, "time": "19:00"},
    "system":       {"enabled": True},
    "timelapse":    {"enabled": True},
    # Wetter-Sichtungen Push (Phase 3). Per-event toggles control whether
    # a successful weather clip triggers a Telegram send. min_score gates
    # everything — sightings below the bar are skipped regardless.
    "weather": {
        "enabled": True,
        "min_score": 0.4,
        "events": {
            "thunder":    True,
            "heavy_rain": True,
            "snow":       True,
            "fog":        False,   # default off — pretty rare to be interesting
            "sunset":     True,
        },
        "recap_push": True,        # ein Push pro fertigem Quartals-/Jahres-Recap
    },
}


# Server.location fallback — Nuremberg (project HQ). Only applied when
# the user hasn't entered coordinates; never overwrites existing values.
SERVER_LOCATION_DEFAULTS: dict = {
    "lat": 49.4521,
    "lon": 11.0767,
    "elevation": None,
}


# Global weather defaults. Same idempotent additive-merge pattern as
# TELEGRAM_PUSH_DEFAULTS — every key the WeatherService expects is
# backfilled on each load() so a fresh install and an upgraded install
# behave identically.
WEATHER_DEFAULTS: dict = {
    "enabled":       True,
    "poll_interval": 300,
    "events": {
        # lightning_potential is in J/kg from Open-Meteo's icon_d2 model.
        "thunder":    {"enabled": True,  "threshold": 1000.0, "cooldown_min": 30},
        "heavy_rain": {"enabled": True,  "threshold": 5.0, "hysteresis": 1.0, "cooldown_min": 30},
        "snow":       {"enabled": True,  "threshold": 0.5,  "cooldown_min": 60},
        "fog":        {"enabled": True,  "vis_max_m": 1000, "contrast_max": 0.25, "cooldown_min": 90},
        # Sunset: triggers once per day in the dusk window.
        "sunset":     {"enabled": True,  "alt_min": -2, "alt_max": 5,
                       "min_duration_min": 12, "cooldown_min": 720},
    },
    "clip": {
        "pre_roll_s":  5,
        "post_roll_s": 5,
        "fps":         15,
        "width":       1280,
    },
    "api": {
        "base_url": "https://api.open-meteo.com/v1/forecast",
        "model":    "icon_d2",
        "timezone": "Europe/Berlin",
    },
}


TL_DEFAULT_PROFILES = {
    "daily":   {"enabled": False, "target_seconds": 60,  "period_seconds": 86400},
    "weekly":  {"enabled": False, "target_seconds": 180, "period_seconds": 604800},
    "monthly": {"enabled": False, "target_seconds": 300, "period_seconds": 2592000},
    "custom":  {"enabled": False, "target_seconds": 30,  "period_seconds": 600},
}


# Per-class detection-score floor. Snapshot constant so reads from
# default_camera don't accidentally mutate the source dict if a caller
# pokes at it.
LABEL_THRESHOLD_DEFAULTS = {
    "person":   0.65,
    "cat":      0.55,
    "bird":     0.45,
    "squirrel": 0.45,
}
# N-of-M sliding-window defaults per class. Bird + squirrel run with
# smaller windows (they cross the frame in seconds; 3-of-5 would
# often miss them); person/cat get the conservative 3-of-5 floor.
CONFIRMATION_WINDOW_DEFAULTS = {
    "person":   {"n": 3, "seconds": 5.0},
    "cat":      {"n": 3, "seconds": 5.0},
    "bird":     {"n": 2, "seconds": 4.0},
    "squirrel": {"n": 2, "seconds": 3.0},
}


# Per-camera sun-timelapse defaults — both phases off until the user
# opts in. window_min is overridden at runtime by _SUN_TL_LOCKED_WINDOW_MIN
# (75 min) and persisted here as 30 only for legacy round-trips.
# E1 · interval_s 3 → 8 (defeats the Reolink snapshot-API cache that
# bursts up to 14 identical frames on a 3 s pull), fps 25 → 15
# (matches the cross-system fixed output rate so the encoder doesn't
# have to "stretch" against a dedup-shortened frame budget). See
# settings/migrations.py · _migrate_timelapse_intervals for the
# matching clamp on legacy settings.json files.
SUN_TL_DEFAULTS: dict = {
    "sunrise": {"enabled": False, "window_min": 30, "interval_s": 8, "fps": 15},
    "sunset":  {"enabled": False, "window_min": 30, "interval_s": 8, "fps": 15},
}


# Per-camera event-timelapse defaults — opt-in master switch + per-trigger
# toggles. Default OFF so existing weather cameras don't suddenly start
# producing 60-min timelapses without explicit consent.
# E1 · interval_s 6 → 8, fps 24 → 15 — same rationale as SUN_TL above.
EVENT_TL_DEFAULTS: dict = {
    "enabled":    False,
    "window_min": 60,
    "interval_s": 8,
    "fps":        15,
    "triggers": {
        "thunder_rising": True,
        "front_passing":  True,
        "storm_front":    True,
    },
}


# Per-class severity matrix — one of "off" / "info" / "alarm" per
# supported class (person, cat, bird, squirrel, dog, car, motion).
# Replaces the four-valued alarm_profile string. The mapping below
# mirrors the previous profile semantics so an upgrade with a legacy
# alarm_profile lands on the equivalent matrix without the user having
# to redo their notification config:
#   hard:   person/car=alarm, animals=off, motion=off
#   medium: person/car=alarm, animals=info, motion=off
#   soft:   person=alarm, car=info, animals=info, motion=info
#   info:   animals=info, person/car/motion=off
ALARM_PROFILE_TO_SEVERITY = {
    "hard":   {"person": "alarm", "car": "alarm",
               "cat": "off", "bird": "off", "squirrel": "off", "dog": "off",
               "motion": "off"},
    "medium": {"person": "alarm", "car": "alarm",
               "cat": "info", "bird": "info", "squirrel": "info", "dog": "info",
               "motion": "off"},
    "soft":   {"person": "alarm", "car": "info",
               "cat": "info", "bird": "info", "squirrel": "info", "dog": "info",
               "motion": "info"},
    "info":   {"person": "off", "car": "off",
               "cat": "info", "bird": "info", "squirrel": "info", "dog": "info",
               "motion": "off"},
}

"""Boot-time migrations applied to settings.json.

Each function takes the raw `data` dict and mutates it in place. The
ordered MIGRATIONS list at the bottom is the authoritative call
sequence — store.load() iterates it once on every load. Newer
migrations append to the end; never reorder existing entries because
they may depend on one another (e.g. migrate_class_severity reads
alarm_profile which migrate_camera_defaults backfills).
"""

from __future__ import annotations

import logging

from ._consts import (
    ALARM_PROFILE_TO_SEVERITY,
    EVENT_TL_DEFAULTS,
    SERVER_LOCATION_DEFAULTS,
    SUN_TL_DEFAULTS,
    TELEGRAM_PUSH_DEFAULTS,
    TL_DEFAULT_PROFILES,
    WEATHER_DEFAULTS,
)
from .defaults import default_camera, window_minutes

log = logging.getLogger(__name__)


def _deep_merge_defaults(target: dict, defaults: dict) -> None:
    """Recursively fill missing keys in `target` from `defaults`.

    Existing user values are NEVER overwritten — only absent keys (and
    nested absent keys inside dicts) are added. Values whose existing
    type is not dict are left as-is even when the default is a dict;
    this protects against stomping on hand-edited overrides.
    """
    if not isinstance(target, dict):
        return
    for key, default_val in defaults.items():
        if isinstance(default_val, dict):
            sub = target.setdefault(key, {})
            if isinstance(sub, dict):
                _deep_merge_defaults(sub, default_val)
        else:
            target.setdefault(key, default_val)


def migrate_camera_defaults(data: dict, base_config: dict) -> None:
    cameras = data.setdefault("cameras", [])
    by_id = {c.get("id"): c for c in cameras}
    # Also index by display name so a seed cam that was renamed by the
    # storage_migration (e.g. "cam-Werkstatt.rechts.oben" →
    # "unknown_unknown_werkstatt_172") isn't blindly re-added under its
    # original id on the next boot. Two cams sharing the same name is
    # already handled elsewhere — this just stops the migration from
    # silently un-doing itself.
    by_name = {(c.get("name") or "").strip().lower(): c for c in cameras if c.get("name")}
    for c in base_config.get("cameras", []):
        base_name = (c.get("name") or "").strip().lower()
        if c["id"] in by_id:
            target = by_id[c["id"]]
        elif base_name and base_name in by_name:
            target = by_name[base_name]
        else:
            cameras.append(default_camera(c))
            continue
        # Only add missing keys; never overwrite user-saved values.
        defaults = default_camera(c)
        for key, val in defaults.items():
            target.setdefault(key, val)


def migrate_schedules(data: dict) -> bool:
    """One-time migration: collapse legacy recording_schedule_* and the
    old alerting-only schedule {enabled,start,end} into one unified
    schedule {enabled, from, to, actions:{record,telegram,hard}}.

    Idempotent — a camera whose schedule already carries the 'actions'
    key is left untouched. Returns True if any cam was migrated so the
    caller can persist the result."""
    migrated = 0
    for cam in data.get("cameras", []):
        sch = cam.get("schedule")
        if isinstance(sch, dict) and "actions" in sch:
            # Already in the new shape; just make sure all sub-keys exist.
            sch.setdefault("from", sch.get("start", "21:00"))
            sch.setdefault("to", sch.get("end", "06:00"))
            acts = sch.setdefault("actions", {})
            acts.setdefault("record", True)
            acts.setdefault("telegram", True)
            acts.setdefault("hard", True)
            continue

        rec_enabled = bool(cam.get("recording_schedule_enabled"))
        rec_start = cam.get("recording_schedule_start", "08:00")
        rec_end = cam.get("recording_schedule_end", "22:00")
        ale_dict = sch if isinstance(sch, dict) else {}
        ale_enabled = bool(ale_dict.get("enabled"))
        ale_start = ale_dict.get("start", "22:00")
        ale_end = ale_dict.get("end", "06:00")

        if not rec_enabled and not ale_enabled:
            new_sched = {
                "enabled": False,
                "from": "21:00",
                "to": "06:00",
                "actions": {"record": True, "telegram": True, "hard": True},
            }
            src = "both-off"
        elif rec_enabled and not ale_enabled:
            new_sched = {
                "enabled": True,
                "from": rec_start,
                "to": rec_end,
                "actions": {"record": True, "telegram": True, "hard": False},
            }
            src = "recording-only"
        elif not rec_enabled and ale_enabled:
            new_sched = {
                "enabled": True,
                "from": ale_start,
                "to": ale_end,
                "actions": {"record": True, "telegram": True, "hard": True},
            }
            src = "alerting-only"
        else:
            # Both active — keep the larger window.
            rec_dur = window_minutes(rec_start, rec_end)
            ale_dur = window_minutes(ale_start, ale_end)
            if rec_dur >= ale_dur:
                f, t = rec_start, rec_end
            else:
                f, t = ale_start, ale_end
            new_sched = {
                "enabled": True,
                "from": f,
                "to": t,
                "actions": {"record": True, "telegram": True, "hard": True},
            }
            src = f"both-on (rec={rec_dur}m ale={ale_dur}m → wider)"

        cam["schedule"] = new_sched
        cam.pop("recording_schedule_enabled", None)
        cam.pop("recording_schedule_start", None)
        cam.pop("recording_schedule_end", None)
        log.info(
            "Schedule-Migration: %s → %s (%s → enabled=%s %s-%s actions=%s)",
            cam.get("id", "?"),
            src,
            f"rec={rec_enabled}/{rec_start}/{rec_end} " f"ale={ale_enabled}/{ale_start}/{ale_end}",
            new_sched["enabled"],
            new_sched["from"],
            new_sched["to"],
            new_sched["actions"],
        )
        migrated += 1
    return migrated > 0


def migrate_class_severity(data: dict) -> None:
    """One-time migration: derive class_severity dict from the legacy
    alarm_profile when class_severity is empty. The legacy alarm_profile
    field stays in storage so older code paths still read it;
    class_severity becomes the new source of truth. Idempotent —
    cameras that already carry a non-empty class_severity dict are
    left untouched.
    """
    migrated = 0
    for cam in data.get("cameras", []):
        if cam.get("class_severity"):
            continue
        profile = (cam.get("alarm_profile") or "soft").strip() or "soft"
        mapping = ALARM_PROFILE_TO_SEVERITY.get(profile, ALARM_PROFILE_TO_SEVERITY["soft"])
        cam["class_severity"] = dict(mapping)
        migrated += 1
        log.info(
            "class_severity-Migration: %s ← alarm_profile=%s → %s",
            cam.get("id", "?"),
            profile,
            mapping,
        )
    if migrated:
        log.info("class_severity-Migration: %d Kameras migriert", migrated)


def migrate_alerting_schedules(data: dict) -> None:
    """One-time migration: derive schedule_notify and schedule_record
    from the legacy schedule.actions structure. The legacy schedule
    field stays in storage but is no longer the source of truth — the
    runtime now reads schedule_notify for Telegram/MQTT gating and
    schedule_record for archive gating.

    Mapping:
      schedule_notify.enabled = legacy.enabled AND actions.telegram
      schedule_notify.from/to = legacy.from/to
      schedule_record.enabled = legacy.enabled AND actions.record
      schedule_record.from/to = legacy.from/to

    Idempotent — cameras that already carry both new schedules are
    left untouched. Empty schedule_notify or schedule_record keys are
    filled in even when the other already exists.
    """
    migrated = 0
    for cam in data.get("cameras", []):
        has_n = isinstance(cam.get("schedule_notify"), dict) and cam["schedule_notify"]
        has_r = isinstance(cam.get("schedule_record"), dict) and cam["schedule_record"]
        if has_n and has_r:
            continue
        sch = cam.get("schedule") or {}
        actions = sch.get("actions") or {}
        sch_enabled = bool(sch.get("enabled"))
        sch_from = sch.get("from") or "21:00"
        sch_to = sch.get("to") or "06:00"
        if not has_n:
            cam["schedule_notify"] = {
                "enabled": sch_enabled and actions.get("telegram", True) is not False,
                "from": sch_from,
                "to": sch_to,
            }
        if not has_r:
            cam["schedule_record"] = {
                "enabled": sch_enabled and actions.get("record", True) is not False,
                "from": sch_from,
                "to": sch_to,
            }
        migrated += 1
        log.info(
            "Alerting-Schedule-Migration: %s ← legacy=%s → notify=%s record=%s",
            cam.get("id", "?"),
            sch,
            cam["schedule_notify"],
            cam["schedule_record"],
        )
    if migrated:
        log.info("Alerting-Schedule-Migration: %d Kameras migriert", migrated)


def migrate_timelapse_settings(data: dict) -> None:
    data.setdefault("timelapse_settings", {"global_enabled": False})


def migrate_timelapse_profiles(data: dict) -> None:
    """Additively add missing timelapse profile keys to existing cameras."""
    for cam in data.get("cameras", []):
        tl = cam.setdefault("timelapse", {})
        profiles = tl.setdefault("profiles", {})
        for pname, pdefault in TL_DEFAULT_PROFILES.items():
            prof = profiles.setdefault(pname, {})
            for k, v in pdefault.items():
                prof.setdefault(k, v)
        # Migrate: if old timelapse.enabled=True but no profile enabled, enable daily
        if tl.get("enabled") and not any(p.get("enabled") for p in profiles.values()):
            profiles["daily"]["enabled"] = True


def migrate_telegram_push_defaults(data: dict) -> None:
    """Additively backfill telegram.push so every key the UI expects exists."""
    tg = data.setdefault("telegram", {})
    push = tg.setdefault("push", {})
    if not isinstance(push, dict):
        push = {}
        tg["push"] = push
    _deep_merge_defaults(push, TELEGRAM_PUSH_DEFAULTS)
    # Backfill night-alert lat/lon from server.location when present —
    # avoids forcing the user to re-enter coordinates already known to
    # the system.
    night = push.get("night_alert") or {}
    srv_loc = (data.get("server", {}) or {}).get("location") or {}
    if night.get("lat") is None and srv_loc.get("lat") is not None:
        night["lat"] = srv_loc.get("lat")
    if night.get("lon") is None and srv_loc.get("lon") is not None:
        night["lon"] = srv_loc.get("lon")


def migrate_server_location_defaults(data: dict) -> None:
    srv = data.setdefault("server", {})
    loc = srv.setdefault("location", {})
    if not isinstance(loc, dict):
        loc = {}
        srv["location"] = loc
    for k, v in SERVER_LOCATION_DEFAULTS.items():
        loc.setdefault(k, v)


def migrate_weather_defaults(data: dict) -> None:
    """Additively backfill the global weather block + per-camera flag."""
    w = data.setdefault("weather", {})
    if not isinstance(w, dict):
        w = {}
        data["weather"] = w
    _deep_merge_defaults(w, WEATHER_DEFAULTS)
    # Make sure every camera carries the opt-in flag in the new shape;
    # existing cameras with handcrafted weather dicts are left alone.
    # The sun_timelapse sub-block is added unconditionally — it's the
    # nested-default backfill the WeatherService relies on at startup.
    for cam in data.get("cameras", []):
        cw = cam.setdefault("weather", {"enabled": False})
        if not isinstance(cw, dict):
            cam["weather"] = {"enabled": False}
            continue
        cw.setdefault("enabled", False)
        sun_tl = cw.setdefault("sun_timelapse", {})
        if isinstance(sun_tl, dict):
            _deep_merge_defaults(sun_tl, SUN_TL_DEFAULTS)
        evt_tl = cw.setdefault("event_timelapse", {})
        if isinstance(evt_tl, dict):
            _deep_merge_defaults(evt_tl, EVENT_TL_DEFAULTS)


def migrate_timelapse_intervals(data: dict) -> None:
    """E1 · enforce the 2026-05-16 timelapse floor on legacy settings.json
    files: every capture interval clamps to ≥ 8 s, every fps locks to
    15. Two-pronged regression defuse:

      * Reolink's HTTP snapshot endpoint serves the same JPEG bytes
        for ~5–14 consecutive pulls at a 3 s interval (cached buffer);
        an 8 s floor drops the duplicate-frame rate from ~20 % to a
        single-digit residue without any camera-side change.
      * The encoder's "stretch to target_duration_s" math produces a
        choppy 4–5 fps MP4 the moment dedup drops too many frames.
        Locking the output to 15 fps eliminates that whole class of
        bug.

    Only the four fields below are mutated; every other key on
    every camera / weather block is left untouched (the migration
    must never destructively rewrite the JSON). Setdefault-style
    additive guards above the clamp catch the "block exists but
    field missing" case so a half-populated legacy file still gets
    valid 8 s / 15 fps values."""
    floor_s = 8
    fixed_fps = 15
    touched_intervals = 0
    touched_fps = 0
    for cam in data.get("cameras", []):
        if not isinstance(cam, dict):
            continue
        # Per-camera motion-snapshot interval. Used by storage compaction
        # AND by the recording layer; only the integer field moves.
        si = cam.get("snapshot_interval_s")
        if isinstance(si, (int, float)) and int(si) < floor_s:
            cam["snapshot_interval_s"] = floor_s
            touched_intervals += 1
        # Camera-side recurring timelapse (daily/weekly/...).
        tl = cam.get("timelapse")
        if isinstance(tl, dict) and tl.get("fps") not in (None, fixed_fps):
            tl["fps"] = fixed_fps
            touched_fps += 1
        # Weather block: sun_timelapse.{sunrise,sunset} + event_timelapse.
        cw = cam.get("weather")
        if not isinstance(cw, dict):
            continue
        sun_tl = cw.get("sun_timelapse")
        if isinstance(sun_tl, dict):
            for phase in ("sunrise", "sunset"):
                p = sun_tl.get(phase)
                if not isinstance(p, dict):
                    continue
                pi = p.get("interval_s")
                if isinstance(pi, (int, float)) and int(pi) < floor_s:
                    p["interval_s"] = floor_s
                    touched_intervals += 1
                if p.get("fps") not in (None, fixed_fps):
                    p["fps"] = fixed_fps
                    touched_fps += 1
        evt_tl = cw.get("event_timelapse")
        if isinstance(evt_tl, dict):
            ei = evt_tl.get("interval_s")
            if isinstance(ei, (int, float)) and int(ei) < floor_s:
                evt_tl["interval_s"] = floor_s
                touched_intervals += 1
            if evt_tl.get("fps") not in (None, fixed_fps):
                evt_tl["fps"] = fixed_fps
                touched_fps += 1
    if touched_intervals or touched_fps:
        log.info(
            "[migration] timelapse-floor: clamped %d interval_s ≥ %ds, " "forced %d fps → %d",
            touched_intervals,
            floor_s,
            touched_fps,
            fixed_fps,
        )


def migrate_label_thresholds(data: dict) -> None:
    """Rewrite the legacy person threshold default 0.65 → 0.45.

    A live test (user standing arms-out in frame) had Coral score
    person 0.28 and 0.44; both were rejected by the 0.65 floor and
    the user saw "Person wird nicht erkannt". 0.65 was the previous
    LABEL_THRESHOLD_DEFAULTS["person"], i.e. a value that landed
    in storage purely because it was the default at write time, not
    because the operator chose it. We rewrite ONLY that exact 0.65
    value — any other stored threshold (e.g. a deliberately raised
    0.55 or 0.80) is left untouched. Idempotent: cameras already on
    0.45 (or any non-0.65 value) skip the touch path.
    """
    touched = 0
    for cam in data.get("cameras", []):
        thrs = cam.get("label_thresholds")
        if not isinstance(thrs, dict):
            continue
        person = thrs.get("person")
        if not isinstance(person, (int, float)):
            continue
        if abs(float(person) - 0.65) < 1e-9:
            thrs["person"] = 0.45
            touched += 1
    if touched:
        log.info(
            "[migration] label-thresholds: rewrote stale person=0.65 → 0.45 " "on %d Kameras",
            touched,
        )


def migrate_runtime_defaults(data: dict) -> None:
    rt = data.setdefault("runtime", {})
    if not isinstance(rt, dict):
        rt = {}
        data["runtime"] = rt
    rt.setdefault("event_feedback", {})
    rt.setdefault("suppress", {})
    rt.setdefault("system_state", {})
    rt.setdefault("alert_index", {})
    rt.setdefault("last_storage_warn_ts", 0)
    rt.setdefault("last_coral_state", "")

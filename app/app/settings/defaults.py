"""Default-config builders for SettingsStore.

Pure data; no SettingsStore reference. Imported by store.py at boot to
seed self.data; imported by migrations.py for camera-default backfill.
"""

from __future__ import annotations

from copy import deepcopy

from ._consts import (
    CONFIRMATION_WINDOW_DEFAULTS,
    LABEL_THRESHOLD_DEFAULTS,
    TELEGRAM_PUSH_DEFAULTS,
    TL_DEFAULT_PROFILES,
)


def default_schedule() -> dict:
    """enabled=False → all three actions effectively 24/7."""
    return {
        "enabled": False,
        "from": "21:00",
        "to": "06:00",
        "actions": {"record": True, "telegram": True, "hard": True},
    }


def default_camera(cam: dict | None = None) -> dict:
    cam = cam or {}
    _tl = cam.get("timelapse") or {}
    _existing_profiles = _tl.get("profiles") or {}
    _merged_profiles = {
        pname: {**pdefault, **(_existing_profiles.get(pname) or {})}
        for pname, pdefault in TL_DEFAULT_PROFILES.items()
    }
    return {
        "id": cam.get("id", ""),
        "name": cam.get("name", cam.get("id", "")),
        # Backfilled additively for legacy cameras: missing → "" so the
        # canonical id picks up "unknown" segments; the user fills these
        # in the camera-edit form when they want a semantic id.
        "manufacturer": cam.get("manufacturer", ""),
        "model": cam.get("model", ""),
        "location": cam.get("location", ""),
        "enabled": cam.get("enabled", True),
        "rtsp_url": cam.get("rtsp_url", ""),
        "snapshot_url": cam.get("snapshot_url", ""),
        "username": cam.get("username", ""),
        "password": cam.get("password", ""),
        "object_filter": cam.get("object_filter", ["person", "cat", "bird"]),
        # 0.0 = "auto" — runtime derives 1.4× motion_sensitivity (capped
        # at 1.0) so wildlife stays more sensitive than normal motion
        # without forcing the user to set both sliders.
        "wildlife_motion_sensitivity": cam.get("wildlife_motion_sensitivity", 0.0),
        # wildlife_min_score lives in the track_* group below — the
        # earlier duplicate entry here was a leftover from the first
        # pass. Both produced the same float-or-zero result, so the
        # removal is bit-identical.
        # Per-label confidence overrides. Defaults are tuned to be
        # forgiving — false positives are caught by the N-of-M
        # confirmation window (see schedule_action_active +
        # DetectionConfirmer), so we no longer need a hard 0.72 floor
        # on person to suppress single-frame artefacts. A live test
        # with a clearly-visible person scored 0.28-0.44 under the
        # old 0.65 floor (every frame REJECTED), which was the root
        # cause of "Person wird nicht erkannt". 0.45 is the SSD-
        # MobileNet industry norm; see migrate_label_thresholds.
        #   - person:   0.45  (was 0.65, originally 0.72)
        #   - cat:      0.55
        #   - bird:     0.45  (smaller subjects, lower COCO confidence)
        #   - squirrel: 0.45  (wildlife stage is the second guard)
        # Migration: cams that still hold the old singleton
        # {"person": 0.72} are upgraded to the 4-class default. Cams
        # with anything else (custom person value, extra labels)
        # keep their config — never stomp user-tuned settings.
        "label_thresholds": (
            dict(LABEL_THRESHOLD_DEFAULTS)
            if cam.get("label_thresholds", None) in (None, {"person": 0.72})
            else cam.get("label_thresholds")
        ),
        # N-of-M confirmation window. Falsy / missing → fresh defaults
        # so existing cams pick up the gate on the next config reload.
        # User-customised dicts pass through untouched.
        "confirmation_window": (
            cam.get("confirmation_window")
            if cam.get("confirmation_window")
            else dict(CONFIRMATION_WINDOW_DEFAULTS)
        ),
        "timelapse": {
            "enabled": _tl.get("enabled", False),
            "fps": _tl.get("fps", 30),
            "period": _tl.get("period", "day"),
            "daily_target_seconds": _tl.get("daily_target_seconds", 60),
            "weekly_target_seconds": _tl.get("weekly_target_seconds", 180),
            "telegram_send": _tl.get("telegram_send", False),
            "profiles": _merged_profiles,
        },
        "zones": cam.get("zones", []),
        "masks": cam.get("masks", []),
        "armed": cam.get("armed", True),
        "telegram_enabled": cam.get("telegram_enabled", True),
        "mqtt_enabled": cam.get("mqtt_enabled", True),
        # Wetter-Sichtungen: opt-in per camera. The substream prebuffer +
        # API polling only spin up for cameras with weather.enabled=True;
        # everyone else stays at zero RAM/CPU cost.
        "weather": (cam.get("weather") or {"enabled": False}),
        # Unified per-camera schedule (replaces the old recording-schedule
        # top-level fields and the alerting-only schedule). Default off
        # = 24/7 in every dimension. See migrate_schedules for the
        # one-time merge of the legacy fields.
        "schedule": cam.get("schedule", default_schedule()),
        "whitelist_names": cam.get("whitelist_names", []),
        "resolution": cam.get("resolution", "auto"),
        "frame_interval_ms": cam.get("frame_interval_ms", 350),
        "snapshot_interval_s": cam.get("snapshot_interval_s", 8),
        # Scroll-level per-camera tuning sliders — were missing from the
        # persisted dict so saves silently dropped them.
        "motion_sensitivity": float(cam.get("motion_sensitivity") or 0.5),
        "detection_min_score": float(cam.get("detection_min_score") or 0.0),
        "bottom_crop_px": int(cam.get("bottom_crop_px") or 0),
        "motion_enabled": cam.get("motion_enabled", True),
        "detection_trigger": cam.get("detection_trigger", "motion_and_objects"),
        "post_motion_tail_s": float(cam.get("post_motion_tail_s") or 0.0),
        "alarm_profile": (cam.get("alarm_profile") or "").strip(),
        # Per-class severity matrix — derived once from the legacy
        # alarm_profile if absent, then persisted as the source of
        # truth. See migrate_class_severity for the mapping.
        "class_severity": cam.get("class_severity") or {},
        # Recording-archive toggle. Defaults True to preserve the
        # historical "actions.record=True" behaviour pre-split.
        "recording_enabled": cam.get("recording_enabled", True),
        # Two independent schedules — see migrate_alerting_schedules
        # for the one-time derivation from the legacy schedule.actions.
        "schedule_notify": cam.get("schedule_notify") or {},
        "schedule_record": cam.get("schedule_record") or {},
        # Per-class notification cooldown (seconds). Empty dict =
        # use the runtime's per-class fallbacks (see
        # _NOTIFY_COOLDOWN_DEFAULTS in telegram_bot).
        "notification_cooldown": cam.get("notification_cooldown") or {},
        # bw916 — per-camera tracker overrides. The four preset buttons
        # in the cam-edit Erkennung tab populate these inputs; before
        # this entry was added, the keys lived in CAMERA_SCHEMA but
        # never made it into default_camera, so the merged dict that
        # upsert_camera builds dropped them and existing.update(merged)
        # could never overwrite the previously-stored value. 0.0 keeps
        # tracker_core's module default.
        "track_spawn_min_score": float(cam.get("track_spawn_min_score") or 0.0),
        "track_continue_min_score": float(cam.get("track_continue_min_score") or 0.0),
        "track_miss_grace_seconds": float(cam.get("track_miss_grace_seconds") or 0.0),
        "track_iou_match_threshold": float(cam.get("track_iou_match_threshold") or 0.0),
        "track_postclip_precision": (cam.get("track_postclip_precision") or "standard"),
        # L07 — ghost-track pruning toggle. Default True so existing
        # cams pick up the cleanup on their next save without user
        # action. `setdefault`-style read with False fallback ONLY when
        # explicitly stored False (the explicit-False case the user
        # wants for debugging).
        "track_filter_ghosts": (False if cam.get("track_filter_ghosts") is False else True),
        # Reolink HTTP-CGI port override — same persistence hole as the
        # tracker fields above, surfaced by task vk257 when the image-
        # mode panel's port number was getting dropped on save.
        "reolink_http_port": int(cam.get("reolink_http_port") or 0),
        "wildlife_min_score": float(cam.get("wildlife_min_score") or 0.0),
        # Per-camera streaming preferences + timestamp-overlay calibration.
        # Empty dicts mean "use the module-level defaults"; the runtime
        # only checks them when present so an unset camera keeps its
        # historical behaviour.
        "streaming": (cam.get("streaming") or {}),
        "timestamp_overlay_zone": (cam.get("timestamp_overlay_zone") or {}),
    }


def build_defaults(base_config: dict) -> dict:
    cams = [default_camera(cam) for cam in base_config.get("cameras", [])]
    return {
        "app": {
            "name": base_config.get("app", {}).get("name", "TAM-spy"),
            "tagline": base_config.get("app", {}).get(
                "tagline", "Analyse · Sicherheit · Tierbeobachtung"
            ),
            "logo": base_config.get("app", {}).get("logo", "🐈‍⬛"),
            "theme": base_config.get("app", {}).get("theme", "dark"),
        },
        "server": {
            "public_base_url": base_config.get("server", {}).get("public_base_url", ""),
            "default_discovery_subnet": base_config.get("server", {}).get(
                "default_discovery_subnet", "192.168.1.0/24"
            ),
        },
        "telegram": {
            "enabled": base_config.get("telegram", {}).get("enabled", False),
            "token": base_config.get("telegram", {}).get("token", ""),
            "chat_id": str(base_config.get("telegram", {}).get("chat_id", "")),
            "push": deepcopy(TELEGRAM_PUSH_DEFAULTS),
        },
        "mqtt": {
            "enabled": base_config.get("mqtt", {}).get("enabled", False),
            "host": base_config.get("mqtt", {}).get("host", "mqtt"),
            "port": int(base_config.get("mqtt", {}).get("port", 1883)),
            "username": base_config.get("mqtt", {}).get("username", ""),
            "password": base_config.get("mqtt", {}).get("password", ""),
            "base_topic": base_config.get("mqtt", {}).get("base_topic", "tam-spy"),
        },
        "cameras": cams,
        "telegram_actions": [],
        "review": {},
        "ui": {"wizard_completed": bool(cams)},
        "timelapse_settings": {
            "global_enabled": base_config.get("timelapse_settings", {}).get(
                "global_enabled", False
            ),
        },
        # Ephemeral runtime data (callback verdicts, suppress windows,
        # offline state). Persisted so a service reload doesn't lose
        # active mute timers or in-flight system_state.
        "runtime": {
            "event_feedback": {},
            "suppress": {},
            "system_state": {},
            "alert_index": {},
            "last_storage_warn_ts": 0,
            "last_coral_state": "",
        },
    }


def window_minutes(start: str, end: str) -> int:
    """Length of an HH:MM window in minutes, supports midnight wrap.
    Empty/equal start+end → 1440 (always)."""

    def _p(s):
        try:
            h, m = (s or "").split(":", 1)
            return int(h) * 60 + int(m)
        except Exception:
            return 0

    s_min, e_min = _p(start), _p(end)
    if s_min == e_min:
        return 1440
    if e_min > s_min:
        return e_min - s_min
    return 1440 - s_min + e_min  # wraps midnight

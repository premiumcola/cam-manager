"""
Input validation schemas for SettingsStore write methods.

Schema format
─────────────
Camera / Group schemas use tuples:
    {field_name: (expected_type, default_or_REQUIRED)}

Section schemas (for update_section) use bare types — all section fields are
treated as optional, they are only type-checked/coerced when present:
    {field_name: expected_type}

validate_and_coerce(data, schema) returns a NEW dict with validated and
coerced values. Unknown keys are passed through unchanged (forward-compatible).
Raises ValueError with a descriptive message on failure.
"""
from __future__ import annotations

# Sentinel for required fields. `object()` is unique so it can't collide
# with any real default value.
REQUIRED = object()

# Object classes the system can filter, label, badge, and chart. Frontend
# pill lists, server stats sets and event_logic mirror this — keep in sync.
KNOWN_OBJECT_LABELS: frozenset[str] = frozenset({
    "person", "cat", "bird", "car", "dog",
})


def _coerce(val, target_type, field_name: str):
    # list/dict cannot be safely coerced from scalar values
    if target_type in (list, dict):
        raise ValueError(
            f"Field {field_name}: expected {target_type.__name__}, "
            f"got {type(val).__name__}"
        )
    # bool needs special handling: bool("false") is True in Python
    if target_type is bool:
        if isinstance(val, (int, float)):
            return bool(val)
        if isinstance(val, str):
            low = val.strip().lower()
            if low in ("true", "1", "yes", "on"):
                return True
            if low in ("false", "0", "no", "off", ""):
                return False
        raise ValueError(
            f"Field {field_name}: expected bool, got {type(val).__name__}"
        )
    try:
        return target_type(val)
    except (TypeError, ValueError):
        raise ValueError(
            f"Field {field_name}: expected {target_type.__name__}, "
            f"got {type(val).__name__}"
        )


def validate_and_coerce(data: dict, schema: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError(f"Expected object, got {type(data).__name__}")
    result = dict(data)
    for field, spec in schema.items():
        if isinstance(spec, tuple):
            field_type, marker = spec
            is_required = marker is REQUIRED
        else:
            field_type = spec
            is_required = False

        if field not in result:
            if is_required:
                raise ValueError(f"Missing field: {field}")
            continue

        val = result[field]
        if not isinstance(val, field_type) or (field_type is int and isinstance(val, bool)):
            # bool is an int subclass — reject bool→int passthrough explicitly
            result[field] = _coerce(val, field_type, field)

    return result


# ── Camera ─────────────────────────────────────────────────────────────────────

CAMERA_SCHEMA: dict = {
    "id":                  (str,   REQUIRED),
    "name":                (str,   REQUIRED),
    "enabled":             (bool,  True),
    "rtsp_url":            (str,   ""),
    "snapshot_url":        (str,   ""),
    "username":            (str,   ""),
    "password":            (str,   ""),
    "location":            (str,   ""),
    "armed":               (bool,  True),
    "telegram_enabled":    (bool,  True),
    "mqtt_enabled":        (bool,  True),
    "resolution":          (str,   "auto"),
    "frame_interval_ms":   (int,   350),
    "snapshot_interval_s": (int,   3),
    "bottom_crop_px":      (int,   0),
    "motion_sensitivity":  (float, 0.5),
    "motion_enabled":      (bool,  True),
    "detection_trigger":   (str,   "motion_and_objects"),
    "post_motion_tail_s":  (float, 0.0),  # 0 = use global default
    "detection_min_score": (float, 0.0),
    "alarm_profile":       (str,   ""),
    "recording_schedule_enabled": (bool, False),
    "recording_schedule_start":   (str,  "08:00"),
    "recording_schedule_end":     (str,  "22:00"),
    "object_filter":       (list,  []),
    "label_thresholds":    (dict,  {}),
    "zones":               (list,  []),
    "masks":               (list,  []),
    "whitelist_names":     (list,  []),
    "timelapse":           (dict,  {}),
    "schedule":            (dict,  {}),
}

# ── Section schemas (for update_section; all fields optional) ──────────────────

SECTION_SCHEMAS: dict = {
    "app": {
        "name":    str,
        "tagline": str,
        "logo":    str,
        "theme":   str,
    },
    "server": {
        "public_base_url":          str,
        "default_discovery_subnet": str,
    },
    "telegram": {
        "enabled": bool,
        "token":   str,
        "chat_id": str,
    },
    "mqtt": {
        "enabled":    bool,
        "host":       str,
        "port":       int,
        "username":   str,
        "password":   str,
        "base_topic": str,
    },
    "storage": {
        "retention_days":       int,
        "media_limit_default":  int,
        "auto_cleanup_enabled": bool,
    },
    "ui": {
        "wizard_completed": bool,
    },
}

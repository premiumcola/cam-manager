"""Unit tests for the validate_and_coerce input validator."""
import sys
from pathlib import Path

import pytest

# Make `app` package importable (same trick as test_rebuild_runtimes)
_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.schema import (  # noqa: E402
    validate_and_coerce,
    CAMERA_SCHEMA,
    GROUP_SCHEMA,
    SECTION_SCHEMAS,
    REQUIRED,
)


class TestValidateAndCoerce:
    # ── 1. Valid input passes through ────────────────────────────────────────
    def test_valid_input_passes(self):
        data = {"id": "cam1", "name": "Camera 1", "enabled": True,
                "rtsp_url": "rtsp://1.2.3.4", "frame_interval_ms": 200}
        out = validate_and_coerce(data, CAMERA_SCHEMA)
        assert out["id"] == "cam1"
        assert out["name"] == "Camera 1"
        assert out["enabled"] is True
        assert out["frame_interval_ms"] == 200

    # ── 2. Missing required field raises ──────────────────────────────────────
    def test_missing_required_raises(self):
        with pytest.raises(ValueError) as exc_info:
            validate_and_coerce({"name": "Camera 1"}, CAMERA_SCHEMA)
        assert "Missing field: id" in str(exc_info.value)

    def test_missing_required_group_id(self):
        with pytest.raises(ValueError) as exc_info:
            validate_and_coerce({"name": "Garden"}, GROUP_SCHEMA)
        assert "Missing field: id" in str(exc_info.value)

    # ── 3. Wrong type with successful coercion ───────────────────────────────
    def test_str_to_int_coercion(self):
        """A frontend sometimes posts numeric values as strings."""
        data = {"id": "cam1", "name": "Cam", "frame_interval_ms": "350"}
        out = validate_and_coerce(data, CAMERA_SCHEMA)
        assert out["frame_interval_ms"] == 350
        assert isinstance(out["frame_interval_ms"], int)

    def test_str_to_bool_coercion(self):
        data = {"id": "cam1", "name": "Cam", "enabled": "false"}
        out = validate_and_coerce(data, CAMERA_SCHEMA)
        assert out["enabled"] is False

    def test_int_to_bool_coercion(self):
        data = {"id": "cam1", "name": "Cam", "armed": 0}
        out = validate_and_coerce(data, CAMERA_SCHEMA)
        assert out["armed"] is False

    # ── 4. Wrong type that cannot be coerced raises ──────────────────────────
    def test_list_type_cannot_be_coerced_from_str(self):
        data = {"id": "cam1", "name": "Cam", "object_filter": "person,cat"}
        with pytest.raises(ValueError) as exc_info:
            validate_and_coerce(data, CAMERA_SCHEMA)
        assert "object_filter" in str(exc_info.value)
        assert "expected list" in str(exc_info.value)

    def test_int_coercion_failure(self):
        data = {"id": "cam1", "name": "Cam", "frame_interval_ms": "not-a-number"}
        with pytest.raises(ValueError) as exc_info:
            validate_and_coerce(data, CAMERA_SCHEMA)
        assert "frame_interval_ms" in str(exc_info.value)
        assert "expected int" in str(exc_info.value)

    # ── 5. Unknown extra keys pass through unchanged ─────────────────────────
    def test_unknown_key_passes_through(self):
        data = {"id": "cam1", "name": "Cam", "future_field": "some-value",
                "another_unknown": 42}
        out = validate_and_coerce(data, CAMERA_SCHEMA)
        assert out["future_field"] == "some-value"
        assert out["another_unknown"] == 42

    # ── Section schemas (all optional) ───────────────────────────────────────
    def test_section_schema_all_optional(self):
        """Section schemas treat every field as optional — empty dict is valid."""
        out = validate_and_coerce({}, SECTION_SCHEMAS["mqtt"])
        assert out == {}

    def test_section_schema_coerces_port(self):
        data = {"host": "mqtt.local", "port": "1883"}
        out = validate_and_coerce(data, SECTION_SCHEMAS["mqtt"])
        assert out["port"] == 1883
        assert isinstance(out["port"], int)

    def test_section_schema_rejects_bad_bool(self):
        data = {"enabled": ["not", "a", "bool"]}
        with pytest.raises(ValueError):
            validate_and_coerce(data, SECTION_SCHEMAS["telegram"])

    # ── Non-dict input ───────────────────────────────────────────────────────
    def test_non_dict_input_raises(self):
        with pytest.raises(ValueError):
            validate_and_coerce("not a dict", CAMERA_SCHEMA)

    # ── Input is not mutated ─────────────────────────────────────────────────
    def test_input_not_mutated(self):
        data = {"id": "cam1", "name": "Cam", "frame_interval_ms": "350"}
        snapshot = dict(data)
        validate_and_coerce(data, CAMERA_SCHEMA)
        assert data == snapshot, "validate_and_coerce must not mutate input"

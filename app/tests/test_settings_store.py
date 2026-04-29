"""Tests for SettingsStore.upsert_camera id-rebuild path.

Reproduces the scenario behind the user-facing complaint
'manufacturer/model never seem to stick': a cam first lands with
empty Hersteller/Modell (canonical id collapses to
``unknown_unknown_<name>_<octet>``), then the user fills the fields
in via the camera-edit form. After the second upsert the canonical
id must be rebuilt and the legacy entry must be gone.

IPs in fixtures are RFC 5737 documentation addresses
(``192.0.2.0/24``)."""
from __future__ import annotations
import importlib
import sys
from pathlib import Path

import pytest  # noqa: F401  (pytest discovery + future fixtures)

_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

# test_rebuild_runtimes installs a MagicMock under
# sys.modules["app.settings_store"] at *import time*; pytest's collection
# pass picks that up before our import runs, leaving us with a fake
# SettingsStore class. Drop the stub and re-import the real module so
# these tests see the actual upsert_camera behaviour.
sys.modules.pop("app.settings_store", None)
import app.settings_store  # noqa: E402
importlib.reload(app.settings_store)

from app.settings_store import SettingsStore  # noqa: E402


def _make_store(tmp_path: Path) -> SettingsStore:
    """Minimal base_config — enough to satisfy schema defaults without
    pulling in real config.yaml. Storage root sits inside tmp_path so
    the migration's analysis pass has a real (empty) tree to walk."""
    storage = tmp_path / "storage"
    storage.mkdir()
    base_config = {
        "app":    {"name": "TAM-spy"},
        "server": {
            "host": "0.0.0.0",
            "port": 8099,
            "default_discovery_subnet": "192.0.2.0/24",
        },
        "cameras": [],
    }
    return SettingsStore(storage / "settings.json", base_config)


def test_upsert_keeps_unknown_id_when_manufacturer_empty(tmp_path: Path):
    """Baseline: empty Hersteller/Modell → canonical id stays
    unknown_unknown_<name>_<octet>. Confirms the bug-precondition
    upsert path is stable so the second upsert in the next test is
    a clean delta."""
    store = _make_store(tmp_path)
    cam = {
        "id":           "unknown_unknown_squirreltownnutbar_183",
        "name":         "Squirrel Town Nut Bar",
        "manufacturer": "",
        "model":        "",
        "rtsp_url":     "rtsp://user:pass@192.0.2.183/h265Preview_01_main",
    }
    returned_id = store.upsert_camera(dict(cam))
    assert returned_id == "unknown_unknown_squirreltownnutbar_183"
    assert store.get_camera(returned_id) is not None


def test_upsert_rebuilds_id_after_manufacturer_filled(tmp_path: Path):
    """Bug repro: the user edits manufacturer + model on an existing
    cam. After save, the canonical id must reflect the new fields,
    the cam record must show the new id, and no zombie
    'unknown_unknown_*' entry may remain in settings.cameras."""
    store = _make_store(tmp_path)
    cam_v1 = {
        "id":           "unknown_unknown_squirreltownnutbar_183",
        "name":         "Squirrel Town Nut Bar",
        "manufacturer": "",
        "model":        "",
        "rtsp_url":     "rtsp://user:pass@192.0.2.183/h265Preview_01_main",
    }
    store.upsert_camera(dict(cam_v1))

    # User opens the edit form, fills in Hersteller + Modell, hits save.
    cam_v2 = {**cam_v1, "manufacturer": "Reolink", "model": "RLC-810A"}
    returned_id = store.upsert_camera(dict(cam_v2))

    assert returned_id == "reolink_rlc810a_squirreltownnutbar_183"
    persisted = store.get_camera(returned_id)
    assert persisted is not None
    assert persisted["manufacturer"] == "Reolink"
    assert persisted["model"] == "RLC-810A"
    assert persisted["id"] == returned_id

    ids = [c.get("id") for c in store.data.get("cameras", [])]
    assert returned_id in ids
    assert "unknown_unknown_squirreltownnutbar_183" not in ids
    assert not any(i.startswith("unknown_unknown") for i in ids)

"""End-to-end tests for storage_migration.migrate.

We build a fake on-disk layout that mirrors the dual-folder pattern seen
in the wild (cam-<ip-dashes> + cam-<name> for the same camera) alongside
a single clean folder, point a stub SettingsStore at it, and verify the
migration:
  - merges the dual folders into the new canonical id
  - rewrites event JSON paths
  - removes the empty object_detection placeholder
  - is idempotent (second invocation is a no-op)

IPs in fixtures are RFC 5737 documentation addresses (192.0.2.0/24)."""
from __future__ import annotations
import json
import sys
from pathlib import Path

import pytest

_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.storage_migration import migrate  # noqa: E402


class _FakeSettingsStore:
    """Just enough of SettingsStore for migrate(). Holds an in-memory data
    dict + a path attribute so the migration's settings-backup helper can
    write to a real file."""

    def __init__(self, path: Path, data: dict):
        self.path = path
        self.data = data
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")

    def save(self):
        self.path.write_text(json.dumps(self.data, indent=2), encoding="utf-8")


def _make_storage(tmp_path: Path) -> Path:
    """Build a representative dual-folder scaffold in tmp."""
    storage = tmp_path / "storage"
    # motion_detection: Werkstatt has TWO legacy folders, Squirrel has one
    md = storage / "motion_detection"
    (md / "cam-192-0-2-172" / "2026-04-25").mkdir(parents=True)
    (md / "cam-192-0-2-172" / "2026-04-25" / "evt_a.jpg").write_bytes(b"a")
    (md / "cam-192-0-2-172" / "2026-04-25" / "evt_a.json").write_text(json.dumps({
        "event_id": "a",
        "camera_id": "cam-192-0-2-172",
        "video_relpath": "timelapse/cam-192-0-2-172/foo.mp4",
        "snapshot_relpath": "motion_detection/cam-192-0-2-172/2026-04-25/evt_a.jpg",
    }), encoding="utf-8")
    (md / "cam-Werkstatt.rechts.oben" / "2026-04-26").mkdir(parents=True)
    (md / "cam-Werkstatt.rechts.oben" / "2026-04-26" / "evt_b.jpg").write_bytes(b"b")
    (md / "cam-Werkstatt.rechts.oben" / "2026-04-26" / "evt_b.json").write_text(json.dumps({
        "event_id": "b",
        "camera_id": "cam-Werkstatt.rechts.oben",
        "snapshot_relpath": "motion_detection/cam-Werkstatt.rechts.oben/2026-04-26/evt_b.jpg",
    }), encoding="utf-8")
    (md / "cam-192-0-2-183" / "2026-04-26").mkdir(parents=True)
    (md / "cam-192-0-2-183" / "2026-04-26" / "evt_c.jpg").write_bytes(b"c")
    # timelapse_frames + timelapse — only the Werkstatt-named variant exists
    tlf = storage / "timelapse_frames"
    (tlf / "cam-Werkstatt.rechts.oben" / "daily" / "2026-04-26").mkdir(parents=True)
    (tlf / "cam-Werkstatt.rechts.oben" / "daily" / "2026-04-26" / "120000.jpg").write_bytes(b"f")
    (tlf / "cam-192-0-2-183" / "daily" / "2026-04-26").mkdir(parents=True)
    tl = storage / "timelapse"
    (tl / "cam-Werkstatt.rechts.oben").mkdir(parents=True)
    (tl / "cam-Werkstatt.rechts.oben" / "2026-04-26.mp4").write_bytes(b"v")
    (tl / "cam-192-0-2-183").mkdir(parents=True)
    # weather: not per-cam in the user's current state, but the migration
    # should tolerate the absence
    (storage / "weather").mkdir()
    # object_detection placeholder (empty) — must be rmdir'd
    (storage / "object_detection").mkdir()
    return storage


def _make_cams() -> list[dict]:
    return [
        {
            "id": "cam-Werkstatt.rechts.oben",
            "name": "Werkstatt",
            "manufacturer": "",
            "model": "",
            "rtsp_url": "rtsp://user:pass@192.0.2.172/h264Preview_01_main",
        },
        {
            "id": "cam-192-0-2-183",
            "name": "Squirrel Town",
            "manufacturer": "Reolink",
            "model": "RLC-810A",
            "rtsp_url": "rtsp://user:pass@192.0.2.183/h264Preview_01_main",
        },
    ]


class TestMigrate:
    def test_dual_folder_collapse(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        summary = migrate(store, storage)
        assert summary["noop"] is False
        # Werkstatt → unknown_unknown_werkstatt_172
        new_werk = "unknown_unknown_werkstatt_172"
        assert (storage / "motion_detection" / new_werk).is_dir()
        # Old folders gone
        assert not (storage / "motion_detection" / "cam-192-0-2-172").exists()
        assert not (storage / "motion_detection" / "cam-Werkstatt.rechts.oben").exists()
        # Both source-day subfolders ended up under the new id
        assert (storage / "motion_detection" / new_werk / "2026-04-25" / "evt_a.jpg").is_file()
        assert (storage / "motion_detection" / new_werk / "2026-04-26" / "evt_b.jpg").is_file()

    def test_canonical_camera_renamed(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        migrate(store, storage)
        # Squirrel → reolink_rlc810a_squirreltown_183 (manufacturer + model set)
        new_squirrel = "reolink_rlc810a_squirreltown_183"
        assert (storage / "motion_detection" / new_squirrel).is_dir()
        assert (storage / "timelapse_frames" / new_squirrel).is_dir()
        assert (storage / "timelapse" / new_squirrel).is_dir()

    def test_event_jsons_rewritten(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        migrate(store, storage)
        new_werk = "unknown_unknown_werkstatt_172"
        evt_a = (storage / "motion_detection" / new_werk / "2026-04-25" / "evt_a.json").read_text(encoding="utf-8")
        meta = json.loads(evt_a)
        assert "cam-192-0-2-172" not in evt_a
        assert meta["video_relpath"] == f"timelapse/{new_werk}/foo.mp4"
        assert meta["snapshot_relpath"] == f"motion_detection/{new_werk}/2026-04-25/evt_a.jpg"
        evt_b = (storage / "motion_detection" / new_werk / "2026-04-26" / "evt_b.json").read_text(encoding="utf-8")
        assert "cam-Werkstatt.rechts.oben" not in evt_b
        assert new_werk in evt_b

    def test_settings_id_updated(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        migrate(store, storage)
        ids = {c["id"] for c in store.data["cameras"]}
        assert "unknown_unknown_werkstatt_172" in ids
        assert "reolink_rlc810a_squirreltown_183" in ids
        # settings.json on disk reflects the new ids too
        on_disk = json.loads(store.path.read_text(encoding="utf-8"))
        on_disk_ids = {c["id"] for c in on_disk["cameras"]}
        assert on_disk_ids == ids

    def test_object_detection_placeholder_removed(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        migrate(store, storage)
        assert not (storage / "object_detection").exists()

    def test_idempotent(self, tmp_path):
        """Second invocation must report noop=True and change nothing."""
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        first = migrate(store, storage)
        assert first["noop"] is False
        # Snapshot disk + settings, then run again.
        before = sorted(p.relative_to(storage).as_posix()
                        for p in storage.rglob("*") if p.is_file())
        before_settings = store.path.read_text(encoding="utf-8")
        second = migrate(store, storage)
        assert second["noop"] is True, f"second run was not noop: {second}"
        after = sorted(p.relative_to(storage).as_posix()
                       for p in storage.rglob("*") if p.is_file())
        assert before == after
        assert before_settings == store.path.read_text(encoding="utf-8")

    def test_settings_backup_created(self, tmp_path):
        storage = _make_storage(tmp_path)
        store = _FakeSettingsStore(tmp_path / "settings.json",
                                   {"cameras": _make_cams()})
        summary = migrate(store, storage)
        assert summary["backup"] is not None
        bak = Path(summary["backup"])
        assert bak.exists()
        # Backup contains the OLD ids
        bak_content = bak.read_text(encoding="utf-8")
        assert "cam-Werkstatt.rechts.oben" in bak_content
        assert "cam-192-0-2-183" in bak_content

    def test_no_cameras_no_op(self, tmp_path):
        storage = tmp_path / "storage"
        storage.mkdir()
        store = _FakeSettingsStore(tmp_path / "settings.json", {"cameras": []})
        s = migrate(store, storage)
        assert s["noop"] is True
        assert s["cameras"] == 0

"""B · Storage hygiene — event JSON co-located in the date subfolder.

Covers:
  - EventStore.add_event() places a new event in
    motion_detection/<cam>/<YYYY-MM-DD>/<event_id>.json (date from
    event_id[:8]) and falls back to the camera root for non-date ids.
  - relocate_root_event_jsons migration moves a loose root-level JSON
    + its .tracks.json sidecar into the date subfolder, leaves tl_*.json
    and unparseable ids alone, is idempotent, and never overwrites.
  - reads (get_event / list_events / _filter_events) still resolve after
    both the new write path and the migration.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.migrations import _relocate_root_event_jsons_sync  # noqa: E402
from app.storage import EventStore, event_date_subdir  # noqa: E402

CAM = "reolink_cx810_gartendachterrasse_181"
EID = "20260528-205220-121254"  # -> 2026-05-28


def _event(event_id: str, **extra) -> dict:
    base = {
        "event_id": event_id,
        "camera_id": CAM,
        "labels": ["person"],
        "time": "2026-05-28T20:52:20",
        "snapshot_relpath": f"motion_detection/{CAM}/2026-05-28/{event_id}.jpg",
    }
    base.update(extra)
    return base


def test_event_date_subdir_helper():
    assert event_date_subdir("20260528-205220-121254") == "2026-05-28"
    assert event_date_subdir("20261231-000000-000000") == "2026-12-31"
    # non-date / legacy / timelapse ids -> None (caller falls back to root)
    assert event_date_subdir("tl_2026-05-28") is None
    assert event_date_subdir("custom") is None
    assert event_date_subdir("1234567") is None  # only 7 digits


def test_add_event_places_in_date_subfolder(tmp_storage_root):
    store = EventStore(str(tmp_storage_root))
    path = store.add_event(CAM, _event(EID))
    expected = tmp_storage_root / "motion_detection" / CAM / "2026-05-28" / f"{EID}.json"
    assert path == expected
    assert expected.is_file()
    # NOT at the camera root
    assert not (tmp_storage_root / "motion_detection" / CAM / f"{EID}.json").exists()
    # reads resolve via rglob
    got = store.get_event(CAM, EID)
    assert got is not None and got["event_id"] == EID
    assert store.list_events(CAM, limit=10)[0]["event_id"] == EID


def test_add_event_legacy_id_falls_back_to_root(tmp_storage_root):
    store = EventStore(str(tmp_storage_root))
    # timelapse-style id: must stay at the camera root
    tl_path = store.add_event(CAM, _event("tl_2026-05-28_daily"))
    assert tl_path == tmp_storage_root / "motion_detection" / CAM / "tl_2026-05-28_daily.json"
    assert tl_path.is_file()
    assert store.get_event(CAM, "tl_2026-05-28_daily") is not None


def test_migration_relocates_root_json_and_tracks(tmp_storage_root):
    store = EventStore(str(tmp_storage_root))
    cam_dir = tmp_storage_root / "motion_detection" / CAM
    cam_dir.mkdir(parents=True, exist_ok=True)
    # Seed a loose root-level event JSON + its tracks sidecar (the legacy
    # layout this migration cleans up).
    (cam_dir / f"{EID}.json").write_text(json.dumps(_event(EID)), encoding="utf-8")
    (cam_dir / f"{EID}.tracks.json").write_text(
        json.dumps({"schema": 3, "tracks": []}), encoding="utf-8"
    )

    moved = _relocate_root_event_jsons_sync(tmp_storage_root)
    assert moved == 2

    date_dir = cam_dir / "2026-05-28"
    assert (date_dir / f"{EID}.json").is_file()
    assert (date_dir / f"{EID}.tracks.json").is_file()
    # Gone from the root
    assert not (cam_dir / f"{EID}.json").exists()
    assert not (cam_dir / f"{EID}.tracks.json").exists()
    # Reads still resolve
    assert store.get_event(CAM, EID) is not None

    # Idempotent: a second run moves nothing.
    assert _relocate_root_event_jsons_sync(tmp_storage_root) == 0


def test_migration_leaves_tl_and_unparseable(tmp_storage_root):
    cam_dir = tmp_storage_root / "motion_detection" / CAM
    cam_dir.mkdir(parents=True, exist_ok=True)
    (cam_dir / "tl_2026-05-28_daily.json").write_text("{}", encoding="utf-8")
    (cam_dir / "custom_event.json").write_text("{}", encoding="utf-8")

    moved = _relocate_root_event_jsons_sync(tmp_storage_root)
    assert moved == 0
    # Both untouched, still at the root
    assert (cam_dir / "tl_2026-05-28_daily.json").is_file()
    assert (cam_dir / "custom_event.json").is_file()


def test_migration_never_overwrites_existing_target(tmp_storage_root):
    cam_dir = tmp_storage_root / "motion_detection" / CAM
    date_dir = cam_dir / "2026-05-28"
    date_dir.mkdir(parents=True, exist_ok=True)
    # A canonical copy already lives in the date subfolder...
    (date_dir / f"{EID}.json").write_text(json.dumps(_event(EID, labels=["cat"])), encoding="utf-8")
    # ...and a stale duplicate sits at the root.
    (cam_dir / f"{EID}.json").write_text(
        json.dumps(_event(EID, labels=["stale"])), encoding="utf-8"
    )

    moved = _relocate_root_event_jsons_sync(tmp_storage_root)
    assert moved == 0  # target exists -> skip, no overwrite
    # The canonical date-subfolder copy is preserved untouched.
    kept = json.loads((date_dir / f"{EID}.json").read_text(encoding="utf-8"))
    assert kept["labels"] == ["cat"]
    # The stale root duplicate is left in place (not destroyed).
    assert (cam_dir / f"{EID}.json").exists()

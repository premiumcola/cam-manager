"""Boot-time migration helpers — idempotent, safe to re-run.

Carved out of server.py during R01.6. Each helper spawns its own
daemon thread so server.py's main boot sequence never blocks on
filesystem I/O. Receive their dependencies (storage paths, settings
store, event store, base config) as plain arguments so this module
has zero coupling back to server.py.
"""

from __future__ import annotations

import json as _json
import logging
import shutil as _shutil
import threading
import time as _time
from datetime import datetime
from pathlib import Path

import cv2 as _cv2

log = logging.getLogger(__name__)


def migrate_timelapse_events(*, storage_root: Path, settings) -> None:
    """One-time migration: remove timelapse-type events that were incorrectly stored
    in the EventStore (storage/motion_detection/<cam_id>/) under old code. These are now tracked
    as sidecar JSONs next to the .mp4 files in storage/timelapse/<cam_id>/.
    Covers both date-subdirectory and camera-level tl_*.json placements."""

    def _do_migrate():
        try:
            removed = 0
            events_root = storage_root / "motion_detection"
            if not events_root.exists():
                return
            for cam_dir in events_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                # Remove tl_ files directly in the camera directory (flat placement)
                for jf in list(cam_dir.glob("tl_*.json")):
                    try:
                        jf.unlink()
                        removed += 1
                    except Exception:
                        pass
                # Remove tl_ files inside date subdirectories
                for date_dir in cam_dir.iterdir():
                    if not date_dir.is_dir():
                        continue
                    for jf in list(date_dir.glob("tl_*.json")):
                        try:
                            jf.unlink()
                            removed += 1
                        except Exception:
                            pass
            if removed:
                log.info("[migration] Removed %d stale timelapse events from EventStore", removed)
        except Exception as e:
            log.warning("[migration] Timelapse event migration failed: %s", e)

        # Also clean up stale timelapse_frames dirs for cameras that no longer exist
        try:
            frames_root = storage_root / "timelapse_frames"
            if not frames_root.exists():
                return
            cameras = settings.data.get("cameras") or []
            active_ids = {c["id"] for c in cameras}
            # Build map of which profiles are enabled per camera
            enabled_profiles: dict[str, set] = {}
            for c in cameras:
                tl = c.get("timelapse") or {}
                profs = tl.get("profiles") or {}
                enabled_profiles[c["id"]] = {p for p, cfg in profs.items() if cfg.get("enabled")}

            cleaned = 0
            for cam_dir in frames_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                if cam_dir.name not in active_ids:
                    try:
                        _shutil.rmtree(str(cam_dir))
                        cleaned += 1
                        log.info(
                            "[migration] Removed frame dir for deleted camera: %s", cam_dir.name
                        )
                    except Exception as e:
                        log.warning("[migration] Could not remove %s: %s", cam_dir.name, e)
                    continue
                # For active cameras: remove frame dirs for DISABLED profiles
                active_profs = enabled_profiles.get(cam_dir.name, set())
                for prof_dir in cam_dir.iterdir():
                    if not prof_dir.is_dir():
                        continue
                    if prof_dir.name not in active_profs:
                        try:
                            _shutil.rmtree(str(prof_dir))
                            cleaned += 1
                            log.info(
                                "[migration] Removed frame dir for disabled profile: %s/%s",
                                cam_dir.name,
                                prof_dir.name,
                            )
                        except Exception as e:
                            log.warning("[migration] Could not remove %s: %s", prof_dir, e)
            if cleaned:
                log.info("[migration] Cleaned %d stale frame directories", cleaned)
        except Exception as e:
            log.warning("[migration] Stale frame dir cleanup failed: %s", e)

    threading.Thread(target=_do_migrate, daemon=True).start()


def generate_missing_thumbnails(*, storage_root: Path) -> None:
    """Generate thumbnail .jpg for any timelapse .mp4 that does not have one yet.
    Runs once on startup in background — safe to re-run, skips if thumb exists."""

    def _do():
        tl_base = storage_root / "timelapse"
        if not tl_base.exists():
            return
        count = 0
        for cam_dir in tl_base.iterdir():
            if not cam_dir.is_dir():
                continue
            for mp4 in cam_dir.glob("*.mp4"):
                thumb = mp4.with_suffix(".jpg")
                if thumb.exists():
                    continue
                try:
                    cap = _cv2.VideoCapture(str(mp4))
                    total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                    if total > 0:
                        cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                    ok, frame = cap.read()
                    cap.release()
                    if ok and frame is not None:
                        tw, th = frame.shape[1], frame.shape[0]
                        if tw > 640:
                            scale = 640 / tw
                            frame = _cv2.resize(frame, (640, int(th * scale)))
                        _cv2.imwrite(str(thumb), frame, [int(_cv2.IMWRITE_JPEG_QUALITY), 80])
                        del frame
                        count += 1
                except Exception as e:
                    log.debug("[thumb] failed for %s: %s", mp4.name, e)
                _time.sleep(0.05)  # pace startup
        if count:
            log.info("[boot] Generated %d missing timelapse thumbnails", count)

    threading.Thread(target=_do, daemon=True).start()


def check_tracks_schema_version(*, storage_root: Path) -> None:
    """Boot scan: count existing tracks.json sidecars whose schema
    version is older than the current ``TRACKS_SCHEMA``. The intent is
    purely diagnostic — we log a single line so the operator knows to
    hit ``/api/tracking/reindex-all`` once after a schema bump. We do
    NOT auto-reindex: a large archive could spawn thousands of jobs
    and saturate the worker for an hour.
    """

    def _do():
        try:
            # Local import keeps this helper independent of worker
            # construction order at boot.
            from .tracking_worker import TRACKS_SCHEMA

            events_root = storage_root / "motion_detection"
            if not events_root.exists():
                return
            stale = 0
            current = 0
            # Group stale by the schema we saw so the log line shows
            # the user exactly which migration step the archive is on.
            by_old: dict = {}
            for cam_dir in events_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                for tp in cam_dir.rglob("*.tracks.json"):
                    try:
                        payload = _json.loads(tp.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    schema = payload.get("schema")
                    if schema == TRACKS_SCHEMA:
                        current += 1
                    else:
                        stale += 1
                        by_old[schema] = by_old.get(schema, 0) + 1
            if stale:
                versions = ", ".join(
                    f"v{k}={v}"
                    for k, v in sorted(
                        by_old.items(),
                        key=lambda kv: (kv[0] is None, kv[0]),
                    )
                )
                log.info(
                    "[tracking] schema=%d (was=%d old sidecars detected: %s, "
                    "run /api/tracking/reindex-all to refresh)",
                    TRACKS_SCHEMA,
                    stale,
                    versions,
                )
            elif current:
                log.debug("[tracking] schema=%d (%d sidecars current)", TRACKS_SCHEMA, current)
        except Exception as e:
            log.warning("[tracking] schema scan failed: %s", e)

    threading.Thread(target=_do, daemon=True).start()


def migrate_timelapse_to_eventstore(*, storage_root: Path, settings, store, base_cfg: dict) -> None:
    """Register existing timelapse sidecars as unified EventStore entries.
    Walks storage/timelapse/<cam>/*.json; for each sidecar that has no matching
    motion_detection/<cam>/tl_<stem>.json yet, builds a tl_event dict and calls
    store.add_event(). Safe to re-run; skips entries that already exist."""

    def _do():
        tl_root = storage_root / "timelapse"
        if not tl_root.exists():
            return
        cfg = settings.export_effective_config(base_cfg)
        public_base = (cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
        registered = 0
        for cam_dir in tl_root.iterdir():
            if not cam_dir.is_dir():
                continue
            cam_id = cam_dir.name
            event_cam_dir = store.events_dir / cam_id
            existing_ids: set = set()
            if event_cam_dir.exists():
                for jf in event_cam_dir.rglob("*.json"):
                    existing_ids.add(jf.stem)
            for sc in cam_dir.glob("*.json"):
                try:
                    meta = _json.loads(sc.read_text(encoding="utf-8"))
                except Exception:
                    continue
                stem = sc.stem
                event_id = f"tl_{stem}"
                if event_id in existing_ids:
                    continue
                mp4 = cam_dir / f"{stem}.mp4"
                if not mp4.exists():
                    continue
                thumb = cam_dir / f"{stem}.jpg"
                video_rel = f"timelapse/{cam_id}/{mp4.name}"
                thumb_rel = f"timelapse/{cam_id}/{thumb.name}" if thumb.exists() else None
                tl_event = {
                    "event_id": event_id,
                    "camera_id": cam_id,
                    "camera_name": cam_id,
                    "type": "timelapse",
                    "labels": ["timelapse"],
                    "top_label": "timelapse",
                    "time": meta.get("time") or datetime.now().isoformat(timespec="seconds"),
                    "profile": meta.get("profile"),
                    "window_key": meta.get("window_key"),
                    "period_s": meta.get("period_s", 0),
                    "target_s": meta.get("target_s", 0),
                    "frame_count": meta.get("frame_count", 0),
                    "filename": mp4.name,
                    "video_relpath": video_rel,
                    "video_url": f"{public_base}/media/{video_rel}"
                    if public_base
                    else f"/media/{video_rel}",
                    "snapshot_relpath": thumb_rel,
                    "snapshot_url": (
                        f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}"
                    )
                    if thumb_rel
                    else None,
                    "thumb_url": (
                        f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}"
                    )
                    if thumb_rel
                    else None,
                    "size_mb": meta.get("size_mb", 0),
                    "duration_s": 0.0,
                    "file_size_bytes": mp4.stat().st_size if mp4.exists() else 0,
                }
                try:
                    store.add_event(cam_id, tl_event)
                    registered += 1
                except Exception as e:
                    log.warning("[migration] timelapse register failed for %s: %s", stem, e)
        if registered:
            log.info("[migration] registered %d timelapse events in EventStore", registered)

    threading.Thread(target=_do, daemon=True).start()

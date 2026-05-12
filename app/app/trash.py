"""Soft-delete with grace period — events go into ``storage/.trash/``
on delete and stay there for ``trash.grace_days`` (default 7) before a
daily sweep hard-deletes them. Users can restore individual events or
empty the trash now via the ``/api/trash/*`` endpoints in
``routes/trash.py``.

Mediathek scope only in this iteration — motion-event deletes route
through ``move_to_trash`` instead of ``EventStore.delete_event``. The
weather-sighting / timelapse delete handlers still hard-delete; their
trash routing lands in a follow-up so this commit stays focused on
the dominant deletion path (Mediathek).

Layout::

    storage/.trash/<cam_id>/<event_id>/
        meta.json            (trashed_at + original paths)
        <event_id>.json      (the original event manifest)
        <event_id>.jpg       (snapshot)
        <event_id>.mp4       (video)
        <event_id>.tracks.json   (optional)
        <event_id>.best.jpg      (optional)

``meta.json`` is the source of truth for restore — it carries the
relative path the JSON manifest originally lived at, so a restore
puts the files back under exactly ``storage/motion_detection/<cam>/
<date>/<event_id>.*`` even when the date subdir wouldn't otherwise
be reconstructible from the event_id alone."""
from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timedelta
from pathlib import Path

from . import app_state

log = logging.getLogger("trash")


_DEFAULT_GRACE_DAYS = 7


def _trash_root() -> Path:
    return Path(app_state.store.root) / ".trash"


def _grace_days() -> int:
    settings = getattr(app_state, "settings", None)
    if settings is None:
        return _DEFAULT_GRACE_DAYS
    v = (settings.data.get("trash") or {}).get("grace_days", _DEFAULT_GRACE_DAYS)
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return _DEFAULT_GRACE_DAYS


def move_to_trash(cam_id: str, event_id: str) -> dict:
    """Move every file belonging to ``(cam_id, event_id)`` into the
    trash dir and write a ``meta.json`` carrying the original relative
    paths so restore can put them back. Returns the same flag dict
    shape ``EventStore.delete_event`` does, plus ``trashed:True`` on
    success — callers can substitute one for the other."""
    store = app_state.store
    cam_root = Path(store.root) / "motion_detection" / cam_id
    matches = list(cam_root.rglob(f"{event_id}.json"))
    if not matches:
        return {"json_deleted": False, "snap_deleted": False,
                "vid_deleted": False, "tracks_deleted": False,
                "trashed": False}
    json_path = matches[0]
    try:
        event = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        event = {}
    trash_dir = _trash_root() / cam_id / event_id
    trash_dir.mkdir(parents=True, exist_ok=True)
    store_root = Path(store.root)
    flags = {"json_deleted": False, "snap_deleted": False,
             "vid_deleted": False, "tracks_deleted": False,
             "trashed": True}
    # Manifest first — capture its relative path so restore knows
    # where to put it back.
    json_rel = str(json_path.relative_to(store_root))
    try:
        shutil.move(str(json_path), str(trash_dir / json_path.name))
        flags["json_deleted"] = True
    except Exception as e:
        log.warning("[trash] %s/%s json move failed: %s", cam_id, event_id, e)
    # Snapshot.
    if event.get("snapshot_relpath"):
        src = store_root / event["snapshot_relpath"]
        if src.exists():
            try:
                shutil.move(str(src), str(trash_dir / src.name))
                flags["snap_deleted"] = True
            except Exception as e:
                log.warning("[trash] %s/%s snap move failed: %s", cam_id, event_id, e)
    # Video + tracks sidecar + best.jpg cache.
    if event.get("video_relpath"):
        src = store_root / event["video_relpath"]
        if src.exists():
            try:
                shutil.move(str(src), str(trash_dir / src.name))
                flags["vid_deleted"] = True
            except Exception as e:
                log.warning("[trash] %s/%s vid move failed: %s", cam_id, event_id, e)
        for tp in list(cam_root.rglob(f"{event_id}.tracks.json")):
            try:
                shutil.move(str(tp), str(trash_dir / tp.name))
                flags["tracks_deleted"] = True
            except Exception:
                log.debug("[trash] %s tracks move failed", tp, exc_info=True)
        for bp in list(cam_root.rglob(f"{event_id}.best.jpg")):
            try:
                shutil.move(str(bp), str(trash_dir / bp.name))
            except Exception:
                log.debug("[trash] %s best move failed", bp, exc_info=True)
    meta = {
        "cam_id":       cam_id,
        "event_id":     event_id,
        "trashed_at":   datetime.now().isoformat(timespec="seconds"),
        "json_rel":     json_rel,
        "event":        event,
    }
    (trash_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return flags


def list_trashed() -> list[dict]:
    """All trashed events with metadata + days-until-expiry. Sorted
    newest-first so the UI shows the most-recently-deleted on top."""
    root = _trash_root()
    if not root.exists():
        return []
    grace = _grace_days()
    now = datetime.now()
    out: list[dict] = []
    for cam_dir in sorted(d for d in root.iterdir() if d.is_dir()):
        for ev_dir in sorted(d for d in cam_dir.iterdir() if d.is_dir()):
            meta_path = ev_dir / "meta.json"
            if not meta_path.exists():
                continue
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            trashed_at = meta.get("trashed_at") or ""
            try:
                t_dt = datetime.fromisoformat(trashed_at)
                expires_at = t_dt + timedelta(days=grace)
                days_left = max(0, int((expires_at - now).total_seconds() // 86400))
            except Exception:
                expires_at = None
                days_left = None
            out.append({
                "cam_id":     meta.get("cam_id"),
                "event_id":   meta.get("event_id"),
                "trashed_at": trashed_at,
                "expires_at": expires_at.isoformat(timespec="seconds") if expires_at else None,
                "days_left":  days_left,
            })
    out.sort(key=lambda e: e.get("trashed_at") or "", reverse=True)
    return out


def restore(cam_id: str, event_id: str) -> bool:
    """Move every file in the trash entry back under its original
    motion_detection path. The original date subdir is reconstructed
    from ``meta.json``'s ``json_rel`` so the restored event slots
    back into its original date partition rather than today's."""
    ev_dir = _trash_root() / cam_id / event_id
    meta_path = ev_dir / "meta.json"
    if not meta_path.exists():
        return False
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return False
    store_root = Path(app_state.store.root)
    event = meta.get("event") or {}
    moved_back = 0
    # Snapshot + video go back to their canonical relpaths.
    for relkey in ("snapshot_relpath", "video_relpath"):
        relpath = event.get(relkey)
        if not relpath:
            continue
        src = ev_dir / Path(relpath).name
        if not src.exists():
            continue
        target = store_root / relpath
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(src), str(target))
            moved_back += 1
        except Exception as e:
            log.warning("[trash] %s restore %s failed: %s",
                        event_id, src, e)
    # JSON manifest goes back to its captured json_rel.
    json_rel = meta.get("json_rel")
    if json_rel:
        target = store_root / json_rel
        src = ev_dir / Path(json_rel).name
        if src.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.move(str(src), str(target))
                moved_back += 1
            except Exception as e:
                log.warning("[trash] %s restore json failed: %s",
                            event_id, e)
        # Sidecars (tracks.json, best.jpg) live in the manifest's
        # parent dir — move whatever else is left next to it.
        target_dir = (store_root / json_rel).parent
        target_dir.mkdir(parents=True, exist_ok=True)
        for src in list(ev_dir.iterdir()):
            if src.name == "meta.json":
                continue
            try:
                shutil.move(str(src), str(target_dir / src.name))
            except Exception:
                log.debug("[trash] sidecar move %s failed",
                          src, exc_info=True)
    # Drop the now-empty trash entry.
    try:
        meta_path.unlink(missing_ok=True)
        if not any(ev_dir.iterdir()):
            ev_dir.rmdir()
    except Exception:
        pass
    return moved_back > 0


def empty() -> int:
    """Hard-delete every entry currently in the trash. Returns the
    number of event dirs removed."""
    root = _trash_root()
    if not root.exists():
        return 0
    removed = 0
    for cam_dir in list(d for d in root.iterdir() if d.is_dir()):
        for ev_dir in list(d for d in cam_dir.iterdir() if d.is_dir()):
            try:
                shutil.rmtree(ev_dir)
                removed += 1
            except Exception as e:
                log.warning("[trash] empty %s failed: %s", ev_dir, e)
        try:
            cam_dir.rmdir()
        except OSError:
            pass  # not empty, leave it
    if root.exists():
        try:
            if not any(root.iterdir()):
                root.rmdir()
        except OSError:
            pass
    return removed


def cleanup_expired() -> int:
    """Daily sweep: hard-delete trash entries past the grace period.
    Wire into the existing daily maintenance cron in a follow-up
    commit; for now the function is exposed so a manual cron / test
    can run it."""
    root = _trash_root()
    if not root.exists():
        return 0
    grace = _grace_days()
    cutoff = datetime.now() - timedelta(days=grace)
    removed = 0
    for cam_dir in list(d for d in root.iterdir() if d.is_dir()):
        for ev_dir in list(d for d in cam_dir.iterdir() if d.is_dir()):
            meta_path = ev_dir / "meta.json"
            expired = False
            if not meta_path.exists():
                # No meta — stale dir from an interrupted move. Sweep.
                expired = True
            else:
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                    t_dt = datetime.fromisoformat(meta.get("trashed_at") or "")
                except Exception:
                    expired = True
                else:
                    expired = t_dt < cutoff
            if expired:
                try:
                    shutil.rmtree(ev_dir)
                    removed += 1
                except Exception as e:
                    log.warning("[trash] expired sweep %s failed: %s",
                                ev_dir, e)
        try:
            cam_dir.rmdir()
        except OSError:
            pass
    return removed

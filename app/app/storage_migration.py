"""One-shot storage migration to the semantic camera-id scheme.

Idempotent: safe to call on every boot. Walks every camera in
``settings.json``, computes the new canonical id via
``camera_id.build_camera_id``, and consolidates legacy storage folders
under each of the four per-camera storage areas:

    motion_detection/  timelapse_frames/  timelapse/  weather/

Candidate-folder match rules (any one is enough):

    1. folder name == camera's current id
    2. folder name == "cam-" + IP-with-dashes  (e.g. "cam-192-168-178-172")
    3. folder name's slug contains both the IP last-octet AND the camera
       name slug — handles the "cam-Werkstatt.rechts.oben" alongside
       "cam-192-168-178-172" dual-folder case
    4. folder name's slug matches the camera name slug exactly

After the per-camera loop:

    - event JSONs in motion_detection/<new_id>/ have their
      ``video_relpath`` / ``snapshot_relpath`` rewritten to the new id
    - settings.json's ``id`` field is updated for every renamed camera
    - settings.json is backed up to ``settings.json.bak.<timestamp>``
      before any change is persisted (extra safety net beyond the
      existing 2-deep rotation)
    - the empty ``storage/object_detection/`` placeholder is rmdir'd

Failure handling: a single failed move is logged at ERROR but never
aborts the whole run — partial progress is fine because the next boot
picks up where we stopped. A failed ``settings.save()`` triggers a
restore from the timestamped backup.
"""
from __future__ import annotations
from datetime import datetime
from pathlib import Path
import json
import logging
import re
import shutil

from .camera_id import build_camera_id, _sanitise

log = logging.getLogger(__name__)


_AREAS = ("motion_detection", "timelapse_frames", "timelapse", "weather")


def _extract_host(rtsp_url: str) -> str:
    """Pull the host portion out of an rtsp_url, ignoring optional creds and
    the port. Returns "" when the URL is empty/malformed."""
    if not rtsp_url or "://" not in rtsp_url:
        return ""
    rest = rtsp_url.split("://", 1)[1]
    if "@" in rest:
        rest = rest.rsplit("@", 1)[1]
    host = rest.split("/", 1)[0]
    if ":" in host and not host.count(":") > 1:  # ipv4:port — strip port
        host = host.split(":", 1)[0]
    return host


def _ip_last_octet(host: str) -> str:
    """IPv4 a.b.c.d → 'd'. Empty string for non-IPv4."""
    if not host or "." not in host:
        return ""
    parts = host.split(".")
    if len(parts) != 4:
        return ""
    last = parts[-1]
    return last if last.isdigit() else ""


def _ip_dashes(host: str) -> str:
    """IPv4 a.b.c.d → 'a-b-c-d'. Empty for non-IPv4."""
    if not host or "." not in host:
        return ""
    parts = host.split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts):
        return ""
    return "-".join(parts)


def _folder_matches(folder_name: str, *, current_id: str, ip_dashes: str,
                    ip_octet: str, name_slug: str) -> bool:
    """Decide whether a sub-folder under one of the storage areas belongs
    to the camera identified by these markers. Conservative — must match
    one of the four rules described in the module docstring."""
    if not folder_name:
        return False
    if current_id and folder_name == current_id:
        return True
    if ip_dashes and folder_name == f"cam-{ip_dashes}":
        return True
    folder_slug = _sanitise(folder_name)
    if not folder_slug:
        return False
    if ip_octet and name_slug and ip_octet in folder_slug and name_slug in folder_slug:
        return True
    if name_slug and (folder_slug == name_slug or folder_slug == f"cam{name_slug}"):
        return True
    return False


def _move_file(src: Path, dst: Path):
    """Move a single file from src to dst with collision handling.
    On collision keep the newer mtime, drop the older. Logs an ERROR on
    failure but does not raise — caller continues to the next file."""
    try:
        if dst.exists():
            try:
                src_mtime = src.stat().st_mtime
                dst_mtime = dst.stat().st_mtime
            except OSError:
                src_mtime = dst_mtime = 0.0
            if src_mtime > dst_mtime:
                src.replace(dst)
                log.debug("[Migration] overwrite %s (newer)", dst)
            else:
                log.debug("[Migration] drop older %s (kept %s)", src, dst)
                src.unlink()
            return
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.replace(dst)
    except Exception as e:
        log.error("[Migration] move failed: %s → %s: %s", src, dst, e)


def _merge_folder(src: Path, target: Path) -> int:
    """Move every file in src (recursively) into target, preserving
    subpaths. Returns the number of files moved. Removes src when empty."""
    if src == target:
        return 0
    target.mkdir(parents=True, exist_ok=True)
    moved = 0
    for path in list(src.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(src)
        _move_file(path, target / rel)
        moved += 1
    # rmdir empty subdirs deepest-first, then the source itself.
    for d in sorted((p for p in src.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass
    try:
        src.rmdir()
    except OSError as e:
        log.warning("[Migration] source not empty after merge: %s (%s)", src, e)
    return moved


def _rewrite_event_jsons(events_dir: Path, old_ids: list[str], new_id: str) -> int:
    """Atomic-write rewrite of every .json under events_dir whose
    video_relpath / snapshot_relpath still contains an old id string.
    Returns the count of files actually rewritten."""
    if not events_dir.exists():
        return 0
    olds = [o for o in old_ids if o and o != new_id]
    if not olds:
        return 0
    rewritten = 0
    for jf in events_dir.rglob("*.json"):
        try:
            text = jf.read_text(encoding="utf-8")
        except Exception:
            continue
        new_text = text
        for old in olds:
            if old in new_text:
                new_text = new_text.replace(old, new_id)
        if new_text == text:
            continue
        tmp = jf.with_suffix(".json.tmp")
        try:
            tmp.write_text(new_text, encoding="utf-8")
            tmp.replace(jf)
            rewritten += 1
        except Exception as e:
            log.error("[Migration] event JSON rewrite failed for %s: %s", jf, e)
    return rewritten


def _plan_camera(cam: dict, storage_root: Path) -> dict:
    """Pure analysis pass — returns the planned actions for one camera
    without touching disk. The caller decides whether to execute.

    Returned dict::

        {
          "old_id":    str,
          "new_id":    str,
          "id_changed": bool,
          "areas": {
            "motion_detection": [Path, ...],
            "timelapse_frames": [...], ...
          }
        }

    A camera is "in canonical form" when ``id_changed=False`` AND every
    ``areas[*]`` list either is empty or only contains the target dir."""
    old_id = cam.get("id", "")
    name = cam.get("name", old_id)
    host = _extract_host(cam.get("rtsp_url", ""))
    ip_octet = _ip_last_octet(host)
    ip_dashes = _ip_dashes(host)
    name_slug = _sanitise(name)
    new_id = build_camera_id(
        cam.get("manufacturer", ""),
        cam.get("model", ""),
        name,
        host,
    )
    out = {
        "old_id":     old_id,
        "new_id":     new_id,
        "id_changed": new_id != old_id,
        "ip_dashes":  ip_dashes,
        "areas":      {a: [] for a in _AREAS},
    }
    for area in _AREAS:
        area_root = storage_root / area
        if not area_root.exists():
            continue
        for child in area_root.iterdir():
            if not child.is_dir():
                continue
            if child.name == new_id:
                continue  # already at the canonical target
            if _folder_matches(child.name, current_id=old_id,
                               ip_dashes=ip_dashes, ip_octet=ip_octet,
                               name_slug=name_slug):
                out["areas"][area].append(child)
    return out


def _backup_settings(settings_store) -> Path | None:
    """Drop a timestamped backup next to settings.json before any change."""
    src = settings_store.path
    if not src.exists():
        return None
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = src.with_suffix(src.suffix + f".bak.{ts}")
    try:
        shutil.copy2(str(src), str(dst))
        return dst
    except Exception as e:
        log.warning("[Migration] settings backup failed: %s", e)
        return None


def migrate(settings_store, storage_root) -> dict:
    """Run the migration once. Always safe to call — the analysis pass
    short-circuits to a single INFO line when nothing's stale.

    Returns a summary dict for the caller's log line."""
    storage_root = Path(storage_root)
    cams = list(settings_store.data.get("cameras", []) or [])
    if not cams:
        log.info("[Migration] no cameras configured — nothing to migrate.")
        return {"cameras": 0, "merges": 0, "rewrites": 0, "noop": True}

    # Pass 1: analysis only, no disk writes.
    plans: list[dict] = []
    needs_work = False
    for cam in cams:
        plan = _plan_camera(cam, storage_root)
        plans.append(plan)
        if plan["id_changed"] or any(plan["areas"][a] for a in _AREAS):
            needs_work = True

    # Empty object_detection cleanup is part of "needs_work" too — the
    # whole boot-time pass should be a single observable unit.
    obj_det = storage_root / "object_detection"
    obj_det_empty_dir = (obj_det.exists() and obj_det.is_dir()
                         and not any(obj_det.iterdir()))

    if not needs_work and not obj_det_empty_dir:
        log.info("[Migration] all storage paths already in canonical form — no migration needed.")
        return {"cameras": len(cams), "merges": 0, "rewrites": 0, "noop": True}

    # Pass 2: take a tagged settings backup, then execute.
    backup_path = _backup_settings(settings_store)

    total_merges = 0
    total_rewrites = 0
    id_changes = 0
    for cam, plan in zip(cams, plans):
        new_id = plan["new_id"]
        old_id = plan["old_id"]
        for area in _AREAS:
            sources: list[Path] = plan["areas"][area]
            if not sources:
                continue
            target = storage_root / area / new_id
            for src in sources:
                moved = _merge_folder(src, target)
                if moved > 0 or not src.exists():
                    log.info("[Migration] %s: merged %s → %s (%d files)",
                             area, src.name, new_id, moved)
                    total_merges += 1
        # Rewrite event JSONs in the target motion_detection folder so any
        # stored video_relpath / snapshot_relpath that still says "<old_id>"
        # points at the new path.
        ev_dir = storage_root / "motion_detection" / new_id
        old_candidates = [old_id]
        if plan["ip_dashes"]:
            old_candidates.append(f"cam-{plan['ip_dashes']}")
        n = _rewrite_event_jsons(ev_dir, old_candidates, new_id)
        total_rewrites += n
        if plan["id_changed"]:
            cam["id"] = new_id
            id_changes += 1

    # Persist settings.json. On failure, restore from the .bak.<ts> we
    # took at the start so we never leave the JSON in a half-updated state.
    settings_save_ok = True
    if id_changes > 0:
        try:
            settings_store.save()
        except Exception as e:
            settings_save_ok = False
            log.error("[Migration] settings.json save failed (%s) — restoring from %s",
                      e, backup_path.name if backup_path else "?")
            if backup_path and backup_path.exists():
                try:
                    shutil.copy2(str(backup_path), str(settings_store.path))
                except Exception as e2:
                    log.error("[Migration] settings restore also failed: %s", e2)

    # Cleanup the orphaned object_detection placeholder.
    if obj_det.exists() and obj_det.is_dir():
        try:
            obj_det.rmdir()  # only succeeds when empty
            log.info("[Migration] removed empty placeholder dir storage/object_detection/")
        except OSError:
            pass  # not empty — leave it

    summary = {
        "cameras":  len(cams),
        "merges":   total_merges,
        "rewrites": total_rewrites,
        "id_changes": id_changes,
        "backup":   str(backup_path) if backup_path else None,
        "save_ok":  settings_save_ok,
        "noop":     False,
    }
    log.info(
        "[Migration] processed %d cameras, %d folder merges, %d event JSONs rewritten, "
        "settings backed up to %s",
        summary["cameras"], summary["merges"], summary["rewrites"],
        backup_path.name if backup_path else "(no backup)",
    )
    return summary

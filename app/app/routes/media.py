"""Media library, storage stats, thumbnail backfill, orphan purge.

Migrated from server.py during R01.4. The fix-thumbnails background
task keeps its module-level state (`_thumb_task`, `_fix_thumbs_lock`)
inside this blueprint — it's bp-private and replacing the singleton
during a config reload would lose progress on an in-flight job.
"""
from __future__ import annotations

import json as _json
import logging
import threading as _threading_fix

import cv2
from flask import Blueprint, jsonify, request

from .. import app_state

bp = Blueprint("media", __name__)


_thumb_task = {"running": False, "done": 0, "total": 0, "errors": 0, "recent": []}
_fix_thumbs_lock = _threading_fix.Lock()


@bp.get('/api/media/storage-stats')
def api_media_storage_stats():
    storage_root = app_state.storage_root
    events_dir = storage_root / "motion_detection"
    tl_root = storage_root / "timelapse"
    active_cams = app_state.get_effective_config().get("cameras", [])
    active_ids = {c["id"] for c in active_cams}

    TRACKED_LABELS = {'person', 'cat', 'bird', 'car', 'dog', 'squirrel', 'motion'}
    OBJECT_LABELS = {'person', 'cat', 'bird', 'car', 'dog', 'squirrel'}

    def _cam_stats_dict(cam_id: str, name_hint: str = "") -> dict:
        size_bytes = 0
        jpg_count = 0
        json_count = 0
        latest_snap_url = None
        latest_object_snap_url = None
        resolved_name = name_hint or cam_id
        label_counts: dict = {}
        cam_dir = events_dir / cam_id
        if cam_dir.exists():
            # Count all event media: photos (.jpg/.jpeg) AND video clips (.mp4).
            # Timelapse .mp4s live under storage/timelapse/ (scanned below) — not here.
            for pattern in ("*.jpg", "*.jpeg", "*.mp4"):
                for p in cam_dir.rglob(pattern):
                    try:
                        size_bytes += p.stat().st_size
                        jpg_count += 1
                    except Exception:
                        pass
            json_files = list(cam_dir.rglob("*.json"))
            json_count = len(json_files)
            # Sorted reverse → newest first; break out of the snap searches once both are populated.
            for jf in sorted(json_files, reverse=True):
                try:
                    ev = _json.loads(jf.read_text(encoding="utf-8"))
                    if resolved_name == cam_id:
                        resolved_name = ev.get("camera_name", cam_id)
                    rel = ev.get("snapshot_relpath")
                    vid_rel = ev.get("video_relpath")
                    labels = ev.get("labels") or []
                    snap_exists = bool(rel and (storage_root / rel).exists())
                    media_exists = snap_exists or bool(vid_rel and (storage_root / vid_rel).exists())
                    if snap_exists:
                        if not latest_snap_url:
                            latest_snap_url = f"/media/{rel}"
                        if not latest_object_snap_url and any(l in OBJECT_LABELS for l in labels):
                            latest_object_snap_url = f"/media/{rel}"
                    # Count each event ONCE under its most-specific label so the
                    # filter pills sum to the actual archive size (not the inflated
                    # multi-label total). Object labels win over motion; if no
                    # object label is present, motion catches the rest.
                    if media_exists:
                        primary = next((l for l in labels if l in OBJECT_LABELS), None)
                        if primary is None and 'motion' in labels:
                            primary = 'motion'
                        if primary is None and not labels:
                            primary = 'motion'
                        if primary in TRACKED_LABELS:
                            label_counts[primary] = label_counts.get(primary, 0) + 1
                except Exception:
                    continue
        tl_dir = tl_root / cam_id
        tl_count = 0
        if tl_dir.exists():
            tl_count = len(list(tl_dir.glob("*.mp4")))
            for p in tl_dir.rglob("*"):
                try:
                    if p.is_file():
                        size_bytes += p.stat().st_size
                except Exception:
                    pass
        return {
            "id": cam_id,
            "name": resolved_name,
            "size_mb": round(size_bytes / 1024 / 1024, 1),
            "jpg_count": jpg_count,
            "event_count": json_count,
            "timelapse_count": tl_count,
            "latest_snap_url": latest_snap_url,
            "latest_object_snap_url": latest_object_snap_url,
            "label_counts": label_counts,
        }

    result = [_cam_stats_dict(c["id"], name_hint=c.get("name", c["id"])) for c in active_cams]

    # Archived: media folders for cameras no longer in active config
    archived = []
    seen = set()
    if events_dir.exists():
        for d in sorted(events_dir.iterdir()):
            if not d.is_dir() or d.name in active_ids:
                continue
            s = _cam_stats_dict(d.name)
            if s["jpg_count"] or s["event_count"] or s["timelapse_count"]:
                archived.append(s)
                seen.add(d.name)
    if tl_root.exists():
        for d in sorted(tl_root.iterdir()):
            if not d.is_dir() or d.name in active_ids or d.name in seen:
                continue
            if any(d.glob("*.mp4")):
                archived.append(_cam_stats_dict(d.name))

    return jsonify({"cameras": result, "archived": archived})


@bp.post('/api/media/rescan')
def api_media_rescan():
    store = app_state.store
    effective = app_state.get_effective_config()
    cam_ids = [c["id"] for c in effective.get("cameras", [])]
    logging.getLogger(__name__).info("[MediaRescan] scanning cam_ids: %s", cam_ids)
    public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
    try:
        count = store.scan_media_files(cam_ids, public_base_url=public_base)
        return jsonify({"ok": True, "registered": count})
    except Exception:
        import traceback
        return jsonify({"ok": False, "error": traceback.format_exc()}), 500


@bp.post('/api/media/fix-thumbnails')
def api_media_fix_thumbnails():
    """Scan all motion_detection event JSONs; for each event with video_relpath
    but no (valid) snapshot file on disk, extract the middle frame of the mp4
    and save it next to the video. Runs in a background thread; progress via
    GET /api/media/fix-thumbnails/status."""
    storage_root = app_state.storage_root
    log_t = logging.getLogger(__name__)
    events_root = storage_root / "motion_detection"
    todo: list = []
    if events_root.exists():
        for jf in events_root.rglob("*.json"):
            try:
                ev = _json.loads(jf.read_text(encoding="utf-8"))
                vid_rel = ev.get("video_relpath")
                if not vid_rel:
                    continue
                snap_rel = ev.get("snapshot_relpath")
                snap_ok = bool(snap_rel) and (storage_root / snap_rel).exists()
                if not snap_ok:
                    todo.append((jf, ev))
            except Exception:
                continue

    with _fix_thumbs_lock:
        if _thumb_task["running"]:
            return jsonify({"ok": True, "already_running": True, **_thumb_task})
        _thumb_task["total"] = len(todo)
        _thumb_task["done"] = 0
        _thumb_task["errors"] = 0
        _thumb_task["recent"] = []
        _thumb_task["running"] = True

    public_base = (app_state.get_effective_config().get("server", {}).get("public_base_url") or "").rstrip("/")

    def _worker():
        for jf, ev in todo:
            err = False
            try:
                vid_rel = ev.get("video_relpath") or ""
                vid_path = storage_root / vid_rel
                if not vid_path.exists():
                    err = True
                    continue
                cap = cv2.VideoCapture(str(vid_path))
                total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                # Seek to ~1/3 of the clip — the first frame of motion clips is
                # often a dark/gray warm-up frame.
                if total_frames > 3:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, total_frames // 3)
                ok, frame = cap.read()
                cap.release()
                if not ok or frame is None:
                    log_t.warning("[fix-thumbs] no readable frame in %s", vid_path.name)
                    err = True
                    continue
                # Downscale to max 640px wide so thumbs stay small on disk
                tw = frame.shape[1]
                if tw > 640:
                    scale = 640 / tw
                    frame = cv2.resize(frame, (640, int(frame.shape[0] * scale)))
                snap_path = vid_path.with_suffix(".jpg")
                if not cv2.imwrite(str(snap_path), frame,
                                   [int(cv2.IMWRITE_JPEG_QUALITY), 82]):
                    log_t.warning("[fix-thumbs] imwrite failed for %s", snap_path.name)
                    err = True
                    continue
                snap_rel = snap_path.relative_to(storage_root).as_posix()
                snap_url = f"{public_base}/media/{snap_rel}" if public_base else f"/media/{snap_rel}"
                ev["snapshot_relpath"] = snap_rel
                ev["snapshot_url"] = snap_url
                ev["thumb_url"] = snap_url
                jf.write_text(_json.dumps(ev, ensure_ascii=False, indent=2),
                              encoding="utf-8")
                log_t.info("[fix-thumbs] %s -> %s", vid_path.name, snap_path.name)
                with _fix_thumbs_lock:
                    _thumb_task["recent"].append(vid_path.name)
                    if len(_thumb_task["recent"]) > 50:
                        _thumb_task["recent"].pop(0)
            except Exception as e:
                log_t.warning("[fix-thumbs] error on %s: %s", jf.name, e)
                err = True
            finally:
                with _fix_thumbs_lock:
                    _thumb_task["done"] += 1
                    if err:
                        _thumb_task["errors"] += 1
        with _fix_thumbs_lock:
            _thumb_task["running"] = False

    _threading_fix.Thread(target=_worker, daemon=True).start()
    return jsonify({"ok": True, "total": len(todo), "already_running": False})


@bp.get('/api/media/fix-thumbnails/status')
def api_media_fix_thumbnails_status():
    with _fix_thumbs_lock:
        return jsonify(dict(_thumb_task))


@bp.post('/api/media/purge-orphans')
def api_media_purge_orphans():
    try:
        removed = app_state.store.purge_orphans()
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.post('/api/media/cleanup')
def api_media_cleanup():
    settings = app_state.settings
    base_cfg = app_state.base_cfg
    payload = request.get_json(force=True) or {}
    storage_sec = settings.data.get("storage", {})
    retention = int(payload.get("retention_days") or storage_sec.get("retention_days") or base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = app_state.store.cleanup_old(retention)
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.get('/api/camera/<cam_id>/media')
def api_camera_media(cam_id):
    settings = app_state.settings
    store = app_state.store
    label = request.args.get('label')
    labels_raw = request.args.get('labels')
    labels = [l.strip() for l in labels_raw.split(',') if l.strip()] if labels_raw else None
    start = request.args.get('start')
    end = request.args.get('end')
    # type=int returns None on parse failure so a bogus ?limit=foo no
    # longer 500s — falls back to the configured media_limit_default.
    cfg_default = app_state.get_effective_config().get("storage", {}).get("media_limit_default", 24)
    limit = request.args.get('limit', type=int) or cfg_default
    offset = request.args.get('offset', type=int) or 0
    items = store.list_events(cam_id, label=label, labels=labels, start=start, end=end, limit=limit, offset=offset, media_only=True)
    total_count = store.count_events(cam_id, label=label, labels=labels, start=start, end=end, media_only=True)
    for item in items:
        review = settings.get_review(f"{cam_id}:{item['event_id']}")
        if review:
            item["review"] = review
    return jsonify({"items": items, "total_count": total_count})


@bp.get('/api/event/<event_id>')
def api_event_get(event_id: str):
    """Cross-camera event lookup for Telegram deep-links. Returns enough
    metadata for the frontend hash router to switch to the right cam +
    open the lightbox. 404 when nothing matches."""
    store = app_state.store
    payload = store.find_event_anywhere(event_id) if store else None
    if not payload:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "event_id":         payload.get("event_id"),
        "camera_id":        payload.get("camera_id"),
        "top_label":        payload.get("top_label") or payload.get("primary_label"),
        "time":             payload.get("time"),
        "video_relpath":    payload.get("video_relpath"),
        "snapshot_relpath": payload.get("snapshot_relpath"),
    })

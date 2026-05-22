"""Object-tracking sidecar management endpoints.

Phase 1: every motion clip the camera_runtime finalises gets a
`tracks.json` sidecar enqueued automatically. The endpoints in this
module are management-only — re-index a single event, sweep the whole
archive for missing/stale sidecars, delete a sidecar, or read worker
stats.

Migrated from server.py during R01.2; the route bodies are byte-for-
byte the originals, with state references rewritten to go through
`app_state` instead of server-local globals.
"""

from __future__ import annotations

import json
import logging

from flask import Blueprint, jsonify, request

from .. import app_state
from ..tracking_worker import TRACKS_SCHEMA, TrackingJob, singleton, tracks_path_for

bp = Blueprint("tracking", __name__)


def _resolve_event_video(event_id: str, cam_id_hint: str | None = None):
    """Return (camera_id, video_path) for an event_id, or (None, None) if
    the event has no usable video. cam_id_hint short-circuits the cross-
    camera scan when the caller already knows the camera."""
    store = app_state.store
    storage_root = app_state.storage_root
    if cam_id_hint:
        ev = store.get_event(cam_id_hint, event_id)
        if ev and ev.get("video_relpath"):
            return cam_id_hint, storage_root / ev["video_relpath"]
        return None, None
    ev = store.find_event_anywhere(event_id)
    if not ev:
        return None, None
    if not ev.get("video_relpath"):
        return ev.get("camera_id"), None
    return ev.get("camera_id"), storage_root / ev["video_relpath"]


@bp.post('/api/tracking/reindex/<event_id>')
@bp.post('/api/events/<event_id>/rescan')
def api_tracking_reindex(event_id):
    cam_id_hint = request.args.get("camera_id")
    cam_id, vid = _resolve_event_video(event_id, cam_id_hint)
    if cam_id is None or vid is None:
        return jsonify({"ok": False, "error": "Event nicht gefunden oder ohne Video"}), 404
    if not vid.exists():
        return jsonify({"ok": False, "error": "Video-Datei fehlt"}), 404
    worker = singleton()
    if worker is None:
        return jsonify({"ok": False, "error": "Tracking-Worker nicht aktiv"}), 503
    worker.enqueue(
        TrackingJob(event_id=event_id, video_path=vid, snapshot_path=None, camera_id=cam_id)
    )
    return jsonify({"ok": True, "queued": 1, "camera_id": cam_id})


@bp.post('/api/tracking/reindex-all')
def api_tracking_reindex_all():
    """Enqueue every event in scope that has a video_relpath but no
    tracks.json — or whose tracks.json predates the current schema.
    Optional ?camera_id=… narrows the scan to a single camera."""
    cam_filter = request.args.get("camera_id")
    worker = singleton()
    if worker is None:
        return jsonify({"ok": False, "error": "Tracking-Worker nicht aktiv"}), 503
    store = app_state.store
    storage_root = app_state.storage_root
    queued = 0
    skipped_uptodate = 0
    skipped_missing = 0
    cam_dirs = []
    if cam_filter:
        d = store.events_dir / cam_filter
        if d.exists():
            cam_dirs.append(d)
    else:
        if store.events_dir.exists():
            cam_dirs = [d for d in store.events_dir.iterdir() if d.is_dir()]
    for cam_dir in cam_dirs:
        cam_id = cam_dir.name
        for jf in cam_dir.rglob("*.json"):
            # Skip our own sidecars.
            if jf.name.endswith(".tracks.json"):
                continue
            try:
                ev = json.loads(jf.read_text(encoding="utf-8"))
            except Exception:
                continue
            video_rel = ev.get("video_relpath")
            if not video_rel:
                continue
            vid = storage_root / video_rel
            if not vid.exists():
                skipped_missing += 1
                continue
            tp = tracks_path_for(vid)
            if tp.exists():
                # Already indexed — only re-queue when schema is older.
                try:
                    existing = json.loads(tp.read_text(encoding="utf-8"))
                    if existing.get("schema") == TRACKS_SCHEMA:
                        skipped_uptodate += 1
                        continue
                except Exception:
                    pass  # corrupt sidecar → re-queue below
            worker.enqueue(
                TrackingJob(
                    event_id=ev.get("event_id", jf.stem),
                    video_path=vid,
                    snapshot_path=None,
                    camera_id=cam_id,
                )
            )
            queued += 1
    logging.getLogger(__name__).info(
        "[tracking] reindex-all cam=%s queued=%d up_to_date=%d missing=%d",
        cam_filter or "*",
        queued,
        skipped_uptodate,
        skipped_missing,
    )
    return jsonify(
        {
            "ok": True,
            "queued": queued,
            "skipped_up_to_date": skipped_uptodate,
            "skipped_missing_video": skipped_missing,
        }
    )


@bp.delete('/api/tracking/<event_id>')
def api_tracking_delete(event_id):
    """Remove the tracks.json sidecar for an event so the lightbox
    falls back to the no-overlay view. Idempotent — 404 only when the
    event itself doesn't exist."""
    cam_id_hint = request.args.get("camera_id")
    cam_id, vid = _resolve_event_video(event_id, cam_id_hint)
    if cam_id is None or vid is None:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    tp = tracks_path_for(vid)
    if tp.exists():
        try:
            tp.unlink()
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
        return jsonify({"ok": True, "deleted": True})
    return jsonify({"ok": True, "deleted": False})


@bp.get('/api/tracking/status')
def api_tracking_status():
    """Worker-stats endpoint — useful for the operator and for the
    re-indexing UI (Phase 2) to show queue depth."""
    worker = singleton()
    if worker is None:
        return jsonify({"ok": False, "alive": False, "schema": TRACKS_SCHEMA})
    return jsonify({"ok": True, "schema": TRACKS_SCHEMA, **worker.stats()})

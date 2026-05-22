"""Event CRUD — single-event delete, bulk delete, confirm, label edit, review.

Migrated from server.py during R01.4. Every write goes through the
`store.update_event` / `store.delete_event` API; the storage layer
handles atomic writes since B08.
"""

from __future__ import annotations

import logging
from datetime import datetime

from flask import Blueprint, jsonify, request

from .. import app_state, trash as _trash

bp = Blueprint("events", __name__)


@bp.delete('/api/camera/<cam_id>/events/<event_id>')
def api_event_delete(cam_id, event_id):
    """Soft-delete: move the event into ``storage/.trash/`` instead
    of hard-deleting. The trash entry sits for ``trash.grace_days``
    days before the daily sweep removes it. /api/trash/<id>/restore
    moves it back; /api/trash/empty hard-deletes everything now."""
    storage_root = app_state.storage_root
    result = _trash.move_to_trash(cam_id, event_id)
    # Timelapse fallback: tl_<stem> events live in storage/timelapse/<cam>/
    # and may not have an EventStore JSON yet (the migration that
    # registers them on boot can race against the user clicking delete
    # before it finishes, and old installs predate the unified
    # registration entirely). Also clean up the on-disk mp4 + sidecar +
    # thumb so the file disappears from the gallery either way.
    tl_cleaned = False
    if event_id.startswith("tl_"):
        stem = event_id[3:]
        if "/" not in stem and "\\" not in stem and ".." not in stem:
            tl_dir = storage_root / "timelapse" / cam_id
            mp4 = tl_dir / f"{stem}.mp4"
            if mp4.exists():
                mp4.unlink(missing_ok=True)
                tl_cleaned = True
                for suffix in (".json", ".jpg"):
                    companion = tl_dir / f"{stem}{suffix}"
                    if companion.exists():
                        try:
                            companion.unlink()
                        except Exception:
                            pass
    if not result["json_deleted"] and not tl_cleaned:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    return jsonify({"ok": True, "tl_cleaned": tl_cleaned, **result})


@bp.post('/api/camera/<cam_id>/events/delete-bulk')
def api_event_delete_bulk(cam_id):
    """Bulk soft-delete — every successfully-moved event lands in
    the trash. Frontend URL stays the same so no client change is
    needed; the only behavioural difference is restorability."""
    payload = request.get_json(force=True, silent=True) or {}
    raw_ids = payload.get("event_ids")
    if not isinstance(raw_ids, list):
        return jsonify({"ok": False, "error": "event_ids muss eine Liste sein"}), 400
    event_ids = [eid for eid in raw_ids if isinstance(eid, str) and eid]
    if not event_ids:
        return jsonify({"ok": False, "error": "Keine event_ids angegeben"}), 400
    if len(event_ids) > 500:
        return jsonify({"ok": False, "error": "Maximal 500 Events pro Aufruf"}), 400
    deleted = 0
    failed = []
    for eid in event_ids:
        try:
            result = _trash.move_to_trash(cam_id, eid)
            if result.get("json_deleted"):
                deleted += 1
            else:
                failed.append(eid)
        except Exception:
            failed.append(eid)
    logging.getLogger(__name__).info(
        "[bulk-delete→trash] cam=%s trashed=%d failed=%d",
        cam_id,
        deleted,
        len(failed),
    )
    return jsonify({"ok": True, "deleted": deleted, "failed": failed})


@bp.post('/api/camera/<cam_id>/events/<event_id>/confirm')
def api_event_confirm(cam_id, event_id):
    store = app_state.store
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["confirmed"] = True
    event["confirmed_at"] = datetime.now().isoformat(timespec="seconds")
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True})


@bp.post('/api/camera/<cam_id>/events/<event_id>/labels')
def api_event_labels(cam_id, event_id):
    store = app_state.store
    payload = request.get_json(force=True, silent=True) or {}
    labels = payload.get("labels", [])
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["labels"] = labels
    # Keep top_label in sync with labels so timeline/badges/stats agree.
    # If the previous top_label was removed, fall back to first remaining label,
    # or "motion" when the user cleared the list entirely.
    prev_top = event.get("top_label")
    if not labels:
        event["top_label"] = "motion"
    elif prev_top not in labels:
        event["top_label"] = labels[0]
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True, "labels": labels, "top_label": event["top_label"]})


@bp.post('/api/camera/<cam_id>/review/<event_id>')
def api_camera_review(cam_id, event_id):
    payload = request.get_json(force=True, silent=True) or {}
    app_state.settings.set_review(f"{cam_id}:{event_id}", payload)
    return jsonify({"ok": True})

"""Trash / Papierkorb endpoints — list, restore, empty.

The trash is populated by ``app.trash.move_to_trash``, which the
motion-event delete handlers in ``routes/events.py`` call instead of
``EventStore.delete_event`` so a delete becomes a soft-delete with a
``trash.grace_days``-day grace period. The cleanup sweep hard-deletes
expired entries when its hook lands in a follow-up commit.

Endpoint URLs match the prompt spec verbatim:
  GET  /api/trash               list trashed entries
  POST /api/trash/<id>/restore  restore one entry by event_id
  POST /api/trash/empty         hard-delete every entry now

``<id>`` is the event_id (unique across cameras for motion events).
The cam_id is read from the trash entry's meta.json so the URL stays
flat."""

from __future__ import annotations

import logging

from flask import Blueprint, jsonify

from .. import trash as _trash

bp = Blueprint("trash", __name__)
_log = logging.getLogger(__name__)


@bp.get('/api/trash')
def api_trash_list():
    """List every trashed event with metadata. Sorted newest-first
    so the UI shows the most-recently-deleted entry on top."""
    items = _trash.list_trashed()
    return jsonify({"ok": True, "items": items, "count": len(items)})


@bp.post('/api/trash/<event_id>/restore')
def api_trash_restore(event_id):
    """Move one entry back to its original location. The event's
    cam_id is looked up from the entry's meta.json so the URL stays
    flat — callers don't have to know which camera the event came
    from when restoring."""
    # Find the cam_id by scanning trash. Event ids are unique per
    # camera in practice, so the first hit is the right one.
    for item in _trash.list_trashed():
        if item.get("event_id") == event_id:
            cam_id = item.get("cam_id")
            if not cam_id:
                return jsonify({"ok": False, "error": "cam_id missing in trash entry"}), 500
            ok = _trash.restore(cam_id, event_id)
            if ok:
                _log.info("[trash] restored %s/%s", cam_id, event_id)
                return jsonify({"ok": True, "cam_id": cam_id, "event_id": event_id})
            return jsonify({"ok": False, "error": "restore failed"}), 500
    return jsonify({"ok": False, "error": "not in trash"}), 404


@bp.post('/api/trash/<event_id>/delete-now')
def api_trash_delete_now(event_id):
    """Hard-delete one entry NOW, bypassing the grace period. Used by
    the Papierkorb UI's per-row "Endgültig löschen" button."""
    for item in _trash.list_trashed():
        if item.get("event_id") == event_id:
            cam_id = item.get("cam_id")
            if not cam_id:
                return jsonify({"ok": False, "error": "cam_id missing in trash entry"}), 500
            ok = _trash.hard_delete_one(cam_id, event_id)
            if ok:
                _log.info("[trash] hard-deleted %s/%s", cam_id, event_id)
                return jsonify({"ok": True, "cam_id": cam_id, "event_id": event_id})
            return jsonify({"ok": False, "error": "delete failed"}), 500
    return jsonify({"ok": False, "error": "not in trash"}), 404


@bp.post('/api/trash/empty')
def api_trash_empty():
    """Hard-delete every trash entry now. Returns the count
    removed."""
    removed = _trash.empty()
    _log.info("[trash] emptied — %d entries removed", removed)
    return jsonify({"ok": True, "removed": removed})

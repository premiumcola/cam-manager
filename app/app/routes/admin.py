"""Admin endpoints — log tail, runtime reload, timelapse-frame cleanup.

Migrated from server.py during R01.2. /api/reload imports
`rebuild_runtimes` lazily from `..server` because the boot helpers
still live in server.py. R01.6 will relocate them and remove that
last cross-import."""

from __future__ import annotations

import logging
from pathlib import Path

from flask import Blueprint, jsonify, request

from .. import app_state
from ..logging_setup import log_buffer

bp = Blueprint("admin", __name__)


@bp.get('/api/logs')
def api_logs():
    level_name = request.args.get('level', 'DEBUG').upper()
    min_level = getattr(logging, level_name, logging.DEBUG)
    subsystem = (request.args.get('subsystem') or '').strip().lower()
    logs = log_buffer.get(min_level)
    if subsystem:
        logs = [l for l in logs if subsystem in (l.get('logger') or '').lower()]
    return jsonify({"logs": logs})


@bp.post('/api/admin/timelapse/cleanup')
def api_admin_timelapse_cleanup():
    """Delete invalid JPEGs from storage/timelapse_frames/.

    Body: {"dry_run": bool, "cam_id": str?, "profile": str?}.
    Returns one summary entry per cam/profile pair so a UI can render
    'scanned X, kept K, deleted D' rows. Finalised .mp4 files are never
    touched — only the JPEG ringbuffer."""
    from ..timelapse_cleanup import cleanup as _cleanup

    payload = request.get_json(force=True, silent=True) or {}
    dry_run = bool(payload.get("dry_run", False))
    cam_id = payload.get("cam_id") or None
    profile = payload.get("profile") or None
    storage_root = Path(
        app_state.get_effective_config().get("storage", {}).get("root", "/app/storage")
    )
    try:
        summaries = _cleanup(storage_root, dry_run=dry_run, cam_id=cam_id, profile=profile)
        total_scanned = sum(s["scanned"] for s in summaries)
        total_deleted = sum(s["deleted"] for s in summaries)
        return jsonify(
            {
                "ok": True,
                "dry_run": dry_run,
                "summaries": summaries,
                "total_scanned": total_scanned,
                "total_deleted": total_deleted,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.post('/api/reload')
def api_reload():
    # Lazy import to avoid the cycle: server.py still owns the boot
    # helpers and imports `routes` for blueprint registration. R01.6
    # relocates these into a dedicated module.
    from ..server import rebuild_runtimes

    rebuild_runtimes()
    return jsonify({"ok": True})

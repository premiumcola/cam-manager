"""Timeline + per-camera stats-range read endpoints.

Migrated from server.py during R01.4. Both routes are pure storage
reads — nothing else in the codebase depends on the helpers here, so
they live inline.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from .. import app_state

bp = Blueprint("timeline_stats", __name__)


@bp.get('/api/camera/<cam_id>/stats_range')
def api_camera_stats(cam_id):
    label = request.args.get('label')
    start = request.args.get('start')
    end = request.args.get('end')
    return jsonify(app_state.store.stats_range(cam_id, label=label, start=start, end=end))


@bp.get('/api/timeline')
def api_timeline():
    settings = app_state.settings
    store = app_state.store
    storage_root = app_state.storage_root
    label = request.args.get('label')
    cam_id = request.args.get('camera')
    now = datetime.now()
    if request.args.get('hours'):
        hours = request.args.get('hours', type=int, default=168)
        start = (now - timedelta(hours=hours)).isoformat(timespec='seconds')
        period = f'{hours}h'
    else:
        period = request.args.get('period', 'week')
        hours = {'day': 24, 'week': 168, 'month': 720}.get(period, 168)
        start = (now - timedelta(hours=hours)).isoformat(timespec='seconds')
    cameras = [cam_id] if cam_id else [c["id"] for c in settings.data.get("cameras", [])]
    tracks = []
    merged = []
    for idx, cid in enumerate(cameras):
        # media_only=True so events whose JPG was deleted/orphaned no longer show
        # up as stale dots on the timeline.
        ev = store.list_events(cid, label=label, start=start, limit=2000, media_only=True)
        pts = []
        for e in reversed(ev):
            snap_rel = e.get("snapshot_relpath")
            snap_url = e.get("snapshot_url")
            # Verify the snapshot file is actually reachable before
            # exposing its URL. Orphaned events would otherwise produce
            # a broken <img> in the activity-cloud tooltip. The DOT
            # itself stays — a detection still happened at that point,
            # just no preview survives — so we null the URL instead of
            # dropping the point. Two paths get checked:
            #   * snapshot_relpath (canonical) — direct storage probe.
            #   * snapshot_url starting with /media/ — derive the
            #     storage path from the URL and probe that.
            # Either branch resolving keeps the URL; neither resolving
            # nulls it. media_only=True on list_events is the first
            # filter; this is the belt-and-braces second pass.
            if snap_rel and not (storage_root / snap_rel).exists():
                snap_url = None
            elif (not snap_rel) and snap_url and snap_url.startswith("/media/"):
                derived = storage_root / snap_url[len("/media/") :]
                if not derived.exists():
                    snap_url = None
            pts.append(
                {
                    "event_id": e["event_id"],
                    "time": e["time"],
                    "labels": e.get("labels", []),
                    "top_label": e.get("top_label"),
                    "alarm_level": e.get("alarm_level", "info"),
                    "snapshot_url": snap_url,
                    "y": idx,
                }
            )
            merged.append({"camera_id": cid, **pts[-1]})
        tracks.append({"camera_id": cid, "points": pts})
    merged.sort(key=lambda x: x["time"])
    return jsonify({"period": period, "start": start, "tracks": tracks, "merged": merged})

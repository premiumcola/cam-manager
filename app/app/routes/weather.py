"""Weather sightings, sun-times, recaps, status, history.

Migrated from server.py during R01.5. Every route reads
`app_state.weather_service` fresh — `rebuild_services` may replace
the instance after a settings save.
"""
from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

import cv2
from flask import Blueprint, Response, jsonify, request, send_from_directory

from .. import app_state

bp = Blueprint("weather", __name__)


# Serializes thumb-regen across parallel requests for the same sighting.
# A single global lock is overkill but the operation is rare (only fires
# when a thumb file is genuinely missing) and a per-path lock map would
# add bookkeeping for no measurable win.
_weather_thumb_regen_lock = threading.Lock()


def _regenerate_weather_thumb(clip_path: Path, thumb_path: Path) -> bool:
    """Extract a frame from roughly the middle of `clip_path` and write
    it as JPEG to `thumb_path` via temp-file + atomic rename. Returns
    True on success. cv2 is the same backend the original thumb writer
    uses so no new dependency."""
    try:
        cap = cv2.VideoCapture(str(clip_path))
        if not cap.isOpened():
            return False
        try:
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if n > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, n // 2))
            ok, frame = cap.read()
            if (not ok or frame is None) and n > 0:
                # Some codecs misreport frame count — first frame always
                # decodes if the file is otherwise valid.
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
            if not ok or frame is None:
                return False
            ok2, buf = cv2.imencode(".jpg", frame,
                                    [int(cv2.IMWRITE_JPEG_QUALITY), 88])
            if not ok2:
                return False
        finally:
            cap.release()
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        # Same-directory tempfile keeps the rename filesystem-local so
        # parallel readers never see a half-written JPEG.
        tmp = thumb_path.with_name(
            f".{thumb_path.name}.tmp.{os.getpid()}.{threading.get_ident()}"
        )
        tmp.write_bytes(buf.tobytes())
        os.replace(str(tmp), str(thumb_path))
        return True
    except Exception as e:
        logging.getLogger(__name__).warning(
            "[weather] thumb regen exception: %s", e)
        return False


@bp.get('/api/weather/sightings')
def api_weather_sightings():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"items": [], "counts": {}, "total": 0, "page": 0, "page_size": 50})
    try:
        page = int(request.args.get('page', 0))
    except (TypeError, ValueError):
        page = 0
    return jsonify(ws.list_sightings(
        cam_id=request.args.get('cam_id') or None,
        event_type=request.args.get('event_type') or None,
        since_iso=request.args.get('from') or None,
        until_iso=request.args.get('to') or None,
        page=page,
    ))


@bp.get('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_get(sighting_id: str):
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"error": "weather service not available"}), 503
    m = ws.get_sighting(sighting_id)
    if not m:
        return jsonify({"error": "not found"}), 404
    return jsonify(m)


@bp.get('/api/weather/sightings/<sighting_id>/clip')
def api_weather_sighting_clip(sighting_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("clip_path", "")
    full = storage_root / rel
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@bp.get('/api/weather/sightings/<sighting_id>/thumb')
def api_weather_sighting_thumb(sighting_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("thumb_path", "")
    full = storage_root / rel
    try:
        if not str(full.resolve()).startswith(str(storage_root.resolve())):
            return Response(status=404)
    except (OSError, RuntimeError):
        return Response(status=404)
    if not full.exists():
        # Thumb JPG missing on disk — try to regenerate from the clip
        # before giving up. Both-missing is the only true 404 case.
        log = logging.getLogger(__name__)
        clip_rel = m.get("clip_path", "")
        clip_full = (storage_root / clip_rel) if clip_rel else None
        if not clip_full or not clip_full.exists():
            log.warning(
                "[weather] thumb 404 — clip and thumb both missing for %s",
                sighting_id)
            return Response(status=404)
        with _weather_thumb_regen_lock:
            # Re-check inside the lock — another request may have won.
            if not full.exists():
                if not _regenerate_weather_thumb(clip_full, full):
                    log.warning("[weather] thumb regen failed for %s",
                                sighting_id)
                    return Response(status=404)
                log.info("[weather] thumb regenerated for %s", sighting_id)
    return send_from_directory(full.parent, full.name, mimetype='image/jpeg')


@bp.delete('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_delete(sighting_id: str):
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"error": "weather service not available"}), 503
    if ws.delete_sighting(sighting_id):
        return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@bp.get('/api/weather/sun-times')
def api_weather_sun_times():
    """Today's sunrise/sunset for the configured location, plus per-camera
    sun-timelapse window previews. Powers the live preview row in
    Settings → Wetter."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"location_set": False, "sunrise": None, "sunset": None,
                        "cameras": []})
    return jsonify(ws.sun_times_today())


@bp.get('/api/weather/recaps')
def api_weather_recaps():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"items": []})
    return jsonify({"items": ws.list_recaps()})


@bp.get('/api/weather/recaps/<recap_id>/clip')
def api_weather_recap_clip(recap_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_recap(recap_id)
    if not m:
        return Response(status=404)
    full = storage_root / m.get("clip_path", "")
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@bp.get('/api/weather/status')
def api_weather_status():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({
            "enabled": False, "last_poll_at": None, "last_api_ok": None,
            "current_state": {}, "current_values": {},
            "location": {"lat": None, "lon": None},
        })
    return jsonify(ws.status())


@bp.get('/api/weather/history')
def api_weather_history():
    """Backing endpoint for the Wetterstatistik chart. `hours` clamped
    to 1..720 by the service (30 d at default 5-min poll). Returns a
    sample list, per-field thresholds drawn from the configured event
    triggers, units, German labels, and the configured poll interval."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({
            "hours": 24, "samples": [], "thresholds": {}, "units": {},
            "labels_de": {}, "fields": [], "poll_interval_s": 300,
        })
    try:
        hours = int(request.args.get("hours", 24))
    except (TypeError, ValueError):
        hours = 24
    return jsonify(ws.history(hours))

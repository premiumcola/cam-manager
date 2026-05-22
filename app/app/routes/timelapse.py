"""Timelapse-related endpoints — global status, per-camera build / list /
delete / rolling, and the global timelapse settings save.

Migrated from server.py during R01.4. The TimelapseBuilder lives in
`app_state.timelapse_builder` and is reused fresh on every call —
no caching here.
"""

from __future__ import annotations

import json as _json
import threading as _thr
from datetime import datetime, timedelta
from pathlib import Path

from flask import Blueprint, jsonify, request

from .. import app_state
from ._helpers import safe_day_param

bp = Blueprint("timelapse", __name__)


@bp.get('/api/timelapse/status')
def api_timelapse_status():
    from ..camera_runtime import _PROFILE_PERIOD_DEFAULTS, _PROFILES

    settings = app_state.settings
    timelapse_builder = app_state.timelapse_builder
    today = datetime.now().strftime("%Y-%m-%d")
    tl_settings = settings.data.get("timelapse_settings", {})
    global_enabled = bool(tl_settings.get("global_enabled", False))
    cameras_out = []
    for cam in settings.data.get("cameras", []):
        cam_id = cam["id"]
        tl = cam.get("timelapse") or {}
        profiles = tl.get("profiles") or {}
        cam_fps = int(tl.get("fps", 25))
        prof_status = {}
        any_active = False
        for pname in _PROFILES:
            prof = profiles.get(pname) or {}
            enabled = bool(prof.get("enabled"))
            if enabled:
                any_active = True
            fc = timelapse_builder.frame_count(cam_id, pname, today)
            target_s = int(prof.get("target_seconds", 60))
            period_s = int(prof.get("period_seconds", _PROFILE_PERIOD_DEFAULTS.get(pname, 86400)))
            prof_fps = int(prof.get("fps") or cam_fps)
            # Sub-1s interval is legitimate for short periods (15min → 1min).
            interval_s = round(period_s / max(1, target_s * prof_fps), 2)
            interval_s = max(0.5, interval_s)
            prof_status[pname] = {
                "enabled": enabled,
                "frame_count": fc,
                "interval_s": interval_s,
                "fps": prof_fps,
            }
        cameras_out.append(
            {
                "camera_id": cam_id,
                "name": cam.get("name", cam_id),
                "any_active": any_active,
                "profiles": prof_status,
            }
        )
    total_active = sum(1 for c in cameras_out if c["any_active"])
    return jsonify(
        {
            "ok": True,
            "global_enabled": global_enabled,
            "active_count": total_active,
            "cameras": cameras_out,
            "today": today,
        }
    )


@bp.post('/api/settings/timelapse')
def api_settings_timelapse_save():
    settings = app_state.settings
    payload = request.get_json(force=True) or {}
    ts = settings.data.setdefault("timelapse_settings", {})
    if "global_enabled" in payload:
        ts["global_enabled"] = bool(payload["global_enabled"])
    settings.save()
    return jsonify({"ok": True})


@bp.get('/api/camera/<cam_id>/timelapse')
def api_camera_timelapse(cam_id):
    settings = app_state.settings
    store = app_state.store
    storage_root = app_state.storage_root
    timelapse_builder = app_state.timelapse_builder
    cam_cfg = settings.get_camera(cam_id)
    if not cam_cfg:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    tl_cfg = cam_cfg.get("timelapse") or {}
    if not tl_cfg.get("enabled", False):
        return jsonify({"ok": False, "error": "timelapse disabled"}), 400
    # Validate YYYY-MM-DD or fall back to today — guards against a
    # path-traversal attempt landing in the filesystem join below.
    day = safe_day_param(request.args.get("day")) or datetime.now().strftime("%Y-%m-%d")
    force = request.args.get("force") == "1"
    target_s = int(tl_cfg.get("daily_target_seconds", 60))
    target_fps = int(tl_cfg.get("fps", 25))
    period = tl_cfg.get("period", "day")
    # Resolve a per-camera filename slug so multi-camera installs
    # downloading the same day's timelapses don't end up with
    # colliding filenames in a single folder. Falls back through
    # display-name → camera_id → "unknown"; never raises.
    from ..camera_id import camera_slug

    cam_slug = camera_slug(app_state.store, cam_id)
    # QA context — passes settings_store through so the post-build
    # sidecar can run fps auto-adjust on the rolling history.
    qa_ctx = {"settings_store": app_state.store}
    path = timelapse_builder.build_period(
        cam_id,
        day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=period,
        force=force,
        cam_slug=cam_slug,
        qa_ctx=qa_ctx,
    )
    if not path:
        frames_dir = storage_root / "timelapse_frames" / cam_id / day
        day_dir = store.events_dir / cam_id / day
        has_frames = (frames_dir.exists() and any(frames_dir.glob("*.jpg"))) or (
            day_dir.exists() and any(day_dir.rglob("*.jpg"))
        )
        if not has_frames:
            return jsonify({"ok": False, "error": "no_frames", "day": day}), 404

        def _bg_build():
            timelapse_builder.build_period(
                cam_id,
                day,
                target_duration_s=target_s,
                target_fps=target_fps,
                period=period,
                force=True,
                cam_slug=cam_slug,
                qa_ctx=qa_ctx,
            )

        _thr.Thread(target=_bg_build, daemon=True).start()
        return jsonify({"ok": False, "error": "building", "day": day, "retry_after": 15}), 202
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "day": day, "url": f"/media/{rel.as_posix()}"})


@bp.get('/api/timelapse/<path:rel>/qa')
def api_timelapse_qa(rel):
    """Return the QA sidecar JSON for an mp4 under storage/.

    ``rel`` is the path of the .mp4 (or path of the sidecar minus
    the trailing ``.qa.json``) relative to storage_root. Examples:
      /api/timelapse/timelapse/<cam>/<file>.mp4/qa
      /api/timelapse/weather/<cam>/sunrise_timelapse/<file>.mp4/qa
    Returns 404 when the sidecar doesn't exist — older builds
    (pre-QA-pass) have no sidecar and the UI falls back to its
    grey "n/a" pill + Rebuild affordance.
    """
    from ..timelapse_qa import qa_sidecar_path, read_qa_sidecar

    storage_root = app_state.storage_root
    # Defence against directory traversal — resolve against storage_root
    # and reject anything that escapes.
    try:
        target = (storage_root / rel).resolve()
        target.relative_to(storage_root.resolve())
    except Exception:
        return jsonify({"error": "invalid path"}), 400
    # Accept either the mp4 path or the explicit .qa.json path.
    if target.suffix == ".mp4":
        sidecar = qa_sidecar_path(target)
    elif target.name.endswith(".qa.json"):
        sidecar = target
    else:
        return jsonify({"error": "expected an .mp4 or .qa.json path"}), 400
    if not sidecar.exists():
        return jsonify({"error": "no sidecar"}), 404
    data = read_qa_sidecar(sidecar.parent / sidecar.name.replace(".qa.json", ""))
    if data is None:
        # Last-resort raw read so a malformed sidecar still surfaces
        # SOMETHING instead of a silent 500.
        try:
            return jsonify(_json.loads(sidecar.read_text(encoding="utf-8")))
        except Exception:
            return jsonify({"error": "sidecar unreadable"}), 500
    return jsonify(data)


@bp.get('/api/camera/<cam_id>/timelapse/list')
def api_camera_timelapse_list(cam_id):
    storage_root = app_state.storage_root
    tl_dir = storage_root / "timelapse" / cam_id
    if not tl_dir.exists():
        return jsonify({"ok": True, "files": []})
    files = []
    for mp4 in sorted(tl_dir.glob("*.mp4"), reverse=True):
        stat = mp4.stat()
        rel = mp4.relative_to(storage_root)
        # Try sidecar JSON first for rich metadata
        meta: dict = {}
        sidecar = tl_dir / f"{mp4.stem}.json"
        if sidecar.exists():
            try:
                meta = _json.loads(sidecar.read_text(encoding="utf-8"))
            except Exception:
                pass
        # Fallback: derive from filename
        # Filename patterns: "2026-04-14_020435_custom.mp4" or "2026-04-14_020435_custom_1min-to-10s.mp4"
        parts = mp4.stem.split("_", 2)
        day = parts[0] if parts else mp4.stem
        period = meta.get("period") or (parts[2].split("_")[0] if len(parts) > 2 else "day")
        # Thumbnail: same stem as video but .jpg (written by _write_video)
        thumb = tl_dir / f"{mp4.stem}.jpg"
        thumb_url = (
            f"/media/{(thumb.relative_to(storage_root)).as_posix()}" if thumb.exists() else None
        )
        files.append(
            {
                "event_id": meta.get("event_id") or f"tl_{mp4.stem}",
                "camera_id": cam_id,
                "type": "timelapse",
                "filename": mp4.name,
                "day": meta.get("window_key", day)[:10],
                "window_key": meta.get("window_key", day),
                "profile": meta.get("profile", period),
                "period": period,
                "period_s": meta.get("period_s", 0),
                "target_s": meta.get("target_s", 0),
                "frame_count": meta.get("frame_count", 0),
                "url": f"/media/{rel.as_posix()}",
                "thumb_url": thumb_url,
                "relpath": rel.as_posix(),
                "size_mb": meta.get("size_mb") or round(stat.st_size / 1024 / 1024, 1),
                "mtime": stat.st_mtime,
                "time": meta.get("time") or day,
            }
        )
    return jsonify({"ok": True, "files": files})


@bp.delete('/api/camera/<cam_id>/timelapse/<filename>')
def api_camera_timelapse_delete(cam_id, filename):
    store = app_state.store
    storage_root = app_state.storage_root
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"ok": False, "error": "invalid"}), 400
    mp4 = storage_root / "timelapse" / cam_id / filename
    if not mp4.exists():
        return jsonify({"ok": False, "error": "not found"}), 404
    mp4.unlink()
    # Also delete sidecar JSON and thumbnail if present
    for companion_suffix in (".json", ".jpg"):
        companion = mp4.with_suffix(companion_suffix)
        if companion.exists():
            try:
                companion.unlink()
            except Exception:
                pass
    # And remove the unified EventStore entry so the media grid stays in sync
    try:
        store.delete_event_by_id(cam_id, f"tl_{mp4.stem}")
    except Exception:
        pass
    return jsonify({"ok": True})


@bp.get('/api/camera/<cam_id>/timelapse/rolling')
def api_camera_timelapse_rolling(cam_id):
    settings = app_state.settings
    storage_root = app_state.storage_root
    timelapse_builder = app_state.timelapse_builder
    # type=int makes Flask return None on a bogus value instead of
    # raising; the `or 10` keeps the legacy default.
    minutes = request.args.get("minutes", type=int) or 10
    minutes = max(1, min(minutes, 120))
    cam_cfg = settings.get_camera(cam_id)
    if not cam_cfg:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    tl_cfg = cam_cfg.get("timelapse") or {}
    if not tl_cfg.get("enabled"):
        return jsonify({"ok": False, "error": "timelapse disabled"}), 400
    day = datetime.now().strftime("%Y-%m-%d")
    frames_dir = storage_root / "timelapse_frames" / cam_id / day
    if not frames_dir.exists():
        return jsonify({"ok": False, "error": "no_frames"}), 404
    cutoff = datetime.now() - timedelta(minutes=minutes)
    images = sorted(
        [p for p in frames_dir.glob("*.jpg") if p.stat().st_mtime >= cutoff.timestamp()]
    )
    if len(images) < 2:
        return jsonify({"ok": False, "error": "not_enough_frames", "minutes": minutes}), 404
    target_fps = int(tl_cfg.get("fps", 25))
    target_s = max(5, int(tl_cfg.get("daily_target_seconds", 60)) // 10)
    from ..camera_id import camera_slug

    cam_slug = camera_slug(app_state.store, cam_id)
    path = timelapse_builder.build_period(
        cam_id,
        day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=f"rolling{minutes}min",
        force=True,
        images_override=images,
        cam_slug=cam_slug,
        qa_ctx={"settings_store": app_state.store},
    )
    if not path:
        return jsonify({"ok": False, "error": "build_failed"}), 500
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "minutes": minutes, "url": f"/media/{rel.as_posix()}"})

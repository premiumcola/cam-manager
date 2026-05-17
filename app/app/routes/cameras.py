"""Camera CRUD, settings/cameras, settings/app, and settings/backups.

Migrated from server.py during R01.3. Camera-save and camera-delete
both touch live runtimes via `restart_single_camera` /
`rebuild_runtimes`, which still live in server.py. Those imports are
lazy inside the route bodies — same pattern admin.py uses for
`/api/reload`. Settings/app save also calls `rebuild_runtimes` for
config changes that affect runtime behaviour.
"""
from __future__ import annotations

import json as _json
import shutil as _shutil
import time as _time
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

from .. import app_state
from ..camera_runtime import CameraRuntime
from ._camera_helpers import (
    _CONN_FIELDS,
    _RESTORE_CONN_FIELDS,
    _auto_detect_device_info,
    _list_backup_files,
    _mask_password_in_url,
    _read_backup,
)

bp = Blueprint("cameras", __name__)


@bp.get('/api/cameras')
def api_cameras():
    runtimes = app_state.runtimes
    cams = []
    for cam in app_state.get_effective_config().get("cameras", []):
        rt = runtimes.get(cam["id"])
        s = rt.status() if rt else {
            "id": cam["id"], "name": cam.get("name", cam["id"]), "location": cam.get("location", ""), "enabled": cam.get("enabled", True),
            "armed": cam.get("armed", True), "status": "disabled", "today_events": 0
        }
        # snap_url / stream_url are dashboard-display-only derived URLs.
        # They MUST use a distinct key so they are never confused with the persisted
        # upstream snapshot_url / rtsp_url (which live in settings.json).
        s["snap_url"] = f"/api/camera/{cam['id']}/snapshot.jpg"
        s["stream_url"] = f"/api/camera/{cam['id']}/stream.mjpg"
        s["stream_url_hd"] = f"/api/camera/{cam['id']}/stream_hd.mjpg"
        # Expose real persisted connection fields from settings so that the edit form
        # and any quick-action spreads ({...cam}) carry the correct upstream values.
        s["snapshot_url"] = cam.get("snapshot_url", "")
        s["rtsp_url"] = cam.get("rtsp_url", "")
        s["username"] = cam.get("username", "")
        s["password"] = cam.get("password", "")
        s["object_filter"] = cam.get("object_filter", [])
        s["telegram_enabled"] = cam.get("telegram_enabled", True)
        s["mqtt_enabled"] = cam.get("mqtt_enabled", True)
        s["whitelist_names"] = cam.get("whitelist_names", [])
        # Unified per-camera schedule. Migration in SettingsStore guarantees
        # the new shape; the legacy recording_schedule_* fields no longer
        # exist in the persisted config.
        s["schedule"] = cam.get("schedule") or {
            "enabled": False, "from": "21:00", "to": "06:00",
            "actions": {"record": True, "telegram": True, "hard": True},
        }
        s["bottom_crop_px"] = cam.get("bottom_crop_px", 0)
        s["motion_sensitivity"] = cam.get("motion_sensitivity", 0.5)
        s["detection_min_score"] = float(cam.get("detection_min_score") or 0.0)
        s["motion_enabled"] = cam.get("motion_enabled", True)
        s["detection_trigger"] = cam.get("detection_trigger", "motion_and_objects")
        s["post_motion_tail_s"] = float(cam.get("post_motion_tail_s") or 0.0)
        s["alarm_profile"] = cam.get("alarm_profile") or ""
        # L1 · per-camera tracker overrides — the cam-edit Erkennung
        # tab's "Objekt-Tracking" inputs read these. Missing the keys
        # here means the form always shows 0 even after a save (the
        # frontend's `parseFloat(undefined) || 0` collapses to 0),
        # so the user-entered values appeared to never persist. 0 /
        # None remain the "use module default" sentinel — surfaced as
        # 0 in the input so the placeholder hint still wins.
        s["track_spawn_min_score"] = float(cam.get("track_spawn_min_score") or 0.0)
        s["track_continue_min_score"] = float(cam.get("track_continue_min_score") or 0.0)
        s["track_miss_grace_seconds"] = float(cam.get("track_miss_grace_seconds") or 0.0)
        s["track_iou_match_threshold"] = float(cam.get("track_iou_match_threshold") or 0.0)
        s["zones"] = cam.get("zones", [])
        s["masks"] = cam.get("masks", [])
        s["resolution"] = cam.get("resolution", "auto")
        s["frame_interval_ms"] = cam.get("frame_interval_ms", 350)
        s["snapshot_interval_s"] = cam.get("snapshot_interval_s", 3)
        s["timelapse"] = cam.get("timelapse", {})
        s["weather"] = cam.get("weather") or {"enabled": False}
        # Recent-detection feed for the live-tile object-icon red glow.
        # Filter to entries within the last 10 s; the dashboard polls
        # this endpoint every 3 s so a fresh detection lights the chip
        # on the very next tick and decays naturally as entries age
        # out of the window. Older entries stay in the runtime deque
        # until the deque's maxlen evicts them; only the filter here
        # controls the visible glow window.
        now_epoch = _time.time()
        recent: list[dict] = []
        if rt is not None and getattr(rt, "recent_detections", None):
            for lbl, ts in list(rt.recent_detections):
                age = now_epoch - ts
                if 0 <= age <= 10.0:
                    recent.append({"label": lbl, "age_s": round(age, 2)})
        s["recent_detections"] = recent
        cams.append(s)
    return jsonify({"cameras": cams})


@bp.get('/api/settings/cameras')
def api_settings_cameras():
    return jsonify({"cameras": app_state.settings.data.get("cameras", [])})


@bp.get('/api/settings/backups')
def api_settings_backups_list():
    """List available settings backups for the recovery UI. Each entry
    summarises the snapshot (mtime, size, total cams) and — when ?cam_id=…
    is supplied — flags whether that backup contains the cam and whether
    its connection fields are usable."""
    cam_id = request.args.get("cam_id") or ""
    items = []
    for p in _list_backup_files():
        try:
            st = p.stat()
        except OSError:
            continue
        data = _read_backup(p)
        n_cameras = len((data or {}).get("cameras", []) or [])
        has_cam = False
        has_connection = False
        if cam_id and isinstance(data, dict):
            for c in data.get("cameras", []) or []:
                if c.get("id") == cam_id:
                    has_cam = True
                    has_connection = bool(c.get("rtsp_url") and c.get("username"))
                    break
        items.append({
            "filename": p.name,
            "mtime_iso": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "size": st.st_size,
            "n_cameras": n_cameras,
            "has_cam": has_cam,
            "has_connection": has_connection,
        })
    return jsonify({"items": items})


@bp.get('/api/settings/backups/<filename>/cam/<cam_id>')
def api_settings_backup_cam(filename: str, cam_id: str):
    """Return the connection fields for `cam_id` from the named backup, with
    the password masked so the preview can show what the user is about to
    restore without leaking the secret."""
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        return jsonify({"ok": False, "error": "invalid filename"}), 400
    candidates = [p for p in _list_backup_files() if p.name == filename]
    if not candidates:
        return jsonify({"ok": False, "error": "backup not found"}), 404
    data = _read_backup(candidates[0])
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "backup not parseable"}), 400
    for c in data.get("cameras", []) or []:
        if c.get("id") == cam_id:
            return jsonify({
                "ok": True,
                "cam_id": cam_id,
                "name": c.get("name", ""),
                "rtsp_url_masked": _mask_password_in_url(c.get("rtsp_url", "")),
                "snapshot_url_masked": _mask_password_in_url(c.get("snapshot_url", "")),
                "username": c.get("username", ""),
                "password_set": bool(c.get("password")),
            })
    return jsonify({"ok": False, "error": "cam not in this backup"}), 404


@bp.post('/api/settings/cameras/<cam_id>/restore-connection')
def api_settings_cam_restore_connection(cam_id: str):
    """Restore connection-only fields for one camera from a named backup.

    Touches exactly the four fields in _RESTORE_CONN_FIELDS — every other
    field on the cam (zones, schedule, profiles…) and every other camera
    is left alone. Triggers restart_single_camera so the cam comes back
    online without a full reload."""
    from ..server import restart_single_camera
    settings = app_state.settings
    payload = request.get_json(force=True) or {}
    filename = (payload.get("filename") or "").strip()
    if "/" in filename or "\\" in filename or filename.startswith("..") or not filename:
        return jsonify({"ok": False, "error": "invalid filename"}), 400
    if not settings.get_camera(cam_id):
        return jsonify({"ok": False, "error": "cam not configured"}), 404
    candidates = [p for p in _list_backup_files() if p.name == filename]
    if not candidates:
        return jsonify({"ok": False, "error": "backup not found"}), 404
    data = _read_backup(candidates[0])
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "backup not parseable"}), 400
    src = next((c for c in data.get("cameras", []) or [] if c.get("id") == cam_id), None)
    if not src:
        return jsonify({"ok": False, "error": "cam not in this backup"}), 404
    if not src.get("rtsp_url"):
        return jsonify({"ok": False, "error": "backup has empty rtsp_url for this cam"}), 400
    current = settings.get_camera(cam_id) or {}
    patch = {f: src.get(f, "") for f in _RESTORE_CONN_FIELDS}
    merged = {**current, **patch}
    try:
        settings.upsert_camera(merged)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 422
    restart_single_camera(cam_id)
    return jsonify({
        "ok": True,
        "cam_id": cam_id,
        "restored_fields": list(_RESTORE_CONN_FIELDS),
        "from": filename,
    })


@bp.post('/api/settings/cameras')
def api_settings_cameras_save():
    from ..server import restart_single_camera
    settings = app_state.settings
    runtimes = app_state.runtimes
    _runtime_cfgs = app_state._runtime_cfgs
    payload = request.get_json(force=True) or {}
    if not payload.get("id"):
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    old_id = payload["id"]
    old_cfg = settings.get_camera(old_id) or {}
    # Guard: never persist dashboard-display URLs as the upstream connection fields.
    # These get into the payload when quick-actions spread state.cameras objects.
    for field in ("snapshot_url", "rtsp_url"):
        val = payload.get(field, "")
        if val.startswith("/api/camera/"):
            # Retain the existing persisted value; display-only URLs must not overwrite it.
            preserved = old_cfg.get(field, "")
            payload[field] = preserved
    # Reolink auto-detect: fill empty manufacturer/model from the camera
    # itself before persisting. No-op when the user typed values manually
    # or the camera doesn't respond. The returned list flags which fields
    # were filled so the UI can show an "automatisch erkannt" hint.
    auto_detected = _auto_detect_device_info(payload)
    try:
        new_id = settings.upsert_camera(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    # If the canonical id changed underneath us (manufacturer / model /
    # name / rtsp_url edit triggered storage_migration), the runtime
    # under the OLD id is now orphaned — drop it before binding a fresh
    # one under the NEW id. Without this, every cam-edit save quietly
    # broke the Telegram bot's cam picker for an hour until something
    # else triggered a rebuild_runtimes.
    enabled_now = payload.get("enabled", True)
    id_renamed = (old_id != new_id)
    conn_changed = any(payload.get(f) != old_cfg.get(f) for f in _CONN_FIELDS)
    if id_renamed:
        existing = runtimes.pop(old_id, None)
        if existing:
            existing.stop()
        _runtime_cfgs.pop(old_id, None)
        if enabled_now:
            restart_single_camera(new_id, reason="rebound after migration")
    elif conn_changed or (new_id not in runtimes and enabled_now):
        restart_single_camera(new_id, reason="rebound after edit")
    return jsonify({
        "ok": True,
        "camera": settings.get_camera(new_id),
        "reloaded": conn_changed or id_renamed,
        "id": new_id,
        "id_renamed_from": old_id if id_renamed else None,
        "auto_detected": auto_detected,
    })


@bp.post('/api/cameras/<cam_id>/probe-device-info')
def api_camera_probe_device_info(cam_id: str):
    """Manual rescan endpoint behind the cam-edit "jetzt erneut erkennen"
    button. Runs the same Reolink GetDevInfo flow as the auto-detect
    save path but on demand and without persisting — the frontend then
    asks the user whether to overwrite existing manuf/model values.
    Used when a camera is firmware-updated or physically replaced but
    keeps the same IP, where the persisted manuf/model are stale.
    """
    cam = app_state.settings.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    rtsp_url = (cam.get("rtsp_url") or "").strip()
    user = cam.get("username") or ""
    password = cam.get("password") or ""
    if not rtsp_url or not user:
        return jsonify({"ok": False, "error": "no credentials configured"}), 400
    try:
        from urllib.parse import urlparse
        host = urlparse(rtsp_url).hostname
    except Exception:
        host = None
    if not host:
        return jsonify({"ok": False, "error": "cannot parse host from rtsp_url"}), 400
    try:
        from .. import reolink_api
        token = reolink_api.login(host, user, password, timeout=4.0)
        if not token:
            return jsonify({"ok": False, "error": "login failed"}), 502
        info = reolink_api.get_device_info(host, token, timeout=4.0)
        reolink_api.logout(host, token, timeout=2.0)
    except Exception as e:
        return jsonify({"ok": False, "error": f"probe failed: {e}"}), 502
    if not info:
        return jsonify({"ok": False, "error": "no device info returned"}), 502
    return jsonify({
        "ok":           True,
        "manufacturer": info["manufacturer"],
        "model":        info["model"],
        "firmware":     info["firmware"],
        "hardware":     info["hardware"],
        "current": {
            "manufacturer": cam.get("manufacturer", ""),
            "model":        cam.get("model", ""),
        },
    })


@bp.post('/api/cameras/<cam_id>/reolink/image-mode')
def api_camera_reolink_image_mode(cam_id: str):
    """Standalone day/night override test panel — manually triggered
    from the Verbindung tab. Hits Reolink's SetIsp + IrLights pair via
    :func:`reolink_api.set_image_mode`; not wired into the timelapse
    pipeline (that comes back in a later round once the operator has
    confirmed the toggle actually works on his cameras).

    Body: ``{"mode": "auto" | "color" | "bw"}``.
    Returns the underlying ``set_image_mode`` result plus the
    masked-back ``mode`` so the UI can echo it.
    """
    cam = app_state.settings.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    vendor = (cam.get("manufacturer") or "").strip().lower()
    if vendor != "reolink":
        return jsonify({
            "ok":    False,
            "error": "image-mode override is Reolink-only "
                     f"(camera vendor={cam.get('manufacturer') or '?'})",
        }), 400
    body = request.get_json(silent=True) or {}
    mode = str(body.get("mode") or "").strip().lower()
    if mode not in ("auto", "color", "bw"):
        return jsonify({
            "ok":    False,
            "error": "mode must be one of auto / color / bw",
        }), 400
    # Pull host from rtsp_url (we never persist the bare host
    # separately — the URL is the source of truth). Fall back to
    # snapshot_url if rtsp_url is empty.
    src = (cam.get("rtsp_url") or cam.get("snapshot_url") or "").strip()
    if not src:
        return jsonify({"ok": False, "error": "no rtsp/snapshot URL configured"}), 400
    try:
        from urllib.parse import urlparse
        host = urlparse(src).hostname
    except Exception:
        host = None
    if not host:
        return jsonify({"ok": False, "error": "cannot parse host from camera URL"}), 400
    user = cam.get("username") or ""
    password = cam.get("password") or ""
    try:
        port = int(cam.get("reolink_http_port") or 0) or 80
    except (TypeError, ValueError):
        port = 80
    try:
        from .. import reolink_api
        result = reolink_api.set_image_mode(
            host, port, user, password, mode, timeout=4.0,
        )
    except Exception as e:
        return jsonify({
            "ok":    False,
            "error": f"image-mode call failed: {e}",
        }), 502
    status_code = 200 if result.get("ok") else 502
    return jsonify({
        "ok":     bool(result.get("ok")),
        "mode":   mode,
        "rc":     result.get("rc"),
        "detail": result.get("detail", ""),
    }), status_code


@bp.post('/api/camera/<cam_id>/reload')
def api_camera_reload(cam_id: str):
    settings = app_state.settings
    runtimes = app_state.runtimes
    store = app_state.store
    # Stop existing runtime for this camera only
    existing = runtimes.pop(cam_id, None)
    if existing:
        existing.stop()
    # Reload config and start fresh runtime for this camera
    cfg = app_state.get_effective_config()
    cam_cfg = settings.get_camera(cam_id)
    if cam_cfg and cam_cfg.get("enabled", True):
        rt = CameraRuntime(
            cam_id, app_state.get_camera_cfg, cfg, store,
            app_state.telegram_service,
            mqtt=app_state.mqtt_service,
            cat_registry=app_state.cat_registry,
            person_registry=app_state.person_registry,
        )
        runtimes[cam_id] = rt
        rt.start()
    return jsonify({"ok": True, "cam_id": cam_id})


@bp.delete('/api/settings/cameras/<cam_id>')
def api_settings_cameras_delete(cam_id):
    settings = app_state.settings
    runtimes = app_state.runtimes
    store = app_state.store
    # Count existing events so the frontend can warn the user
    cam_dir = store.events_dir / cam_id
    event_count = len(list(cam_dir.glob("*.json"))) if cam_dir.exists() else 0
    deleted = settings.delete_camera(cam_id)
    if not deleted:
        return jsonify({"ok": False, "error": "Kamera nicht gefunden"}), 404
    # Stop the running thread
    rt = runtimes.pop(cam_id, None)
    if rt:
        rt.stop()
    return jsonify({"ok": True, "event_count": event_count})


@bp.post('/api/cameras/<source_id>/merge-into/<target_id>')
def api_camera_merge(source_id, target_id):
    """Move all media (events + timelapse) from source camera into target camera,
    rewrite affected JSON metadata so the events appear under the target on disk
    AND in the gallery, then delete the source camera entry from settings.

    Source may be archived (no settings entry, only files on disk) or an
    inactive/error camera that is still configured. Target must be a configured
    camera. Filename collisions get an `_m1`, `_m2`, … suffix; the same suffix
    is applied to the corresponding JSON so JSON ↔ media stay paired.
    """
    settings = app_state.settings
    runtimes = app_state.runtimes
    store = app_state.store
    storage_root = app_state.storage_root
    if source_id == target_id:
        return jsonify({"ok": False, "error": "Quelle und Ziel sind identisch"}), 400
    if not settings.get_camera(target_id):
        return jsonify({"ok": False, "error": "Ziel-Kamera nicht gefunden"}), 404

    src_events = store.events_dir / source_id
    tgt_events = store.events_dir / target_id
    src_tl = storage_root / "timelapse" / source_id
    tgt_tl = storage_root / "timelapse" / target_id

    moved_files = 0
    moved_events = 0
    moved_timelapses = 0

    def _resolve_collision(dest: Path) -> tuple[Path, str]:
        """Return a non-existing destination path + the suffix that was added.
        Suffix is appended to the stem (event_id) so the matching JSON can use
        the same suffix and stay paired with its media file."""
        if not dest.exists():
            return dest, ""
        for i in range(1, 10000):
            cand = dest.with_name(f"{dest.stem}_m{i}{dest.suffix}")
            if not cand.exists():
                return cand, f"_m{i}"
        raise RuntimeError("zu viele Kollisionen")

    # ── Events: walk JSON files first so we can rewrite + move their media ───
    if src_events.exists():
        tgt_events.mkdir(parents=True, exist_ok=True)
        for json_path in sorted(src_events.rglob("*.json")):
            rel_inside_cam = json_path.relative_to(src_events)
            tgt_json = tgt_events / rel_inside_cam
            tgt_json.parent.mkdir(parents=True, exist_ok=True)
            tgt_json, suffix = _resolve_collision(tgt_json)
            try:
                ev = _json.loads(json_path.read_text(encoding="utf-8"))
            except Exception:
                # Corrupt JSON — just move it raw and skip rewrite
                json_path.rename(tgt_json)
                moved_files += 1
                continue

            old_event_id = ev.get("event_id") or json_path.stem
            new_event_id = old_event_id + suffix
            ev["event_id"] = new_event_id
            ev["camera_id"] = target_id
            ev["camera_name"] = settings.get_camera(target_id).get("name", target_id)

            # Move snapshot + video media files alongside the JSON
            for rel_key, url_key in (("snapshot_relpath", "snapshot_url"),
                                     ("video_relpath", "video_url")):
                rel = ev.get(rel_key)
                if not rel:
                    continue
                src_media = storage_root / rel
                if not src_media.exists():
                    # Stale reference — drop it so the moved JSON isn't an orphan
                    ev[rel_key] = None
                    ev[url_key] = None
                    continue
                # Compute the path inside the source cam dir, then mirror it under target.
                try:
                    media_rel_inside_cam = src_media.relative_to(src_events)
                except ValueError:
                    # Media lives outside the camera tree (unusual) — skip move
                    continue
                tgt_media = tgt_events / media_rel_inside_cam
                tgt_media.parent.mkdir(parents=True, exist_ok=True)
                if suffix:
                    tgt_media = tgt_media.with_name(f"{tgt_media.stem}{suffix}{tgt_media.suffix}")
                # Final collision guard (should already be free thanks to suffix)
                tgt_media, _extra = _resolve_collision(tgt_media)
                src_media.rename(tgt_media)
                new_rel = tgt_media.relative_to(storage_root).as_posix()
                ev[rel_key] = new_rel
                ev[url_key] = f"/media/{new_rel}"
                moved_files += 1

            tgt_json.write_text(_json.dumps(ev, ensure_ascii=False, indent=2), encoding="utf-8")
            json_path.unlink(missing_ok=True)
            moved_events += 1
            moved_files += 1

        # Sweep any orphan media still in the source tree (e.g. files that had
        # no JSON yet — scan_media_files would have registered them later).
        for media in list(src_events.rglob("*")):
            if not media.is_file():
                continue
            rel_inside_cam = media.relative_to(src_events)
            dest = tgt_events / rel_inside_cam
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest, _ = _resolve_collision(dest)
            media.rename(dest)
            moved_files += 1

        # Drop empty directories from the source tree
        try:
            _shutil.rmtree(src_events)
        except Exception:
            pass

    # ── Timelapse: simple file move, no metadata to rewrite ───────────────────
    if src_tl.exists():
        tgt_tl.mkdir(parents=True, exist_ok=True)
        for f in list(src_tl.rglob("*")):
            if not f.is_file():
                continue
            rel = f.relative_to(src_tl)
            dest = tgt_tl / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest, _ = _resolve_collision(dest)
            f.rename(dest)
            moved_files += 1
            moved_timelapses += 1
        try:
            _shutil.rmtree(src_tl)
        except Exception:
            pass

    # ── Drop the source camera entry + stop its runtime ───────────────────────
    if settings.get_camera(source_id):
        settings.delete_camera(source_id)
        rt = runtimes.pop(source_id, None)
        if rt:
            rt.stop()

    return jsonify({
        "ok": True,
        "source_id": source_id,
        "target_id": target_id,
        "moved_files": moved_files,
        "moved_events": moved_events,
        "moved_timelapses": moved_timelapses,
    })


@bp.get('/api/settings/app')
def api_settings_app():
    settings = app_state.settings
    proc = settings.data.get("processing", {})
    eff = app_state.get_effective_config().get("processing", {}) or {}
    bird_cfg = eff.get("bird_species", {}) or {}
    wl_cfg = eff.get("wildlife", {}) or {}
    bird_model_path = bird_cfg.get("model_path")
    bird_cpu_path   = bird_cfg.get("cpu_model_path")
    bird_labels_path = bird_cfg.get("labels_path")
    wl_model_path = wl_cfg.get("model_path")
    wl_cpu_path   = wl_cfg.get("cpu_model_path")
    wl_labels_path = wl_cfg.get("labels_path")
    bird_model_available = any(p and Path(p).exists() for p in (bird_model_path, bird_cpu_path))
    bird_labels_available = bool(bird_labels_path and Path(bird_labels_path).exists())
    wl_model_available = any(p and Path(p).exists() for p in (wl_model_path, wl_cpu_path))
    wl_labels_available = bool(wl_labels_path and Path(wl_labels_path).exists())
    # Auto-discover the wildlife model when the configured path is missing
    # or absent on disk. Same heuristic the WildlifeClassifier itself uses,
    # so the API response and runtime stay in sync.
    if not wl_model_available:
        from ..detectors import discover_wildlife_paths
        disc = discover_wildlife_paths()
        if disc:
            wl_model_path = disc.get("model_path") or wl_model_path
            wl_cpu_path   = disc.get("cpu_model_path") or wl_cpu_path
            wl_model_available = True
            if not wl_labels_available and disc.get("labels_path"):
                wl_labels_path = disc["labels_path"]
                wl_labels_available = True
    return jsonify({
        "app": settings.data.get("app", {}),
        "server": settings.data.get("server", {}),
        "telegram": settings.data.get("telegram", {}),
        "mqtt": settings.data.get("mqtt", {}),
        "ui": settings.data.get("ui", {}),
        "processing": {
            "coral_enabled": proc.get("detection", {}).get("mode", "none") == "coral",
            "bird_species_enabled": bool(proc.get("bird_species", {}).get("enabled", False)),
            "bird_model_available": bird_model_available,
            "bird_labels_available": bird_labels_available,
            "bird_model_path": bird_model_path,
            "wildlife_enabled": bool(proc.get("wildlife", {}).get("enabled", False)),
            "wildlife_model_available": wl_model_available,
            "wildlife_labels_available": wl_labels_available,
            "wildlife_model_path": wl_model_path,
        },
    })


@bp.post('/api/settings/app')
def api_settings_app_save():
    from ..server import rebuild_runtimes
    settings = app_state.settings
    payload = request.get_json(force=True) or {}
    needs_rebuild = False
    try:
        for sec in ("app", "server", "ui", "storage"):
            if sec in payload:
                settings.update_section(sec, payload.get(sec) or {})
        if "telegram" in payload:
            # Telegram credentials change → rebuild_runtimes() picks up the
            # new bot token / chat id so the next test (and any subsequent
            # alert from a camera) uses the fresh service.
            settings.update_section("telegram", payload.get("telegram") or {})
            needs_rebuild = True
        if "mqtt" in payload:
            settings.update_section("mqtt", payload.get("mqtt") or {})
            needs_rebuild = True
        if "processing" in payload:
            proc = payload["processing"]
            sec = {
                "detection": {"mode": "coral" if proc.get("coral_enabled") else "none"},
                "bird_species": {"enabled": bool(proc.get("bird_species_enabled"))},
            }
            # Only touch wildlife if the client actually sent it — otherwise
            # saving the Coral toggles would clobber an existing wildlife
            # config that the user set up separately.
            if "wildlife_enabled" in proc:
                sec["wildlife"] = {"enabled": bool(proc.get("wildlife_enabled"))}
            settings.update_section("processing", sec)
            needs_rebuild = True
        if "weather" in payload:
            # update_section deep-merges (Phase 2 telegram fix), so partial
            # writes like {"events": {"thunder": {"threshold": 800}}} don't
            # wipe sibling keys.
            settings.update_section("weather", payload.get("weather") or {})
            needs_rebuild = True
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    if needs_rebuild:
        rebuild_runtimes()
    return jsonify({"ok": True, "saved": True})


@bp.post('/api/camera/<cam_id>/arm')
def api_camera_arm(cam_id):
    settings = app_state.settings
    payload = request.get_json(force=True, silent=True) or {}
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    cam["armed"] = bool(payload.get("armed", True))
    try:
        settings.upsert_camera(cam)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    mqtt = app_state.mqtt_service
    if mqtt is not None:
        mqtt.publish(f"camera/{cam_id}/armed", {"armed": cam["armed"]}, retain=True)
    return jsonify({"ok": True, "camera": cam})

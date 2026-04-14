
from __future__ import annotations
from pathlib import Path
from flask import Flask, jsonify, request, Response, send_from_directory, render_template
from datetime import datetime, timedelta
import cv2
import logging
from collections import deque

class _LogBuffer(logging.Handler):
    def __init__(self, maxlen: int = 400):
        super().__init__()
        self.setFormatter(logging.Formatter("%(message)s"))
        self._records: deque = deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord):
        try:
            self._records.append({
                "ts": datetime.fromtimestamp(record.created).strftime("%H:%M:%S"),
                "level": record.levelname,
                "logger": record.name,
                "msg": self.format(record),
            })
        except Exception:
            pass

    def get(self, min_level: int = logging.DEBUG) -> list:
        return [r for r in self._records if logging.getLevelName(r["level"]) >= min_level]

log_buffer = _LogBuffer()
logging.getLogger().addHandler(log_buffer)
logging.getLogger().setLevel(logging.DEBUG)
# suppress noisy libraries
for _noisy in ("urllib3", "werkzeug", "httpx", "httpcore", "telegram"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

from .config_loader import load_config
from .storage import EventStore
from .camera_runtime import CameraRuntime
from .telegram_bot import TelegramService
from .cat_identity import IdentityRegistry
from .timelapse import TimelapseBuilder
from .discovery import discover_hosts
from .settings_store import SettingsStore
from .mqtt_service import MQTTService

def _get_build_info() -> dict:
    """Try git subprocess first (works in dev); fall back to committed buildinfo.json."""
    import subprocess, json as _json
    result: dict = {"commit": "dev", "date": "—", "count": "—"}
    try:
        repo_root = Path(__file__).resolve().parent.parent.parent
        commit = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%h"],
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()
        date = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%ci"],
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()[:10]
        count = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-list", "--count", "HEAD"],
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()
        if commit:
            result = {"commit": commit, "date": date, "count": count}
            return result
    except Exception:
        pass
    try:
        bi = Path(__file__).parent / "buildinfo.json"
        result = _json.loads(bi.read_text())
    except Exception:
        pass
    return result


_BUILD_INFO = _get_build_info()


base_cfg = load_config()
storage_root = Path(base_cfg["storage"]["root"])
web_root = Path(__file__).resolve().parent.parent / "web"
app = Flask(__name__, template_folder=str(web_root / "templates"), static_folder=str(web_root / "static"))

import hashlib as _hashlib
import pathlib as _pathlib
_static_hashes: dict[str, str] = {}

def _file_hash(filename: str) -> str:
    if filename not in _static_hashes:
        path = _pathlib.Path(__file__).parent.parent / "web" / "static" / filename
        try:
            _static_hashes[filename] = _hashlib.md5(path.read_bytes()).hexdigest()[:8]
        except Exception:
            _static_hashes[filename] = "0"
    return _static_hashes[filename]

app.jinja_env.globals["static_v"] = _file_hash

store = EventStore(str(storage_root))
settings = SettingsStore(storage_root / "settings.json", base_cfg)
cfg = settings.export_effective_config(base_cfg)
cat_registry = IdentityRegistry(storage_root / "cat_registry.json", threshold=int(cfg.get("processing", {}).get("cat_identity", {}).get("match_threshold", 10)))
person_registry = IdentityRegistry(storage_root / "person_registry.json", threshold=int(cfg.get("processing", {}).get("person_identity", {}).get("match_threshold", 10)))
timelapse_builder = TimelapseBuilder(storage_root)
mqtt_service = None
telegram_service = None
runtimes: dict[str, CameraRuntime] = {}


def get_effective_config():
    return settings.export_effective_config(base_cfg)


def get_camera_cfg(cam_id: str):
    return settings.get_camera(cam_id)


def rebuild_services():
    global cfg, mqtt_service, telegram_service
    cfg = get_effective_config()
    mqtt_service = MQTTService(cfg.get("mqtt", {}))
    telegram_service = TelegramService(cfg.get("telegram", {}), store=store, runtimes=runtimes, global_cfg=lambda: settings.export_effective_config(base_cfg), timelapse_builder=timelapse_builder, settings_store=settings)
    telegram_service.start_polling()


def rebuild_runtimes():
    global cfg
    for rt in list(runtimes.values()):
        rt.stop()
    runtimes.clear()
    cfg = get_effective_config()
    rebuild_services()
    mqtt_service.publish("status/reload", {"time": datetime.now().isoformat(timespec="seconds")})
    for cam in cfg.get("cameras", []):
        if cam.get("enabled", True):
            rt = CameraRuntime(cam["id"], get_camera_cfg, cfg, store, telegram_service, mqtt=mqtt_service, cat_registry=cat_registry, person_registry=person_registry)
            runtimes[cam["id"]] = rt
            rt.start()


rebuild_runtimes()


def _startup_media_scan():
    """Scan existing media files on startup in background."""
    import threading
    def _do_scan():
        try:
            effective = settings.export_effective_config(base_cfg)
            cam_ids = [c["id"] for c in effective.get("cameras", [])]
            public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
            count = store.scan_media_files(cam_ids, public_base_url=public_base)
            if count:
                logging.getLogger(__name__).info("[startup] MediaScan: %d orphaned files registered", count)
        except Exception as e:
            logging.getLogger(__name__).warning("[startup] MediaScan failed: %s", e)
    t = threading.Thread(target=_do_scan, daemon=True)
    t.start()


_startup_media_scan()


def _run_daily_cleanup():
    import threading
    retention = int(base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = store.cleanup_old(retention)
        if removed:
            logging.getLogger(__name__).info(f"[cleanup] Removed {removed} old event files (>{retention}d)")
    except Exception as e:
        logging.getLogger(__name__).warning(f"[cleanup] Failed: {e}")
    t = threading.Timer(86400, _run_daily_cleanup)
    t.daemon = True
    t.start()


_run_daily_cleanup()


def _migrate_timelapse_events():
    """One-time migration: remove timelapse-type events that were incorrectly stored
    in the EventStore (storage/events/<cam_id>/) under old code. These are now tracked
    as sidecar JSONs next to the .mp4 files in storage/timelapse/<cam_id>/.
    Covers both date-subdirectory and camera-level tl_*.json placements."""
    import threading, shutil as _shutil
    def _do_migrate():
        log = logging.getLogger(__name__)
        try:
            removed = 0
            events_root = storage_root / "events"
            if not events_root.exists():
                return
            for cam_dir in events_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                # Remove tl_ files directly in the camera directory (flat placement)
                for jf in list(cam_dir.glob("tl_*.json")):
                    try:
                        jf.unlink()
                        removed += 1
                    except Exception:
                        pass
                # Remove tl_ files inside date subdirectories
                for date_dir in cam_dir.iterdir():
                    if not date_dir.is_dir():
                        continue
                    for jf in list(date_dir.glob("tl_*.json")):
                        try:
                            jf.unlink()
                            removed += 1
                        except Exception:
                            pass
            if removed:
                log.info("[migration] Removed %d stale timelapse events from EventStore", removed)
        except Exception as e:
            log.warning("[migration] Timelapse event migration failed: %s", e)

        # Also clean up stale timelapse_frames dirs for cameras that no longer exist
        try:
            frames_root = storage_root / "timelapse_frames"
            if not frames_root.exists():
                return
            active_ids = {c["id"] for c in (settings.data.get("cameras") or [])}
            cleaned = 0
            for cam_dir in frames_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                if cam_dir.name not in active_ids:
                    try:
                        _shutil.rmtree(str(cam_dir))
                        cleaned += 1
                        log.info("[migration] Removed stale frame dir for old camera: %s", cam_dir.name)
                    except Exception as e:
                        log.warning("[migration] Could not remove %s: %s", cam_dir.name, e)
        except Exception as e:
            log.warning("[migration] Stale frame dir cleanup failed: %s", e)

    threading.Thread(target=_do_migrate, daemon=True).start()


_migrate_timelapse_events()


def _generate_missing_thumbnails():
    """Generate thumbnail .jpg for any timelapse .mp4 that does not have one yet.
    Runs once on startup in background — safe to re-run, skips if thumb exists."""
    import threading, cv2 as _cv2
    def _do():
        log = logging.getLogger(__name__)
        tl_base = storage_root / "timelapse"
        if not tl_base.exists():
            return
        count = 0
        for cam_dir in tl_base.iterdir():
            if not cam_dir.is_dir():
                continue
            for mp4 in cam_dir.glob("*.mp4"):
                thumb = mp4.with_suffix(".jpg")
                if thumb.exists():
                    continue
                try:
                    cap = _cv2.VideoCapture(str(mp4))
                    total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                    if total > 0:
                        cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                    ok, frame = cap.read()
                    cap.release()
                    if ok and frame is not None:
                        tw, th = frame.shape[1], frame.shape[0]
                        if tw > 640:
                            scale = 640 / tw
                            frame = _cv2.resize(frame, (640, int(th * scale)))
                        _cv2.imwrite(str(thumb), frame, [int(_cv2.IMWRITE_JPEG_QUALITY), 80])
                        del frame
                        count += 1
                except Exception as e:
                    log.debug("[thumb] failed for %s: %s", mp4.name, e)
                import time as _time; _time.sleep(0.05)  # pace startup
        if count:
            log.info("[startup] Generated %d missing timelapse thumbnails", count)
    threading.Thread(target=_do, daemon=True).start()


_generate_missing_thumbnails()


@app.get('/')
def index():
    return render_template('index.html')


@app.get('/media/<path:subpath>')
def media_file(subpath):
    return send_from_directory(storage_root, subpath)


@app.get('/api/logs')
def api_logs():
    level_name = request.args.get('level', 'DEBUG').upper()
    min_level = getattr(logging, level_name, logging.DEBUG)
    subsystem = (request.args.get('subsystem') or '').strip().lower()
    logs = log_buffer.get(min_level)
    if subsystem:
        logs = [l for l in logs if subsystem in (l.get('logger') or '').lower()]
    return jsonify({"logs": logs})


@app.get('/api/bootstrap')
def api_bootstrap():
    return jsonify(settings.bootstrap_state())


@app.get('/api/config')
def api_config():
    c = get_effective_config()
    return jsonify({
        "app": c.get("app", {}),
        "server": {"public_base_url": c.get("server", {}).get("public_base_url", "")},
        "default_discovery_subnet": c.get("server", {}).get("default_discovery_subnet", "192.168.1.0/24"),
        "cameras": c.get("cameras", []),
        "camera_groups": c.get("camera_groups", []),
        "coral": {
            "mode": c.get("processing", {}).get("detection", {}).get("mode", "none"),
            "bird_species_enabled": bool(c.get("processing", {}).get("bird_species", {}).get("enabled")),
        },
        "telegram": {"enabled": bool(c.get("telegram", {}).get("enabled")), "chat_id": c.get("telegram", {}).get("chat_id", ""), "token": c.get("telegram", {}).get("token", "")},
        "mqtt": {"enabled": bool(c.get("mqtt", {}).get("enabled")), "base_topic": c.get("mqtt", {}).get("base_topic", "tam-spy"), "host": c.get("mqtt", {}).get("host", ""), "port": c.get("mqtt", {}).get("port", 1883), "username": c.get("mqtt", {}).get("username", ""), "password": c.get("mqtt", {}).get("password", "")},
        "storage": {
            "root": str(base_cfg.get("storage", {}).get("root", "/app/storage")),
            "retention_days": settings.data.get("storage", {}).get("retention_days") or base_cfg.get("storage", {}).get("retention_days", 14),
            "media_limit_default": settings.data.get("storage", {}).get("media_limit_default") or base_cfg.get("storage", {}).get("media_limit_default", 24),
            "auto_cleanup_enabled": bool(settings.data.get("storage", {}).get("auto_cleanup_enabled", False)),
        },
    })


@app.get('/api/discover')
def api_discover():
    subnet = request.args.get('subnet') or get_effective_config().get("server", {}).get("default_discovery_subnet", "192.168.1.0/24")
    cameras, total_scanned = discover_hosts(subnet)
    return jsonify({"subnet": subnet, "results": cameras, "total_scanned": total_scanned})


@app.get('/api/cameras')
def api_cameras():
    cams = []
    for cam in get_effective_config().get("cameras", []):
        rt = runtimes.get(cam["id"])
        s = rt.status() if rt else {
            "id": cam["id"], "name": cam.get("name", cam["id"]), "location": cam.get("location", ""), "enabled": cam.get("enabled", True),
            "group_id": cam.get("group_id"), "role": cam.get("role"), "armed": cam.get("armed", True), "status": "disabled", "today_events": 0
        }
        # snap_url / stream_url are dashboard-display-only derived URLs.
        # They MUST use a distinct key so they are never confused with the persisted
        # upstream snapshot_url / rtsp_url (which live in settings.json).
        s["snap_url"] = f"/api/camera/{cam['id']}/snapshot.jpg"
        s["stream_url"] = f"/api/camera/{cam['id']}/stream.mjpg"
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
        s["schedule"] = cam.get("schedule", {"enabled": False, "start": "22:00", "end": "06:00"})
        s["bottom_crop_px"] = cam.get("bottom_crop_px", 0)
        s["motion_sensitivity"] = cam.get("motion_sensitivity", 0.5)
        s["zones"] = cam.get("zones", [])
        s["masks"] = cam.get("masks", [])
        s["resolution"] = cam.get("resolution", "auto")
        s["frame_interval_ms"] = cam.get("frame_interval_ms", 350)
        s["snapshot_interval_s"] = cam.get("snapshot_interval_s", 3)
        s["timelapse"] = cam.get("timelapse", {})
        cams.append(s)
    return jsonify({"cameras": cams})


@app.get('/api/status')
def api_status():
    return jsonify({
        "cameras": [runtimes[c["id"]].status() if c["id"] in runtimes else {"id": c["id"], "status": "disabled", "name": c.get("name", c["id"])} for c in get_effective_config().get("cameras", [])],
        "cat_profiles": cat_registry.list_profiles(),
        "person_profiles": person_registry.list_profiles(),
        "telegram_actions": settings.data.get("telegram_actions", [])[:12],
    })


@app.get('/api/groups')
def api_groups():
    return jsonify({"groups": settings.data.get("camera_groups", [])})


@app.post('/api/groups')
def api_groups_save():
    payload = request.get_json(force=True) or {}
    settings.upsert_group(payload)
    rebuild_runtimes()
    return jsonify({"ok": True, "group": payload})


@app.get('/api/settings/cameras')
def api_settings_cameras():
    return jsonify({"cameras": settings.data.get("cameras", [])})


_CONN_FIELDS = {"rtsp_url", "snapshot_url", "username", "password", "enabled"}


@app.post('/api/settings/cameras')
def api_settings_cameras_save():
    global cfg
    payload = request.get_json(force=True) or {}
    if not payload.get("id"):
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    cam_id = payload["id"]
    old_cfg = settings.get_camera(cam_id) or {}
    # Guard: never persist dashboard-display URLs as the upstream connection fields.
    # These get into the payload when quick-actions spread state.cameras objects.
    for field in ("snapshot_url", "rtsp_url"):
        val = payload.get(field, "")
        if val.startswith("/api/camera/"):
            # Retain the existing persisted value; display-only URLs must not overwrite it.
            preserved = old_cfg.get(field, "")
            payload[field] = preserved
    settings.upsert_camera(payload)
    # Only restart this camera's runtime when connection-relevant fields changed
    conn_changed = any(payload.get(f) != old_cfg.get(f) for f in _CONN_FIELDS)
    enabled_now = payload.get("enabled", True)
    if conn_changed or (cam_id not in runtimes and enabled_now):
        existing = runtimes.pop(cam_id, None)
        if existing:
            existing.stop()
        cfg = get_effective_config()
        if enabled_now:
            rt = CameraRuntime(cam_id, get_camera_cfg, cfg, store, telegram_service, mqtt=mqtt_service, cat_registry=cat_registry, person_registry=person_registry)
            runtimes[cam_id] = rt
            rt.start()
    return jsonify({"ok": True, "camera": settings.get_camera(cam_id), "reloaded": conn_changed})


@app.post('/api/camera/<cam_id>/reload')
def api_camera_reload(cam_id: str):
    global cfg
    # Stop existing runtime for this camera only
    existing = runtimes.pop(cam_id, None)
    if existing:
        existing.stop()
    # Reload config and start fresh runtime for this camera
    cfg = get_effective_config()
    cam_cfg = settings.get_camera(cam_id)
    if cam_cfg and cam_cfg.get("enabled", True):
        rt = CameraRuntime(cam_id, get_camera_cfg, cfg, store, telegram_service, mqtt=mqtt_service, cat_registry=cat_registry, person_registry=person_registry)
        runtimes[cam_id] = rt
        rt.start()
    return jsonify({"ok": True, "cam_id": cam_id})


@app.delete('/api/settings/cameras/<cam_id>')
def api_settings_cameras_delete(cam_id):
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


@app.get('/api/settings/app')
def api_settings_app():
    proc = settings.data.get("processing", {})
    return jsonify({
        "app": settings.data.get("app", {}),
        "server": settings.data.get("server", {}),
        "telegram": settings.data.get("telegram", {}),
        "mqtt": settings.data.get("mqtt", {}),
        "ui": settings.data.get("ui", {}),
        "processing": {
            "coral_enabled": proc.get("detection", {}).get("mode", "none") == "coral",
            "bird_species_enabled": bool(proc.get("bird_species", {}).get("enabled", False)),
        },
    })


@app.post('/api/settings/app')
def api_settings_app_save():
    payload = request.get_json(force=True) or {}
    needs_rebuild = False
    for sec in ("app", "server", "telegram", "ui", "storage"):
        if sec in payload:
            settings.update_section(sec, payload.get(sec) or {})
    if "mqtt" in payload:
        settings.update_section("mqtt", payload.get("mqtt") or {})
        needs_rebuild = True
    if "processing" in payload:
        proc = payload["processing"]
        settings.update_section("processing", {
            "detection": {"mode": "coral" if proc.get("coral_enabled") else "none"},
            "bird_species": {"enabled": bool(proc.get("bird_species_enabled"))},
        })
        needs_rebuild = True
    if needs_rebuild:
        rebuild_runtimes()
    return jsonify({"ok": True, "saved": True})


@app.get('/api/settings/export')
def api_settings_export():
    fmt = request.args.get('format', 'json')
    text = settings.export_text(fmt)
    mimetype = 'application/x-yaml' if fmt == 'yaml' else 'application/json'
    return Response(text, mimetype=mimetype, headers={"Content-Disposition": f"attachment; filename=tam-spy-settings.{fmt}"})


@app.post('/api/settings/import')
def api_settings_import():
    payload = request.get_json(force=True) or {}
    fmt = payload.get('format', 'json')
    content = payload.get('content', '')
    try:
        settings.import_text(content, fmt)
        rebuild_runtimes()
        return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post('/api/wizard/complete')
def api_wizard_complete():
    payload = request.get_json(force=True) or {}
    if payload.get("app"):
        settings.update_section("app", payload["app"])
    if payload.get("server"):
        settings.update_section("server", payload["server"])
    if payload.get("telegram"):
        settings.update_section("telegram", payload["telegram"])
    if payload.get("mqtt"):
        settings.update_section("mqtt", payload["mqtt"])
    for group in payload.get("camera_groups", []) or []:
        settings.upsert_group(group)
    for cam in payload.get("cameras", []) or []:
        if cam.get("id"):
            settings.upsert_camera(cam)
    settings.update_section("ui", {"wizard_completed": True})
    rebuild_runtimes()
    return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})


@app.get('/api/media/storage-stats')
def api_media_storage_stats():
    result = []
    events_dir = storage_root / "events"
    for cam in get_effective_config().get("cameras", []):
        cam_dir = events_dir / cam["id"]
        size_bytes = 0
        jpg_count = 0
        json_count = 0
        if cam_dir.exists():
            for pattern in ("*.jpg", "*.jpeg", "*.mp4"):
                for p in cam_dir.rglob(pattern):
                    try:
                        size_bytes += p.stat().st_size
                        if pattern != "*.mp4":
                            jpg_count += 1
                    except Exception:
                        pass
            json_count = len(list(cam_dir.rglob("*.json")))
        # Find latest stored snapshot for thumbnail fallback
        latest_snap_url = None
        if cam_dir.exists():
            import json as _json
            for jf in sorted(cam_dir.rglob("*.json"), reverse=True):
                try:
                    ev = _json.loads(jf.read_text(encoding="utf-8"))
                    rel = ev.get("snapshot_relpath")
                    if rel and (storage_root / rel).exists():
                        latest_snap_url = f"/media/{rel}"
                        break
                except Exception:
                    continue
        result.append({
            "id": cam["id"],
            "name": cam.get("name", cam["id"]),
            "size_mb": round(size_bytes / 1024 / 1024, 1),
            "jpg_count": jpg_count,
            "event_count": json_count,
            "latest_snap_url": latest_snap_url,
        })
    return jsonify({"cameras": result})


@app.post('/api/media/rescan')
def api_media_rescan():
    effective = get_effective_config()
    cam_ids = [c["id"] for c in effective.get("cameras", [])]
    logging.getLogger(__name__).info("[MediaRescan] scanning cam_ids: %s", cam_ids)
    public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
    try:
        count = store.scan_media_files(cam_ids, public_base_url=public_base)
        return jsonify({"ok": True, "registered": count})
    except Exception as e:
        import traceback
        return jsonify({"ok": False, "error": traceback.format_exc()}), 500


@app.post('/api/media/purge-orphans')
def api_media_purge_orphans():
    try:
        removed = store.purge_orphans()
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post('/api/media/cleanup')
def api_media_cleanup():
    payload = request.get_json(force=True) or {}
    storage_sec = settings.data.get("storage", {})
    retention = int(payload.get("retention_days") or storage_sec.get("retention_days") or base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = store.cleanup_old(retention)
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post('/api/reload')
def api_reload():
    rebuild_runtimes()
    return jsonify({"ok": True})


@app.get('/api/cats')
def api_cats():
    return jsonify({"profiles": cat_registry.list_profiles()})


@app.get('/api/persons')
def api_persons():
    return jsonify({"profiles": person_registry.list_profiles()})


def _register_identity(registry: IdentityRegistry, cam_id: str, identity_type: str):
    payload = request.get_json(force=True, silent=True) or {}
    event_id = payload.get("event_id")
    name = (payload.get("name") or "").strip()
    whitelisted = bool(payload.get("whitelisted", False))
    notes = payload.get("notes", "")
    if not event_id or not name:
        return jsonify({"ok": False, "error": "event_id und name erforderlich"}), 400
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    snap_rel = event.get("snapshot_relpath")
    snap_path = storage_root / snap_rel if snap_rel else None
    if not snap_path or not snap_path.exists():
        return jsonify({"ok": False, "error": "Snapshot-Datei fehlt"}), 404
    img = cv2.imread(str(snap_path))
    if img is None:
        return jsonify({"ok": False, "error": "Snapshot nicht lesbar"}), 400
    det = next((d for d in event.get("detections", []) if d.get("label") == identity_type), None)
    if not det:
        return jsonify({"ok": False, "error": f"Kein {identity_type} in diesem Event"}), 400
    b = det.get("bbox") or {}
    crop = img[max(0, int(b.get("y1", 0))):max(0, int(b.get("y2", 0))), max(0, int(b.get("x1", 0))):max(0, int(b.get("x2", 0)))]
    if crop.size == 0:
        return jsonify({"ok": False, "error": "Crop leer"}), 400
    ok = registry.register_crop(name, crop, whitelisted=whitelisted, notes=notes)
    if ok:
        if identity_type == "cat":
            event["cat_name"] = name
        else:
            event["person_name"] = name
            event["whitelisted"] = whitelisted
        store.update_event(cam_id, event_id, event)
    return jsonify({"ok": bool(ok), "profiles": registry.list_profiles()})


@app.post('/api/camera/<cam_id>/cats/register')
def api_cat_register(cam_id):
    return _register_identity(cat_registry, cam_id, "cat")


@app.post('/api/camera/<cam_id>/persons/register')
def api_person_register(cam_id):
    return _register_identity(person_registry, cam_id, "person")


@app.post('/api/persons/<name>/flags')
def api_person_flags(name):
    payload = request.get_json(force=True, silent=True) or {}
    ok = person_registry.set_profile_flags(name, whitelisted=payload.get("whitelisted"), notes=payload.get("notes"))
    return jsonify({"ok": ok, "profiles": person_registry.list_profiles()})


@app.get('/api/camera/<cam_id>/status')
def api_camera_status(cam_id):
    rt = runtimes.get(cam_id)
    if not rt:
        return jsonify({"ok": False, "error": "camera not running"}), 404
    s = rt.status()
    s["snap_url"] = f"/api/camera/{cam_id}/snapshot.jpg"
    s["stream_url"] = f"/api/camera/{cam_id}/stream.mjpg"
    return jsonify(s)


@app.get('/api/camera/<cam_id>/snapshot.jpg')
def api_camera_snapshot(cam_id):
    rt = runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    data = rt.snapshot_jpeg()
    if not data:
        return ("no frame", 503)
    return Response(data, mimetype='image/jpeg', headers={'Cache-Control': 'no-store'})


@app.get('/api/camera/<cam_id>/stream.mjpg')
def api_camera_stream(cam_id):
    rt = runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    def gen():
        import time as _time
        _interval = 1.0 / 25  # 25 fps cap — avoids busy-spin against shared frame buffer
        while True:
            t0 = _time.monotonic()
            data = rt.snapshot_jpeg(quality=82)
            if data:
                yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n')
            gap = _interval - (_time.monotonic() - t0)
            if gap > 0:
                _time.sleep(gap)
    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.post('/api/camera/<cam_id>/arm')
def api_camera_arm(cam_id):
    payload = request.get_json(force=True, silent=True) or {}
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    cam["armed"] = bool(payload.get("armed", True))
    settings.upsert_camera(cam)
    mqtt_service.publish(f"camera/{cam_id}/armed", {"armed": cam["armed"]}, retain=True)
    return jsonify({"ok": True, "camera": cam})


@app.get('/api/camera/<cam_id>/media')
def api_camera_media(cam_id):
    label = request.args.get('label')
    start = request.args.get('start')
    end = request.args.get('end')
    limit = int(request.args.get('limit') or get_effective_config().get("storage", {}).get("media_limit_default", 24))
    offset = int(request.args.get('offset') or 0)
    items = store.list_events(cam_id, label=label, start=start, end=end, limit=limit, offset=offset)
    total_count = store.count_events(cam_id, label=label, start=start, end=end)
    for item in items:
        review = settings.get_review(f"{cam_id}:{item['event_id']}")
        if review:
            item["review"] = review
    return jsonify({"items": items, "total_count": total_count})


@app.delete('/api/camera/<cam_id>/events/<event_id>')
def api_event_delete(cam_id, event_id):
    result = store.delete_event(cam_id, event_id)
    if not result["json_deleted"]:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    return jsonify({"ok": True, **result})


@app.post('/api/camera/<cam_id>/events/<event_id>/confirm')
def api_event_confirm(cam_id, event_id):
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["confirmed"] = True
    event["confirmed_at"] = datetime.now().isoformat(timespec="seconds")
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True})


@app.post('/api/camera/<cam_id>/events/<event_id>/labels')
def api_event_labels(cam_id, event_id):
    payload = request.get_json(force=True, silent=True) or {}
    labels = payload.get("labels", [])
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["labels"] = labels
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True, "labels": labels})


@app.post('/api/camera/<cam_id>/review/<event_id>')
def api_camera_review(cam_id, event_id):
    payload = request.get_json(force=True, silent=True) or {}
    settings.set_review(f"{cam_id}:{event_id}", payload)
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/stats_range')
def api_camera_stats(cam_id):
    label = request.args.get('label')
    start = request.args.get('start')
    end = request.args.get('end')
    return jsonify(store.stats_range(cam_id, label=label, start=start, end=end))


@app.get('/api/timeline')
def api_timeline():
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
        ev = store.list_events(cid, label=label, start=start, limit=2000)
        pts = []
        for e in reversed(ev):
            pts.append({
                "event_id": e["event_id"],
                "time": e["time"],
                "labels": e.get("labels", []),
                "top_label": e.get("top_label"),
                "alarm_level": e.get("alarm_level", "info"),
                "snapshot_url": e.get("snapshot_url"),
                "y": idx,
            })
            merged.append({"camera_id": cid, **pts[-1]})
        tracks.append({"camera_id": cid, "points": pts})
    merged.sort(key=lambda x: x["time"])
    return jsonify({"period": period, "start": start, "tracks": tracks, "merged": merged})


@app.get('/api/telegram/actions')
def api_telegram_actions():
    return jsonify({"items": settings.data.get("telegram_actions", [])[:40]})


@app.post('/api/telegram/test')
def api_telegram_test():
    import asyncio as _asyncio
    tg_cfg = settings.export_effective_config(base_cfg).get("telegram", {})
    logging.getLogger(__name__).info("[Telegram] Test: enabled=%s token_set=%s chat_id=%s",
        tg_cfg.get("enabled"), bool(tg_cfg.get("token")), tg_cfg.get("chat_id"))
    if not telegram_service or not telegram_service.enabled:
        reasons = []
        if not tg_cfg.get("enabled"): reasons.append("Telegram nicht aktiviert")
        if not tg_cfg.get("token"): reasons.append("Token fehlt")
        if not tg_cfg.get("chat_id"): reasons.append("Chat-ID fehlt")
        return jsonify({"ok": False, "error": " · ".join(reasons) or "Telegram nicht konfiguriert"}), 400
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    msg = f"TAM-spy Test ✓ Verbindung funktioniert! {ts}"
    try:
        _asyncio.run(telegram_service.send_alert(caption=msg))
        return jsonify({"ok": True, "message": msg})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get('/api/timelapse/status')
def api_timelapse_status():
    from .camera_runtime import _PROFILES, _PROFILE_PERIOD_DEFAULTS
    today = datetime.now().strftime("%Y-%m-%d")
    tl_settings = settings.data.get("timelapse_settings", {})
    global_enabled = bool(tl_settings.get("global_enabled", False))
    cameras_out = []
    for cam in settings.data.get("cameras", []):
        cam_id = cam["id"]
        tl = cam.get("timelapse") or {}
        profiles = tl.get("profiles") or {}
        fps = int(tl.get("fps", 30))
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
            interval_s = max(2, round(period_s / max(1, target_s * fps)))
            prof_status[pname] = {
                "enabled": enabled,
                "frame_count": fc,
                "interval_s": interval_s,
            }
        cameras_out.append({
            "camera_id": cam_id,
            "name": cam.get("name", cam_id),
            "any_active": any_active,
            "profiles": prof_status,
        })
    total_active = sum(1 for c in cameras_out if c["any_active"])
    return jsonify({
        "ok": True,
        "global_enabled": global_enabled,
        "active_count": total_active,
        "cameras": cameras_out,
        "today": today,
    })


@app.post('/api/settings/timelapse')
def api_settings_timelapse_save():
    payload = request.get_json(force=True) or {}
    ts = settings.data.setdefault("timelapse_settings", {})
    if "global_enabled" in payload:
        ts["global_enabled"] = bool(payload["global_enabled"])
    settings.save()
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/timelapse')
def api_camera_timelapse(cam_id):
    cam_cfg = settings.get_camera(cam_id)
    if not cam_cfg:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    tl_cfg = cam_cfg.get("timelapse") or {}
    if not tl_cfg.get("enabled", False):
        return jsonify({"ok": False, "error": "timelapse disabled"}), 400
    day = request.args.get("day") or datetime.now().strftime("%Y-%m-%d")
    force = request.args.get("force") == "1"
    target_s = int(tl_cfg.get("daily_target_seconds", 60))
    target_fps = int(tl_cfg.get("fps", 30))
    period = tl_cfg.get("period", "day")
    path = timelapse_builder.build_period(
        cam_id, day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=period,
        force=force
    )
    if not path:
        frames_dir = storage_root / "timelapse_frames" / cam_id / day
        day_dir = store.events_dir / cam_id / day
        has_frames = (frames_dir.exists() and any(frames_dir.glob("*.jpg"))) or \
                     (day_dir.exists() and any(day_dir.rglob("*.jpg")))
        if not has_frames:
            return jsonify({"ok": False, "error": "no_frames", "day": day}), 404
        import threading as _thr
        def _bg_build():
            timelapse_builder.build_period(cam_id, day, target_duration_s=target_s,
                                           target_fps=target_fps, period=period, force=True)
        _thr.Thread(target=_bg_build, daemon=True).start()
        return jsonify({"ok": False, "error": "building", "day": day, "retry_after": 15}), 202
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "day": day, "url": f"/media/{rel.as_posix()}"})


@app.get('/api/camera/<cam_id>/timelapse/list')
def api_camera_timelapse_list(cam_id):
    import json as _json
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
        thumb_url = f"/media/{(thumb.relative_to(storage_root)).as_posix()}" if thumb.exists() else None
        files.append({
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
        })
    return jsonify({"ok": True, "files": files})


@app.delete('/api/camera/<cam_id>/timelapse/<filename>')
def api_camera_timelapse_delete(cam_id, filename):
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
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/timelapse/rolling')
def api_camera_timelapse_rolling(cam_id):
    minutes = int(request.args.get("minutes", 10))
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
    images = sorted([
        p for p in frames_dir.glob("*.jpg")
        if p.stat().st_mtime >= cutoff.timestamp()
    ])
    if len(images) < 2:
        return jsonify({"ok": False, "error": "not_enough_frames", "minutes": minutes}), 404
    target_fps = int(tl_cfg.get("fps", 30))
    target_s = max(5, int(tl_cfg.get("daily_target_seconds", 60)) // 10)
    path = timelapse_builder.build_period(
        cam_id, day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=f"rolling{minutes}min",
        force=True,
        images_override=images
    )
    if not path:
        return jsonify({"ok": False, "error": "build_failed"}), 500
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "minutes": minutes, "url": f"/media/{rel.as_posix()}"})


# ── Achievements / Trophäen ──────────────────────────────────────────────────
import json as _json_mod
import threading as _threading_mod

_ach_lock = _threading_mod.Lock()
_ach_path = storage_root / "achievements.json"

def _load_achievements() -> dict:
    try:
        if _ach_path.exists():
            return _json_mod.loads(_ach_path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def _save_achievements(data: dict):
    try:
        _ach_path.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logging.getLogger(__name__).warning("achievements save: %s", e)

@app.get('/api/achievements')
def api_achievements_get():
    with _ach_lock:
        return jsonify({"achievements": _load_achievements()})

@app.post('/api/achievements/unlock')
def api_achievements_unlock():
    payload = request.get_json(force=True, silent=True) or {}
    species_id = (payload.get("id") or "").strip().lower()
    if not species_id:
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    with _ach_lock:
        data = _load_achievements()
        already = species_id in data
        if not already:
            data[species_id] = {
                "date": datetime.now().isoformat(timespec="seconds"),
                "camera_id": payload.get("camera_id", ""),
                "species": payload.get("species", species_id),
                "count": 1,
            }
        else:
            data[species_id]["count"] = data[species_id].get("count", 1) + 1
        _save_achievements(data)
    return jsonify({"ok": True, "already_had": already, "achievements": data})


# ── System info ──────────────────────────────────────────────────────────────
@app.get('/api/system')
def api_system():
    import time as _time
    mem_total = mem_used = proc_mem_mb = uptime_s = 0.0
    try:
        mem: dict = {}
        with open('/proc/meminfo') as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    mem[parts[0].rstrip(':')] = int(parts[1]) * 1024
        mem_total = mem.get('MemTotal', 0)
        mem_available = mem.get('MemAvailable', 0)
        mem_used = mem_total - mem_available
    except Exception:
        pass
    try:
        with open('/proc/uptime') as f:
            uptime_s = float(f.read().split()[0])
    except Exception:
        pass
    try:
        import resource as _resource
        ru = _resource.getrusage(_resource.RUSAGE_SELF)
        proc_mem_mb = round(ru.ru_maxrss / 1024, 1)  # KB → MB on Linux
    except Exception:
        pass
    coral_device = None
    try:
        import subprocess as _sp
        lsusb = _sp.check_output(['lsusb'], text=True, timeout=3, stderr=_sp.DEVNULL)
        for line in lsusb.splitlines():
            if 'Google' in line or 'Coral' in line or '18d1' in line.lower():
                coral_device = line.strip()
                break
    except Exception:
        pass
    return jsonify({
        "build": _BUILD_INFO,
        "mem_total_mb": round(mem_total / 1048576, 1),
        "mem_used_mb": round(mem_used / 1048576, 1),
        "proc_mem_mb": proc_mem_mb,
        "uptime_s": uptime_s,
        "storage_root": str(storage_root),
        "camera_count": len(runtimes),
        "coral_device": coral_device,
    })


if __name__ == '__main__':
    app.run(host=cfg.get('server', {}).get('host', '0.0.0.0'), port=int(cfg.get('server', {}).get('port', 8099)), threaded=True)

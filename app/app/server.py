
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

base_cfg = load_config()
storage_root = Path(base_cfg["storage"]["root"])
web_root = Path(__file__).resolve().parent.parent / "web"
app = Flask(__name__, template_folder=str(web_root / "templates"), static_folder=str(web_root / "static"))
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
    return jsonify({"logs": log_buffer.get(min_level)})


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
        s["snapshot_url"] = f"/api/camera/{cam['id']}/snapshot.jpg"
        s["stream_url"] = f"/api/camera/{cam['id']}/stream.mjpg"
        s["zones"] = cam.get("zones", [])
        s["masks"] = cam.get("masks", [])
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


@app.post('/api/settings/cameras')
def api_settings_cameras_save():
    payload = request.get_json(force=True) or {}
    if not payload.get("id"):
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    settings.upsert_camera(payload)
    rebuild_runtimes()
    return jsonify({"ok": True, "camera": settings.get_camera(payload["id"])})


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
    for sec in ("app", "server", "telegram", "mqtt", "ui", "storage"):
        if sec in payload:
            settings.update_section(sec, payload.get(sec) or {})
    if "processing" in payload:
        proc = payload["processing"]
        settings.update_section("processing", {
            "detection": {"mode": "coral" if proc.get("coral_enabled") else "none"},
            "bird_species": {"enabled": bool(proc.get("bird_species_enabled"))},
        })
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
        result.append({
            "id": cam["id"],
            "name": cam.get("name", cam["id"]),
            "size_mb": round(size_bytes / 1024 / 1024, 1),
            "jpg_count": jpg_count,
            "event_count": json_count,
        })
    return jsonify({"cameras": result})


@app.post('/api/media/rescan')
def api_media_rescan():
    effective = get_effective_config()
    cam_ids = [c["id"] for c in effective.get("cameras", [])]
    public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
    try:
        count = store.scan_media_files(cam_ids, public_base_url=public_base)
        return jsonify({"ok": True, "registered": count})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


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
    s["snapshot_url"] = f"/api/camera/{cam_id}/snapshot.jpg"
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
        while True:
            data = rt.snapshot_jpeg(quality=82)
            if data:
                yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n')
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
    for item in items:
        review = settings.get_review(f"{cam_id}:{item['event_id']}")
        if review:
            item["review"] = review
    return jsonify({"items": items})


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
    period = request.args.get('period', 'week')
    label = request.args.get('label')
    cam_id = request.args.get('camera')
    now = datetime.now()
    if period == 'day':
        start = (now - timedelta(days=1)).isoformat(timespec='seconds')
    elif period == 'month':
        start = (now - timedelta(days=30)).isoformat(timespec='seconds')
    else:
        start = (now - timedelta(days=7)).isoformat(timespec='seconds')
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
    path = timelapse_builder.build_for_day(cam_id, day, fps=int(tl_cfg.get("fps", 12)), force=force)
    if not path:
        return jsonify({"ok": False, "error": "no timelapse data", "day": day}), 404
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "day": day, "url": f"/media/{rel.as_posix()}"})


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
            }
            _save_achievements(data)
    return jsonify({"ok": True, "already_had": already, "achievements": data})


if __name__ == '__main__':
    app.run(host=cfg.get('server', {}).get('host', '0.0.0.0'), port=int(cfg.get('server', {}).get('port', 8099)), threaded=True)

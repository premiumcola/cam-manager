"""Bootstrap, config, system, discover, wizard, and import/export.

Migrated from server.py during R01.3. Verbatim route bodies; state
references rewritten to flow through `app_state`. The wizard endpoint
calls `_auto_detect_device_info` from `_camera_helpers` because both
this blueprint and the cameras blueprint touch the same auto-detect
flow.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory

from .. import app_state
from ..discovery import discover_hosts
from ._camera_helpers import _auto_detect_device_info

bp = Blueprint("bootstrap", __name__)


def _auto_detect_subnet() -> str:
    """Best-effort detection of the LAN's /24 — fallback to a
    well-known RFC-1918 subnet when the socket trick fails (e.g.
    inside a network-isolated container)."""
    import ipaddress
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return str(ipaddress.IPv4Network(f"{ip}/24", strict=False))
    except Exception:
        return "192.168.1.0/24"


@bp.get('/')
def index():
    return render_template('index.html')


@bp.get('/media/<path:subpath>')
def media_file(subpath):
    return send_from_directory(app_state.storage_root, subpath)


@bp.get('/sw.js')
def service_worker():
    """Serve the service worker from the app root so its scope covers
    the entire site. max_age=0 stops the browser from caching the SW
    itself — otherwise updates land 24h late."""
    web_static = Path(__file__).resolve().parents[2] / "web" / "static"
    return send_from_directory(
        str(web_static), "sw.js",
        mimetype="application/javascript", max_age=0,
    )


@bp.get('/api/bootstrap')
def api_bootstrap():
    return jsonify(app_state.settings.bootstrap_state())


@bp.get('/api/config')
def api_config():
    settings = app_state.settings
    base_cfg = app_state.base_cfg
    c = app_state.get_effective_config()
    proc = c.get("processing", {}) or {}
    bird_cfg = proc.get("bird_species", {}) or {}
    bird_model_path = bird_cfg.get("model_path")
    bird_cpu_path = bird_cfg.get("cpu_model_path")
    bird_labels_path = bird_cfg.get("labels_path")
    bird_model_available = any(p and Path(p).exists() for p in (bird_model_path, bird_cpu_path))
    # Wildlife block — must mirror the four fields surfaced by
    # /api/settings/app, otherwise hydrateAppSettings reads
    # proc.wildlife_enabled as undefined → false and flips the toggle
    # back ~2 s after the user enables it (loadAll re-fetches /api/config
    # after the POST). Same auto-discover fallback as /api/settings/app
    # so both endpoints stay in sync on a fresh install where the user
    # hasn't pinned a model_path yet.
    wl_cfg = proc.get("wildlife", {}) or {}
    wl_model_path = wl_cfg.get("model_path")
    wl_cpu_path   = wl_cfg.get("cpu_model_path")
    wl_labels_path = wl_cfg.get("labels_path")
    wl_model_available = any(p and Path(p).exists() for p in (wl_model_path, wl_cpu_path))
    wl_labels_available = bool(wl_labels_path and Path(wl_labels_path).exists())
    if not wl_model_available:
        from ..detectors import discover_wildlife_paths
        disc = discover_wildlife_paths()
        if disc:
            wl_model_path = disc.get("model_path") or wl_model_path
            wl_model_available = True
            if not wl_labels_available and disc.get("labels_path"):
                wl_labels_path = disc["labels_path"]
                wl_labels_available = True
    srv = c.get("server", {}) or {}
    return jsonify({
        "app": c.get("app", {}),
        "server": {
            "public_base_url": srv.get("public_base_url", ""),
            # Standortdaten — von der Wetter-UI gelesen, vom Wetter-Service
            # für Sonnenstand-Berechnung genutzt.
            "location": srv.get("location") or {"lat": None, "lon": None, "elevation": None},
        },
        "default_discovery_subnet": srv.get("default_discovery_subnet", "192.168.1.0/24"),
        "cameras": c.get("cameras", []),
        "weather": c.get("weather") or {},
        "coral": {
            "mode": proc.get("detection", {}).get("mode", "none"),
            "bird_species_enabled": bool(bird_cfg.get("enabled")),
        },
        "processing": {
            "detection": proc.get("detection", {}),
            "bird_species_enabled": bool(bird_cfg.get("enabled")),
            "bird_model_available": bird_model_available,
            "bird_labels_available": bool(bird_labels_path and Path(bird_labels_path).exists()),
            "bird_model_path": bird_model_path,
            "wildlife_enabled": bool(wl_cfg.get("enabled", False)),
            "wildlife_model_available": wl_model_available,
            "wildlife_labels_available": wl_labels_available,
            "wildlife_model_path": wl_model_path,
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


@bp.get('/api/discover')
def api_discover():
    configured = app_state.get_effective_config().get("server", {}).get("default_discovery_subnet", "")
    subnet = request.args.get('subnet') or configured or _auto_detect_subnet()
    logging.info(f"[discovery] starting scan on subnet={subnet}")
    cameras, total_scanned = discover_hosts(subnet)
    logging.info(f"[discovery] scan done — {len(cameras)} cameras found out of {total_scanned} hosts")
    return jsonify({"subnet": subnet, "results": cameras, "total_scanned": total_scanned})


@bp.get('/api/status')
def api_status():
    settings = app_state.settings
    runtimes = app_state.runtimes
    return jsonify({
        "cameras": [runtimes[c["id"]].status() if c["id"] in runtimes else {"id": c["id"], "status": "disabled", "name": c.get("name", c["id"])} for c in app_state.get_effective_config().get("cameras", [])],
        "cat_profiles": app_state.cat_registry.list_profiles(),
        "person_profiles": app_state.person_registry.list_profiles(),
        "telegram_actions": settings.data.get("telegram_actions", [])[:12],
    })


@bp.get('/api/system')
def api_system():
    # Lazy import — server.py owns the build-info constants until R01.6
    # finishes the cleanup pass. Imported per request so any future
    # rebind on server.py side is observable here.
    from ..server import _BUILD_INFO, _PROCESS_START_ISO
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
        "process_start": _PROCESS_START_ISO,
        "mem_total_mb": round(mem_total / 1048576, 1),
        "mem_used_mb": round(mem_used / 1048576, 1),
        "proc_mem_mb": proc_mem_mb,
        "uptime_s": uptime_s,
        "storage_root": str(app_state.storage_root),
        "camera_count": len(app_state.runtimes),
        "coral_device": coral_device,
    })


@bp.post('/api/wizard/complete')
def api_wizard_complete():
    from ..server import rebuild_runtimes
    settings = app_state.settings
    payload = request.get_json(force=True) or {}
    try:
        if payload.get("app"):
            settings.update_section("app", payload["app"])
        if payload.get("server"):
            settings.update_section("server", payload["server"])
        if payload.get("telegram"):
            settings.update_section("telegram", payload["telegram"])
        if payload.get("mqtt"):
            settings.update_section("mqtt", payload["mqtt"])
        for cam in payload.get("cameras", []) or []:
            if cam.get("id"):
                # Auto-detect manuf/model on first save too — wizard
                # users typically enter creds but skip the optional
                # Reolink/RLC fields. Mutates cam in place; ignored
                # silently on non-Reolink or no-response.
                _auto_detect_device_info(cam)
                settings.upsert_camera(cam)
        settings.update_section("ui", {"wizard_completed": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    rebuild_runtimes()
    return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})


@bp.get('/api/settings/export')
def api_settings_export():
    fmt = request.args.get('format', 'json')
    text = app_state.settings.export_text(fmt)
    mimetype = 'application/x-yaml' if fmt == 'yaml' else 'application/json'
    return Response(text, mimetype=mimetype, headers={"Content-Disposition": f"attachment; filename=tam-spy-settings.{fmt}"})


@bp.post('/api/settings/import')
def api_settings_import():
    from ..server import rebuild_runtimes
    settings = app_state.settings
    payload = request.get_json(force=True) or {}
    fmt = payload.get('format', 'json')
    content = payload.get('content', '')
    try:
        settings.import_text(content, fmt)
        rebuild_runtimes()
        return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

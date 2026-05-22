"""Bootstrap, config, system, discover, wizard, and import/export.

Migrated from server.py during R01.3. Verbatim route bodies; state
references rewritten to flow through `app_state`. The wizard endpoint
calls `_auto_detect_device_info` from `_camera_helpers` because both
this blueprint and the cameras blueprint touch the same auto-detect
flow.
"""

from __future__ import annotations

import logging
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, send_from_directory

from .. import app_state
from ..discovery import discover_hosts, discover_hosts_stream
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
        str(web_static),
        "sw.js",
        mimetype="application/javascript",
        max_age=0,
    )


@bp.get('/version.json')
def app_version():
    """Tiny shell-version endpoint consumed by the service worker on
    install. We hash the compiled app.css — its content already shifts
    on every commit that touches a CSS partial (css_builder.py
    concatenates them) so it's a faithful proxy for the entire
    front-end shell. The SW uses this value to derive its cache
    name; bumping the hash invalidates the PWA shell cache without
    the user having to re-add the app from their home screen."""
    # _file_hash lives on the jinja env — pull it through the
    # current Flask app so this stays in lock-step with the
    # ?v= cache-bust query the templates already use.
    from flask import current_app

    hasher = current_app.jinja_env.globals.get("static_v")
    shell_hash = hasher("app.css") if callable(hasher) else "v1"
    return jsonify({"shell_hash": shell_hash})


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
    wl_cpu_path = wl_cfg.get("cpu_model_path")
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
    return jsonify(
        {
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
            "telegram": {
                "enabled": bool(c.get("telegram", {}).get("enabled")),
                "chat_id": c.get("telegram", {}).get("chat_id", ""),
                "token": c.get("telegram", {}).get("token", ""),
            },
            "mqtt": {
                "enabled": bool(c.get("mqtt", {}).get("enabled")),
                "base_topic": c.get("mqtt", {}).get("base_topic", "tam-spy"),
                "host": c.get("mqtt", {}).get("host", ""),
                "port": c.get("mqtt", {}).get("port", 1883),
                "username": c.get("mqtt", {}).get("username", ""),
                "password": c.get("mqtt", {}).get("password", ""),
            },
            "storage": {
                "root": str(base_cfg.get("storage", {}).get("root", "/app/storage")),
                "retention_days": settings.data.get("storage", {}).get("retention_days")
                or base_cfg.get("storage", {}).get("retention_days", 14),
                "media_limit_default": settings.data.get("storage", {}).get("media_limit_default")
                or base_cfg.get("storage", {}).get("media_limit_default", 24),
                "auto_cleanup_enabled": bool(
                    settings.data.get("storage", {}).get("auto_cleanup_enabled", False)
                ),
            },
        }
    )


@bp.get('/api/discover')
def api_discover():
    configured = (
        app_state.get_effective_config().get("server", {}).get("default_discovery_subnet", "")
    )
    subnet = request.args.get('subnet') or configured or _auto_detect_subnet()
    logging.info(f"[discovery] starting scan on subnet={subnet}")
    cameras, total_scanned = discover_hosts(subnet)
    logging.info(
        f"[discovery] scan done — {len(cameras)} cameras found out of {total_scanned} hosts"
    )
    return jsonify({"subnet": subnet, "results": cameras, "total_scanned": total_scanned})


@bp.get('/api/discover/stream')
def api_discover_stream():
    """Server-Sent Events variant of /api/discover. Streams progress
    events while the two-phase scan runs; ends with a `done` event
    that carries the same payload the sync endpoint returns.

    Event types:
      • phase        — {phase, subnet, total_hosts}
      • progress     — {scanned, total, current_ip}     (~5/s)
      • phase1_hit   — {ip, ports}
      • phase2_check — {ip, action}                     ("banner_fetch"|"vendor_guess")
      • candidate    — {ip, hostname, guess, open_ports}
      • done         — {subnet, total_scanned, found, results}
      • error        — {message}
    """
    import json as _json

    configured = (
        app_state.get_effective_config().get("server", {}).get("default_discovery_subnet", "")
    )
    subnet = request.args.get('subnet') or configured or _auto_detect_subnet()
    logging.info(f"[discovery] starting SSE scan on subnet={subnet}")

    def _gen():
        # Initial keep-alive comment so EventSource fires `open` even
        # before the first phase event lands.
        yield ": ready\n\n"
        try:
            for kind, payload in discover_hosts_stream(subnet):
                yield f"event: {kind}\ndata: {_json.dumps(payload)}\n\n"
                if kind == "done":
                    res = payload.get("results", [])
                    logging.info(
                        "[discovery] SSE scan done — %d cameras found out of %d hosts",
                        len(res),
                        payload.get("total_scanned", 0),
                    )
        except GeneratorExit:
            # Client disconnected mid-scan — silent.
            return
        except Exception as exc:
            logging.exception("[discovery] SSE scan failed")
            yield f"event: error\ndata: {_json.dumps({'message': str(exc)})}\n\n"

    return Response(
        _gen(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",  # disable nginx/proxy buffering if any
            "Connection": "keep-alive",
        },
    )


def _mask_pw(pw: str) -> str:
    """Return ``***`` for any password, or ``∅`` for empty — used in
    [discovery] log lines so the audit grep stays clean."""
    if not pw:
        return "∅"
    return "***"


def _probe_reolink_login(host: str, user: str, password: str, timeout: float = 4.0) -> dict:
    """Distinguish auth-fail from network-fail in a single Reolink Login
    request. Returns one of:
      {"vendor": "reolink", "auth": "ok"}
      {"vendor": "reolink", "auth": "bad"}    — HTTP 200 + ``code != 0``
      {"vendor": "reolink", "auth": "net"}    — connect/HTTP/parse error
    The shipped ``reolink_api.login`` only signals success/None and was
    designed for the day-night override path, where any non-success is
    treated identically.  The discovery probe needs to tell the user
    *why* the login didn't work, so we issue the request directly.
    """
    import requests

    body = [
        {
            "cmd": "Login",
            "action": 0,
            "param": {"User": {"userName": user, "password": password or ""}},
        }
    ]
    try:
        r = requests.post(
            f"http://{host}/api.cgi",
            params={"cmd": "Login"},
            json=body,
            timeout=timeout,
        )
    except Exception as exc:
        logging.info(
            "[discovery] reolink login net-error host=%s user=%s pw=%s: %s",
            host,
            user,
            _mask_pw(password),
            exc,
        )
        return {"vendor": "reolink", "auth": "net"}
    if r.status_code != 200:
        logging.info(
            "[discovery] reolink login HTTP %s host=%s user=%s pw=%s",
            r.status_code,
            host,
            user,
            _mask_pw(password),
        )
        return {"vendor": "reolink", "auth": "net"}
    try:
        payload = r.json()
        first = payload[0] if isinstance(payload, list) and payload else {}
    except Exception as exc:
        logging.info("[discovery] reolink login parse host=%s: %s", host, exc)
        return {"vendor": "reolink", "auth": "net"}
    # Success shape: first.value.Token.name is set.
    token = ((first.get("value") or {}).get("Token") or {}).get("name")
    if token:
        # Best-effort logout — never let it raise.
        try:
            from ..reolink_api import logout as _rl_logout

            _rl_logout(host, token, timeout=2.0)
        except Exception:
            pass
        return {"vendor": "reolink", "auth": "ok"}
    # Reolink returns code != 0 with an error.detail string on bad creds —
    # rspCode -7 / -6 specifically. Any non-success code on a 200 here
    # means the request reached the camera, which means the network is
    # fine — the credentials are the problem.
    if isinstance(first, dict) and "error" in first:
        return {"vendor": "reolink", "auth": "bad"}
    code = first.get("code")
    if isinstance(code, int) and code != 0:
        return {"vendor": "reolink", "auth": "bad"}
    # Unrecognised shape — treat as network so the RTSP fallback runs
    # and either confirms or denies the auth.
    return {"vendor": "reolink", "auth": "net"}


def _probe_rtsp(
    ip: str, port: int, user: str, password: str, path: str, timeout_ms: int = 4000
) -> dict:
    """Vendor-agnostic RTSP probe via OpenCV+FFmpeg. Returns:
      {"vendor": "rtsp", "auth": "ok"}            — frame readable
      {"vendor": "rtsp", "auth": "bad"}           — 401 / Unauthorized
      {"vendor": "rtsp", "auth": "unreachable"}   — no route / refused
      {"vendor": "rtsp", "auth": "timeout"}       — open / read timed out
      {"vendor": "rtsp", "auth": "unknown"}       — opened but no frame
    OpenCV's FFmpeg backend writes the underlying error string to stderr
    only — we capture the timing of cap.isOpened() / read() and treat
    the absence of an opened handle as a generic network failure unless
    the FFmpeg log captured below mentions HTTP 401 / Unauthorized.
    """
    import os
    import urllib.parse

    import cv2  # noqa: PLC0415 — keep import local to keep boot fast

    enc_pw = urllib.parse.quote(password or "", safe="")
    enc_user = urllib.parse.quote(user or "", safe="")
    safe_path = path or ""
    if safe_path and not safe_path.startswith("/"):
        safe_path = "/" + safe_path
    rtsp_url = f"rtsp://{enc_user}:{enc_pw}@{ip}:{port}{safe_path}"
    masked = f"rtsp://{user}:{_mask_pw(password)}@{ip}:{port}{safe_path}"
    logging.info("[discovery] rtsp probe %s", masked)

    # FFmpeg socket-level timeout in microseconds. Setting via env var so
    # the per-handle CAP_PROP_OPEN_TIMEOUT_MSEC is reinforced (some
    # FFmpeg versions ignore the property and only honour stimeout).
    prev_env = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = f"rtsp_transport;tcp|stimeout;{timeout_ms * 1000}"
    cap = None
    try:
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, timeout_ms)
        cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            # No way to ask FFmpeg "why?" via the OpenCV API. Distinguish
            # by trying a quick TCP connect to the port: refused/no-route
            # → unreachable, success → likely auth.
            return {"vendor": "rtsp", "auth": _classify_rtsp_open_fail(ip, port)}
        ok, frame = cap.read()
        if ok and frame is not None and getattr(frame, "size", 0) > 0:
            return {"vendor": "rtsp", "auth": "ok"}
        # Opened but no frame — common when the URL path is wrong on a
        # camera that does authenticate. Surface as ``unknown`` so the
        # UI lets the user save with a warning.
        return {"vendor": "rtsp", "auth": "unknown"}
    finally:
        try:
            if cap is not None:
                cap.release()
        except Exception:
            pass
        # Restore the prior env var so we don't poison the rest of the
        # process (camera_runtime/_capture sets its own value before
        # opening the production stream, but a test request running
        # while no camera is up could leak otherwise).
        if prev_env is None:
            os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
        else:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev_env


def _classify_rtsp_open_fail(ip: str, port: int, timeout: float = 1.5) -> str:
    """Quick fallback classification when ``cap.isOpened()`` is false.
    A successful TCP connect means the port is up — so the most likely
    cause of OpenCV failing to open is an auth failure (401) or a wrong
    path. A refused/timed-out connect means the camera is unreachable.
    """
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        rc = s.connect_ex((ip, port))
        if rc == 0:
            return "bad"  # port reachable but FFmpeg couldn't open → auth
        return "unreachable"
    except Exception:
        return "timeout"
    finally:
        try:
            s.close()
        except Exception:
            pass


# German user-facing strings for each (vendor, reason) pair.
_DETAIL_DE: dict[str, str] = {
    "auth_ok": "Zugangsdaten korrekt.",
    "auth_failed": "Passwort oder Benutzername ist falsch.",
    "unreachable": "Kamera ist nicht erreichbar (Port geschlossen oder Gerät offline).",
    "timeout": "Zeitüberschreitung — Kamera antwortet nicht rechtzeitig.",
    "auth_unknown": "Antwort konnte nicht eindeutig ausgewertet werden.",
    "error": "Unerwarteter Fehler beim Prüfen der Zugangsdaten.",
}


@bp.post('/api/discover/test-credentials')
def api_discover_test_credentials():
    """Probe a candidate camera with the credentials the user just typed
    in the discovery modal. Always returns 200 — never raises — so the
    frontend stays responsive even when a camera is fully offline.

    Hard 6 s wall-clock cap: the Reolink HTTP probe (≤4 s) plus the
    RTSP fallback (≤4 s) only run sequentially in the worst case where
    Reolink is unreachable; ``_probe_reolink_login`` returns ``net``
    quickly enough that the combined budget fits.
    """
    payload = request.get_json(silent=True) or {}
    ip = (payload.get("ip") or "").strip()
    user = (payload.get("user") or "").strip()
    password = payload.get("password") or ""
    path = (payload.get("path") or "").strip()
    try:
        port = int(payload.get("port") or 554)
    except (TypeError, ValueError):
        port = 554
    if not ip:
        return jsonify(
            {
                "ok": False,
                "vendor": "unknown",
                "reason": "error",
                "detail": "Keine IP-Adresse angegeben.",
            }
        )
    if not user:
        # Empty user is sometimes valid for ONVIF anon, but the cam-add
        # form always pre-fills "admin" so an empty user here is a UI
        # bug — surface it instead of probing blindly.
        return jsonify(
            {
                "ok": False,
                "vendor": "unknown",
                "reason": "auth_failed",
                "detail": "Benutzername fehlt.",
            }
        )

    logging.info(
        "[discovery] credential test %s:%d user=%s pw=%s path=%s",
        ip,
        port,
        user,
        _mask_pw(password),
        path or "—",
    )

    # ── Reolink HTTP login first ────────────────────────────────────────
    rl = _probe_reolink_login(ip, user, password, timeout=4.0)
    if rl["auth"] == "ok":
        return jsonify(
            {
                "ok": True,
                "vendor": "reolink",
                "reason": "auth_ok",
                "detail": _DETAIL_DE["auth_ok"],
            }
        )
    if rl["auth"] == "bad":
        return jsonify(
            {
                "ok": False,
                "vendor": "reolink",
                "reason": "auth_failed",
                "detail": _DETAIL_DE["auth_failed"],
            }
        )
    # ``net`` → fall through to the RTSP fallback. Anything non-Reolink
    # always lands here.

    rt = _probe_rtsp(ip, port, user, password, path, timeout_ms=4000)
    if rt["auth"] == "ok":
        return jsonify(
            {
                "ok": True,
                "vendor": "rtsp",
                "reason": "auth_ok",
                "detail": _DETAIL_DE["auth_ok"],
            }
        )
    if rt["auth"] == "bad":
        return jsonify(
            {
                "ok": False,
                "vendor": "rtsp",
                "reason": "auth_failed",
                "detail": _DETAIL_DE["auth_failed"],
            }
        )
    if rt["auth"] == "timeout":
        return jsonify(
            {
                "ok": False,
                "vendor": "rtsp",
                "reason": "timeout",
                "detail": _DETAIL_DE["timeout"],
            }
        )
    if rt["auth"] == "unreachable":
        return jsonify(
            {
                "ok": False,
                "vendor": "rtsp",
                "reason": "unreachable",
                "detail": _DETAIL_DE["unreachable"],
            }
        )
    # ``unknown`` — opened, but no frame. Lets the user save anyway.
    return jsonify(
        {
            "ok": False,
            "vendor": "rtsp",
            "reason": "auth_unknown",
            "detail": _DETAIL_DE["auth_unknown"],
        }
    )


@bp.get('/api/status')
def api_status():
    settings = app_state.settings
    runtimes = app_state.runtimes
    return jsonify(
        {
            "cameras": [
                runtimes[c["id"]].status()
                if c["id"] in runtimes
                else {"id": c["id"], "status": "disabled", "name": c.get("name", c["id"])}
                for c in app_state.get_effective_config().get("cameras", [])
            ],
            "cat_profiles": app_state.cat_registry.list_profiles(),
            "person_profiles": app_state.person_registry.list_profiles(),
            "telegram_actions": settings.data.get("telegram_actions", [])[:12],
        }
    )


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
    return jsonify(
        {
            "build": _BUILD_INFO,
            "process_start": _PROCESS_START_ISO,
            "mem_total_mb": round(mem_total / 1048576, 1),
            "mem_used_mb": round(mem_used / 1048576, 1),
            "proc_mem_mb": proc_mem_mb,
            "uptime_s": uptime_s,
            "storage_root": str(app_state.storage_root),
            "camera_count": len(app_state.runtimes),
            "coral_device": coral_device,
        }
    )


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
    return Response(
        text,
        mimetype=mimetype,
        headers={"Content-Disposition": f"attachment; filename=tam-spy-settings.{fmt}"},
    )


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

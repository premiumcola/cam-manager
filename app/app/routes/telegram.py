"""Telegram health/test/action endpoints + per-camera test-alert.

Migrated from server.py during R01.5. Each route reads
`app_state.telegram_service` fresh — the service is mutable, replaced
by `_reload_telegram_service` whenever the bot config changes, so
caching the reference at module import time would silently break
after the first settings save.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime

from flask import Blueprint, jsonify

from .. import app_state

bp = Blueprint("telegram_bp", __name__)


@bp.get('/api/telegram/actions')
def api_telegram_actions():
    return jsonify({"items": app_state.settings.data.get("telegram_actions", [])[:40]})


@bp.get('/api/telegram/status')
def api_telegram_status():
    """Read-only polling status for the connection-panel badge."""
    tg = app_state.telegram_service
    if not tg:
        return jsonify({"state": "off", "since_seconds": 0, "enabled": False})
    try:
        return jsonify(tg.get_polling_status())
    except Exception as e:
        return jsonify({"state": "off", "since_seconds": 0, "enabled": False, "error": str(e)}), 500


@bp.post('/api/telegram/test')
def api_telegram_test():
    settings = app_state.settings
    base_cfg = app_state.base_cfg
    tg = app_state.telegram_service
    tg_cfg = settings.export_effective_config(base_cfg).get("telegram", {})
    logging.getLogger(__name__).info(
        "[tg] Test: enabled=%s token_set=%s chat_id=%s",
        tg_cfg.get("enabled"),
        bool(tg_cfg.get("token")),
        tg_cfg.get("chat_id"),
    )
    if not tg or not tg.enabled:
        reasons = []
        if not tg_cfg.get("enabled"):
            reasons.append("Telegram nicht aktiviert")
        if not tg_cfg.get("token"):
            reasons.append("Token fehlt")
        if not tg_cfg.get("chat_id"):
            reasons.append("Chat-ID fehlt")
        return jsonify(
            {"ok": False, "error": " · ".join(reasons) or "Telegram nicht konfiguriert"}
        ), 400
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    msg = f"Squirreling · Sightings Test ✓ Verbindung funktioniert! {ts}"
    try:
        # Route through the persistent send-loop instead of asyncio.run(),
        # which would create+tear-down a new loop on every call and trip
        # "loop is closed" after rapid retries.
        fut = tg.send(msg, parse_mode=None)
        if fut is not None:
            fut.result(timeout=15)
        return jsonify({"ok": True, "message": msg})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.post('/api/cameras/<cam_id>/test-alert')
def api_test_alert(cam_id: str):
    """Fire a test push through every channel currently enabled on the
    camera. Returns per-channel success/error so the cam-edit Alerting-
    tab "Test-Push senden" button can show which channel arrived and
    which silently dropped. Lets the user verify their config end-to-
    end without having to wait for an actual detection.

    The test never goes through the severity / class_severity / quiet-
    hours pipeline — it bypasses send_event_alert and calls the raw
    send_alert_sync (Telegram) and publish (MQTT) so the user sees the
    transport status, not whether it would have been silenced. Errors
    are caught per-channel; one bad channel doesn't bury the others.
    """
    settings = app_state.settings
    tg = app_state.telegram_service
    mqtt = app_state.mqtt_service
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    cam_name = cam.get("name") or cam_id
    caption = f"🧪 Test-Push · {cam_name} · {datetime.now().strftime('%H:%M:%S')}"
    results: dict[str, dict] = {}
    if cam.get("telegram_enabled") and tg is not None and tg.enabled:
        try:
            tg.send_alert_sync(caption=caption, jpeg_bytes=None)
            results["telegram"] = {"ok": True}
        except Exception as e:
            results["telegram"] = {"ok": False, "error": str(e)}
    else:
        reason = "Kanal aus" if not cam.get("telegram_enabled") else "Bot nicht aktiv"
        results["telegram"] = {"ok": False, "error": reason}
    if cam.get("mqtt_enabled") and mqtt is not None:
        try:
            payload = {
                "test": True,
                "camera_id": cam_id,
                "camera_name": cam_name,
                "ts": datetime.now().isoformat(timespec="seconds"),
            }
            mqtt.publish(f"events/{cam_id}/test", payload)
            results["mqtt"] = {"ok": True}
        except Exception as e:
            results["mqtt"] = {"ok": False, "error": str(e)}
    else:
        reason = "Kanal aus" if not cam.get("mqtt_enabled") else "MQTT nicht konfiguriert"
        results["mqtt"] = {"ok": False, "error": reason}
    any_ok = any(r.get("ok") for r in results.values())
    return jsonify({"ok": any_ok, "channels": results}), (200 if any_ok else 502)


@bp.get('/api/system/telegram')
def api_system_telegram():
    """Health snapshot for the cam-edit Alerting-tab status strip.
    Returns the bot's connected/disconnected state plus the
    timestamp of the most recent successful send_alert. Connected
    means: the TelegramService instance exists, has bot+token+chat_id
    configured, and is currently in the polling-active state.

    Returned shape:
      {
        "enabled":       bool,    # service has token + chat_id
        "connected":     bool,    # polling thread is currently running
        "last_send_iso": str|null, # ISO timestamp of last successful push
        "last_send_age_s": float|null,  # seconds since last_send
      }
    Frontend maps:
      enabled=False                            → grey dot, "deaktiviert"
      enabled=True && connected=True           → green dot, "verbunden"
      enabled=True && connected=False          → red dot, "getrennt"
    """
    out = {
        "enabled": False,
        "connected": False,
        "last_send_iso": None,
        "last_send_age_s": None,
    }
    tg = app_state.telegram_service
    if tg is None:
        return jsonify(out)
    out["enabled"] = bool(getattr(tg, "enabled", False))
    try:
        poll_status = tg.get_polling_status() or {}
        state = (poll_status.get("state") or "").lower()
        out["connected"] = state in ("polling", "running", "active")
    except Exception:
        out["connected"] = False
    last_push = getattr(tg, "_last_push_ts", None)
    if last_push:
        try:
            out["last_send_iso"] = datetime.fromtimestamp(float(last_push)).isoformat(
                timespec="seconds"
            )
            out["last_send_age_s"] = round(time.time() - float(last_push), 1)
        except Exception:
            pass
    return jsonify(out)

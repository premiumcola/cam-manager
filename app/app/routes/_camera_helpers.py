"""Shared helpers for the camera-CRUD and bootstrap blueprints.

Lives next to its callers (cameras.py, bootstrap.py) because every
helper here is referenced from at least two routes across those
modules. Single-route helpers stay inline in their blueprint per the
R01.x pattern."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .. import app_state

# Connection-field set used by the camera save handler to detect
# whether a camera-config save needs a runtime restart. The save
# handler's diff against the previous cfg short-circuits when only
# non-connection fields changed.
_CONN_FIELDS = {"rtsp_url", "snapshot_url", "username", "password", "enabled"}

# Connection-only fields used by the camera-recovery flow. Excludes
# "enabled" because we never want a recovery to silently flip a
# disabled cam back on.
_RESTORE_CONN_FIELDS = ("rtsp_url", "snapshot_url", "username", "password")


def _auto_detect_device_info(cam: dict) -> list[str]:
    """Reolink GetDevInfo auto-detect for camera saves. Fills empty
    manufacturer / model when the cam has credentials and the IP
    responds — so the user no longer has to type "Reolink" / "RLC-810A"
    by hand (and the recurring manuf/model-loss bug stops biting because
    the values are derived from the camera itself on every save).

    Mutates `cam` in-place and returns the list of field names that were
    filled by auto-detect — the cam-edit UI surfaces this as an
    "automatisch erkannt" hint under each affected input.

    Opportunistic: silent on every failure (missing creds, unparseable
    URL, login error, non-Reolink camera, network timeout). Save flow
    must never block on auto-detect — a 4 s budget across login +
    GetDevInfo + logout is the cap. If the user typed manuf/model
    manually, this is a no-op (we don't overwrite — the existing values
    are respected).
    """
    if cam.get("manufacturer") and cam.get("model"):
        return []
    rtsp_url = (cam.get("rtsp_url") or "").strip()
    user = cam.get("username") or ""
    password = cam.get("password") or ""
    if not rtsp_url or not user:
        return []
    try:
        from urllib.parse import urlparse

        host = urlparse(rtsp_url).hostname
    except Exception:
        host = None
    if not host:
        return []
    try:
        from .. import reolink_api

        token = reolink_api.login(host, user, password, timeout=4.0)
        if not token:
            return []
        info = reolink_api.get_device_info(host, token, timeout=4.0)
        reolink_api.logout(host, token, timeout=2.0)
    except Exception as e:
        logging.info("[cam] auto-detect skipped host=%s: %s", host, e)
        return []
    if not info:
        return []
    filled: list[str] = []
    if not cam.get("manufacturer"):
        cam["manufacturer"] = info["manufacturer"]
        filled.append("manufacturer")
    if not cam.get("model"):
        cam["model"] = info["model"]
        filled.append("model")
    if filled:
        logging.info(
            "[cam] auto-detected via Reolink GetDevInfo: %s %s (cam=%s)",
            info["manufacturer"],
            info["model"],
            cam.get("name") or cam.get("id"),
        )
    return filled


def _mask_password_in_url(url: str) -> str:
    """Replace the password in an embedded-credential URL with '•••' so the
    recovery preview can show the URL shape without leaking the secret."""
    if not url or "://" not in url or "@" not in url:
        return url
    try:
        scheme, rest = url.split("://", 1)
        creds, host = rest.rsplit("@", 1)
        if ":" in creds:
            user, _ = creds.split(":", 1)
            return f"{scheme}://{user}:•••@{host}"
        return url
    except Exception:
        return url


def _list_backup_files() -> list[Path]:
    """Backup sources, oldest-priority order:
    1. settings.json.bak  (last save)
    2. settings.json.bak2 (second-last save)
    3. storage/backups/*.json (manual exports — newest first)"""
    settings = app_state.settings
    out: list[Path] = []
    for name in ("settings.json.bak", "settings.json.bak2"):
        p = settings.path.parent / name
        if p.exists():
            out.append(p)
    backups_dir = settings.path.parent / "backups"
    if backups_dir.exists():
        out.extend(
            sorted(backups_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        )
    return out


def _read_backup(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

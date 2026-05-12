"""Reolink HTTP CGI helper — minimal subset used by the day/night override
for the sun-timelapse capture window.

Three short sync calls, all 5 s timeouts, all swallow network errors and
log a single WARNING on failure (the caller is the weather scheduler — a
flaky API call must never abort the timelapse capture).

Login flow per Reolink CGI: POST /api.cgi?cmd=Login → token → use token
in subsequent SetIspCfg / Logout calls. Token has a short session
lifetime; callers should not cache it across jobs — login → set → logout
in one short burst (the function signatures encourage exactly that).
"""

from __future__ import annotations

import logging

import requests

log = logging.getLogger(__name__)

# Module-level session reused across calls in the same worker thread so
# that overriding many cams in sequence doesn't re-handshake TCP each
# time. requests.Session is documented as thread-safe for separate hosts;
# all our calls hit one cam per worker invocation so we never share a
# Session object across threads at the same host anyway.
_session = requests.Session()


def _base_url(host: str) -> str:
    return f"http://{host}/api.cgi"


def _make_url(host: str, port: int | None = None, *, https: bool = False) -> str:
    """Build the api.cgi URL with optional explicit port and scheme. The
    plain ``_base_url`` helper above is kept for legacy callers (sun-
    timelapse override, GetDevInfo probe) that always hit port 80; this
    variant is used by the standalone image-mode endpoint where the
    operator may have remapped Reolink's HTTP port."""
    scheme = "https" if https else "http"
    default_port = 443 if https else 80
    if port and int(port) != default_port:
        return f"{scheme}://{host}:{int(port)}/api.cgi"
    return f"{scheme}://{host}/api.cgi"


def login(host: str, username: str, password: str, timeout: float = 5.0) -> str | None:
    """POST cmd=Login and return the session token, or None on failure."""
    if not host or not username:
        # password may legitimately be empty on factory-default cams;
        # only bail if we have neither host nor user.
        log.warning("[reolink] daynight override needs cam credentials, skipping (host=%r user=%r)",
                    host, username or "")
        return None
    body = [{
        "cmd":    "Login",
        "action": 0,
        "param":  {"User": {"userName": username, "password": password or ""}},
    }]
    try:
        r = _session.post(
            _base_url(host),
            params={"cmd": "Login"},
            json=body,
            timeout=timeout,
        )
    except Exception as e:
        log.warning("[reolink] login network error host=%s: %s", host, e)
        return None
    if r.status_code != 200:
        log.warning("[reolink] login HTTP %s host=%s", r.status_code, host)
        return None
    try:
        payload = r.json()
        first = payload[0] if isinstance(payload, list) and payload else {}
        rsp = (first.get("value") or {}).get("Token") or {}
        token = rsp.get("name")
        if not token:
            log.warning("[reolink] login OK but no token in response host=%s body=%s",
                        host, str(payload)[:200])
            return None
        return token
    except Exception as e:
        log.warning("[reolink] login parse error host=%s: %s body=%s",
                    host, e, r.text[:200])
        return None


# Reolink rspCode mapping. Sourced from the published API doc + the
# firmware-shape variations we've observed in the wild on RLC-810A
# and CX810 cameras. Used to translate the cryptic numeric code into
# a human-readable hint in the WARNING line — important when a user
# is staring at "set_daynight … rspCode=-6" trying to figure out why
# the override silently no-ops.
_REOLINK_RSPCODE_HINTS: dict[int, str] = {
     0: "ok",
    -1: "ungültige Parameter (Firmware erwartet andere Feldnamen?)",
    -2: "Antwort fehlerhaft / unerwartetes Format",
    -3: "Antwort konnte nicht geparst werden",
    -6: "kein Admin-Recht — User-Account hat keine ISP-Rechte",
    -7: "Login fehlgeschlagen / Token ungültig",
    -8: "zu viele gleichzeitige Verbindungen — Kamera lehnt weitere Sessions ab",
   -10: "Fähigkeit nicht unterstützt (Firmware kennt SetIspCfg.dayNight nicht)",
   -11: "Token abgelaufen — bitte neu verbinden",
   -13: ("Funktion nicht unterstützt — diese Kamera/Firmware bietet kein "
         "S/W-Schalten über die API. Manche älteren Modelle "
         "(z. B. RLC-410/420 ohne Plus-Suffix) können das nicht."),
  -502: "Zeitüberschreitung beim Warten auf die Kamera",
}


def set_daynight(host: str, token: str, mode: str,
                 channel: int = 0, timeout: float = 5.0) -> bool:
    """Force the cam's day/night mode. mode ∈ {Color, Black&White, Auto}.

    Returns True iff Reolink reports a success rspCode (0 or 200 —
    different firmware versions report success with either). False on
    any other response, network error or parse failure. Failure paths
    log the full HTTP status, rspCode, and Reolink ``error.detail``
    string so the operator can tell apart "wrong field" / "no admin
    right" / "command not supported by firmware" without rerunning
    against tcpdump.
    """
    if mode not in ("Color", "Black&White", "Auto"):
        log.warning("[reolink] set_daynight invalid mode=%r", mode)
        return False
    if not token:
        log.warning("[reolink] set_daynight host=%s mode=%s: empty token", host, mode)
        return False
    body = [{
        "cmd":    "SetIspCfg",
        "action": 0,
        "param":  {"Isp": {"channel": channel, "dayNight": mode}},
    }]
    try:
        r = _session.post(
            _base_url(host),
            # Mask the token in any debug logging — the token is a
            # short-lived session id, but it grants ISP-write access
            # for ~30 min, so don't leak it into log files. The
            # underlying request still carries the full token; we
            # just keep it out of any string we format ourselves.
            params={"cmd": "SetIspCfg", "token": token},
            json=body,
            timeout=timeout,
        )
    except Exception as e:
        log.warning(
            "[reolink] set_daynight network error host=%s mode=%s ch=%d: %s",
            host, mode, channel, e,
        )
        return False
    status = r.status_code
    body_txt = (r.text or "")
    # Truncate the formatted body in the log line to 600 chars — the
    # full JSON for an error response runs ~120 chars but a future
    # firmware may pad it; 600 is a safe upper bound that still fits
    # one log line.
    body_log = body_txt[:600]
    if status != 200:
        log.warning(
            "[reolink] set_daynight HTTP %d host=%s mode=%s ch=%d body=%s",
            status, host, mode, channel, body_log,
        )
        return False
    try:
        payload = r.json()
    except Exception as e:
        log.warning(
            "[reolink] set_daynight parse error host=%s mode=%s: %s body=%s",
            host, mode, e, body_log,
        )
        return False
    first = payload[0] if isinstance(payload, list) and payload else {}
    # Two response shapes — success carries the rspCode under
    # ``value.rspCode``, error carries it under ``error.rspCode`` plus
    # a human ``error.detail`` string. We read both so a permission
    # rejection doesn't slip through as "unknown failure".
    value = first.get("value") if isinstance(first.get("value"), dict) else None
    err = first.get("error") if isinstance(first.get("error"), dict) else None
    rsp_code = None
    if value is not None and "rspCode" in value:
        rsp_code = value.get("rspCode")
    elif err is not None and "rspCode" in err:
        rsp_code = err.get("rspCode")
    err_detail = (err or {}).get("detail", "") if err else ""
    outer_code = first.get("code")
    # Success conditions:
    #   • value.rspCode == 200 (RLC-810A / older firmware)
    #   • value.rspCode == 0   (CX810 / newer firmware)
    #   • outer code == 0 with no error block (some firmwares omit
    #     value entirely on a no-op success)
    if rsp_code in (0, 200):
        return True
    if outer_code == 0 and err is None:
        return True
    # Failure path — emit a single rich WARNING the operator can
    # diagnose from. Include outer code, rspCode (when present),
    # error.detail, and the truncated raw body as a last-resort
    # forensic anchor.
    hint = ""
    if isinstance(rsp_code, int):
        hint = _REOLINK_RSPCODE_HINTS.get(rsp_code, "")
    log.warning(
        "[reolink] set_daynight host=%s mode=%s ch=%d FAILED · "
        "outer_code=%s rspCode=%s detail=%r%s · body=%s",
        host, mode, channel, outer_code, rsp_code, err_detail,
        f" · hint={hint!r}" if hint else "",
        body_log,
    )
    return False


def get_device_info(host: str, token: str, timeout: float = 5.0) -> dict | None:
    """Query Reolink GetDevInfo CGI — used by the cam-save auto-detect flow
    so the user doesn't have to type "Reolink" / "RLC-810A" by hand and
    the canonical camera-id can be built without "unknown_unknown_…"
    fallbacks. Returns:

      {"manufacturer": "Reolink",
       "model":        "RLC-810A",   # exact GetDevInfo model string
       "firmware":     "v3.0.0.494",
       "hardware":     "IPC_523128M5MP"}

    or None on any failure (no token, network error, non-200 HTTP, error
    rspCode, missing model). Failures are silent at WARNING level so a
    flaky probe never blocks a save.
    """
    if not token:
        return None
    body = [{"cmd": "GetDevInfo", "action": 0, "param": {}}]
    try:
        r = _session.post(
            _base_url(host),
            params={"cmd": "GetDevInfo", "token": token},
            json=body,
            timeout=timeout,
        )
    except Exception as e:
        log.warning("[reolink] get_device_info network error host=%s: %s", host, e)
        return None
    if r.status_code != 200:
        log.warning("[reolink] get_device_info HTTP %s host=%s", r.status_code, host)
        return None
    try:
        payload = r.json()
        first = payload[0] if isinstance(payload, list) and payload else {}
        if first.get("code") != 0:
            log.warning("[reolink] get_device_info host=%s code=%s rsp=%s",
                        host, first.get("code"), str(payload)[:200])
            return None
        dev = (first.get("value") or {}).get("DevInfo") or {}
        model = str(dev.get("model", "") or "").strip()
        if not model:
            return None
        return {
            "manufacturer": "Reolink",
            "model":        model,
            "firmware":     str(dev.get("firmVer", "") or "").strip(),
            "hardware":     str(dev.get("hardVer", "") or "").strip(),
        }
    except Exception as e:
        log.warning("[reolink] get_device_info parse error host=%s: %s body=%s",
                    host, e, r.text[:200])
        return None


def _login_with_port(
    host: str,
    port: int,
    user: str,
    password: str,
    *,
    https: bool = False,
    timeout: float = 4.0,
) -> str | None:
    """Variant of ``login`` that accepts an explicit port + scheme.
    Used by ``set_image_mode`` for the standalone Verbindungs-Test
    panel where the camera may listen on a non-default port. Returns
    the session token or None on any failure."""
    if not host or not user:
        log.warning("[reolink] image-mode login skipped · host=%r user=%r",
                    host, user or "")
        return None
    body = [{
        "cmd":    "Login",
        "action": 0,
        "param":  {"User": {"userName": user, "password": password or ""}},
    }]
    try:
        r = _session.post(
            _make_url(host, port, https=https),
            params={"cmd": "Login"},
            json=body,
            timeout=timeout,
        )
    except Exception as e:
        log.warning("[reolink] image-mode login network error host=%s: %s",
                    host, e)
        return None
    if r.status_code != 200:
        log.warning("[reolink] image-mode login HTTP %s host=%s",
                    r.status_code, host)
        return None
    try:
        payload = r.json()
        first = payload[0] if isinstance(payload, list) and payload else {}
        tok = ((first.get("value") or {}).get("Token") or {}).get("name")
        return tok or None
    except Exception as e:
        log.warning("[reolink] image-mode login parse error host=%s: %s",
                    host, e)
        return None


# Wire-mapping for the high-level image-mode call. Public so the route
# layer can echo the underlying values back to the UI on demand without
# duplicating the dict.
IMAGE_MODE_MAP: dict[str, tuple[str, str]] = {
    "auto":  ("Auto",         "Auto"),
    "color": ("Color",        "Off"),
    "bw":    ("Black&White",  "Auto"),
}


def set_image_mode(
    host: str,
    port: int,
    user: str,
    password: str,
    mode: str,
    *,
    https: bool = False,
    timeout: float = 4.0,
) -> dict:
    """Force the day/night image mode on a Reolink cam in one short call.

    ``mode`` ∈ {"auto", "color", "bw"} maps to:
      ``auto``  → SetIsp dayNight=Auto         + IrLights state=Auto
      ``color`` → SetIsp dayNight=Color        + IrLights state=Off
      ``bw``    → SetIsp dayNight=Black&White  + IrLights state=Auto

    Both commands ship in a single ``/api.cgi?token=...`` POST (Reolink
    accepts array bodies). On a "command not supported" response (rspCode
    -10) the call retries the SetIsp half with a v1-schema variant that
    newer firmware accepts.

    Returns ``{"ok": bool, "rc": <int|str>, "detail": str}``. Always
    logs ONE INFO line per call; never logs the password.
    """
    mode_norm = (mode or "").strip().lower()
    if mode_norm not in IMAGE_MODE_MAP:
        log.warning("[reolink] set_image_mode invalid mode=%r host=%s",
                    mode, host)
        return {"ok": False, "rc": "bad-mode",
                "detail": "mode muss auto/color/bw sein"}
    day_night, ir_state = IMAGE_MODE_MAP[mode_norm]
    token = _login_with_port(host, port, user, password,
                             https=https, timeout=timeout)
    if not token:
        log.info("[reolink] %s set_image_mode → %s (rc=login-failed)",
                 host, mode_norm)
        return {"ok": False, "rc": "login-failed",
                "detail": "Login fehlgeschlagen — Host/Port/User prüfen"}

    def _send_pair(isp_param: dict) -> tuple[bool, object, str]:
        body = [
            {"cmd": "SetIsp",      "action": 0, "param": isp_param},
            {"cmd": "SetIrLights", "action": 0,
             "param": {"IrLights": {"state": ir_state}}},
        ]
        try:
            r = _session.post(
                _make_url(host, port, https=https),
                params={"cmd": "", "token": token},
                json=body,
                timeout=timeout,
            )
        except Exception as e:
            return (False, "network", str(e))
        if r.status_code != 200:
            return (False, r.status_code, (r.text or "")[:200])
        try:
            payload = r.json()
        except Exception:
            return (False, "parse", (r.text or "")[:200])
        if not isinstance(payload, list) or not payload:
            return (False, "shape", str(payload)[:200])
        # Walk the array — every command must succeed individually.
        for entry in payload:
            value = entry.get("value") if isinstance(entry.get("value"), dict) else None
            err = entry.get("error") if isinstance(entry.get("error"), dict) else None
            rc = None
            if value and "rspCode" in value:
                rc = value.get("rspCode")
            elif err and "rspCode" in err:
                rc = err.get("rspCode")
            outer = entry.get("code")
            if rc in (0, 200) or (outer == 0 and err is None):
                continue
            return (False, rc if rc is not None else (outer if outer is not None else "unknown"),
                    (err or {}).get("detail", "") if err else "")
        return (True, 0, "")

    # v0 SetIsp schema — the shape used by set_daynight() above. Works
    # on RLC-810A / CX810 / CX410 in our test rig.
    ok, rc, detail = _send_pair({"Isp": {"channel": 0, "dayNight": day_night}})
    if not ok and rc == -10:
        # v1 retry — newer RLC-1224A firmware rejects v0 with rspCode
        # -10 ("command not supported"); the v1 wire shape moves
        # ``channel`` up one level. Same logical payload, different
        # envelope.
        ok, rc, detail = _send_pair({"channel": 0, "Isp": {"dayNight": day_night}})

    # Best-effort token release — failure here does NOT flip the
    # operation result.
    try:
        _session.post(
            _make_url(host, port, https=https),
            params={"cmd": "Logout", "token": token},
            json=[{"cmd": "Logout", "action": 0, "param": {}}],
            timeout=timeout,
        )
    except Exception:
        pass

    log.info("[reolink] %s set_image_mode → %s (rc=%s)", host, mode_norm, rc)
    if not ok and not detail and isinstance(rc, int):
        detail = _REOLINK_RSPCODE_HINTS.get(rc, "")
    return {"ok": ok, "rc": rc, "detail": detail or ("ok" if ok else "")}


def logout(host: str, token: str, timeout: float = 5.0) -> None:
    """Best-effort token release. Errors are swallowed and only logged at
    DEBUG — leaking a token to its 30-min server-side timeout is not a
    real problem."""
    if not token:
        return
    try:
        _session.post(
            _base_url(host),
            params={"cmd": "Logout", "token": token},
            json=[{"cmd": "Logout", "action": 0, "param": {}}],
            timeout=timeout,
        )
    except Exception as e:
        log.debug("[reolink] logout swallowed host=%s: %s", host, e)

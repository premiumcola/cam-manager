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


def set_daynight(host: str, token: str, mode: str,
                 channel: int = 0, timeout: float = 5.0) -> bool:
    """Force the cam's day/night mode. mode ∈ {Color, Black&White, Auto}.

    Returns True iff Reolink reports rspCode == 200. False on any other
    response, network error or parse failure (caller logs the cam_id
    context — we only know `host` here).
    """
    if mode not in ("Color", "Black&White", "Auto"):
        log.warning("[reolink] set_daynight invalid mode=%r", mode)
        return False
    if not token:
        return False
    body = [{
        "cmd":    "SetIspCfg",
        "action": 0,
        "param":  {"Isp": {"channel": channel, "dayNight": mode}},
    }]
    try:
        r = _session.post(
            _base_url(host),
            params={"cmd": "SetIspCfg", "token": token},
            json=body,
            timeout=timeout,
        )
    except Exception as e:
        log.warning("[reolink] set_daynight network error host=%s mode=%s: %s",
                    host, mode, e)
        return False
    if r.status_code != 200:
        log.warning("[reolink] set_daynight HTTP %s host=%s mode=%s",
                    r.status_code, host, mode)
        return False
    try:
        payload = r.json()
        first = payload[0] if isinstance(payload, list) and payload else {}
        code = ((first.get("value") or {}).get("rspCode")
                if isinstance(first.get("value"), dict)
                else first.get("code"))
        if code == 200:
            return True
        # Log the raw body once at WARNING so firmware-shape mismatches
        # surface for diagnosis (different RLC firmware versions vary on
        # the param.Isp.channel vs param.channel placement).
        log.warning("[reolink] set_daynight host=%s mode=%s rsp=%s",
                    host, mode, str(payload)[:200])
        return False
    except Exception as e:
        log.warning("[reolink] set_daynight parse error host=%s: %s body=%s",
                    host, e, r.text[:200])
        return False


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

from __future__ import annotations
import ipaddress
import logging
import socket
import http.client
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

log = logging.getLogger(__name__)

# Phase-1 sweep: only these ports are checked across ALL hosts in parallel.
# A host that responds on any of these is a camera candidate.
# Reolink-specific: 80 (HTTP UI), 554 (RTSP), 8000 (ONVIF — Reolink uses 8000
# for ONVIF, not the IANA-default 2020), plus legacy media port 9000.
# Other vendors: 8554 (alt RTSP), 34567 (Hikvision SDK), 37777 (Dahua SDK).
# 2020 was removed — no Reolink uses it and it caused false positives.
CAMERA_INDICATOR_PORTS = [80, 554, 8000, 8554, 9000, 34567, 37777]

# Phase-2 extras: checked only on confirmed camera candidates for better fingerprinting
EXTRA_PORTS = [443, 8080, 8443]


def _tcp_open(ip: str, port: int, timeout: float = 0.8) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((ip, port)) == 0
    except Exception:
        return False
    finally:
        s.close()


def _http_banner(ip: str, port: int, timeout: float = 1.5) -> dict:
    for scheme in ("http", "https"):
        try:
            if scheme == "http":
                conn = http.client.HTTPConnection(ip, port, timeout=timeout)
            else:
                import ssl
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                conn = http.client.HTTPSConnection(ip, port, timeout=timeout, context=ctx)
            conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0"})
            r = conn.getresponse()
            headers = dict(r.getheaders())
            body = r.read(2048).decode("utf-8", errors="replace")
            bl = body.lower()
            title = ""
            if "<title>" in bl:
                s = bl.index("<title>") + 7
                e = bl.index("</title>") if "</title>" in bl else s + 80
                title = body[s:e].strip()
            return {
                "server": headers.get("Server", ""),
                "title": title,
                "www_auth": headers.get("WWW-Authenticate", ""),
                "status": r.status,
                # Lowercased body excerpt — used by _guess() to spot vendor
                # markers (e.g. "reolink") that don't surface in the Server
                # header or <title>.
                "body": bl,
            }
        except Exception:
            pass
    return {}


def _rtsp_banner(ip: str, port: int, timeout: float = 1.5) -> bool:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((ip, port))
        s.send(b"OPTIONS rtsp://" + ip.encode() + b"/ RTSP/1.0\r\nCSeq: 1\r\n\r\n")
        data = s.recv(256)
        s.close()
        return b"RTSP" in data
    except Exception:
        return False


def _guess(open_ports: list[int], banners: dict) -> str:
    """Return human-readable vendor/type name without 'Kamera' prefix."""
    server = banners.get("server", "").lower()
    title = banners.get("title", "").lower()
    www_auth = banners.get("www_auth", "").lower()
    body = banners.get("body", "")  # already lowercased in _http_banner

    rtsp_open = any(p in open_ports for p in (554, 8554))

    # Check banner content for vendor hints. body is included because Reolink
    # firmware ships the vendor name as inline JS strings, not in <title>.
    for keyword, vendor in [
        ("reolink", "Reolink"), ("hikvision", "Hikvision"), ("hik", "Hikvision"),
        ("dahua", "Dahua"), ("amcrest", "Amcrest"), ("axis", "Axis"),
        ("hanwha", "Hanwha"), ("uniview", "Uniview"), ("vivotek", "Vivotek"),
        ("foscam", "Foscam"), ("tp-link", "TP-Link"), ("tapo", "TP-Link Tapo"),
    ]:
        if keyword in server or keyword in title or keyword in www_auth or keyword in body:
            return vendor

    # Strong Reolink signal even without a banner match: the HTTP-UI port 80
    # is open AND the Reolink-specific ONVIF port 8000 is open. Hikvision
    # also uses 8000, but for that the banner check above would already have
    # fired ("realm=Hikvision" in www_auth, "hikvision" in server, etc).
    if 80 in open_ports and 8000 in open_ports:
        return "Reolink"

    # Two Reolink-private ports together with no other vendor match are also
    # a strong signal — covers the case where HTTP UI is firewalled but RTSP
    # and the legacy media port are reachable.
    if 9000 in open_ports and 554 in open_ports:
        return "Reolink"

    if rtsp_open:
        # Hikvision uses 8000 as its SDK port AND has a recognisable HTTP banner;
        # only claim Hikvision here when the banner / WWW-Auth confirms it,
        # otherwise port 8000 likely belongs to a Reolink HTTP API.
        if 8000 in open_ports and ("hikvision" in server or "hikvision" in www_auth):
            return "Hikvision"
        if 37777 in open_ports:
            return "Dahua / Amcrest"
        if 9000 in open_ports or 8000 in open_ports:
            return "Reolink"
        return "RTSP-Kamera"

    if 9000 in open_ports:
        return "Reolink"
    if 37777 in open_ports:
        return "Dahua / Amcrest"
    if 34567 in open_ports:
        return "Hikvision"
    # Reolink HTTP API on 8000 alone — RTSP may be slow to ACK or disabled.
    if 8000 in open_ports:
        return "Reolink"

    if www_auth and "realm" in www_auth:
        return "IP-Kamera (HTTP-Auth)"

    return "Unbekannte Kamera"


def _reolink_rtsp_hints(ip: str, rtsp_port: int, user: str = "admin") -> dict:
    """Probe a Reolink camera to detect whether it supports H.264 or H.265 main stream,
    and return suggested RTSP URL patterns.
    Returns a dict with 'rtsp_main', 'rtsp_sub', and 'codec' keys."""
    port_str = f":{rtsp_port}" if rtsp_port != 554 else ""
    # Reolink naming convention:
    #   h264Preview_01_main / h264Preview_01_sub — older firmware (RLC-810A etc.)
    #   h265Preview_01_main / h264Preview_01_sub — newer firmware (CX810 etc.)
    # Sub-stream is always H.264 regardless of main codec.
    # We pick h264Preview as the conservative default; the UI lets users switch to h265.
    return {
        "rtsp_main_h264": f"rtsp://{user}:@{ip}{port_str}/h264Preview_01_main",
        "rtsp_main_h265": f"rtsp://{user}:@{ip}{port_str}/h265Preview_01_main",
        "rtsp_sub": f"rtsp://{user}:@{ip}{port_str}/h264Preview_01_sub",
        "suggested_path": "/h264Preview_01_main",
        "note": "Reolink — use H.265 path for CX810/newer firmware; H.264 for RLC-810A/older",
    }


def discover_hosts(subnet: str, max_hosts: int = 254) -> tuple[list, int]:
    """Two-phase scan. Phase 1: sweep all hosts × CAMERA_INDICATOR_PORTS in parallel.
    Phase 2: banner-fetch only the handful of camera candidates.
    Returns (camera_candidates, total_ips_attempted).
    """
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except Exception:
        return [], 0

    hosts = [str(h) for h in net.hosts()][:max_hosts]

    # ── Phase 1: parallel sweep across all (host, camera_port) combos ──────────
    tasks = [(ip, port) for ip in hosts for port in CAMERA_INDICATOR_PORTS]

    # 1.2s phase-1 timeout: newer Reolink firmware (v3.x+) is slow to ACK on 554.
    def probe_one(args: tuple) -> tuple | None:
        ip, port = args
        return (ip, port) if _tcp_open(ip, port, timeout=1.2) else None

    hits: dict[str, list[int]] = defaultdict(list)
    with ThreadPoolExecutor(max_workers=300) as ex:
        for result in ex.map(probe_one, tasks):
            if result:
                ip, port = result
                hits[ip].append(port)

    # Phase-1 visibility: log every host that answered, even ones _guess() will
    # later reject. Helps debug "Reolink not found" cases where only one of
    # 554/8000/9000 is actually reachable.
    if log.isEnabledFor(logging.DEBUG):
        if hits:
            for ip in sorted(hits, key=lambda x: list(map(int, x.split(".")))):
                log.debug("[discovery] phase1 hit %s ports=%s", ip, sorted(hits[ip]))
        else:
            log.debug("[discovery] phase1: no hits across %d hosts", len(hosts))

    if not hits:
        return [], len(hosts)

    # ── Phase 2: enrich camera candidates ───────────────────────────────────────
    results = []
    for ip, cam_ports in hits.items():
        open_ports = list(cam_ports)

        # Check extra ports for better fingerprinting
        for port in EXTRA_PORTS:
            if _tcp_open(ip, port, timeout=0.8):
                open_ports.append(port)

        banners: dict = {}
        for web_port in [p for p in open_ports if p in (80, 8080, 8000, 443, 8443)]:
            b = _http_banner(ip, web_port)
            if b:
                banners = b
                break

        for rtsp_port in [p for p in open_ports if p in (554, 8554)]:
            if _rtsp_banner(ip, rtsp_port):
                banners["rtsp_confirmed"] = True
                break

        hostname = ""
        _prev_timeout = socket.getdefaulttimeout()
        try:
            socket.setdefaulttimeout(1.0)
            fqdn = socket.gethostbyaddr(ip)[0]
            hostname = fqdn.split(".")[0].lower()
        except Exception:
            pass
        finally:
            socket.setdefaulttimeout(_prev_timeout)

        open_ports.sort()
        guess = _guess(open_ports, banners)
        entry = {"ip": ip, "open_ports": open_ports, "guess": guess, "hostname": hostname}
        # Attach Reolink-specific RTSP URL hints so the wizard can pre-populate fields
        if guess == "Reolink":
            rtsp_port = next((p for p in (554, 8554) if p in open_ports), 554)
            entry["reolink_hints"] = _reolink_rtsp_hints(ip, rtsp_port)
        results.append(entry)

    results.sort(key=lambda x: list(map(int, x["ip"].split("."))))
    return results, len(hosts)

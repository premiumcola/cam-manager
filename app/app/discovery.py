from __future__ import annotations
import ipaddress
import socket
import http.client
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

# Phase-1 sweep: only these ports are checked across ALL hosts in parallel.
# A host that responds on any of these is a camera candidate.
# RTSP (554/8554), ONVIF (2020), Reolink API (9000), Dahua SDK (37777), Hikvision SDK (34567)
CAMERA_INDICATOR_PORTS = [554, 8554, 2020, 9000, 37777, 34567]

# Phase-2 extras: checked only on confirmed camera candidates for better fingerprinting
EXTRA_PORTS = [80, 443, 8000, 8080, 8443]


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
            body = r.read(512).decode("utf-8", errors="replace")
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

    rtsp_open = any(p in open_ports for p in (554, 8554))

    # Check banner content for vendor hints
    for keyword, vendor in [
        ("reolink", "Reolink"), ("hikvision", "Hikvision"), ("hik", "Hikvision"),
        ("dahua", "Dahua"), ("amcrest", "Amcrest"), ("axis", "Axis"),
        ("hanwha", "Hanwha"), ("uniview", "Uniview"), ("vivotek", "Vivotek"),
        ("foscam", "Foscam"), ("tp-link", "TP-Link"), ("tapo", "TP-Link Tapo"),
    ]:
        if keyword in server or keyword in title or keyword in www_auth:
            return vendor

    if rtsp_open:
        if 8000 in open_ports:
            return "Hikvision"
        if 37777 in open_ports:
            return "Dahua / Amcrest"
        if 9000 in open_ports:
            return "Reolink"
        return "RTSP-Kamera"

    if 9000 in open_ports:
        return "Reolink"
    if 37777 in open_ports:
        return "Dahua / Amcrest"
    if 34567 in open_ports:
        return "Hikvision"
    if 2020 in open_ports:
        return "ONVIF-Kamera"

    if www_auth and "realm" in www_auth:
        return "IP-Kamera (HTTP-Auth)"

    return "Unbekannte Kamera"


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

    def probe_one(args: tuple) -> tuple | None:
        ip, port = args
        return (ip, port) if _tcp_open(ip, port, timeout=0.8) else None

    hits: dict[str, list[int]] = defaultdict(list)
    with ThreadPoolExecutor(max_workers=300) as ex:
        for result in ex.map(probe_one, tasks):
            if result:
                ip, port = result
                hits[ip].append(port)

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

        open_ports.sort()
        results.append({"ip": ip, "open_ports": open_ports, "guess": _guess(open_ports, banners)})

    results.sort(key=lambda x: list(map(int, x["ip"].split("."))))
    return results, len(hosts)

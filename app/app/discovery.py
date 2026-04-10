from __future__ import annotations
import ipaddress
import socket
from concurrent.futures import ThreadPoolExecutor

COMMON_PORTS = [80, 443, 554, 8000, 8080, 8081, 8554]


def _probe_ip(ip: str, timeout: float = 0.35):
    open_ports = []
    for port in COMMON_PORTS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            if s.connect_ex((ip, port)) == 0:
                open_ports.append(port)
        except Exception:
            pass
        finally:
            s.close()
    if open_ports:
        return {"ip": ip, "open_ports": open_ports, "guess": "camera-like host"}
    return None


def discover_hosts(subnet: str, max_hosts: int = 64):
    try:
        net = ipaddress.ip_network(subnet, strict=False)
    except Exception:
        return []
    hosts = [str(h) for h in net.hosts()][:max_hosts]
    results = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        for item in ex.map(_probe_ip, hosts):
            if item:
                results.append(item)
    return results

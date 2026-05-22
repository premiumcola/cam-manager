"""Boot + shutdown helpers carved out of ``server.py``.

Each function moved verbatim; references to server.py's module-level
globals (``settings``, ``store``, ``runtimes``, ``storage_root``,
``base_cfg``) were rewritten to flow through :mod:`app_state` so the
new module needs no special wiring. server.py imports these names
back in for any in-file callers; external callers reach
``_BUILD_INFO`` / ``_PROCESS_START_ISO`` via that same re-export.
"""

from __future__ import annotations

import atexit
import hashlib as _hashlib
import logging
import os
import pathlib as _pathlib
import signal as _signal
import subprocess
import threading
import time
from datetime import UTC, datetime as _dt
from pathlib import Path

from . import app_state

log = logging.getLogger(__name__)

# Module load timestamp. Heartbeat + shutdown bilanz both read this
# through ``from .lifecycle import _BOOT_TS`` so the uptime stays
# consistent across the maintenance + shutdown paths.
_BOOT_TS = time.time()


def _get_build_info() -> dict:
    """Return build info: ENV vars injected at build time → git subprocess (dev)
    → volume-mounted config/buildinfo.json → baked-in app/buildinfo.json."""
    import json as _json

    env_commit = os.environ.get("BUILD_COMMIT", "").strip()
    if env_commit and env_commit != "dev":
        return {
            "commit": env_commit,
            "date": os.environ.get("BUILD_DATE", "—").strip(),
            "count": os.environ.get("BUILD_COUNT", "—").strip(),
        }
    try:
        repo_root = Path(__file__).resolve().parent.parent.parent
        commit = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%h"],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        ).strip()
        date = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%ci"],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        ).strip()[:10]
        count = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-list", "--count", "HEAD"],
            text=True,
            timeout=4,
            stderr=subprocess.DEVNULL,
        ).strip()
        if commit:
            return {"commit": commit, "date": date, "count": count}
    except Exception:
        pass
    for bi in [
        Path(__file__).resolve().parent.parent / "config" / "buildinfo.json",
        Path(__file__).parent / "buildinfo.json",
    ]:
        try:
            data = _json.loads(bi.read_text())
            if data.get("commit"):
                return data
        except Exception:
            pass
    return {"commit": "dev", "date": "—", "count": "—"}


_BUILD_INFO = _get_build_info()

# Captured once at module load so "Letzter Neustart" on the dashboard reflects
# when the Flask process actually started — distinct from BUILD_DATE, which
# only advances on a code rebuild. For bind-mounted dev setups the container
# often runs code from days ago; users need to see when the restart happened.
_PROCESS_START_ISO = _dt.now(UTC).astimezone().isoformat(timespec="seconds")


def _fetch_github_commit_count():
    """One-shot background fetch of the live commit count from GitHub.
    Git isn't present inside the container, so buildinfo.json is frozen at build time.
    Pulling the real count from the public API keeps the dashboard in sync."""
    import re as _re
    import threading as _thr
    import urllib.request as _ur

    def _do():
        global _BUILD_INFO
        try:
            url = 'https://api.github.com/repos/premiumcola/cam-manager/commits?per_page=1'
            req = _ur.Request(url, headers={'User-Agent': 'tam-spy'})
            with _ur.urlopen(req, timeout=8) as r:
                link = r.headers.get('Link', '') or ''
                m = _re.search(r'page=(\d+)>; rel="last"', link)
                if m:
                    _BUILD_INFO = {**_BUILD_INFO, 'count': m.group(1)}
        except Exception as e:
            logging.getLogger(__name__).debug('GitHub commit count fetch failed: %s', e)

    _thr.Thread(target=_do, daemon=True).start()


_static_hashes: dict[str, str] = {}


def _file_hash(filename: str) -> str:
    if filename not in _static_hashes:
        path = _pathlib.Path(__file__).parent.parent / "web" / "static" / filename
        try:
            _static_hashes[filename] = _hashlib.md5(path.read_bytes()).hexdigest()[:8]
        except Exception:
            _static_hashes[filename] = "0"
    return _static_hashes[filename]


_DISK_FREE_CACHE: list = [0.0, 0.0]  # (last_check_ts, free_gb)


def _disk_free_gb_cached() -> float:
    import shutil as _sh

    now = time.time()
    if (now - _DISK_FREE_CACHE[0]) < 60.0 and _DISK_FREE_CACHE[1] > 0:
        return _DISK_FREE_CACHE[1]
    try:
        free_gb = _sh.disk_usage(str(app_state.storage_root)).free / (1024**3)
    except Exception:
        free_gb = 0.0
    _DISK_FREE_CACHE[0] = now
    _DISK_FREE_CACHE[1] = free_gb
    return free_gb


def _format_uptime(seconds: float) -> str:
    secs = int(max(0, seconds))
    h, rem = divmod(secs, 3600)
    m = rem // 60
    if h >= 24:
        d, h = divmod(h, 24)
        return f"{d}d{h}h{m:02d}m"
    return f"{h}h{m:02d}m"


def _emit_boot_inventory(base_cfg: dict, storage_root: Path):
    """One-time inventory log at process start. Every line prefixed [boot]
    so a single grep tells the operator what got loaded. Cheap — runs once
    and never again."""
    import platform as _plat
    import shutil as _sh
    import subprocess as _sp

    from .logging_setup import console_level

    log = logging.getLogger("app.app.boot")
    settings = app_state.settings
    log.info("[boot] ── Tam-Spy starting ──")
    # Git sha — best-effort. Caches on its own across calls because we
    # only call this once.
    git_sha = "n/a"
    git_branch = ""
    try:
        repo = Path(__file__).resolve().parent.parent.parent
        if (repo / ".git").exists():
            git_sha = (
                _sp.check_output(
                    ["git", "rev-parse", "--short", "HEAD"],
                    cwd=str(repo),
                    stderr=_sp.DEVNULL,
                    timeout=2,
                )
                .decode()
                .strip()
                or "n/a"
            )
            try:
                git_branch = (
                    _sp.check_output(
                        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                        cwd=str(repo),
                        stderr=_sp.DEVNULL,
                        timeout=2,
                    )
                    .decode()
                    .strip()
                )
            except Exception:
                git_branch = ""
    except Exception:
        pass
    build_tag = os.environ.get("BUILD_COMMIT") or os.environ.get("BUILD_DATE") or ""
    log.info(
        "[boot] git: %s%s%s",
        git_sha,
        f" · branch={git_branch}" if git_branch else "",
        f" · build={build_tag}" if build_tag else "",
    )
    # Versions
    try:
        ffmpeg_v = "n/a"
        ffmpeg_bin = _sh.which("ffmpeg")
        if ffmpeg_bin:
            try:
                head = (
                    _sp.check_output([ffmpeg_bin, "-version"], stderr=_sp.STDOUT, timeout=3)
                    .decode(errors="replace")
                    .splitlines()[0]
                )
                # "ffmpeg version 5.1.4 Copyright …" → "5.1.4"
                parts = head.split()
                if len(parts) >= 3:
                    ffmpeg_v = parts[2]
            except Exception:
                ffmpeg_v = "?"
    except Exception:
        ffmpeg_v = "?"
    # cv2 is imported lazily — the top-level server.py shed the global
    # import in the May trim refactor (commit 0de7790) and never
    # reinstated it. Kept local so `inventory` always logs a real
    # OpenCV version instead of triggering a NameError.
    try:
        import cv2 as _cv2  # noqa: PLC0415

        opencv_v = getattr(_cv2, "__version__", "?")
    except Exception:
        opencv_v = "n/a"
    log.info(
        "[boot] python=%s · opencv=%s · ffmpeg=%s · platform=%s",
        _plat.python_version(),
        opencv_v,
        ffmpeg_v,
        _plat.platform(terse=True),
    )
    # RTSP transport line — single source of truth for "what protocol
    # are we asking FFmpeg to use for every cv2.VideoCapture in this
    # process". Set in docker-compose.yml as
    # OPENCV_FFMPEG_CAPTURE_OPTIONS; the snapshot probe in
    # routes/bootstrap.py and the camera runtime in
    # camera_runtime/_capture.py override per-handle when needed but
    # always to the same value. Anything other than "tcp" risks the
    # bottom-strip H.265 corruption seen in the night-test debugging.
    rtsp_opts = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS", "")
    rtsp_transport = "udp"  # FFmpeg default
    for kv in rtsp_opts.split("|") if rtsp_opts else []:
        if kv.startswith("rtsp_transport;"):
            rtsp_transport = kv.split(";", 1)[1] or "udp"
            break
    if rtsp_transport == "tcp":
        log.info("[boot] rtsp transport: tcp (stream loss protection enabled)")
    else:
        log.warning(
            "[boot] rtsp transport: %s — H.265 packet loss may corrupt frames; "
            "set OPENCV_FFMPEG_CAPTURE_OPTIONS=rtsp_transport;tcp",
            rtsp_transport,
        )
    # Paths + log level
    lvl_name = logging.getLevelName(console_level())
    log.info(
        "[boot] storage_root=%s · settings=%s · log_level=%s",
        storage_root,
        storage_root / "settings.json",
        lvl_name,
    )
    # Camera roster — counts, ids, summary. Per-cam bind log lines come
    # later from rebuild_runtimes().
    cams = base_cfg.get("cameras") or settings.data.get("cameras", []) or []
    cam_ids = [c.get("id", "?") for c in cams]
    log.info(
        "[boot] cameras configured: %d (ids: %s)", len(cams), ", ".join(cam_ids) if cam_ids else "—"
    )
    # Detection / classifier setup
    proc = base_cfg.get("processing", {}) or {}
    det = proc.get("detection") or {}
    det_mode = det.get("mode", "motion_only")
    log.info(
        "[boot] detection: mode=%s · model=%s · min_score=%s · region_filter=%s",
        det_mode,
        det.get("coral_model_path") or det.get("cpu_model_path") or "—",
        det.get("min_score", "?"),
        "on" if det.get("region_filter", True) else "off",
    )
    bird = proc.get("bird_species") or {}
    log.info(
        "[boot] bird_classifier: %s · model=%s",
        "enabled" if bird.get("enabled", False) else "disabled",
        bird.get("model_path") or "—",
    )
    wild = proc.get("wildlife") or {}
    log.info(
        "[boot] wildlife_classifier: %s", "enabled" if wild.get("enabled", False) else "disabled"
    )
    # Coral USB presence — best-effort lsusb match. Skip cleanly if lsusb
    # missing (Windows host, etc.).
    coral = "not found"
    try:
        if _sh.which("lsusb"):
            out = _sp.check_output(["lsusb"], stderr=_sp.DEVNULL, timeout=2).decode(
                errors="replace"
            )
            if "Google" in out and "1a6e:089a" in out.replace(" ", ""):
                coral = "found (USB)"
            elif "Global Unichip" in out:
                coral = "found (USB unichip)"
    except Exception:
        pass
    log.info("[boot] coral tpu: %s", coral)
    # Weather + Telegram + MQTT (config snapshots — runtime status comes
    # later when each subsystem starts).
    w = settings.data.get("weather", {}) or {}
    loc = base_cfg.get("server", {}).get("location") or {}
    lat, lon = loc.get("lat"), loc.get("lon")
    elev = loc.get("elevation")
    # Single-line resolved location so misconfigurations are visible
    # in the boot inventory — astral takes lat/lon/elevation, sun
    # event times depend on all three.
    log.info(
        "[boot] location: lat=%s, lon=%s, elevation=%sm",
        lat if lat is not None else "—",
        lon if lon is not None else "—",
        elev if elev is not None else "—",
    )
    log.info(
        "[boot] weather: %s · location=%s · interval=%ss",
        "enabled" if w.get("enabled", True) else "disabled",
        f"{lat},{lon}" if lat is not None and lon is not None else "none",
        w.get("poll_interval", 300),
    )
    tg = settings.data.get("telegram", {}) or {}
    chat_masked = ""
    if tg.get("chat_id"):
        cid = str(tg["chat_id"])
        chat_masked = (cid[:3] + "…" + cid[-3:]) if len(cid) > 6 else cid
    log.info(
        "[boot] telegram: %s · chat=%s",
        "enabled" if tg.get("enabled") else "disabled",
        chat_masked or "—",
    )
    mq = settings.data.get("mqtt", {}) or {}
    log.info(
        "[boot] mqtt: %s · host=%s",
        "enabled" if mq.get("enabled") else "disabled",
        mq.get("host") or "—",
    )


def _startup_media_scan():
    """Scan existing media files on startup in background."""

    def _do_scan():
        try:
            settings = app_state.settings
            store = app_state.store
            base_cfg = app_state.base_cfg
            effective = settings.export_effective_config(base_cfg)
            cam_ids = [c["id"] for c in effective.get("cameras", [])]
            public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
            count = store.scan_media_files(cam_ids, public_base_url=public_base)
            if count:
                logging.getLogger(__name__).info(
                    "[boot] MediaScan: %d orphaned files registered", count
                )
        except Exception as e:
            logging.getLogger(__name__).warning("[boot] MediaScan failed: %s", e)

    t = threading.Thread(target=_do_scan, daemon=True)
    t.start()


def _emit_shutdown_bilanz(reason: str = "signal"):
    """SIGTERM / atexit final log block. Per-cam session totals + closing
    boot line. Best-effort: any individual rt.status() failure is logged
    locally and we keep going."""
    log = logging.getLogger("app.app.boot")
    log.info("[boot] ── Tam-Spy stopping (reason=%s) ──", reason)
    for cam_id, rt in list(app_state.runtimes.items()):
        try:
            st = rt.status() or {}
        except Exception:
            st = {}
        try:
            log.info(
                "[cam:%s] session: today_events=%s reconnects=%s reconnects_24h=%s uptime=%s",
                cam_id,
                st.get("today_events", "?"),
                st.get("reconnect_count", "?"),
                st.get("reconnect_count_24h", "?"),
                _format_uptime(time.time() - _BOOT_TS),
            )
        except Exception:
            pass
    log.info("[boot] ── stopped cleanly ──")


def _install_shutdown_hooks():
    """SIGTERM (docker stop), SIGINT (Ctrl-C), and atexit all funnel into
    _emit_shutdown_bilanz. Idempotent — multiple signals only log once."""
    fired = [False]

    def _once(reason: str):
        if fired[0]:
            return
        fired[0] = True
        try:
            _emit_shutdown_bilanz(reason)
        except Exception as e:
            logging.getLogger("app.app.boot").error(
                "[boot] shutdown bilanz failed: %s",
                e,
                exc_info=True,
            )

    def _sig_handler(signum, frame):
        name = {15: "SIGTERM", 2: "SIGINT"}.get(signum, f"signal {signum}")
        _once(name)

    try:
        _signal.signal(_signal.SIGTERM, _sig_handler)
        _signal.signal(_signal.SIGINT, _sig_handler)
    except Exception as e:
        logging.getLogger("app.app.boot").debug("[boot] signal handler install skipped: %s", e)
    atexit.register(lambda: _once("atexit"))

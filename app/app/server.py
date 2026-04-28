
from __future__ import annotations
import os
import copy as _copy
import json
import threading
import time
from pathlib import Path
from flask import Flask, jsonify, request, Response, send_from_directory, render_template
from datetime import datetime, timedelta
import cv2
import logging
from collections import deque

# Centralised logging setup — installs the explicit StreamHandler with a
# parseable format, the in-memory buffer for the web UI, and the WARNING+
# rate-limit filter. Must run before any subsystem imports that emit logs.
from .logging_setup import setup_logging, log_buffer, console_level
setup_logging()

import socket
import ipaddress
from .config_loader import load_config
from .storage import EventStore
from .camera_runtime import CameraRuntime
from .telegram_bot import TelegramService
from .weather_service import WeatherService
from .cat_identity import IdentityRegistry
from .timelapse import TimelapseBuilder
from .discovery import discover_hosts
from .settings_store import SettingsStore


def _auto_detect_subnet() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return str(ipaddress.IPv4Network(f"{ip}/24", strict=False))
    except Exception:
        return "192.168.1.0/24"
from .mqtt_service import MQTTService

def _get_build_info() -> dict:
    """Return build info: ENV vars injected at build time → git subprocess (dev)
    → volume-mounted config/buildinfo.json → baked-in app/buildinfo.json."""
    import subprocess, json as _json
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
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()
        date = subprocess.check_output(
            ["git", "-C", str(repo_root), "log", "-1", "--format=%ci"],
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()[:10]
        count = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-list", "--count", "HEAD"],
            text=True, timeout=4, stderr=subprocess.DEVNULL).strip()
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
from datetime import datetime as _dt, timezone as _tz
_PROCESS_START_ISO = _dt.now(_tz.utc).astimezone().isoformat(timespec="seconds")


def _fetch_github_commit_count():
    """One-shot background fetch of the live commit count from GitHub.
    Git isn't present inside the container, so buildinfo.json is frozen at build time.
    Pulling the real count from the public API keeps the dashboard in sync."""
    import threading as _thr, urllib.request as _ur, re as _re
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


_fetch_github_commit_count()


base_cfg = load_config()
storage_root = Path(base_cfg["storage"]["root"])
web_root = Path(__file__).resolve().parent.parent / "web"
app = Flask(__name__, template_folder=str(web_root / "templates"), static_folder=str(web_root / "static"))


def _emit_boot_inventory(base_cfg: dict, storage_root: Path):
    """One-time inventory log at process start. Every line prefixed [boot]
    so a single grep tells the operator what got loaded. Cheap — runs once
    and never again."""
    import platform as _plat
    import shutil as _sh
    import subprocess as _sp
    log = logging.getLogger("app.app.boot")
    log.info("[boot] ── Tam-Spy starting ──")
    # Git sha — best-effort. Caches on its own across calls because we
    # only call this once.
    git_sha = "n/a"
    git_branch = ""
    try:
        repo = Path(__file__).resolve().parent.parent.parent
        if (repo / ".git").exists():
            git_sha = _sp.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                cwd=str(repo), stderr=_sp.DEVNULL, timeout=2,
            ).decode().strip() or "n/a"
            try:
                git_branch = _sp.check_output(
                    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                    cwd=str(repo), stderr=_sp.DEVNULL, timeout=2,
                ).decode().strip()
            except Exception:
                git_branch = ""
    except Exception:
        pass
    build_tag = os.environ.get("BUILD_COMMIT") or os.environ.get("BUILD_DATE") or ""
    log.info("[boot] git: %s%s%s", git_sha,
             f" · branch={git_branch}" if git_branch else "",
             f" · build={build_tag}" if build_tag else "")
    # Versions
    try:
        ffmpeg_v = "n/a"
        ffmpeg_bin = _sh.which("ffmpeg")
        if ffmpeg_bin:
            try:
                head = _sp.check_output([ffmpeg_bin, "-version"],
                                         stderr=_sp.STDOUT, timeout=3
                                         ).decode(errors="replace").splitlines()[0]
                # "ffmpeg version 5.1.4 Copyright …" → "5.1.4"
                parts = head.split()
                if len(parts) >= 3:
                    ffmpeg_v = parts[2]
            except Exception:
                ffmpeg_v = "?"
    except Exception:
        ffmpeg_v = "?"
    log.info("[boot] python=%s · opencv=%s · ffmpeg=%s · platform=%s",
             _plat.python_version(), getattr(cv2, "__version__", "?"),
             ffmpeg_v, _plat.platform(terse=True))
    # Paths + log level
    lvl_name = logging.getLevelName(console_level())
    log.info("[boot] storage_root=%s · settings=%s · log_level=%s",
             storage_root, storage_root / "settings.json", lvl_name)
    # Camera roster — counts, ids, summary. Per-cam bind log lines come
    # later from rebuild_runtimes().
    cams = base_cfg.get("cameras") or settings.data.get("cameras", []) or []
    cam_ids = [c.get("id", "?") for c in cams]
    log.info("[boot] cameras configured: %d (ids: %s)",
             len(cams), ", ".join(cam_ids) if cam_ids else "—")
    # Detection / classifier setup
    proc = base_cfg.get("processing", {}) or {}
    det = proc.get("detection") or {}
    det_mode = det.get("mode", "motion_only")
    log.info("[boot] detection: mode=%s · model=%s · min_score=%s · region_filter=%s",
             det_mode, det.get("coral_model_path") or det.get("cpu_model_path") or "—",
             det.get("min_score", "?"),
             "on" if det.get("region_filter", True) else "off")
    bird = proc.get("bird_species") or {}
    log.info("[boot] bird_classifier: %s · model=%s",
             "enabled" if bird.get("enabled", False) else "disabled",
             bird.get("model_path") or "—")
    wild = proc.get("wildlife") or {}
    log.info("[boot] wildlife_classifier: %s",
             "enabled" if wild.get("enabled", False) else "disabled")
    # Coral USB presence — best-effort lsusb match. Skip cleanly if lsusb
    # missing (Windows host, etc.).
    coral = "not found"
    try:
        if _sh.which("lsusb"):
            out = _sp.check_output(["lsusb"], stderr=_sp.DEVNULL, timeout=2
                                    ).decode(errors="replace")
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
    log.info("[boot] weather: %s · location=%s · interval=%ss",
             "enabled" if w.get("enabled", True) else "disabled",
             f"{lat},{lon}" if lat is not None and lon is not None else "none",
             w.get("poll_interval", 300))
    tg = settings.data.get("telegram", {}) or {}
    chat_masked = ""
    if tg.get("chat_id"):
        cid = str(tg["chat_id"])
        chat_masked = (cid[:3] + "…" + cid[-3:]) if len(cid) > 6 else cid
    log.info("[boot] telegram: %s · chat=%s",
             "enabled" if tg.get("enabled") else "disabled",
             chat_masked or "—")
    mq = settings.data.get("mqtt", {}) or {}
    log.info("[boot] mqtt: %s · host=%s",
             "enabled" if mq.get("enabled") else "disabled",
             mq.get("host") or "—")


import hashlib as _hashlib
import pathlib as _pathlib
_static_hashes: dict[str, str] = {}

def _file_hash(filename: str) -> str:
    if filename not in _static_hashes:
        path = _pathlib.Path(__file__).parent.parent / "web" / "static" / filename
        try:
            _static_hashes[filename] = _hashlib.md5(path.read_bytes()).hexdigest()[:8]
        except Exception:
            _static_hashes[filename] = "0"
    return _static_hashes[filename]

app.jinja_env.globals["static_v"] = _file_hash

store = EventStore(str(storage_root))
# storage/object_detection/ used to be pre-created here as a placeholder for
# a feature that never landed (motion_detection events already carry
# classifier results via top_label + detections[]). The startup migration
# below rmdirs it when empty; future per-classifier physical separation,
# if we ever do it, will route by top_label at write time instead.
settings = SettingsStore(storage_root / "settings.json", base_cfg)
# Boot inventory — single block summarising the bootstrap state. Runs
# right after settings load, before any subsystem starts emitting its
# own log lines, so the inventory sits at the top of every restart's
# `docker logs` tail.
try:
    _emit_boot_inventory(base_cfg, storage_root)
except Exception as _e:
    logging.getLogger(__name__).warning("[boot] inventory render failed: %s", _e)
# One-shot semantic-id migration. Idempotent — on a clean boot it logs
# a single "no migration needed" line. Must run BEFORE rebuild_runtimes()
# so the camera threads pick up the new ids on first start, never the old.
try:
    from .storage_migration import migrate as _migrate_storage
    _migrate_storage(settings, storage_root)
except Exception as _e:
    logging.getLogger(__name__).error(
        "[migration] storage migration failed (continuing with existing state): %s", _e,
        exc_info=True,
    )
cfg = settings.export_effective_config(base_cfg)
cat_registry = IdentityRegistry(storage_root / "cat_registry.json", threshold=int(cfg.get("processing", {}).get("cat_identity", {}).get("match_threshold", 10)))
person_registry = IdentityRegistry(storage_root / "person_registry.json", threshold=int(cfg.get("processing", {}).get("person_identity", {}).get("match_threshold", 10)))
timelapse_builder = TimelapseBuilder(storage_root)
mqtt_service = None
telegram_service = None
weather_service = None
runtimes: dict[str, CameraRuntime] = {}
_runtime_cfgs: dict[str, dict] = {}  # cam_id → deep copy of camera cfg at runtime start

# Single-flight lock + last-applied snapshot for telegram reloads. The lock
# prevents two HTTP saves landing simultaneously from each starting a fresh
# polling thread; the snapshot avoids a 3 s slot-wait on every camera-config
# save when nothing telegram-related has actually changed.
_telegram_reload_lock = threading.Lock()
_last_telegram_cfg_snapshot: dict | None = None


def get_effective_config():
    return settings.export_effective_config(base_cfg)


def get_camera_cfg(cam_id: str):
    return settings.get_camera(cam_id)


def _reload_telegram_service():
    """Single source of truth for swapping the TelegramService.

    Stops the old instance fully (so Telegram's getUpdates slot is freed),
    waits 3 s for the API to release the slot, then constructs and starts
    a fresh instance. Skips entirely when the telegram config snapshot is
    unchanged — the common case for camera-config saves."""
    global telegram_service, _last_telegram_cfg_snapshot
    log = logging.getLogger(__name__)
    with _telegram_reload_lock:
        new_cfg = get_effective_config()
        new_tg_cfg = new_cfg.get("telegram", {}) or {}
        if telegram_service is not None and _last_telegram_cfg_snapshot == new_tg_cfg:
            log.debug("[tg] Reload skipped — config unchanged")
            return
        was_polling = False
        if telegram_service is not None:
            try:
                was_polling = telegram_service.get_polling_status().get("state") in (
                    "active", "starting", "conflict",
                )
            except Exception:
                was_polling = False
            try:
                telegram_service.stop(reason="settings reload")
            except Exception as e:
                log.warning("[tg] Stop during reload failed: %s", e)
            telegram_service = None
            # Telegram's getUpdates slot can stay reserved for a couple of
            # seconds after we close it; without this pause the new bot's
            # first poll collides with the tail of the old long-poll and
            # trips the Conflict error in a tight loop.
            if was_polling:
                time.sleep(3)
        log.info("[tg] Starting fresh service after reload")
        telegram_service = TelegramService(
            new_tg_cfg,
            store=store,
            runtimes=runtimes,
            global_cfg=lambda: settings.export_effective_config(base_cfg),
            timelapse_builder=timelapse_builder,
            settings_store=settings,
        )
        telegram_service.start()
        _last_telegram_cfg_snapshot = _copy.deepcopy(new_tg_cfg)
        # Camera runtimes hold their own per-runtime ref to the notifier;
        # push the new service into them so alerts don't keep flowing
        # through the dead instance.
        for rt in runtimes.values():
            rt.notifier = telegram_service


def rebuild_services():
    global cfg, mqtt_service
    cfg = get_effective_config()
    mqtt_service = MQTTService(cfg.get("mqtt", {}))
    _reload_telegram_service()
    # WeatherService: same lifecycle pattern. Builds once per process; on
    # subsequent rebuild_services calls (settings change) it reloads in place.
    global weather_service
    if weather_service is None:
        weather_service = WeatherService(
            cfg.get("weather", {}),
            runtimes=runtimes,
            settings_store=settings,
            server_cfg=cfg.get("server", {}),
            # Pass a getter (NOT the instance) so each call resolves to the
            # current TelegramService — settings reload constructs a fresh
            # instance and rebinds the global, so a cached reference would
            # point at a dead service.
            telegram_getter=lambda: telegram_service,
        )
        weather_service.start()
    else:
        weather_service.reload(cfg.get("weather", {}), server_cfg=cfg.get("server", {}))
    # Existing camera runtimes hold their own references to the previous
    # telegram_service / mqtt_service (assigned in __init__). After a pure
    # services reload (e.g. Telegram or MQTT credential change without a
    # camera-config change), rebuild_runtimes() won't restart any camera —
    # so we have to push the fresh services into every live runtime here,
    # otherwise alerts keep going through the stale (often disabled) object.
    for rt in runtimes.values():
        rt.notifier = telegram_service
        rt.mqtt = mqtt_service


def _compute_camera_diff(
    current_ids: set,
    current_cfgs: dict,
    new_cam_cfgs: dict,
) -> tuple:
    """Return (to_remove, to_add, to_restart) sets based on camera config diff."""
    new_ids = set(new_cam_cfgs)
    to_remove = set(current_ids) - new_ids
    to_add = new_ids - set(current_ids)
    to_restart = {
        cam_id for cam_id in set(current_ids) & new_ids
        if current_cfgs.get(cam_id) != new_cam_cfgs.get(cam_id)
    }
    return to_remove, to_add, to_restart


def restart_single_camera(cam_id: str, *, reason: str = "bound"):
    """Stop and restart one camera runtime with fresh config.

    ``reason`` is the suffix on the success log line — defaults to
    ``bound runtime`` (used by the boot loop) but the per-camera save
    handler passes ``rebound after migration`` when the id was just
    rewritten by storage_migration. Either way the line surfaces a
    successful runtime swap; failures emit an ERROR with stacktrace."""
    log = logging.getLogger(__name__)
    existing = runtimes.pop(cam_id, None)
    if existing:
        existing.stop()
    _runtime_cfgs.pop(cam_id, None)
    cam_cfg = get_camera_cfg(cam_id)
    if not cam_cfg:
        log.info("[boot] cam %s: skipped (not in settings)", cam_id)
        return
    if not cam_cfg.get("enabled", True):
        log.info("[boot] cam %s: skipped (disabled)", cam_id)
        return
    try:
        rt = CameraRuntime(cam_id, get_camera_cfg, cfg, store, telegram_service,
                           mqtt=mqtt_service, cat_registry=cat_registry,
                           person_registry=person_registry)
        runtimes[cam_id] = rt
        _runtime_cfgs[cam_id] = _copy.deepcopy(cam_cfg)
        rt.start()
        if reason == "bound":
            log.info("[boot] cam %s: bound runtime", cam_id)
        else:
            log.info("[boot] cam %s: %s", cam_id, reason)
    except Exception as e:
        log.error("[boot] cam %s: constructor failed: %s — will retry",
                  cam_id, e, exc_info=True)


def rebuild_runtimes():
    global cfg
    cfg = get_effective_config()
    rebuild_services()
    mqtt_service.publish("status/reload", {"time": datetime.now().isoformat(timespec="seconds")})

    new_cam_cfgs: dict = {}
    for cam in cfg.get("cameras", []):
        if cam.get("enabled", True):
            cam_cfg = get_camera_cfg(cam["id"])
            if cam_cfg:
                new_cam_cfgs[cam["id"]] = cam_cfg

    to_remove, to_add, to_restart = _compute_camera_diff(
        set(runtimes.keys()), _runtime_cfgs, new_cam_cfgs
    )

    for cam_id in to_remove:
        rt = runtimes.pop(cam_id)
        rt.stop()
        _runtime_cfgs.pop(cam_id, None)

    for cam_id in to_restart | to_add:
        restart_single_camera(cam_id)

    # One-line boot summary so the operator can see at a glance whether
    # all configured cameras are running. The Telegram fallback path
    # surfaces "missing" cameras to the user; this log line surfaces them
    # to the host shell.
    log = logging.getLogger(__name__)
    expected = list(new_cam_cfgs.keys())
    running = sorted(runtimes.keys())
    missing = sorted(set(expected) - set(running))
    log.info("[boot] runtimes ready: %d camera(s) (ids: %s)%s",
             len(running),
             ", ".join(running) if running else "—",
             f" — {len(missing)} skipped/failed: {', '.join(missing)}" if missing else "")


rebuild_runtimes()
logging.getLogger("app.app.boot").info("[boot] ── inventory complete ──")


def _startup_media_scan():
    """Scan existing media files on startup in background."""
    import threading
    def _do_scan():
        try:
            effective = settings.export_effective_config(base_cfg)
            cam_ids = [c["id"] for c in effective.get("cameras", [])]
            public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
            count = store.scan_media_files(cam_ids, public_base_url=public_base)
            if count:
                logging.getLogger(__name__).info("[boot] MediaScan: %d orphaned files registered", count)
        except Exception as e:
            logging.getLogger(__name__).warning("[boot] MediaScan failed: %s", e)
    t = threading.Thread(target=_do_scan, daemon=True)
    t.start()


_startup_media_scan()


def _run_daily_cleanup():
    import threading
    retention = int(base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = store.cleanup_old(retention)
        if removed:
            logging.getLogger(__name__).info(f"[storage] Removed {removed} old event files (>{retention}d)")
    except Exception as e:
        logging.getLogger(__name__).warning(f"[storage] Failed: {e}")
    t = threading.Timer(86400, _run_daily_cleanup)
    t.daemon = True
    t.start()


_run_daily_cleanup()


# ── Heartbeat + shutdown ─────────────────────────────────────────────────────
_BOOT_TS = time.time()
_DISK_FREE_CACHE: list = [0.0, 0.0]  # (last_check_ts, free_gb)


def _disk_free_gb_cached() -> float:
    import shutil as _sh
    now = time.time()
    if (now - _DISK_FREE_CACHE[0]) < 60.0 and _DISK_FREE_CACHE[1] > 0:
        return _DISK_FREE_CACHE[1]
    try:
        free_gb = _sh.disk_usage(str(storage_root)).free / (1024 ** 3)
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


def _heartbeat_emit():
    """Single periodic [heartbeat] line that summarises every subsystem in
    one row. Reuses values already exposed elsewhere (rt.status(), the
    weather runtime poll ts, the polling status). When something is
    unhealthy, the line escalates to WARNING so the rate-limit filter
    coalesces repeats without losing the signal."""
    log = logging.getLogger("app.app.heartbeat")
    parts = [f"uptime={_format_uptime(time.time() - _BOOT_TS)}"]
    unhealthy = False
    # Camera roster
    cam_bits = []
    cams_iter = list(runtimes.items())
    cam_bits_count = len(cams_iter)
    for cam_id, rt in cams_iter:
        try:
            st = rt.status() or {}
        except Exception:
            st = {}
        name = (st.get("name") or cam_id).split()[0]  # one word per cam keeps the line short
        if st.get("status") in ("active", "starting"):
            fps = st.get("preview_fps") or 0
            r24 = st.get("reconnect_count_24h", 0)
            cam_bits.append(f"{name} {fps:.0f}fps r24h={r24}")
        else:
            age = st.get("frame_age_s")
            age_str = f"{int(age) // 60}m" if isinstance(age, (int, float)) else "?"
            cam_bits.append(f"{name} OFFLINE (last frame {age_str} ago)")
            unhealthy = True
    parts.append(f"cams={cam_bits_count} ({', '.join(cam_bits) if cam_bits else '—'})")
    # Weather
    try:
        last_iso = settings.runtime_get("weather_last_poll_ts")
        if last_iso:
            age_min = int((time.time() - float(last_iso)) / 60)
            if age_min < 15:
                wpart = f"weather=ok (last poll {age_min}m"
            else:
                wpart = f"weather=stale (last poll {age_min}m"
                unhealthy = True
            # Active events from weather_service.status()
            active = []
            try:
                if weather_service:
                    cur = (weather_service.status() or {}).get("current_state") or {}
                    from .weather_service import EVENT_LABEL_DE as _W_LBL
                    active = [_W_LBL.get(k, k) for k, on in cur.items() if on]
            except Exception:
                pass
            wpart += f", active={', '.join(active) if active else 'keine'})"
            parts.append(wpart)
        else:
            parts.append("weather=no-poll-yet")
    except Exception:
        pass
    # Coral inference avg
    coral_avgs = []
    for _id, rt in cams_iter:
        try:
            v = (rt.status() or {}).get("inference_avg_ms")
        except Exception:
            v = None
        if isinstance(v, (int, float)) and v > 0:
            coral_avgs.append(v)
    if coral_avgs:
        parts.append(f"coral={sum(coral_avgs) / len(coral_avgs):.0f}ms")
    # Disk
    free_gb = _disk_free_gb_cached()
    if free_gb < 10:
        parts.append(f"disk={free_gb:.1f}GB free  ⚠")
        unhealthy = True
    elif free_gb < 25:
        parts.append(f"disk={free_gb:.0f}GB free")
        unhealthy = True
    else:
        parts.append(f"disk={free_gb:.0f}GB free")
    # Telegram polling
    try:
        ps = telegram_service.get_polling_status() if telegram_service else {}
    except Exception:
        ps = {}
    pstate = ps.get("state", "?")
    if pstate == "active":
        parts.append(f"tg=polling {ps.get('since_seconds', 0) // 60}m")
    else:
        parts.append(f"tg={pstate}")
        unhealthy = True
    # Emit
    msg = "[heartbeat] " + " · ".join(parts)
    if unhealthy:
        log.warning(msg)
    else:
        log.info(msg)
    # Re-arm.
    t = threading.Timer(300.0, _heartbeat_emit)
    t.daemon = True
    t.start()


# Fire the first heartbeat 60 s after boot so the inventory block + first
# poll cycles have settled before the line lands; subsequent ticks every
# 5 minutes inside the timer loop.
_first_hb = threading.Timer(60.0, _heartbeat_emit)
_first_hb.daemon = True
_first_hb.start()


def _emit_shutdown_bilanz(reason: str = "signal"):
    """SIGTERM / atexit final log block. Per-cam session totals + closing
    boot line. Best-effort: any individual rt.status() failure is logged
    locally and we keep going."""
    log = logging.getLogger("app.app.boot")
    log.info("[boot] ── Tam-Spy stopping (reason=%s) ──", reason)
    for cam_id, rt in list(runtimes.items()):
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
    import atexit
    import signal as _signal
    fired = [False]

    def _once(reason: str):
        if fired[0]:
            return
        fired[0] = True
        try:
            _emit_shutdown_bilanz(reason)
        except Exception as e:
            logging.getLogger("app.app.boot").error(
                "[boot] shutdown bilanz failed: %s", e, exc_info=True,
            )

    def _sig_handler(signum, frame):
        name = {15: "SIGTERM", 2: "SIGINT"}.get(signum, f"signal {signum}")
        _once(name)

    try:
        _signal.signal(_signal.SIGTERM, _sig_handler)
        _signal.signal(_signal.SIGINT, _sig_handler)
    except Exception as e:
        logging.getLogger("app.app.boot").debug(
            "[boot] signal handler install skipped: %s", e
        )
    atexit.register(lambda: _once("atexit"))


_install_shutdown_hooks()


def _migrate_timelapse_events():
    """One-time migration: remove timelapse-type events that were incorrectly stored
    in the EventStore (storage/motion_detection/<cam_id>/) under old code. These are now tracked
    as sidecar JSONs next to the .mp4 files in storage/timelapse/<cam_id>/.
    Covers both date-subdirectory and camera-level tl_*.json placements."""
    import threading, shutil as _shutil
    def _do_migrate():
        log = logging.getLogger(__name__)
        try:
            removed = 0
            events_root = storage_root / "motion_detection"
            if not events_root.exists():
                return
            for cam_dir in events_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                # Remove tl_ files directly in the camera directory (flat placement)
                for jf in list(cam_dir.glob("tl_*.json")):
                    try:
                        jf.unlink()
                        removed += 1
                    except Exception:
                        pass
                # Remove tl_ files inside date subdirectories
                for date_dir in cam_dir.iterdir():
                    if not date_dir.is_dir():
                        continue
                    for jf in list(date_dir.glob("tl_*.json")):
                        try:
                            jf.unlink()
                            removed += 1
                        except Exception:
                            pass
            if removed:
                log.info("[migration] Removed %d stale timelapse events from EventStore", removed)
        except Exception as e:
            log.warning("[migration] Timelapse event migration failed: %s", e)

        # Also clean up stale timelapse_frames dirs for cameras that no longer exist
        try:
            frames_root = storage_root / "timelapse_frames"
            if not frames_root.exists():
                return
            cameras = settings.data.get("cameras") or []
            active_ids = {c["id"] for c in cameras}
            # Build map of which profiles are enabled per camera
            enabled_profiles: dict[str, set] = {}
            for c in cameras:
                tl = c.get("timelapse") or {}
                profs = tl.get("profiles") or {}
                enabled_profiles[c["id"]] = {
                    p for p, cfg in profs.items() if cfg.get("enabled")
                }

            cleaned = 0
            for cam_dir in frames_root.iterdir():
                if not cam_dir.is_dir():
                    continue
                if cam_dir.name not in active_ids:
                    try:
                        _shutil.rmtree(str(cam_dir))
                        cleaned += 1
                        log.info("[migration] Removed frame dir for deleted camera: %s", cam_dir.name)
                    except Exception as e:
                        log.warning("[migration] Could not remove %s: %s", cam_dir.name, e)
                    continue
                # For active cameras: remove frame dirs for DISABLED profiles
                active_profs = enabled_profiles.get(cam_dir.name, set())
                for prof_dir in cam_dir.iterdir():
                    if not prof_dir.is_dir():
                        continue
                    if prof_dir.name not in active_profs:
                        try:
                            _shutil.rmtree(str(prof_dir))
                            cleaned += 1
                            log.info("[migration] Removed frame dir for disabled profile: %s/%s",
                                     cam_dir.name, prof_dir.name)
                        except Exception as e:
                            log.warning("[migration] Could not remove %s: %s", prof_dir, e)
            if cleaned:
                log.info("[migration] Cleaned %d stale frame directories", cleaned)
        except Exception as e:
            log.warning("[migration] Stale frame dir cleanup failed: %s", e)

    threading.Thread(target=_do_migrate, daemon=True).start()


_migrate_timelapse_events()


def _generate_missing_thumbnails():
    """Generate thumbnail .jpg for any timelapse .mp4 that does not have one yet.
    Runs once on startup in background — safe to re-run, skips if thumb exists."""
    import threading, cv2 as _cv2
    def _do():
        log = logging.getLogger(__name__)
        tl_base = storage_root / "timelapse"
        if not tl_base.exists():
            return
        count = 0
        for cam_dir in tl_base.iterdir():
            if not cam_dir.is_dir():
                continue
            for mp4 in cam_dir.glob("*.mp4"):
                thumb = mp4.with_suffix(".jpg")
                if thumb.exists():
                    continue
                try:
                    cap = _cv2.VideoCapture(str(mp4))
                    total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                    if total > 0:
                        cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                    ok, frame = cap.read()
                    cap.release()
                    if ok and frame is not None:
                        tw, th = frame.shape[1], frame.shape[0]
                        if tw > 640:
                            scale = 640 / tw
                            frame = _cv2.resize(frame, (640, int(th * scale)))
                        _cv2.imwrite(str(thumb), frame, [int(_cv2.IMWRITE_JPEG_QUALITY), 80])
                        del frame
                        count += 1
                except Exception as e:
                    log.debug("[thumb] failed for %s: %s", mp4.name, e)
                import time as _time; _time.sleep(0.05)  # pace startup
        if count:
            log.info("[boot] Generated %d missing timelapse thumbnails", count)
    threading.Thread(target=_do, daemon=True).start()


_generate_missing_thumbnails()


def _migrate_timelapse_to_eventstore():
    """Register existing timelapse sidecars as unified EventStore entries.
    Walks storage/timelapse/<cam>/*.json; for each sidecar that has no matching
    motion_detection/<cam>/tl_<stem>.json yet, builds a tl_event dict and calls
    store.add_event(). Safe to re-run; skips entries that already exist."""
    import threading, json as _json
    def _do():
        log = logging.getLogger(__name__)
        tl_root = storage_root / "timelapse"
        if not tl_root.exists():
            return
        cfg = settings.export_effective_config(base_cfg)
        public_base = (cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
        registered = 0
        for cam_dir in tl_root.iterdir():
            if not cam_dir.is_dir():
                continue
            cam_id = cam_dir.name
            event_cam_dir = store.events_dir / cam_id
            existing_ids: set = set()
            if event_cam_dir.exists():
                for jf in event_cam_dir.rglob("*.json"):
                    existing_ids.add(jf.stem)
            for sc in cam_dir.glob("*.json"):
                try:
                    meta = _json.loads(sc.read_text(encoding="utf-8"))
                except Exception:
                    continue
                stem = sc.stem
                event_id = f"tl_{stem}"
                if event_id in existing_ids:
                    continue
                mp4 = cam_dir / f"{stem}.mp4"
                if not mp4.exists():
                    continue
                thumb = cam_dir / f"{stem}.jpg"
                video_rel = f"timelapse/{cam_id}/{mp4.name}"
                thumb_rel = f"timelapse/{cam_id}/{thumb.name}" if thumb.exists() else None
                tl_event = {
                    "event_id": event_id,
                    "camera_id": cam_id,
                    "camera_name": cam_id,
                    "type": "timelapse",
                    "labels": ["timelapse"],
                    "top_label": "timelapse",
                    "time": meta.get("time") or datetime.now().isoformat(timespec="seconds"),
                    "profile": meta.get("profile"),
                    "window_key": meta.get("window_key"),
                    "period_s": meta.get("period_s", 0),
                    "target_s": meta.get("target_s", 0),
                    "frame_count": meta.get("frame_count", 0),
                    "filename": mp4.name,
                    "video_relpath": video_rel,
                    "video_url": f"{public_base}/media/{video_rel}" if public_base else f"/media/{video_rel}",
                    "snapshot_relpath": thumb_rel,
                    "snapshot_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "thumb_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "size_mb": meta.get("size_mb", 0),
                    "duration_s": 0.0,
                    "file_size_bytes": mp4.stat().st_size if mp4.exists() else 0,
                }
                try:
                    store.add_event(cam_id, tl_event)
                    registered += 1
                except Exception as e:
                    log.warning("[migration] timelapse register failed for %s: %s", stem, e)
        if registered:
            log.info("[migration] registered %d timelapse events in EventStore", registered)
    threading.Thread(target=_do, daemon=True).start()


_migrate_timelapse_to_eventstore()


@app.get('/')
def index():
    return render_template('index.html')


@app.get('/media/<path:subpath>')
def media_file(subpath):
    return send_from_directory(storage_root, subpath)


@app.get('/api/logs')
def api_logs():
    level_name = request.args.get('level', 'DEBUG').upper()
    min_level = getattr(logging, level_name, logging.DEBUG)
    subsystem = (request.args.get('subsystem') or '').strip().lower()
    logs = log_buffer.get(min_level)
    if subsystem:
        logs = [l for l in logs if subsystem in (l.get('logger') or '').lower()]
    return jsonify({"logs": logs})


@app.get('/api/bootstrap')
def api_bootstrap():
    return jsonify(settings.bootstrap_state())


@app.get('/api/config')
def api_config():
    c = get_effective_config()
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
        from .detectors import discover_wildlife_paths
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


@app.get('/api/discover')
def api_discover():
    configured = get_effective_config().get("server", {}).get("default_discovery_subnet", "")
    subnet = request.args.get('subnet') or configured or _auto_detect_subnet()
    logging.info(f"[discovery] starting scan on subnet={subnet}")
    cameras, total_scanned = discover_hosts(subnet)
    logging.info(f"[discovery] scan done — {len(cameras)} cameras found out of {total_scanned} hosts")
    return jsonify({"subnet": subnet, "results": cameras, "total_scanned": total_scanned})


@app.get('/api/cameras')
def api_cameras():
    cams = []
    for cam in get_effective_config().get("cameras", []):
        rt = runtimes.get(cam["id"])
        s = rt.status() if rt else {
            "id": cam["id"], "name": cam.get("name", cam["id"]), "location": cam.get("location", ""), "enabled": cam.get("enabled", True),
            "armed": cam.get("armed", True), "status": "disabled", "today_events": 0
        }
        # snap_url / stream_url are dashboard-display-only derived URLs.
        # They MUST use a distinct key so they are never confused with the persisted
        # upstream snapshot_url / rtsp_url (which live in settings.json).
        s["snap_url"] = f"/api/camera/{cam['id']}/snapshot.jpg"
        s["stream_url"] = f"/api/camera/{cam['id']}/stream.mjpg"
        s["stream_url_hd"] = f"/api/camera/{cam['id']}/stream_hd.mjpg"
        # Expose real persisted connection fields from settings so that the edit form
        # and any quick-action spreads ({...cam}) carry the correct upstream values.
        s["snapshot_url"] = cam.get("snapshot_url", "")
        s["rtsp_url"] = cam.get("rtsp_url", "")
        s["username"] = cam.get("username", "")
        s["password"] = cam.get("password", "")
        s["object_filter"] = cam.get("object_filter", [])
        s["telegram_enabled"] = cam.get("telegram_enabled", True)
        s["mqtt_enabled"] = cam.get("mqtt_enabled", True)
        s["whitelist_names"] = cam.get("whitelist_names", [])
        # Unified per-camera schedule. Migration in SettingsStore guarantees
        # the new shape; the legacy recording_schedule_* fields no longer
        # exist in the persisted config.
        s["schedule"] = cam.get("schedule") or {
            "enabled": False, "from": "21:00", "to": "06:00",
            "actions": {"record": True, "telegram": True, "hard": True},
        }
        s["bottom_crop_px"] = cam.get("bottom_crop_px", 0)
        s["motion_sensitivity"] = cam.get("motion_sensitivity", 0.5)
        s["detection_min_score"] = float(cam.get("detection_min_score") or 0.0)
        s["motion_enabled"] = cam.get("motion_enabled", True)
        s["detection_trigger"] = cam.get("detection_trigger", "motion_and_objects")
        s["post_motion_tail_s"] = float(cam.get("post_motion_tail_s") or 0.0)
        s["alarm_profile"] = cam.get("alarm_profile") or ""
        s["zones"] = cam.get("zones", [])
        s["masks"] = cam.get("masks", [])
        s["resolution"] = cam.get("resolution", "auto")
        s["frame_interval_ms"] = cam.get("frame_interval_ms", 350)
        s["snapshot_interval_s"] = cam.get("snapshot_interval_s", 3)
        s["timelapse"] = cam.get("timelapse", {})
        s["weather"] = cam.get("weather") or {"enabled": False}
        cams.append(s)
    return jsonify({"cameras": cams})


@app.get('/api/status')
def api_status():
    return jsonify({
        "cameras": [runtimes[c["id"]].status() if c["id"] in runtimes else {"id": c["id"], "status": "disabled", "name": c.get("name", c["id"])} for c in get_effective_config().get("cameras", [])],
        "cat_profiles": cat_registry.list_profiles(),
        "person_profiles": person_registry.list_profiles(),
        "telegram_actions": settings.data.get("telegram_actions", [])[:12],
    })


@app.get('/api/settings/cameras')
def api_settings_cameras():
    return jsonify({"cameras": settings.data.get("cameras", [])})


_CONN_FIELDS = {"rtsp_url", "snapshot_url", "username", "password", "enabled"}

# Connection-only fields used by the camera-recovery flow. Excludes "enabled"
# because we never want a recovery to silently flip a disabled cam back on.
_RESTORE_CONN_FIELDS = ("rtsp_url", "snapshot_url", "username", "password")


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
    out: list[Path] = []
    for name in ("settings.json.bak", "settings.json.bak2"):
        p = settings.path.parent / name
        if p.exists():
            out.append(p)
    backups_dir = settings.path.parent / "backups"
    if backups_dir.exists():
        out.extend(sorted(backups_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True))
    return out


def _read_backup(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


@app.get('/api/settings/backups')
def api_settings_backups_list():
    """List available settings backups for the recovery UI. Each entry
    summarises the snapshot (mtime, size, total cams) and — when ?cam_id=…
    is supplied — flags whether that backup contains the cam and whether
    its connection fields are usable."""
    cam_id = request.args.get("cam_id") or ""
    items = []
    for p in _list_backup_files():
        try:
            st = p.stat()
        except OSError:
            continue
        data = _read_backup(p)
        n_cameras = len((data or {}).get("cameras", []) or [])
        has_cam = False
        has_connection = False
        if cam_id and isinstance(data, dict):
            for c in data.get("cameras", []) or []:
                if c.get("id") == cam_id:
                    has_cam = True
                    has_connection = bool(c.get("rtsp_url") and c.get("username"))
                    break
        items.append({
            "filename": p.name,
            "mtime_iso": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "size": st.st_size,
            "n_cameras": n_cameras,
            "has_cam": has_cam,
            "has_connection": has_connection,
        })
    return jsonify({"items": items})


@app.get('/api/settings/backups/<filename>/cam/<cam_id>')
def api_settings_backup_cam(filename: str, cam_id: str):
    """Return the connection fields for `cam_id` from the named backup, with
    the password masked so the preview can show what the user is about to
    restore without leaking the secret."""
    if "/" in filename or "\\" in filename or filename.startswith(".."):
        return jsonify({"ok": False, "error": "invalid filename"}), 400
    candidates = [p for p in _list_backup_files() if p.name == filename]
    if not candidates:
        return jsonify({"ok": False, "error": "backup not found"}), 404
    data = _read_backup(candidates[0])
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "backup not parseable"}), 400
    for c in data.get("cameras", []) or []:
        if c.get("id") == cam_id:
            return jsonify({
                "ok": True,
                "cam_id": cam_id,
                "name": c.get("name", ""),
                "rtsp_url_masked": _mask_password_in_url(c.get("rtsp_url", "")),
                "snapshot_url_masked": _mask_password_in_url(c.get("snapshot_url", "")),
                "username": c.get("username", ""),
                "password_set": bool(c.get("password")),
            })
    return jsonify({"ok": False, "error": "cam not in this backup"}), 404


@app.post('/api/settings/cameras/<cam_id>/restore-connection')
def api_settings_cam_restore_connection(cam_id: str):
    """Restore connection-only fields for one camera from a named backup.

    Touches exactly the four fields in _RESTORE_CONN_FIELDS — every other
    field on the cam (zones, schedule, profiles…) and every other camera
    is left alone. Triggers restart_single_camera so the cam comes back
    online without a full reload."""
    payload = request.get_json(force=True) or {}
    filename = (payload.get("filename") or "").strip()
    if "/" in filename or "\\" in filename or filename.startswith("..") or not filename:
        return jsonify({"ok": False, "error": "invalid filename"}), 400
    if not settings.get_camera(cam_id):
        return jsonify({"ok": False, "error": "cam not configured"}), 404
    candidates = [p for p in _list_backup_files() if p.name == filename]
    if not candidates:
        return jsonify({"ok": False, "error": "backup not found"}), 404
    data = _read_backup(candidates[0])
    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "backup not parseable"}), 400
    src = next((c for c in data.get("cameras", []) or [] if c.get("id") == cam_id), None)
    if not src:
        return jsonify({"ok": False, "error": "cam not in this backup"}), 404
    if not src.get("rtsp_url"):
        return jsonify({"ok": False, "error": "backup has empty rtsp_url for this cam"}), 400
    current = settings.get_camera(cam_id) or {}
    patch = {f: src.get(f, "") for f in _RESTORE_CONN_FIELDS}
    merged = {**current, **patch}
    try:
        settings.upsert_camera(merged)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 422
    restart_single_camera(cam_id)
    return jsonify({
        "ok": True,
        "cam_id": cam_id,
        "restored_fields": list(_RESTORE_CONN_FIELDS),
        "from": filename,
    })


@app.post('/api/settings/cameras')
def api_settings_cameras_save():
    global cfg
    payload = request.get_json(force=True) or {}
    if not payload.get("id"):
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    old_id = payload["id"]
    old_cfg = settings.get_camera(old_id) or {}
    # Guard: never persist dashboard-display URLs as the upstream connection fields.
    # These get into the payload when quick-actions spread state.cameras objects.
    for field in ("snapshot_url", "rtsp_url"):
        val = payload.get(field, "")
        if val.startswith("/api/camera/"):
            # Retain the existing persisted value; display-only URLs must not overwrite it.
            preserved = old_cfg.get(field, "")
            payload[field] = preserved
    try:
        new_id = settings.upsert_camera(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    # If the canonical id changed underneath us (manufacturer / model /
    # name / rtsp_url edit triggered storage_migration), the runtime
    # under the OLD id is now orphaned — drop it before binding a fresh
    # one under the NEW id. Without this, every cam-edit save quietly
    # broke the Telegram bot's cam picker for an hour until something
    # else triggered a rebuild_runtimes.
    cfg = get_effective_config()
    enabled_now = payload.get("enabled", True)
    id_renamed = (old_id != new_id)
    conn_changed = any(payload.get(f) != old_cfg.get(f) for f in _CONN_FIELDS)
    if id_renamed:
        existing = runtimes.pop(old_id, None)
        if existing:
            existing.stop()
        _runtime_cfgs.pop(old_id, None)
        if enabled_now:
            restart_single_camera(new_id, reason="rebound after migration")
    elif conn_changed or (new_id not in runtimes and enabled_now):
        restart_single_camera(new_id, reason="rebound after edit")
    return jsonify({
        "ok": True,
        "camera": settings.get_camera(new_id),
        "reloaded": conn_changed or id_renamed,
        "id": new_id,
        "id_renamed_from": old_id if id_renamed else None,
    })


@app.post('/api/camera/<cam_id>/reload')
def api_camera_reload(cam_id: str):
    global cfg
    # Stop existing runtime for this camera only
    existing = runtimes.pop(cam_id, None)
    if existing:
        existing.stop()
    # Reload config and start fresh runtime for this camera
    cfg = get_effective_config()
    cam_cfg = settings.get_camera(cam_id)
    if cam_cfg and cam_cfg.get("enabled", True):
        rt = CameraRuntime(cam_id, get_camera_cfg, cfg, store, telegram_service, mqtt=mqtt_service, cat_registry=cat_registry, person_registry=person_registry)
        runtimes[cam_id] = rt
        rt.start()
    return jsonify({"ok": True, "cam_id": cam_id})


@app.delete('/api/settings/cameras/<cam_id>')
def api_settings_cameras_delete(cam_id):
    # Count existing events so the frontend can warn the user
    cam_dir = store.events_dir / cam_id
    event_count = len(list(cam_dir.glob("*.json"))) if cam_dir.exists() else 0
    deleted = settings.delete_camera(cam_id)
    if not deleted:
        return jsonify({"ok": False, "error": "Kamera nicht gefunden"}), 404
    # Stop the running thread
    rt = runtimes.pop(cam_id, None)
    if rt:
        rt.stop()
    return jsonify({"ok": True, "event_count": event_count})


@app.post('/api/cameras/<source_id>/merge-into/<target_id>')
def api_camera_merge(source_id, target_id):
    """Move all media (events + timelapse) from source camera into target camera,
    rewrite affected JSON metadata so the events appear under the target on disk
    AND in the gallery, then delete the source camera entry from settings.

    Source may be archived (no settings entry, only files on disk) or an
    inactive/error camera that is still configured. Target must be a configured
    camera. Filename collisions get an `_m1`, `_m2`, … suffix; the same suffix
    is applied to the corresponding JSON so JSON ↔ media stay paired.
    """
    import json as _json
    import shutil as _shutil
    if source_id == target_id:
        return jsonify({"ok": False, "error": "Quelle und Ziel sind identisch"}), 400
    if not settings.get_camera(target_id):
        return jsonify({"ok": False, "error": "Ziel-Kamera nicht gefunden"}), 404

    src_events = store.events_dir / source_id
    tgt_events = store.events_dir / target_id
    src_tl = storage_root / "timelapse" / source_id
    tgt_tl = storage_root / "timelapse" / target_id

    moved_files = 0
    moved_events = 0
    moved_timelapses = 0

    def _resolve_collision(dest: Path) -> tuple[Path, str]:
        """Return a non-existing destination path + the suffix that was added.
        Suffix is appended to the stem (event_id) so the matching JSON can use
        the same suffix and stay paired with its media file."""
        if not dest.exists():
            return dest, ""
        for i in range(1, 10000):
            cand = dest.with_name(f"{dest.stem}_m{i}{dest.suffix}")
            if not cand.exists():
                return cand, f"_m{i}"
        raise RuntimeError("zu viele Kollisionen")

    # ── Events: walk JSON files first so we can rewrite + move their media ───
    if src_events.exists():
        tgt_events.mkdir(parents=True, exist_ok=True)
        for json_path in sorted(src_events.rglob("*.json")):
            rel_inside_cam = json_path.relative_to(src_events)
            tgt_json = tgt_events / rel_inside_cam
            tgt_json.parent.mkdir(parents=True, exist_ok=True)
            tgt_json, suffix = _resolve_collision(tgt_json)
            try:
                ev = _json.loads(json_path.read_text(encoding="utf-8"))
            except Exception:
                # Corrupt JSON — just move it raw and skip rewrite
                json_path.rename(tgt_json)
                moved_files += 1
                continue

            old_event_id = ev.get("event_id") or json_path.stem
            new_event_id = old_event_id + suffix
            ev["event_id"] = new_event_id
            ev["camera_id"] = target_id
            ev["camera_name"] = settings.get_camera(target_id).get("name", target_id)

            # Move snapshot + video media files alongside the JSON
            for rel_key, url_key in (("snapshot_relpath", "snapshot_url"),
                                     ("video_relpath", "video_url")):
                rel = ev.get(rel_key)
                if not rel:
                    continue
                src_media = storage_root / rel
                if not src_media.exists():
                    # Stale reference — drop it so the moved JSON isn't an orphan
                    ev[rel_key] = None
                    ev[url_key] = None
                    continue
                # Compute the path inside the source cam dir, then mirror it under target.
                try:
                    media_rel_inside_cam = src_media.relative_to(src_events)
                except ValueError:
                    # Media lives outside the camera tree (unusual) — skip move
                    continue
                tgt_media = tgt_events / media_rel_inside_cam
                tgt_media.parent.mkdir(parents=True, exist_ok=True)
                if suffix:
                    tgt_media = tgt_media.with_name(f"{tgt_media.stem}{suffix}{tgt_media.suffix}")
                # Final collision guard (should already be free thanks to suffix)
                tgt_media, _extra = _resolve_collision(tgt_media)
                src_media.rename(tgt_media)
                new_rel = tgt_media.relative_to(storage_root).as_posix()
                ev[rel_key] = new_rel
                ev[url_key] = f"/media/{new_rel}"
                moved_files += 1

            tgt_json.write_text(_json.dumps(ev, ensure_ascii=False, indent=2), encoding="utf-8")
            json_path.unlink(missing_ok=True)
            moved_events += 1
            moved_files += 1

        # Sweep any orphan media still in the source tree (e.g. files that had
        # no JSON yet — scan_media_files would have registered them later).
        for media in list(src_events.rglob("*")):
            if not media.is_file():
                continue
            rel_inside_cam = media.relative_to(src_events)
            dest = tgt_events / rel_inside_cam
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest, _ = _resolve_collision(dest)
            media.rename(dest)
            moved_files += 1

        # Drop empty directories from the source tree
        try:
            _shutil.rmtree(src_events)
        except Exception:
            pass

    # ── Timelapse: simple file move, no metadata to rewrite ───────────────────
    if src_tl.exists():
        tgt_tl.mkdir(parents=True, exist_ok=True)
        for f in list(src_tl.rglob("*")):
            if not f.is_file():
                continue
            rel = f.relative_to(src_tl)
            dest = tgt_tl / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest, _ = _resolve_collision(dest)
            f.rename(dest)
            moved_files += 1
            moved_timelapses += 1
        try:
            _shutil.rmtree(src_tl)
        except Exception:
            pass

    # ── Drop the source camera entry + stop its runtime ───────────────────────
    if settings.get_camera(source_id):
        settings.delete_camera(source_id)
        rt = runtimes.pop(source_id, None)
        if rt:
            rt.stop()

    return jsonify({
        "ok": True,
        "source_id": source_id,
        "target_id": target_id,
        "moved_files": moved_files,
        "moved_events": moved_events,
        "moved_timelapses": moved_timelapses,
    })


@app.get('/api/settings/app')
def api_settings_app():
    proc = settings.data.get("processing", {})
    eff = get_effective_config().get("processing", {}) or {}
    bird_cfg = eff.get("bird_species", {}) or {}
    wl_cfg = eff.get("wildlife", {}) or {}
    bird_model_path = bird_cfg.get("model_path")
    bird_cpu_path   = bird_cfg.get("cpu_model_path")
    bird_labels_path = bird_cfg.get("labels_path")
    wl_model_path = wl_cfg.get("model_path")
    wl_cpu_path   = wl_cfg.get("cpu_model_path")
    wl_labels_path = wl_cfg.get("labels_path")
    bird_model_available = any(p and Path(p).exists() for p in (bird_model_path, bird_cpu_path))
    bird_labels_available = bool(bird_labels_path and Path(bird_labels_path).exists())
    wl_model_available = any(p and Path(p).exists() for p in (wl_model_path, wl_cpu_path))
    wl_labels_available = bool(wl_labels_path and Path(wl_labels_path).exists())
    # Auto-discover the wildlife model when the configured path is missing
    # or absent on disk. Same heuristic the WildlifeClassifier itself uses,
    # so the API response and runtime stay in sync.
    if not wl_model_available:
        from .detectors import discover_wildlife_paths
        disc = discover_wildlife_paths()
        if disc:
            wl_model_path = disc.get("model_path") or wl_model_path
            wl_cpu_path   = disc.get("cpu_model_path") or wl_cpu_path
            wl_model_available = True
            if not wl_labels_available and disc.get("labels_path"):
                wl_labels_path = disc["labels_path"]
                wl_labels_available = True
    return jsonify({
        "app": settings.data.get("app", {}),
        "server": settings.data.get("server", {}),
        "telegram": settings.data.get("telegram", {}),
        "mqtt": settings.data.get("mqtt", {}),
        "ui": settings.data.get("ui", {}),
        "processing": {
            "coral_enabled": proc.get("detection", {}).get("mode", "none") == "coral",
            "bird_species_enabled": bool(proc.get("bird_species", {}).get("enabled", False)),
            "bird_model_available": bird_model_available,
            "bird_labels_available": bird_labels_available,
            "bird_model_path": bird_model_path,
            "wildlife_enabled": bool(proc.get("wildlife", {}).get("enabled", False)),
            "wildlife_model_available": wl_model_available,
            "wildlife_labels_available": wl_labels_available,
            "wildlife_model_path": wl_model_path,
        },
    })


@app.post('/api/settings/app')
def api_settings_app_save():
    payload = request.get_json(force=True) or {}
    needs_rebuild = False
    try:
        for sec in ("app", "server", "ui", "storage"):
            if sec in payload:
                settings.update_section(sec, payload.get(sec) or {})
        if "telegram" in payload:
            # Telegram credentials change → rebuild_runtimes() picks up the
            # new bot token / chat id so the next test (and any subsequent
            # alert from a camera) uses the fresh service.
            settings.update_section("telegram", payload.get("telegram") or {})
            needs_rebuild = True
        if "mqtt" in payload:
            settings.update_section("mqtt", payload.get("mqtt") or {})
            needs_rebuild = True
        if "processing" in payload:
            proc = payload["processing"]
            sec = {
                "detection": {"mode": "coral" if proc.get("coral_enabled") else "none"},
                "bird_species": {"enabled": bool(proc.get("bird_species_enabled"))},
            }
            # Only touch wildlife if the client actually sent it — otherwise
            # saving the Coral toggles would clobber an existing wildlife
            # config that the user set up separately.
            if "wildlife_enabled" in proc:
                sec["wildlife"] = {"enabled": bool(proc.get("wildlife_enabled"))}
            settings.update_section("processing", sec)
            needs_rebuild = True
        if "weather" in payload:
            # update_section deep-merges (Phase 2 telegram fix), so partial
            # writes like {"events": {"thunder": {"threshold": 800}}} don't
            # wipe sibling keys.
            settings.update_section("weather", payload.get("weather") or {})
            needs_rebuild = True
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    if needs_rebuild:
        rebuild_runtimes()
    return jsonify({"ok": True, "saved": True})


@app.get('/api/settings/export')
def api_settings_export():
    fmt = request.args.get('format', 'json')
    text = settings.export_text(fmt)
    mimetype = 'application/x-yaml' if fmt == 'yaml' else 'application/json'
    return Response(text, mimetype=mimetype, headers={"Content-Disposition": f"attachment; filename=tam-spy-settings.{fmt}"})


@app.post('/api/settings/import')
def api_settings_import():
    payload = request.get_json(force=True) or {}
    fmt = payload.get('format', 'json')
    content = payload.get('content', '')
    try:
        settings.import_text(content, fmt)
        rebuild_runtimes()
        return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400


@app.post('/api/wizard/complete')
def api_wizard_complete():
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
                settings.upsert_camera(cam)
        settings.update_section("ui", {"wizard_completed": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    rebuild_runtimes()
    return jsonify({"ok": True, "bootstrap": settings.bootstrap_state()})


@app.get('/api/media/storage-stats')
def api_media_storage_stats():
    import json as _json
    events_dir = storage_root / "motion_detection"
    tl_root = storage_root / "timelapse"
    active_cams = get_effective_config().get("cameras", [])
    active_ids = {c["id"] for c in active_cams}

    TRACKED_LABELS = {'person', 'cat', 'bird', 'car', 'dog', 'squirrel', 'motion'}
    OBJECT_LABELS = {'person', 'cat', 'bird', 'car', 'dog', 'squirrel'}

    def _cam_stats_dict(cam_id: str, name_hint: str = "") -> dict:
        size_bytes = 0
        jpg_count = 0
        json_count = 0
        latest_snap_url = None
        latest_object_snap_url = None
        resolved_name = name_hint or cam_id
        label_counts: dict = {}
        cam_dir = events_dir / cam_id
        if cam_dir.exists():
            # Count all event media: photos (.jpg/.jpeg) AND video clips (.mp4).
            # Timelapse .mp4s live under storage/timelapse/ (scanned below) — not here.
            for pattern in ("*.jpg", "*.jpeg", "*.mp4"):
                for p in cam_dir.rglob(pattern):
                    try:
                        size_bytes += p.stat().st_size
                        jpg_count += 1
                    except Exception:
                        pass
            json_files = list(cam_dir.rglob("*.json"))
            json_count = len(json_files)
            # Sorted reverse → newest first; break out of the snap searches once both are populated.
            for jf in sorted(json_files, reverse=True):
                try:
                    ev = _json.loads(jf.read_text(encoding="utf-8"))
                    if resolved_name == cam_id:
                        resolved_name = ev.get("camera_name", cam_id)
                    rel = ev.get("snapshot_relpath")
                    vid_rel = ev.get("video_relpath")
                    labels = ev.get("labels") or []
                    snap_exists = bool(rel and (storage_root / rel).exists())
                    media_exists = snap_exists or bool(vid_rel and (storage_root / vid_rel).exists())
                    if snap_exists:
                        if not latest_snap_url:
                            latest_snap_url = f"/media/{rel}"
                        if not latest_object_snap_url and any(l in OBJECT_LABELS for l in labels):
                            latest_object_snap_url = f"/media/{rel}"
                    # Count each event ONCE under its most-specific label so the
                    # filter pills sum to the actual archive size (not the inflated
                    # multi-label total). Object labels win over motion; if no
                    # object label is present, motion catches the rest.
                    if media_exists:
                        primary = next((l for l in labels if l in OBJECT_LABELS), None)
                        if primary is None and 'motion' in labels:
                            primary = 'motion'
                        if primary is None and not labels:
                            primary = 'motion'
                        if primary in TRACKED_LABELS:
                            label_counts[primary] = label_counts.get(primary, 0) + 1
                except Exception:
                    continue
        tl_dir = tl_root / cam_id
        tl_count = 0
        if tl_dir.exists():
            tl_count = len(list(tl_dir.glob("*.mp4")))
            for p in tl_dir.rglob("*"):
                try:
                    if p.is_file():
                        size_bytes += p.stat().st_size
                except Exception:
                    pass
        return {
            "id": cam_id,
            "name": resolved_name,
            "size_mb": round(size_bytes / 1024 / 1024, 1),
            "jpg_count": jpg_count,
            "event_count": json_count,
            "timelapse_count": tl_count,
            "latest_snap_url": latest_snap_url,
            "latest_object_snap_url": latest_object_snap_url,
            "label_counts": label_counts,
        }

    result = [_cam_stats_dict(c["id"], name_hint=c.get("name", c["id"])) for c in active_cams]

    # Archived: media folders for cameras no longer in active config
    archived = []
    seen = set()
    if events_dir.exists():
        for d in sorted(events_dir.iterdir()):
            if not d.is_dir() or d.name in active_ids:
                continue
            s = _cam_stats_dict(d.name)
            if s["jpg_count"] or s["event_count"] or s["timelapse_count"]:
                archived.append(s)
                seen.add(d.name)
    if tl_root.exists():
        for d in sorted(tl_root.iterdir()):
            if not d.is_dir() or d.name in active_ids or d.name in seen:
                continue
            if any(d.glob("*.mp4")):
                archived.append(_cam_stats_dict(d.name))

    return jsonify({"cameras": result, "archived": archived})


@app.post('/api/media/rescan')
def api_media_rescan():
    effective = get_effective_config()
    cam_ids = [c["id"] for c in effective.get("cameras", [])]
    logging.getLogger(__name__).info("[MediaRescan] scanning cam_ids: %s", cam_ids)
    public_base = (effective.get("server", {}).get("public_base_url") or "").rstrip("/")
    try:
        count = store.scan_media_files(cam_ids, public_base_url=public_base)
        return jsonify({"ok": True, "registered": count})
    except Exception as e:
        import traceback
        return jsonify({"ok": False, "error": traceback.format_exc()}), 500


import threading as _threading_fix
_thumb_task = {"running": False, "done": 0, "total": 0, "errors": 0, "recent": []}
_fix_thumbs_lock = _threading_fix.Lock()


@app.post('/api/media/fix-thumbnails')
def api_media_fix_thumbnails():
    """Scan all motion_detection event JSONs; for each event with video_relpath
    but no (valid) snapshot file on disk, extract the middle frame of the mp4
    and save it next to the video. Runs in a background thread; progress via
    GET /api/media/fix-thumbnails/status."""
    import json as _json
    log_t = logging.getLogger(__name__)
    events_root = storage_root / "motion_detection"
    todo: list = []
    if events_root.exists():
        for jf in events_root.rglob("*.json"):
            try:
                ev = _json.loads(jf.read_text(encoding="utf-8"))
                vid_rel = ev.get("video_relpath")
                if not vid_rel:
                    continue
                snap_rel = ev.get("snapshot_relpath")
                snap_ok = bool(snap_rel) and (storage_root / snap_rel).exists()
                if not snap_ok:
                    todo.append((jf, ev))
            except Exception:
                continue

    with _fix_thumbs_lock:
        if _thumb_task["running"]:
            return jsonify({"ok": True, "already_running": True, **_thumb_task})
        _thumb_task["total"] = len(todo)
        _thumb_task["done"] = 0
        _thumb_task["errors"] = 0
        _thumb_task["recent"] = []
        _thumb_task["running"] = True

    public_base = (get_effective_config().get("server", {}).get("public_base_url") or "").rstrip("/")

    def _worker():
        for jf, ev in todo:
            err = False
            try:
                vid_rel = ev.get("video_relpath") or ""
                vid_path = storage_root / vid_rel
                if not vid_path.exists():
                    err = True
                    continue
                cap = cv2.VideoCapture(str(vid_path))
                total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                # Seek to ~1/3 of the clip — the first frame of motion clips is
                # often a dark/gray warm-up frame.
                if total_frames > 3:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, total_frames // 3)
                ok, frame = cap.read()
                cap.release()
                if not ok or frame is None:
                    log_t.warning("[fix-thumbs] no readable frame in %s", vid_path.name)
                    err = True
                    continue
                # Downscale to max 640px wide so thumbs stay small on disk
                tw = frame.shape[1]
                if tw > 640:
                    scale = 640 / tw
                    frame = cv2.resize(frame, (640, int(frame.shape[0] * scale)))
                snap_path = vid_path.with_suffix(".jpg")
                if not cv2.imwrite(str(snap_path), frame,
                                   [int(cv2.IMWRITE_JPEG_QUALITY), 82]):
                    log_t.warning("[fix-thumbs] imwrite failed for %s", snap_path.name)
                    err = True
                    continue
                snap_rel = snap_path.relative_to(storage_root).as_posix()
                snap_url = f"{public_base}/media/{snap_rel}" if public_base else f"/media/{snap_rel}"
                ev["snapshot_relpath"] = snap_rel
                ev["snapshot_url"] = snap_url
                ev["thumb_url"] = snap_url
                jf.write_text(_json.dumps(ev, ensure_ascii=False, indent=2),
                              encoding="utf-8")
                log_t.info("[fix-thumbs] %s -> %s", vid_path.name, snap_path.name)
                with _fix_thumbs_lock:
                    _thumb_task["recent"].append(vid_path.name)
                    if len(_thumb_task["recent"]) > 50:
                        _thumb_task["recent"].pop(0)
            except Exception as e:
                log_t.warning("[fix-thumbs] error on %s: %s", jf.name, e)
                err = True
            finally:
                with _fix_thumbs_lock:
                    _thumb_task["done"] += 1
                    if err:
                        _thumb_task["errors"] += 1
        with _fix_thumbs_lock:
            _thumb_task["running"] = False

    _threading_fix.Thread(target=_worker, daemon=True).start()
    return jsonify({"ok": True, "total": len(todo), "already_running": False})


@app.get('/api/media/fix-thumbnails/status')
def api_media_fix_thumbnails_status():
    with _fix_thumbs_lock:
        return jsonify(dict(_thumb_task))


@app.post('/api/media/purge-orphans')
def api_media_purge_orphans():
    try:
        removed = store.purge_orphans()
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post('/api/media/cleanup')
def api_media_cleanup():
    payload = request.get_json(force=True) or {}
    storage_sec = settings.data.get("storage", {})
    retention = int(payload.get("retention_days") or storage_sec.get("retention_days") or base_cfg.get("storage", {}).get("retention_days", 14))
    try:
        removed = store.cleanup_old(retention)
        return jsonify({"ok": True, "removed": removed})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post('/api/admin/timelapse/cleanup')
def api_admin_timelapse_cleanup():
    """Delete invalid JPEGs from storage/timelapse_frames/.

    Body: {"dry_run": bool, "cam_id": str?, "profile": str?}.
    Returns one summary entry per cam/profile pair so a UI can render
    'scanned X, kept K, deleted D' rows. Finalised .mp4 files are never
    touched — only the JPEG ringbuffer."""
    from .timelapse_cleanup import cleanup as _cleanup
    payload = request.get_json(force=True, silent=True) or {}
    dry_run = bool(payload.get("dry_run", False))
    cam_id = payload.get("cam_id") or None
    profile = payload.get("profile") or None
    storage_root = Path(get_effective_config().get("storage", {}).get("root", "/app/storage"))
    try:
        summaries = _cleanup(storage_root, dry_run=dry_run,
                             cam_id=cam_id, profile=profile)
        total_scanned = sum(s["scanned"] for s in summaries)
        total_deleted = sum(s["deleted"] for s in summaries)
        return jsonify({
            "ok": True,
            "dry_run": dry_run,
            "summaries": summaries,
            "total_scanned": total_scanned,
            "total_deleted": total_deleted,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post('/api/reload')
def api_reload():
    rebuild_runtimes()
    return jsonify({"ok": True})


@app.get('/api/cats')
def api_cats():
    return jsonify({"profiles": cat_registry.list_profiles()})


@app.get('/api/persons')
def api_persons():
    return jsonify({"profiles": person_registry.list_profiles()})


def _register_identity(registry: IdentityRegistry, cam_id: str, identity_type: str):
    payload = request.get_json(force=True, silent=True) or {}
    event_id = payload.get("event_id")
    name = (payload.get("name") or "").strip()
    whitelisted = bool(payload.get("whitelisted", False))
    notes = payload.get("notes", "")
    if not event_id or not name:
        return jsonify({"ok": False, "error": "event_id und name erforderlich"}), 400
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    snap_rel = event.get("snapshot_relpath")
    snap_path = storage_root / snap_rel if snap_rel else None
    if not snap_path or not snap_path.exists():
        return jsonify({"ok": False, "error": "Snapshot-Datei fehlt"}), 404
    img = cv2.imread(str(snap_path))
    if img is None:
        return jsonify({"ok": False, "error": "Snapshot nicht lesbar"}), 400
    det = next((d for d in event.get("detections", []) if d.get("label") == identity_type), None)
    if not det:
        return jsonify({"ok": False, "error": f"Kein {identity_type} in diesem Event"}), 400
    b = det.get("bbox") or {}
    crop = img[max(0, int(b.get("y1", 0))):max(0, int(b.get("y2", 0))), max(0, int(b.get("x1", 0))):max(0, int(b.get("x2", 0)))]
    if crop.size == 0:
        return jsonify({"ok": False, "error": "Crop leer"}), 400
    ok = registry.register_crop(name, crop, whitelisted=whitelisted, notes=notes)
    if ok:
        if identity_type == "cat":
            event["cat_name"] = name
        else:
            event["person_name"] = name
            event["whitelisted"] = whitelisted
        store.update_event(cam_id, event_id, event)
    return jsonify({"ok": bool(ok), "profiles": registry.list_profiles()})


@app.post('/api/camera/<cam_id>/cats/register')
def api_cat_register(cam_id):
    return _register_identity(cat_registry, cam_id, "cat")


@app.post('/api/camera/<cam_id>/persons/register')
def api_person_register(cam_id):
    return _register_identity(person_registry, cam_id, "person")


@app.post('/api/persons/<name>/flags')
def api_person_flags(name):
    payload = request.get_json(force=True, silent=True) or {}
    ok = person_registry.set_profile_flags(name, whitelisted=payload.get("whitelisted"), notes=payload.get("notes"))
    return jsonify({"ok": ok, "profiles": person_registry.list_profiles()})


@app.get('/api/camera/<cam_id>/status')
def api_camera_status(cam_id):
    rt = runtimes.get(cam_id)
    if not rt:
        return jsonify({"ok": False, "error": "camera not running"}), 404
    s = rt.status()
    s["snap_url"] = f"/api/camera/{cam_id}/snapshot.jpg"
    s["stream_url"] = f"/api/camera/{cam_id}/stream.mjpg"
    s["stream_url_hd"] = f"/api/camera/{cam_id}/stream_hd.mjpg"
    return jsonify(s)


@app.get('/api/camera/<cam_id>/snapshot.jpg')
def api_camera_snapshot(cam_id):
    rt = runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    data = rt.snapshot_jpeg()
    if not data:
        return ("no frame", 503)
    return Response(data, mimetype='image/jpeg', headers={'Cache-Control': 'no-store'})


@app.get('/api/camera/<cam_id>/stream.mjpg')
def api_camera_stream(cam_id):
    """Baseline preview stream — sub-stream quality, ~25fps cap.
    Increments live_viewers while connected so stream_mode reflects active users."""
    rt = runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    rt.add_viewer()
    def gen():
        import time as _time
        _interval = 1.0 / 25  # 25 fps cap — avoids busy-spin against shared frame buffer
        try:
            while True:
                t0 = _time.monotonic()
                data = rt.snapshot_jpeg(quality=82)
                if data:
                    yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n')
                gap = _interval - (_time.monotonic() - t0)
                if gap > 0:
                    _time.sleep(gap)
        finally:
            rt.remove_viewer()
    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')


import shutil as _shutil_check
_FFMPEG_AVAILABLE = _shutil_check.which('ffmpeg') is not None


@app.get('/api/camera/<cam_id>/stream_hd.mjpg')
def api_camera_stream_hd(cam_id):
    """Interactive HD stream.

    Preferred path: ffmpeg transcodes the camera's RTSP main stream (H.264 or
    H.265) directly to MJPEG and we pipe that into the HTTP response. This
    avoids OpenCV's flaky H.265 decoder and re-uses the camera's native
    timebase, so playback is smooth and artifact-free.

    Fallback (no ffmpeg binary): read annotated frames from the camera runtime
    preview buffer and re-encode in Python. Slower and may show decode
    artifacts, but keeps the UI functional."""
    cam_cfg = settings.get_camera(cam_id)
    rt = runtimes.get(cam_id)
    rtsp_url = (cam_cfg or {}).get("rtsp_url") if cam_cfg else None

    if _FFMPEG_AVAILABLE and rtsp_url:
        import subprocess
        if rt:
            rt.add_viewer()

        def gen_ffmpeg():
            cmd = [
                'ffmpeg', '-rtsp_transport', 'tcp',
                '-i', rtsp_url,
                '-vf', 'fps=15',
                '-q:v', '4',
                '-f', 'mjpeg',
                '-an',
                'pipe:1',
            ]
            proc = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=1024 * 1024,
                )
                buf = b''
                while True:
                    chunk = proc.stdout.read(8192)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        start = buf.find(b'\xff\xd8')
                        if start < 0:
                            buf = b''
                            break
                        end = buf.find(b'\xff\xd9', start + 2)
                        if end < 0:
                            # Keep the partial JPEG; wait for more bytes
                            if start > 0:
                                buf = buf[start:]
                            break
                        jpeg = buf[start:end + 2]
                        buf = buf[end + 2:]
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n'
                               + jpeg + b'\r\n')
            except GeneratorExit:
                pass
            except Exception as e:
                logging.getLogger(__name__).warning(
                    "[%s] HD ffmpeg stream error: %s", cam_id, e)
            finally:
                if proc is not None:
                    try:
                        proc.kill()
                        proc.wait(timeout=2)
                    except Exception:
                        pass
                if rt:
                    rt.remove_viewer()

        return Response(gen_ffmpeg(),
                        mimetype='multipart/x-mixed-replace; boundary=frame')

    # ── Fallback: OpenCV-based re-encode from the runtime preview buffer ────
    if not rt:
        return ("not running", 404)
    rt.add_viewer()

    def gen_opencv():
        import time as _time
        _interval = 1.0 / 15
        try:
            while True:
                t0 = _time.monotonic()
                with rt.lock:
                    frame = rt.preview.copy() if rt.preview is not None else (
                        rt.frame.copy() if rt.frame is not None else None
                    )
                if frame is not None:
                    ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                    if ok:
                        yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n')
                gap = _interval - (_time.monotonic() - t0)
                if gap > 0:
                    _time.sleep(gap)
        finally:
            rt.remove_viewer()

    return Response(gen_opencv(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.post('/api/camera/<cam_id>/arm')
def api_camera_arm(cam_id):
    payload = request.get_json(force=True, silent=True) or {}
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    cam["armed"] = bool(payload.get("armed", True))
    try:
        settings.upsert_camera(cam)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    mqtt_service.publish(f"camera/{cam_id}/armed", {"armed": cam["armed"]}, retain=True)
    return jsonify({"ok": True, "camera": cam})


@app.get('/api/camera/<cam_id>/media')
def api_camera_media(cam_id):
    label = request.args.get('label')
    labels_raw = request.args.get('labels')
    labels = [l.strip() for l in labels_raw.split(',') if l.strip()] if labels_raw else None
    start = request.args.get('start')
    end = request.args.get('end')
    limit = int(request.args.get('limit') or get_effective_config().get("storage", {}).get("media_limit_default", 24))
    offset = int(request.args.get('offset') or 0)
    items = store.list_events(cam_id, label=label, labels=labels, start=start, end=end, limit=limit, offset=offset, media_only=True)
    total_count = store.count_events(cam_id, label=label, labels=labels, start=start, end=end, media_only=True)
    for item in items:
        review = settings.get_review(f"{cam_id}:{item['event_id']}")
        if review:
            item["review"] = review
    return jsonify({"items": items, "total_count": total_count})


@app.delete('/api/camera/<cam_id>/events/<event_id>')
def api_event_delete(cam_id, event_id):
    result = store.delete_event(cam_id, event_id)
    if not result["json_deleted"]:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    return jsonify({"ok": True, **result})


@app.post('/api/camera/<cam_id>/events/delete-bulk')
def api_event_delete_bulk(cam_id):
    payload = request.get_json(force=True, silent=True) or {}
    raw_ids = payload.get("event_ids")
    if not isinstance(raw_ids, list):
        return jsonify({"ok": False, "error": "event_ids muss eine Liste sein"}), 400
    event_ids = [eid for eid in raw_ids if isinstance(eid, str) and eid]
    if not event_ids:
        return jsonify({"ok": False, "error": "Keine event_ids angegeben"}), 400
    if len(event_ids) > 500:
        return jsonify({"ok": False, "error": "Maximal 500 Events pro Aufruf"}), 400
    deleted = 0
    failed = []
    for eid in event_ids:
        try:
            result = store.delete_event(cam_id, eid)
            if result.get("json_deleted"):
                deleted += 1
            else:
                failed.append(eid)
        except Exception:
            failed.append(eid)
    logging.getLogger(__name__).info("[bulk-delete] cam=%s deleted=%d failed=%d", cam_id, deleted, len(failed))
    return jsonify({"ok": True, "deleted": deleted, "failed": failed})


@app.post('/api/camera/<cam_id>/events/<event_id>/confirm')
def api_event_confirm(cam_id, event_id):
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["confirmed"] = True
    event["confirmed_at"] = datetime.now().isoformat(timespec="seconds")
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True})


@app.post('/api/camera/<cam_id>/events/<event_id>/labels')
def api_event_labels(cam_id, event_id):
    payload = request.get_json(force=True, silent=True) or {}
    labels = payload.get("labels", [])
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    event["labels"] = labels
    # Keep top_label in sync with labels so timeline/badges/stats agree.
    # If the previous top_label was removed, fall back to first remaining label,
    # or "motion" when the user cleared the list entirely.
    prev_top = event.get("top_label")
    if not labels:
        event["top_label"] = "motion"
    elif prev_top not in labels:
        event["top_label"] = labels[0]
    store.update_event(cam_id, event_id, event)
    return jsonify({"ok": True, "labels": labels, "top_label": event["top_label"]})


@app.post('/api/camera/<cam_id>/review/<event_id>')
def api_camera_review(cam_id, event_id):
    payload = request.get_json(force=True, silent=True) or {}
    settings.set_review(f"{cam_id}:{event_id}", payload)
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/stats_range')
def api_camera_stats(cam_id):
    label = request.args.get('label')
    start = request.args.get('start')
    end = request.args.get('end')
    return jsonify(store.stats_range(cam_id, label=label, start=start, end=end))


@app.get('/api/timeline')
def api_timeline():
    label = request.args.get('label')
    cam_id = request.args.get('camera')
    now = datetime.now()
    if request.args.get('hours'):
        hours = request.args.get('hours', type=int, default=168)
        start = (now - timedelta(hours=hours)).isoformat(timespec='seconds')
        period = f'{hours}h'
    else:
        period = request.args.get('period', 'week')
        hours = {'day': 24, 'week': 168, 'month': 720}.get(period, 168)
        start = (now - timedelta(hours=hours)).isoformat(timespec='seconds')
    cameras = [cam_id] if cam_id else [c["id"] for c in settings.data.get("cameras", [])]
    tracks = []
    merged = []
    for idx, cid in enumerate(cameras):
        # media_only=True so events whose JPG was deleted/orphaned no longer show
        # up as stale dots on the timeline.
        ev = store.list_events(cid, label=label, start=start, limit=2000, media_only=True)
        pts = []
        for e in reversed(ev):
            snap_rel = e.get("snapshot_relpath")
            if snap_rel and not (storage_root / snap_rel).exists():
                continue
            pts.append({
                "event_id": e["event_id"],
                "time": e["time"],
                "labels": e.get("labels", []),
                "top_label": e.get("top_label"),
                "alarm_level": e.get("alarm_level", "info"),
                "snapshot_url": e.get("snapshot_url"),
                "y": idx,
            })
            merged.append({"camera_id": cid, **pts[-1]})
        tracks.append({"camera_id": cid, "points": pts})
    merged.sort(key=lambda x: x["time"])
    return jsonify({"period": period, "start": start, "tracks": tracks, "merged": merged})


@app.get('/api/telegram/actions')
def api_telegram_actions():
    return jsonify({"items": settings.data.get("telegram_actions", [])[:40]})


@app.get('/api/telegram/status')
def api_telegram_status():
    """Read-only polling status for the connection-panel badge."""
    if not telegram_service:
        return jsonify({"state": "off", "since_seconds": 0, "enabled": False})
    try:
        return jsonify(telegram_service.get_polling_status())
    except Exception as e:
        return jsonify({"state": "off", "since_seconds": 0, "enabled": False,
                        "error": str(e)}), 500


@app.post('/api/telegram/test')
def api_telegram_test():
    tg_cfg = settings.export_effective_config(base_cfg).get("telegram", {})
    logging.getLogger(__name__).info("[tg] Test: enabled=%s token_set=%s chat_id=%s",
        tg_cfg.get("enabled"), bool(tg_cfg.get("token")), tg_cfg.get("chat_id"))
    if not telegram_service or not telegram_service.enabled:
        reasons = []
        if not tg_cfg.get("enabled"): reasons.append("Telegram nicht aktiviert")
        if not tg_cfg.get("token"): reasons.append("Token fehlt")
        if not tg_cfg.get("chat_id"): reasons.append("Chat-ID fehlt")
        return jsonify({"ok": False, "error": " · ".join(reasons) or "Telegram nicht konfiguriert"}), 400
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    msg = f"TAM-spy Test ✓ Verbindung funktioniert! {ts}"
    try:
        # Route through the persistent send-loop instead of asyncio.run(),
        # which would create+tear-down a new loop on every call and trip
        # "loop is closed" after rapid retries.
        fut = telegram_service.send(msg, parse_mode=None)
        if fut is not None:
            fut.result(timeout=15)
        return jsonify({"ok": True, "message": msg})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get('/api/timelapse/status')
def api_timelapse_status():
    from .camera_runtime import _PROFILES, _PROFILE_PERIOD_DEFAULTS
    today = datetime.now().strftime("%Y-%m-%d")
    tl_settings = settings.data.get("timelapse_settings", {})
    global_enabled = bool(tl_settings.get("global_enabled", False))
    cameras_out = []
    for cam in settings.data.get("cameras", []):
        cam_id = cam["id"]
        tl = cam.get("timelapse") or {}
        profiles = tl.get("profiles") or {}
        cam_fps = int(tl.get("fps", 25))
        prof_status = {}
        any_active = False
        for pname in _PROFILES:
            prof = profiles.get(pname) or {}
            enabled = bool(prof.get("enabled"))
            if enabled:
                any_active = True
            fc = timelapse_builder.frame_count(cam_id, pname, today)
            target_s = int(prof.get("target_seconds", 60))
            period_s = int(prof.get("period_seconds", _PROFILE_PERIOD_DEFAULTS.get(pname, 86400)))
            prof_fps = int(prof.get("fps") or cam_fps)
            # Sub-1s interval is legitimate for short periods (15min → 1min).
            interval_s = round(period_s / max(1, target_s * prof_fps), 2)
            interval_s = max(0.5, interval_s)
            prof_status[pname] = {
                "enabled": enabled,
                "frame_count": fc,
                "interval_s": interval_s,
                "fps": prof_fps,
            }
        cameras_out.append({
            "camera_id": cam_id,
            "name": cam.get("name", cam_id),
            "any_active": any_active,
            "profiles": prof_status,
        })
    total_active = sum(1 for c in cameras_out if c["any_active"])
    return jsonify({
        "ok": True,
        "global_enabled": global_enabled,
        "active_count": total_active,
        "cameras": cameras_out,
        "today": today,
    })


@app.post('/api/settings/timelapse')
def api_settings_timelapse_save():
    payload = request.get_json(force=True) or {}
    ts = settings.data.setdefault("timelapse_settings", {})
    if "global_enabled" in payload:
        ts["global_enabled"] = bool(payload["global_enabled"])
    settings.save()
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/timelapse')
def api_camera_timelapse(cam_id):
    cam_cfg = settings.get_camera(cam_id)
    if not cam_cfg:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    tl_cfg = cam_cfg.get("timelapse") or {}
    if not tl_cfg.get("enabled", False):
        return jsonify({"ok": False, "error": "timelapse disabled"}), 400
    day = request.args.get("day") or datetime.now().strftime("%Y-%m-%d")
    force = request.args.get("force") == "1"
    target_s = int(tl_cfg.get("daily_target_seconds", 60))
    target_fps = int(tl_cfg.get("fps", 25))
    period = tl_cfg.get("period", "day")
    path = timelapse_builder.build_period(
        cam_id, day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=period,
        force=force
    )
    if not path:
        frames_dir = storage_root / "timelapse_frames" / cam_id / day
        day_dir = store.events_dir / cam_id / day
        has_frames = (frames_dir.exists() and any(frames_dir.glob("*.jpg"))) or \
                     (day_dir.exists() and any(day_dir.rglob("*.jpg")))
        if not has_frames:
            return jsonify({"ok": False, "error": "no_frames", "day": day}), 404
        import threading as _thr
        def _bg_build():
            timelapse_builder.build_period(cam_id, day, target_duration_s=target_s,
                                           target_fps=target_fps, period=period, force=True)
        _thr.Thread(target=_bg_build, daemon=True).start()
        return jsonify({"ok": False, "error": "building", "day": day, "retry_after": 15}), 202
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "day": day, "url": f"/media/{rel.as_posix()}"})


@app.get('/api/camera/<cam_id>/timelapse/list')
def api_camera_timelapse_list(cam_id):
    import json as _json
    tl_dir = storage_root / "timelapse" / cam_id
    if not tl_dir.exists():
        return jsonify({"ok": True, "files": []})
    files = []
    for mp4 in sorted(tl_dir.glob("*.mp4"), reverse=True):
        stat = mp4.stat()
        rel = mp4.relative_to(storage_root)
        # Try sidecar JSON first for rich metadata
        meta: dict = {}
        sidecar = tl_dir / f"{mp4.stem}.json"
        if sidecar.exists():
            try:
                meta = _json.loads(sidecar.read_text(encoding="utf-8"))
            except Exception:
                pass
        # Fallback: derive from filename
        # Filename patterns: "2026-04-14_020435_custom.mp4" or "2026-04-14_020435_custom_1min-to-10s.mp4"
        parts = mp4.stem.split("_", 2)
        day = parts[0] if parts else mp4.stem
        period = meta.get("period") or (parts[2].split("_")[0] if len(parts) > 2 else "day")
        # Thumbnail: same stem as video but .jpg (written by _write_video)
        thumb = tl_dir / f"{mp4.stem}.jpg"
        thumb_url = f"/media/{(thumb.relative_to(storage_root)).as_posix()}" if thumb.exists() else None
        files.append({
            "event_id": meta.get("event_id") or f"tl_{mp4.stem}",
            "camera_id": cam_id,
            "type": "timelapse",
            "filename": mp4.name,
            "day": meta.get("window_key", day)[:10],
            "window_key": meta.get("window_key", day),
            "profile": meta.get("profile", period),
            "period": period,
            "period_s": meta.get("period_s", 0),
            "target_s": meta.get("target_s", 0),
            "frame_count": meta.get("frame_count", 0),
            "url": f"/media/{rel.as_posix()}",
            "thumb_url": thumb_url,
            "relpath": rel.as_posix(),
            "size_mb": meta.get("size_mb") or round(stat.st_size / 1024 / 1024, 1),
            "mtime": stat.st_mtime,
            "time": meta.get("time") or day,
        })
    return jsonify({"ok": True, "files": files})


@app.delete('/api/camera/<cam_id>/timelapse/<filename>')
def api_camera_timelapse_delete(cam_id, filename):
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"ok": False, "error": "invalid"}), 400
    mp4 = storage_root / "timelapse" / cam_id / filename
    if not mp4.exists():
        return jsonify({"ok": False, "error": "not found"}), 404
    mp4.unlink()
    # Also delete sidecar JSON and thumbnail if present
    for companion_suffix in (".json", ".jpg"):
        companion = mp4.with_suffix(companion_suffix)
        if companion.exists():
            try:
                companion.unlink()
            except Exception:
                pass
    # And remove the unified EventStore entry so the media grid stays in sync
    try:
        store.delete_event_by_id(cam_id, f"tl_{mp4.stem}")
    except Exception:
        pass
    return jsonify({"ok": True})


@app.get('/api/camera/<cam_id>/timelapse/rolling')
def api_camera_timelapse_rolling(cam_id):
    minutes = int(request.args.get("minutes", 10))
    minutes = max(1, min(minutes, 120))
    cam_cfg = settings.get_camera(cam_id)
    if not cam_cfg:
        return jsonify({"ok": False, "error": "camera not found"}), 404
    tl_cfg = cam_cfg.get("timelapse") or {}
    if not tl_cfg.get("enabled"):
        return jsonify({"ok": False, "error": "timelapse disabled"}), 400
    day = datetime.now().strftime("%Y-%m-%d")
    frames_dir = storage_root / "timelapse_frames" / cam_id / day
    if not frames_dir.exists():
        return jsonify({"ok": False, "error": "no_frames"}), 404
    cutoff = datetime.now() - timedelta(minutes=minutes)
    images = sorted([
        p for p in frames_dir.glob("*.jpg")
        if p.stat().st_mtime >= cutoff.timestamp()
    ])
    if len(images) < 2:
        return jsonify({"ok": False, "error": "not_enough_frames", "minutes": minutes}), 404
    target_fps = int(tl_cfg.get("fps", 25))
    target_s = max(5, int(tl_cfg.get("daily_target_seconds", 60)) // 10)
    path = timelapse_builder.build_period(
        cam_id, day,
        target_duration_s=target_s,
        target_fps=target_fps,
        period=f"rolling{minutes}min",
        force=True,
        images_override=images
    )
    if not path:
        return jsonify({"ok": False, "error": "build_failed"}), 500
    rel = Path(path).relative_to(storage_root)
    return jsonify({"ok": True, "minutes": minutes, "url": f"/media/{rel.as_posix()}"})


# ── Achievements / Sichtungen ────────────────────────────────────────────────
import json as _json_mod
import threading as _threading_mod

_ach_lock = _threading_mod.Lock()
_ach_path = storage_root / "achievements.json"

def _load_achievements() -> dict:
    try:
        if _ach_path.exists():
            return _json_mod.loads(_ach_path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def _save_achievements(data: dict):
    try:
        _ach_path.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logging.getLogger(__name__).warning("achievements save: %s", e)

@app.get('/api/achievements')
def api_achievements_get():
    with _ach_lock:
        return jsonify({"achievements": _load_achievements()})

@app.post('/api/achievements/unlock')
def api_achievements_unlock():
    payload = request.get_json(force=True, silent=True) or {}
    species_id = (payload.get("id") or "").strip().lower()
    if not species_id:
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    with _ach_lock:
        data = _load_achievements()
        already = species_id in data
        if not already:
            data[species_id] = {
                "date": datetime.now().isoformat(timespec="seconds"),
                "camera_id": payload.get("camera_id", ""),
                "species": payload.get("species", species_id),
                "count": 1,
            }
        else:
            data[species_id]["count"] = data[species_id].get("count", 1) + 1
        _save_achievements(data)
    return jsonify({"ok": True, "already_had": already, "achievements": data})


@app.get('/api/achievements/<species_id>/media')
def api_achievements_media(species_id: str):
    """All media events for a species, across every camera. The species
    is identified by its achievement ID (e.g. "gruenfink"); we walk the
    camera_runtime._SPECIES_TO_ACH_ID reverse-map to find every German
    variant that collapses into that ID ("Grünfink" / "Gruenfink") and
    union the results."""
    from .camera_runtime import _SPECIES_TO_ACH_ID
    sid = (species_id or "").strip().lower()
    # Collect every species-name key that maps to this achievement ID
    name_variants = {name for name, ach in _SPECIES_TO_ACH_ID.items() if ach == sid}
    if not name_variants:
        return jsonify({"items": [], "total_count": 0})
    try:
        limit = max(1, int(request.args.get('limit') or 24))
    except ValueError:
        limit = 24
    try:
        offset = max(0, int(request.args.get('offset') or 0))
    except ValueError:
        offset = 0
    cams = get_effective_config().get("cameras", []) or []
    seen_ids: set[str] = set()
    pool: list = []
    for cam in cams:
        cam_id = cam.get("id")
        if not cam_id:
            continue
        for variant in name_variants:
            # list_events sorts desc by time internally. media_only skips
            # metadata-only entries — the drilldown only wants visible cards.
            for ev in store.list_events(cam_id, bird_species=variant, media_only=True, limit=5000):
                eid = ev.get("event_id")
                if not eid or eid in seen_ids:
                    continue
                seen_ids.add(eid)
                # Attach any stored review so the drilldown matches what the
                # main Mediathek shows for the same event.
                review = settings.get_review(f"{cam_id}:{eid}")
                if review:
                    ev["review"] = review
                pool.append(ev)
    pool.sort(key=lambda x: x.get("time", ""), reverse=True)
    total = len(pool)
    page = pool[offset:offset + limit]
    return jsonify({"items": page, "total_count": total})


# ── System info ──────────────────────────────────────────────────────────────
@app.post('/api/coral/test')
def api_coral_test():
    """Run a single object-detection inference for the user to verify the
    Coral/CPU pipeline. Uses a live frame from the requested camera when
    available, otherwise a synthetic test pattern. Returns the annotated
    frame as base64, the detector mode + reason, inference time in ms,
    and the matching lsusb line."""
    import base64 as _b64, time as _time, subprocess as _sp
    from .detectors import CoralObjectDetector, BirdSpeciesClassifier, Detection, draw_detections
    payload = request.get_json(silent=True) or {}
    cam_id = (payload.get("camera_id") or "").strip() or None

    # Detection config from the effective runtime config
    eff = get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}

    # Source frame: camera runtime → snapshot; otherwise a test pattern
    frame = None
    source = "test_pattern"
    camera_name = None
    if cam_id:
        rt = runtimes.get(cam_id)
        if rt is not None:
            with rt.lock:
                # Prefer the clean H.264 sub-stream frame. The main-stream
                # rt.frame is OpenCV's software H.265 decode output, which is
                # riddled with pink/magenta artifacts and unusable for a
                # visual sanity check of Coral detection results.
                if getattr(rt, '_preview_frame', None) is not None:
                    frame = rt._preview_frame.copy()
                elif rt.preview is not None:
                    frame = rt.preview.copy()
                elif rt.frame is not None:
                    frame = rt.frame.copy()
            if frame is not None:
                source = "camera"
                cam_cfg = settings.get_camera(cam_id) or {}
                camera_name = cam_cfg.get("name", cam_id)
    if frame is None:
        import numpy as _np
        frame = _np.zeros((300, 300, 3), dtype=_np.uint8)
        frame[50:150, 50:150] = (255, 120, 0)
        frame[150:250, 100:200] = (80, 200, 0)
        frame[80:120, 200:280] = (50, 100, 180)

    # Fresh detector per test so the result always reflects the current config
    detector = CoralObjectDetector(det_cfg)

    detections: list = []
    infer_ms = 0.0
    err_msg = None
    if detector.available:
        try:
            t0 = _time.perf_counter()
            detections = detector.detect_frame(frame)
            infer_ms = round((_time.perf_counter() - t0) * 1000, 1)
        except Exception as e:
            err_msg = str(e)

    # Optional bird species classification on each bird crop — gives the user
    # immediate feedback in the Coral test panel ("bird 87% → Amsel 72%")
    # instead of only seeing the generic COCO label.
    bird_species_mode = "none"
    bird_species_reason = "disabled"
    if detections and bird_cfg.get("enabled"):
        bird_clf = BirdSpeciesClassifier(bird_cfg)
        bird_species_mode = bird_clf.mode
        bird_species_reason = bird_clf.reason
        if bird_clf.available:
            h_full, w_full = frame.shape[:2]
            for d in detections:
                if d.label != "bird":
                    continue
                x1, y1, x2, y2 = d.bbox
                # Expand the bbox slightly so the classifier sees a little
                # context around the bird — the COCO bbox tends to be tight.
                pad = 6
                cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
                cx2 = min(w_full, x2 + pad); cy2 = min(h_full, y2 + pad)
                crop = frame[cy1:cy2, cx1:cx2]
                if crop is None or crop.size == 0:
                    continue
                try:
                    sp, sp_latin, sp_score = bird_clf.classify_crop(crop)
                except Exception:
                    sp, sp_latin, sp_score = None, None, None
                if sp:
                    d.species = sp
                    d.species_latin = sp_latin
                    d.species_score = float(sp_score) if sp_score is not None else None

    annotated = draw_detections(frame, detections)
    # Keep the preview small for transport (max width 640, JPEG q=80)
    h, w = annotated.shape[:2]
    if w > 640:
        scale = 640 / w
        annotated = cv2.resize(annotated, (640, int(h * scale)))
    ok, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    image_b64 = ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None

    # lsusb line for the Coral stick (best-effort)
    usb_info = None
    try:
        lsusb = _sp.check_output(['lsusb'], text=True, timeout=3, stderr=_sp.DEVNULL)
        for line in lsusb.splitlines():
            low = line.lower()
            if 'google' in low or 'coral' in low or '18d1' in low or '1a6e' in low:
                usb_info = line.strip()
                break
    except Exception:
        pass

    return jsonify({
        "ok": True,
        "detector_mode": detector.mode,
        "detector_available": detector.available,
        "detector_reason": detector.reason,
        "model_path": det_cfg.get("model_path"),
        "bird_species_mode": bird_species_mode,
        "bird_species_reason": bird_species_reason,
        "source": source,
        "camera_id": cam_id,
        "camera_name": camera_name,
        "inference_ms": infer_ms,
        "inference_error": err_msg,
        "detections": [d.to_dict() for d in detections],
        "image_b64": image_b64,
        "usb_info": usb_info,
    })


_TEST_FOLDER_LABELS = {
    "bird":     {"label": "Vogel",        "icon": "🐦"},
    "cat":      {"label": "Katze",        "icon": "🐱"},
    "person":   {"label": "Person",       "icon": "🚶"},
    "car":      {"label": "Auto",         "icon": "🚗"},
    "squirrel": {"label": "Eichhörnchen", "icon": "🐿️"},
    "fox":      {"label": "Fuchs",        "icon": "🦊"},
    "hedgehog": {"label": "Igel",         "icon": "🦔"},
}
_TEST_VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}


@app.get('/api/coral/test-images')
def api_coral_test_images():
    """List subfolders under storage/test_images/ with image counts so the
    Coral test-panel dropdown can populate a 'Testbilder' optgroup."""
    eff = get_effective_config()
    storage_root = Path(eff.get("storage", {}).get("root", "storage"))
    base = storage_root / "test_images"
    if not base.exists():
        return jsonify({"folders": [], "expected_at": str(base)})
    folders = []
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        count = sum(
            1 for p in d.iterdir()
            if p.is_file() and p.suffix.lower() in _TEST_VALID_EXT
        )
        if count == 0:
            continue
        meta = _TEST_FOLDER_LABELS.get(d.name, {})
        folders.append({
            "name":  d.name,
            "count": count,
            "label": meta.get("label", d.name.capitalize()),
            "icon":  meta.get("icon", "📁"),
        })
    return jsonify({"folders": folders})


@app.post('/api/coral/test-batch')
def api_coral_test_batch():
    """Run detect_frame on every image under storage/test_images/<folder>/.

    Body: {"folder": "bird"} runs only that folder. Empty body runs all.
    Returns a per-image breakdown (incl. annotated image_b64 with bounding
    boxes drawn on it) plus a summary of label counts so the user can
    sanity-check object-detection quality without live camera feeds."""
    import base64 as _b64
    import time as _time
    from .detectors import CoralObjectDetector, BirdSpeciesClassifier, WildlifeClassifier, draw_detections
    payload = request.get_json(silent=True) or {}
    folder_filter = (payload.get("folder") or "").strip()

    eff = get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}
    wl_cfg = (eff.get("processing", {}) or {}).get("wildlife", {}) or {}
    storage_root = Path(eff.get("storage", {}).get("root", "storage"))
    base = storage_root / "test_images"
    if not base.exists():
        return jsonify({
            "ok": False,
            "error": "test_images directory not found",
            "expected_at": str(base),
            "results": [],
        }), 404

    if folder_filter:
        candidate_dirs = [base / folder_filter]
    else:
        candidate_dirs = sorted(
            d for d in base.iterdir()
            if d.is_dir() and not d.name.startswith("_")
        )

    detector = CoralObjectDetector(det_cfg)
    if not detector.available:
        return jsonify({
            "ok": False,
            "error": "detector unavailable",
            "detector_mode": detector.mode,
            "detector_reason": detector.reason,
            "results": [],
        })

    # Second-stage bird classifier — only runs when enabled and a bird is
    # detected in the frame. Built once per batch for speed.
    bird_clf = BirdSpeciesClassifier(bird_cfg) if bird_cfg.get("enabled") else None

    # Wildlife classifier (fox/squirrel/hedgehog via ImageNet MobileNetV2).
    # For test-batch we want to mirror the live pipeline AND give honest
    # diagnostics — so when any of the wildlife folders is being tested,
    # build the classifier even if `wildlife.enabled` is False in settings.
    # The user otherwise sees a stream of zeros and can't tell whether the
    # model is broken or simply switched off.
    _WILDLIFE_FOLDERS = {"fox", "hedgehog", "squirrel"}
    target_folders = {d.name for d in candidate_dirs if d.is_dir()}
    needs_wildlife = bool(target_folders & _WILDLIFE_FOLDERS)
    wildlife_settings_enabled = bool(wl_cfg.get("enabled"))
    wl_clf = None
    if wildlife_settings_enabled or needs_wildlife:
        wl_cfg_eff = dict(wl_cfg)
        wl_cfg_eff["enabled"] = True
        wl_clf = WildlifeClassifier(wl_cfg_eff)
    # Surfaced to the response so the UI can explain a 0-detection result
    # in a wildlife folder when the user has wildlife disabled in settings.
    wildlife_disabled_warning = (
        "Wildlife-Erkennung ist deaktiviert — Eichhörnchen/Fuchs/Igel werden nicht erkannt. "
        "In Einstellungen aktivieren."
        if (needs_wildlife and not wildlife_settings_enabled) else None
    )

    results: list = []
    by_label: dict = {}
    total_images = 0
    with_detections = 0
    with_wildlife = 0
    inference_times: list = []
    species_counts: dict = {}
    wildlife_counts: dict = {}

    for d in candidate_dirs:
        if not d.is_dir():
            continue
        for img_path in sorted(d.iterdir()):
            if img_path.suffix.lower() not in _TEST_VALID_EXT:
                continue
            frame = cv2.imread(str(img_path))
            if frame is None:
                results.append({
                    "folder": d.name,
                    "filename": img_path.name,
                    "error": "could not read image",
                })
                continue
            stages_run: list[str] = []
            try:
                t0 = _time.perf_counter()
                dets = detector.detect_frame(frame)
                ms = round((_time.perf_counter() - t0) * 1000, 1)
                stages_run.append("detector")
            except Exception as e:
                results.append({
                    "folder": d.name,
                    "filename": img_path.name,
                    "error": str(e),
                    "stages_run": stages_run,
                })
                continue
            # Species classification on each bird crop when the classifier is on
            if dets and bird_clf is not None and bird_clf.available:
                hh, ww = frame.shape[:2]
                for dd in dets:
                    if dd.label != "bird":
                        continue
                    x1, y1, x2, y2 = dd.bbox
                    pad = 6
                    cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
                    cx2 = min(ww, x2 + pad); cy2 = min(hh, y2 + pad)
                    crop = frame[cy1:cy2, cx1:cx2]
                    if crop is None or crop.size == 0:
                        continue
                    try:
                        sp, sp_latin, sp_score = bird_clf.classify_crop(crop)
                    except Exception:
                        sp, sp_latin, sp_score = None, None, None
                    if sp:
                        dd.species = sp
                        dd.species_latin = sp_latin
                        dd.species_score = float(sp_score) if sp_score is not None else None
                        species_counts[sp] = species_counts.get(sp, 0) + 1
                stages_run.append("bird_classifier")
            # Wildlife (ImageNet) classification — only runs for folders
            # where COCO doesn't have a matching class.
            wildlife_info = None
            if wl_clf is not None and wl_clf.available and d.name in _WILDLIFE_FOLDERS:
                try:
                    cat, raw_lbl, wscore = wl_clf.classify_crop(frame)
                except Exception:
                    cat, raw_lbl, wscore = None, None, None
                fh, fw = frame.shape[:2]
                refined_bbox: tuple[int, int, int, int] | None = None
                if cat:
                    # Localise the animal: re-run COCO at threshold 0.25
                    # and steal the bbox of any animal-shape donor class
                    # (cat/dog/bear/sheep/cow/teddy bear). Mirrors the live
                    # pipeline so the test-batch UI shows the same kind of
                    # detection record the runtime would emit.
                    _DONORS = ("cat", "dog", "bear", "sheep", "cow", "teddy bear")
                    try:
                        low_dets = detector.detect_frame(frame, min_score=0.25) or []
                    except Exception:
                        low_dets = []
                    for ld in low_dets:
                        if ld.label in _DONORS:
                            refined_bbox = tuple(ld.bbox)
                            break
                    # Confident squirrel → suppress overlapping COCO false-
                    # positives (cat/teddy bear/bear/dog) so the event isn't
                    # double-labelled. Same IoU policy as camera_runtime.
                    if cat == "squirrel" and float(wscore or 0) >= 0.55 and refined_bbox is not None:
                        from .camera_runtime import _bbox_iou as _iou
                        _DROP = {"cat", "dog", "bear", "teddy bear"}
                        dets = [
                            dd for dd in dets
                            if not (dd.label in _DROP and _iou(tuple(dd.bbox), refined_bbox) >= 0.3)
                        ]
                    # Promote wildlife hit to a first-class Detection-shaped
                    # entry on the response so the frontend renders it as a
                    # regular pill / bbox alongside person/cat/bird/car/dog.
                    from .detectors import Detection as _Det
                    promoted_bbox = refined_bbox if refined_bbox is not None else (0, 0, int(fw), int(fh))
                    dets.append(_Det(
                        label=cat,
                        score=float(wscore) if wscore is not None else 0.5,
                        bbox=promoted_bbox,
                        raw_cls_id=-1,
                        species=raw_lbl,
                        species_latin=None,
                        species_score=float(wscore) if wscore is not None else None,
                    ))
                if raw_lbl is not None:
                    # Diagnostic info — what ImageNet thought, regardless of
                    # whether we mapped it to a category. The UI uses this
                    # for the "kein Treffer XX%" bottom pill on misses.
                    wildlife_info = {
                        "label": cat,
                        "imagenet": raw_lbl,
                        "score": round(float(wscore), 3) if wscore is not None else None,
                        "bbox": list(refined_bbox) if refined_bbox is not None else [0, 0, int(fw), int(fh)],
                    }
                    if cat:
                        wildlife_counts[cat] = wildlife_counts.get(cat, 0) + 1
                stages_run.append("wildlife_classifier")
            # Encode the RAW frame for transport — bbox overlays are drawn
            # client-side onto a <canvas> so the user sees both COCO and
            # wildlife rectangles with the colour scheme the UI controls.
            # Original image dimensions are reported so the client can
            # rescale bbox coords to the canvas surface.
            orig_h, orig_w = frame.shape[:2]
            transport = frame
            if orig_w > 480:
                scale = 480 / orig_w
                transport = cv2.resize(frame, (480, int(orig_h * scale)))
            ok, buf = cv2.imencode('.jpg', transport, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            image_b64 = ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None
            results.append({
                "folder": d.name,
                "filename": img_path.name,
                "inference_ms": ms,
                "image_b64": image_b64,
                "image_w": int(orig_w),
                "image_h": int(orig_h),
                "stages_run": stages_run,
                "detections": [{
                    "label": dd.label,
                    "score": round(float(dd.score), 3),
                    "bbox": list(dd.bbox),
                    "raw_cls_id": int(dd.raw_cls_id),
                    "species": dd.species,
                    "species_latin": dd.species_latin,
                    "species_score": round(float(dd.species_score), 3) if dd.species_score is not None else None,
                } for dd in dets],
                "wildlife": wildlife_info,
            })
            total_images += 1
            inference_times.append(ms)
            if dets:
                with_detections += 1
                for dd in dets:
                    by_label[dd.label] = by_label.get(dd.label, 0) + 1
            # For wildlife folders, "hit" means either COCO found something
            # or wildlife classifier found fox/squirrel/hedgehog
            if wildlife_info and wildlife_info.get("label"):
                with_wildlife += 1

    response = {
        "ok": True,
        "detector_mode": detector.mode,
        "detector_reason": detector.reason,
        "bird_species_mode": bird_clf.mode if bird_clf else "none",
        "bird_species_reason": bird_clf.reason if bird_clf else "disabled",
        "wildlife_mode": wl_clf.mode if wl_clf else "none",
        "wildlife_reason": wl_clf.reason if wl_clf else "disabled",
        "wildlife_settings_enabled": wildlife_settings_enabled,
        "model_path": det_cfg.get("model_path"),
        "summary": {
            "total_images": total_images,
            "with_detections": with_detections,
            "with_wildlife": with_wildlife,
            "by_label": by_label,
            "by_species": species_counts,
            "by_wildlife": wildlife_counts,
            "avg_ms": round(sum(inference_times) / len(inference_times), 1) if inference_times else 0.0,
        },
        "results": results,
    }
    if wildlife_disabled_warning:
        response["wildlife_disabled_warning"] = wildlife_disabled_warning
    return jsonify(response)


_MODELS_DIR = Path("/app/models")


def _describe_tflite(filename: str) -> str:
    """Return a human-readable description based on common filename patterns.
    Pure heuristics — we never crack the model file itself."""
    low = filename.lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low:
        return "Objekt-Erkennung · Person, Auto, Vogel, Katze, Hund + 75 COCO-Klassen"
    if 'efficientdet' in low:
        return "Objekt-Erkennung · EfficientDet (höhere Genauigkeit, langsamer)"
    if 'bavarian' in low and 'bird' in low:
        return "Vogelarten · Bayerische Gartenvögel (30 Arten)"
    if ('inat' in low and 'bird' in low) or 'inat_bird' in low:
        return "Vogelarten · ~960 Arten weltweit (iNaturalist)"
    if 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        return "Wildtiere · Eichhörnchen, Fuchs, Igel + 997 ImageNet-Klassen"
    if 'bird' in low or 'bavarian' in low:
        return "Vogelarten-Klassifikation"
    if 'classifier' in low or 'classification' in low:
        return "Image classifier"
    if 'posenet' in low or 'pose' in low:
        return "Human pose estimation"
    if 'deeplab' in low or 'segment' in low:
        return "Semantic segmentation"
    return "Custom model"


def _categorize_tflite(filename: str) -> str:
    """Map a model filename to a purpose category. Used by the UI to group
    models into Objekt-Erkennung / Vogelarten / Wildtiere / Sonstige."""
    low = filename.lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low or 'efficientdet' in low:
        return "detection"
    if 'inat' in low or ('bird' in low) or 'bavarian' in low:
        return "bird_species"
    if 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        return "wildlife"
    return "other"


def _labels_for_model(filename: str) -> dict:
    """Best-effort guess of which labels file belongs to a given model.
    Returns {"path": str|None, "filename": str|None, "exists": bool, "count": int|None}."""
    low = filename.lower()
    candidates: list[Path] = []
    if ('ssd' in low and 'mobilenet' in low) or 'efficientdet' in low:
        candidates = [Path("/app/config/coco_labels.example.txt"),
                      Path("/app/config/coco_labels.txt")]
    elif 'inat' in low and 'bird' in low:
        candidates = [Path("/app/models/inat_bird_labels.txt")]
    elif 'bavarian' in low and 'bird' in low:
        candidates = [Path("/app/config/bavarian_birds_common.txt")]
    elif 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        candidates = [Path("/app/models/imagenet_labels.txt")]
    for c in candidates:
        if c.exists():
            try:
                count = sum(1 for ln in c.read_text(encoding="utf-8", errors="ignore").splitlines() if ln.strip())
            except Exception:
                count = None
            return {"path": str(c), "filename": c.name, "exists": True, "count": count}
    # Return the first expected path so the UI can show "fehlt" meaningfully
    if candidates:
        c = candidates[0]
        return {"path": str(c), "filename": c.name, "exists": False, "count": None}
    return {"path": None, "filename": None, "exists": False, "count": None}


@app.get('/api/coral/models')
def api_coral_models():
    """List every .tflite model present in /app/models/, annotated with size,
    a filename-derived description, a purpose category, and the matching
    labels-file (if any). Flags which one is currently loaded per category."""
    eff = get_effective_config()
    proc = eff.get("processing") or {}
    active_by_category = {
        "detection":    (proc.get("detection") or {}).get("model_path"),
        "bird_species": (proc.get("bird_species") or {}).get("model_path"),
        "wildlife":     (proc.get("wildlife") or {}).get("model_path"),
    }
    # Current (legacy field) kept for backward compat
    current = active_by_category.get("detection")
    items: list = []
    if _MODELS_DIR.exists():
        for p in sorted(_MODELS_DIR.glob("*.tflite")):
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            category = _categorize_tflite(p.name)
            active_path = active_by_category.get(category)
            items.append({
                "filename": p.name,
                "path": str(p),
                "size_bytes": size,
                "size_mb": round(size / 1048576, 2),
                "description": _describe_tflite(p.name),
                "edgetpu": "_edgetpu" in p.name.lower(),
                "model_category": category,
                "labels": _labels_for_model(p.name),
                "active": str(p) == current,                       # legacy: detection only
                "active_in_category": str(p) == active_path,        # per-category flag
            })
    return jsonify({
        "ok": True,
        "models": items,
        "current": current,
        "active_by_category": active_by_category,
        "models_dir": str(_MODELS_DIR),
    })


@app.post('/api/coral/models/select')
def api_coral_models_select():
    """Switch the active detection model. The incoming path must live inside
    /app/models/; anything else is rejected to stop directory-traversal
    abuse. Writes through SettingsStore and triggers a runtime rebuild so
    the new detector loads on every camera."""
    payload = request.get_json(silent=True) or {}
    raw_path = (payload.get("path") or "").strip()
    if not raw_path:
        return jsonify({"ok": False, "error": "path required"}), 400
    try:
        target = Path(raw_path).resolve()
        target.relative_to(_MODELS_DIR.resolve())
    except Exception:
        return jsonify({"ok": False, "error": "path must be inside /app/models"}), 400
    if not target.exists() or target.suffix.lower() != ".tflite":
        return jsonify({"ok": False, "error": "model not found"}), 404

    proc = settings.data.setdefault("processing", {})
    det = proc.setdefault("detection", {})
    det["model_path"] = str(target)
    det["mode"] = "coral"
    # cpu_model_path auto-derives the non-_edgetpu variant; keep in sync so
    # the CPU fallback picks up the matching model when pycoral is missing.
    cpu_candidate = str(target).replace("_edgetpu.tflite", ".tflite")
    if cpu_candidate != str(target) and Path(cpu_candidate).exists():
        det["cpu_model_path"] = cpu_candidate
    else:
        det.pop("cpu_model_path", None)
    settings.save()
    try:
        rebuild_runtimes()
    except Exception as e:
        logging.getLogger(__name__).warning("Coral model switch: rebuild_runtimes failed: %s", e)
    return jsonify({"ok": True, "path": str(target)})


# ── Wetter-Sichtungen (Phase 1: read-only API) ───────────────────────────────

@app.get('/api/weather/sightings')
def api_weather_sightings():
    if weather_service is None:
        return jsonify({"items": [], "counts": {}, "total": 0, "page": 0, "page_size": 50})
    try:
        page = int(request.args.get('page', 0))
    except (TypeError, ValueError):
        page = 0
    return jsonify(weather_service.list_sightings(
        cam_id=request.args.get('cam_id') or None,
        event_type=request.args.get('event_type') or None,
        since_iso=request.args.get('from') or None,
        until_iso=request.args.get('to') or None,
        page=page,
    ))


@app.get('/api/event/<event_id>')
def api_event_get(event_id: str):
    """Cross-camera event lookup for Telegram deep-links. Returns enough
    metadata for the frontend hash router to switch to the right cam +
    open the lightbox. 404 when nothing matches."""
    payload = store.find_event_anywhere(event_id) if store else None
    if not payload:
        return jsonify({"error": "not found"}), 404
    return jsonify({
        "event_id":         payload.get("event_id"),
        "camera_id":        payload.get("camera_id"),
        "top_label":        payload.get("top_label") or payload.get("primary_label"),
        "time":             payload.get("time"),
        "video_relpath":    payload.get("video_relpath"),
        "snapshot_relpath": payload.get("snapshot_relpath"),
    })


@app.get('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_get(sighting_id: str):
    if weather_service is None:
        return jsonify({"error": "weather service not available"}), 503
    m = weather_service.get_sighting(sighting_id)
    if not m:
        return jsonify({"error": "not found"}), 404
    return jsonify(m)


@app.get('/api/weather/sightings/<sighting_id>/clip')
def api_weather_sighting_clip(sighting_id: str):
    if weather_service is None:
        return Response(status=503)
    m = weather_service.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("clip_path", "")
    full = storage_root / rel
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@app.get('/api/weather/sightings/<sighting_id>/thumb')
def api_weather_sighting_thumb(sighting_id: str):
    if weather_service is None:
        return Response(status=503)
    m = weather_service.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("thumb_path", "")
    full = storage_root / rel
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='image/jpeg')


@app.delete('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_delete(sighting_id: str):
    if weather_service is None:
        return jsonify({"error": "weather service not available"}), 503
    if weather_service.delete_sighting(sighting_id):
        return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@app.get('/api/weather/sun-times')
def api_weather_sun_times():
    """Today's sunrise/sunset for the configured location, plus per-camera
    sun-timelapse window previews. Powers the live preview row in
    Settings → Wetter."""
    if weather_service is None:
        return jsonify({"location_set": False, "sunrise": None, "sunset": None,
                        "cameras": []})
    return jsonify(weather_service.sun_times_today())


@app.get('/api/weather/recaps')
def api_weather_recaps():
    if weather_service is None:
        return jsonify({"items": []})
    return jsonify({"items": weather_service.list_recaps()})


@app.get('/api/weather/recaps/<recap_id>/clip')
def api_weather_recap_clip(recap_id: str):
    if weather_service is None:
        return Response(status=503)
    m = weather_service.get_recap(recap_id)
    if not m:
        return Response(status=404)
    full = storage_root / m.get("clip_path", "")
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@app.get('/api/weather/status')
def api_weather_status():
    if weather_service is None:
        return jsonify({
            "enabled": False, "last_poll_at": None, "last_api_ok": None,
            "current_state": {}, "current_values": {},
            "location": {"lat": None, "lon": None},
        })
    return jsonify(weather_service.status())


@app.get('/api/weather/history')
def api_weather_history():
    """Backing endpoint for the Wetterstatistik chart. `hours` clamped
    to 1..720 by the service (30 d at default 5-min poll). Returns a
    sample list, per-field thresholds drawn from the configured event
    triggers, units, German labels, and the configured poll interval."""
    if weather_service is None:
        return jsonify({
            "hours": 24, "samples": [], "thresholds": {}, "units": {},
            "labels_de": {}, "fields": [], "poll_interval_s": 300,
        })
    try:
        hours = int(request.args.get("hours", 24))
    except (TypeError, ValueError):
        hours = 24
    return jsonify(weather_service.history(hours))


@app.get('/api/system')
def api_system():
    import time as _time
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
        "storage_root": str(storage_root),
        "camera_count": len(runtimes),
        "coral_device": coral_device,
    })


if __name__ == '__main__':
    app.run(host=cfg.get('server', {}).get('host', '0.0.0.0'), port=int(cfg.get('server', {}).get('port', 8099)), threaded=True)


from __future__ import annotations

import copy as _copy
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request, send_from_directory

# Centralised logging setup — installs the explicit StreamHandler with a
# parseable format, the in-memory buffer for the web UI, and the WARNING+
# rate-limit filter. Must run before any subsystem imports that emit logs.
from .logging_setup import console_level, log_buffer, setup_logging

setup_logging()

import ipaddress
import socket

from . import app_state
from .camera_runtime import CameraRuntime
from .cat_identity import IdentityRegistry
from .config_loader import load_config
from .discovery import discover_hosts
from .settings_store import SettingsStore
from .storage import EventStore, _atomic_write_text
from .telegram_bot import TelegramService
from .timelapse import TimelapseBuilder
from .weather_service import WeatherService


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
from .tracking_worker import TrackingJob, build_worker as build_tracking_worker, tracks_path_for


def _get_build_info() -> dict:
    """Return build info: ENV vars injected at build time → git subprocess (dev)
    → volume-mounted config/buildinfo.json → baked-in app/buildinfo.json."""
    import json as _json
    import subprocess
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
from datetime import UTC, datetime as _dt

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


_fetch_github_commit_count()


base_cfg = load_config()
storage_root = Path(base_cfg["storage"]["root"])
# Mirror into app_state so future blueprints can `from . import app_state`
# and reach the same singletons. server.py keeps its local globals for
# the duration of the migration; both names point at the same object.
app_state.base_cfg = base_cfg
app_state.storage_root = storage_root
web_root = Path(__file__).resolve().parent.parent / "web"

# Concatenate CSS partials into web/static/app.css before Flask boots.
# No-op when the partials dir is empty (e.g. mid-bootstrap), so it's harmless
# regardless of phase. See app/app/css_builder.py + app/web/static/css/README.md
from .css_builder import build_css as _build_css
_build_css(log=logging.getLogger("app.css"))

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
    elev = loc.get("elevation")
    # Single-line resolved location so misconfigurations are visible
    # in the boot inventory — astral takes lat/lon/elevation, sun
    # event times depend on all three.
    log.info("[boot] location: lat=%s, lon=%s, elevation=%sm",
             lat if lat is not None else "—",
             lon if lon is not None else "—",
             elev if elev is not None else "—")
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
app_state.store = store
# storage/object_detection/ used to be pre-created here as a placeholder for
# a feature that never landed (motion_detection events already carry
# classifier results via top_label + detections[]). The startup migration
# below rmdirs it when empty; future per-classifier physical separation,
# if we ever do it, will route by top_label at write time instead.
settings = SettingsStore(storage_root / "settings.json", base_cfg)
app_state.settings = settings
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
# Sun-Timelapse layout split: legacy `weather/<cam>/sun_timelapse/`
# (mixed sunrise+sunset) → per-phase dirs. Idempotent, manifests are
# backed up before rewrite. Touches only weather sighting files; never
# settings.json. Must run before WeatherService starts so the service
# only sees the new layout.
try:
    from .weather_service import migrate_sun_timelapse_layout as _migrate_sun_tl
    _migrate_sun_tl(storage_root)
except Exception as _e:
    logging.getLogger(__name__).error(
        "[migration] sun_timelapse split failed (continuing with existing state): %s", _e,
        exc_info=True,
    )
cfg = settings.export_effective_config(base_cfg)
cat_registry = IdentityRegistry(storage_root / "cat_registry.json", threshold=int(cfg.get("processing", {}).get("cat_identity", {}).get("match_threshold", 10)))
app_state.cat_registry = cat_registry
person_registry = IdentityRegistry(storage_root / "person_registry.json", threshold=int(cfg.get("processing", {}).get("person_identity", {}).get("match_threshold", 10)))
app_state.person_registry = person_registry
timelapse_builder = TimelapseBuilder(storage_root)
app_state.timelapse_builder = timelapse_builder
mqtt_service = None
telegram_service = None
weather_service = None
runtimes: dict[str, CameraRuntime] = {}
_runtime_cfgs: dict[str, dict] = {}  # cam_id → deep copy of camera cfg at runtime start
# Bind the same dict object on both sides so dict mutations
# (runtimes[cam_id] = rt, .pop(...)) are visible to importers of
# app_state without a re-mirror at every mutation site. The service
# globals (mqtt/telegram/weather) get rebound by reassignment, so
# rebuild_services / _reload_telegram_service mirror them explicitly.
app_state.runtimes = runtimes
app_state._runtime_cfgs = _runtime_cfgs

# Register all per-domain route blueprints in one shot. Their handlers
# resolve shared state at request time via `app_state`, so registering
# here (after every singleton has been assigned onto app_state above)
# is safe even though the runtimes / services may still be None at this
# exact moment — they'll be populated by rebuild_services /
# rebuild_runtimes a few hundred lines below.
from .routes import register_blueprints as _register_blueprints
_register_blueprints(app)

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
            app_state.telegram_service = None
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
        app_state.telegram_service = telegram_service
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
    app_state.mqtt_service = mqtt_service
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
        app_state.weather_service = weather_service
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
# Phase 1 object tracking — start the singleton worker right after the
# camera runtimes are up. detection_cfg_getter pulls the live processing
# block from settings on every job so a settings reload swaps the
# detector without restarting the worker thread.
_tracking_cfg_getter = lambda: (
    settings.export_effective_config(base_cfg)
    .get("processing", {})
    .get("detection", {})
)
build_tracking_worker(storage_root=storage_root,
                      detection_cfg_getter=_tracking_cfg_getter,
                      cam_cfg_getter=lambda cam_id: settings.get_camera(cam_id) or {})
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
    import shutil as _shutil
    import threading
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
    import threading

    import cv2 as _cv2
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
    import json as _json
    import threading
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


# /, /media/<path>, /api/bootstrap, /api/config live in
# routes/bootstrap.py since R01.3.
# /api/logs lives in routes/admin.py since R01.2.


# /api/discover, /api/cameras, /api/status live in
# routes/bootstrap.py since R01.3.
# Camera CRUD, settings/cameras, and settings/backups endpoints,
# plus their helpers (_auto_detect_device_info, _mask_password_in_url,
# _list_backup_files, _read_backup, _CONN_FIELDS,
# _RESTORE_CONN_FIELDS), live in routes/cameras.py +
# routes/_camera_helpers.py since R01.3.


@app.post('/api/cameras/<cam_id>/test-alert')
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
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    cam_name = cam.get("name") or cam_id
    caption = f"🧪 Test-Push · {cam_name} · {datetime.now().strftime('%H:%M:%S')}"
    results: dict[str, dict] = {}
    if cam.get("telegram_enabled") and telegram_service is not None and telegram_service.enabled:
        try:
            telegram_service.send_alert_sync(caption=caption, jpeg_bytes=None)
            results["telegram"] = {"ok": True}
        except Exception as e:
            results["telegram"] = {"ok": False, "error": str(e)}
    else:
        reason = "Kanal aus" if not cam.get("telegram_enabled") else "Bot nicht aktiv"
        results["telegram"] = {"ok": False, "error": reason}
    if cam.get("mqtt_enabled") and mqtt_service is not None:
        try:
            payload = {
                "test": True,
                "camera_id": cam_id,
                "camera_name": cam_name,
                "ts": datetime.now().isoformat(timespec="seconds"),
            }
            mqtt_service.publish(f"events/{cam_id}/test", payload)
            results["mqtt"] = {"ok": True}
        except Exception as e:
            results["mqtt"] = {"ok": False, "error": str(e)}
    else:
        reason = "Kanal aus" if not cam.get("mqtt_enabled") else "MQTT nicht konfiguriert"
        results["mqtt"] = {"ok": False, "error": reason}
    any_ok = any(r.get("ok") for r in results.values())
    return jsonify({"ok": any_ok, "channels": results}), (200 if any_ok else 502)


@app.get('/api/system/telegram')
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
        "enabled":         False,
        "connected":       False,
        "last_send_iso":   None,
        "last_send_age_s": None,
    }
    if telegram_service is None:
        return jsonify(out)
    out["enabled"] = bool(getattr(telegram_service, "enabled", False))
    try:
        poll_status = telegram_service.get_polling_status() or {}
        state = (poll_status.get("state") or "").lower()
        out["connected"] = state in ("polling", "running", "active")
    except Exception:
        out["connected"] = False
    last_push = getattr(telegram_service, "_last_push_ts", None)
    if last_push:
        try:
            out["last_send_iso"] = datetime.fromtimestamp(float(last_push)).isoformat(timespec="seconds")
            out["last_send_age_s"] = round(time.time() - float(last_push), 1)
        except Exception:
            pass
    return jsonify(out)


@app.post('/api/cameras/<cam_id>/test-detection')
def api_test_detection(cam_id: str):
    """Run Coral inference on the camera's most-recent frame and return
    each raw detection alongside a verdict — pass / belowthresh /
    filtered — computed against the camera's current configuration
    (detection_min_score, label_thresholds, object_filter). The cam-
    edit "Erkennung jetzt simulieren" button hits this and renders the
    snapshot inline with coloured bounding boxes so the user can see
    exactly what Coral found and which filter dropped what.

    No fresh capture: we read the runtime's last cached frame
    (rt.frame). That frame is at most one frame_interval_ms old and
    avoids the cost / racing of a second RTSP open. Inference runs at
    a low 0.20 threshold so even almost-rejected hits surface in the
    visualisation; the user's actual thresholds are applied afterwards
    to compute the per-detection verdict.
    """
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    rt = runtimes.get(cam_id)
    if rt is None:
        return jsonify({"error": "Kamera-Runtime nicht aktiv (deaktiviert?)"}), 503
    frame = rt.frame.copy() if rt.frame is not None else None
    if frame is None:
        return jsonify({"error": "Noch kein Frame vorhanden — Kamera startet?"}), 503
    detector = getattr(rt, "detector", None)
    if not detector or not getattr(detector, "available", False):
        return jsonify({"error": "Coral nicht verfügbar (motion-only?)"}), 503
    try:
        raw = detector.detect_frame_raw(frame, threshold=0.20)
    except Exception as e:
        log.warning("[test-detection] %s inference failed: %s", cam_id, e)
        return jsonify({"error": f"Inference fehlgeschlagen: {e}"}), 500
    # Resolve the global confidence floor — empty/zero on the camera
    # means "use the global processing.detection.min_score". This must
    # match what camera_runtime actually applies at runtime so the
    # simulation result reflects what would happen in production.
    global_floor = float(cam.get("detection_min_score") or 0.0)
    if global_floor <= 0:
        proc = (get_effective_config().get("processing") or {})
        global_floor = float((proc.get("detection") or {}).get("min_score") or 0.55)
    per_class = cam.get("label_thresholds") or {}
    obj_filter = set(cam.get("object_filter") or [])
    out = []
    for d in raw:
        cls_thresh = float(per_class.get(d.label, global_floor))
        if obj_filter and d.label not in obj_filter:
            verdict = "filtered"
            reason = f"Klasse '{d.label}' nicht im Filter"
        elif d.score < cls_thresh:
            verdict = "belowthresh"
            reason = f"unter Schwelle {int(round(cls_thresh * 100))} %"
        else:
            verdict = "pass"
            reason = ""
        x1, y1, x2, y2 = d.bbox
        out.append({
            "label":   d.label,
            "score":   round(float(d.score), 4),
            "bbox":    [int(x1), int(y1), int(max(0, x2 - x1)), int(max(0, y2 - y1))],
            "verdict": verdict,
            "reason":  reason,
        })
    out.sort(key=lambda r: r["score"], reverse=True)
    # Encode the frame as a base64 data URL so the frontend can display
    # it inline without a separate snapshot fetch (and so the snapshot
    # is the same frame the boxes were computed against).
    try:
        import base64

        import cv2
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        snapshot = f"data:image/jpeg;base64,{base64.b64encode(jpg.tobytes()).decode()}" if ok else None
    except Exception as e:
        log.warning("[test-detection] %s encode failed: %s", cam_id, e)
        snapshot = None
    h, w = frame.shape[:2]
    return jsonify({
        "ok":         True,
        "snapshot":   snapshot,
        "frame_size": {"w": int(w), "h": int(h)},
        "detections": out,
    })


# /api/cameras/<id>/probe-device-info, /api/camera/<id>/reload, and
# DELETE /api/settings/cameras/<id> live in routes/cameras.py since R01.3.


# /api/cameras/<source>/merge-into/<target> lives in routes/cameras.py since R01.3.


# /api/settings/app (GET+POST), /api/settings/export, /api/settings/import,
# and /api/wizard/complete live in routes/cameras.py + routes/bootstrap.py
# since R01.3.


# /api/media/* and /api/event/<id> live in routes/media.py since R01.4.


# /api/admin/timelapse/cleanup and /api/reload live in
# routes/admin.py since R01.2.


# Cat/person identity + achievements endpoints live in
# routes/sichtungen.py since R01.2.


# /api/camera/<id>/status, /api/camera/<id>/snapshot.jpg, and the
# two MJPEG streams live in routes/streams.py since R01.3.

import shutil as _shutil_check

_FFMPEG_AVAILABLE = _shutil_check.which('ffmpeg') is not None


# /api/camera/<id>/arm lives in routes/cameras.py since R01.3.


# /api/camera/<id>/media lives in routes/media.py;
# event CRUD (events/<id>, events/delete-bulk, events/<id>/confirm,
# events/<id>/labels, review/<id>) lives in routes/events.py;
# /api/camera/<id>/stats_range and /api/timeline live in
# routes/timeline_stats.py — all since R01.4.
# Object-tracking sidecar endpoints (`/api/tracking/*`) live in
# routes/tracking.py since R01.2.


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


# Timelapse-related endpoints live in routes/timelapse.py since R01.4.
# Achievements endpoints live in routes/sichtungen.py since R01.2.


# ── System info ──────────────────────────────────────────────────────────────
@app.post('/api/coral/test')
def api_coral_test():
    """Run every classifier stage against a single frame and return a
    per-model breakdown. The user wants to see "what each model would
    say" in the Settings → Modelle test panel — including stages that
    are currently disabled in the runtime, so the test bypasses the
    .enabled flag for the second-stage classifiers.

    Response shape:
      {
        ok, source, camera_id, camera_name, image_b64, usb_info,
        models_run: [
          {category, model, mode, available, reason, inference_ms, results: [...]},
          ...
        ],
        # Legacy flat fields kept for the older test-panel UI:
        detector_mode, detector_available, detector_reason, inference_ms,
        detections, bird_species_mode, bird_species_reason,
      }
    """
    import base64 as _b64
    import os as _os
    import subprocess as _sp
    import time as _time

    from .detectors import (
        BirdSpeciesClassifier,
        CoralObjectDetector,
        WildlifeClassifier,
        draw_detections,
    )
    payload = request.get_json(silent=True) or {}
    cam_id = (payload.get("camera_id") or "").strip() or None

    eff = get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}
    wild_cfg = (eff.get("processing", {}) or {}).get("wildlife", {}) or {}

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

    models_run: list[dict] = []

    # ── Stage 1: COCO detection ──────────────────────────────────────────
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
    models_run.append({
        "category": "detection",
        "model": _os.path.basename(det_cfg.get("model_path") or "") or None,
        "mode": detector.mode,
        "available": bool(detector.available),
        "reason": detector.reason,
        "inference_ms": infer_ms,
        "error": err_msg,
        "results": [d.to_dict() for d in detections],
    })

    # ── Stage 2: bird species classifier ─────────────────────────────────
    # Test-mode override: ignore .enabled so the user can see what the
    # model would say even when the runtime has it switched off.
    bird_test_cfg = dict(bird_cfg)
    bird_test_cfg["enabled"] = True
    bird_clf = BirdSpeciesClassifier(bird_test_cfg)
    bird_results: list[dict] = []
    bird_ms = 0.0
    if bird_clf.available and detections:
        h_full, w_full = frame.shape[:2]
        t0 = _time.perf_counter()
        for d in detections:
            if d.label != "bird":
                continue
            x1, y1, x2, y2 = d.bbox
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
                bird_results.append({
                    "species": sp,
                    "latin": sp_latin,
                    "score": round(float(sp_score), 4) if sp_score is not None else None,
                    "from_label": "bird",
                })
        bird_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append({
        "category": "bird_species",
        "model": _os.path.basename(bird_cfg.get("model_path") or "") or None,
        "mode": bird_clf.mode,
        "available": bool(bird_clf.available),
        "reason": bird_clf.reason,
        "inference_ms": bird_ms,
        "error": None,
        "results": bird_results,
    })

    # ── Stage 3: wildlife classifier (mammals not covered by COCO) ───────
    # Same test-mode override: enabled=True so a CPU-only setup can
    # validate that the wildlife pipeline would work, even if the
    # runtime currently has it disabled. Runs on every detection that
    # is NOT a bird and NOT a person — those are covered upstream.
    wild_test_cfg = dict(wild_cfg)
    wild_test_cfg["enabled"] = True
    wild_clf = WildlifeClassifier(wild_test_cfg)
    wild_results: list[dict] = []
    wild_ms = 0.0
    if wild_clf.available and detections:
        h_full, w_full = frame.shape[:2]
        t0 = _time.perf_counter()
        for d in detections:
            if d.label in ("bird", "person"):
                continue
            x1, y1, x2, y2 = d.bbox
            pad = 6
            cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
            cx2 = min(w_full, x2 + pad); cy2 = min(h_full, y2 + pad)
            crop = frame[cy1:cy2, cx1:cx2]
            if crop is None or crop.size == 0:
                continue
            try:
                category, imagenet_label, score = wild_clf.classify_crop(crop)
            except Exception:
                category, imagenet_label, score = None, None, None
            wild_results.append({
                "from_label": d.label,
                "imagenet": imagenet_label,
                "mapped": category,  # "squirrel" / "fox" / "hedgehog" / null
                "score": round(float(score), 4) if score is not None else None,
            })
        wild_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append({
        "category": "wildlife",
        "model": _os.path.basename(wild_cfg.get("model_path") or "") or None,
        "mode": wild_clf.mode,
        "available": bool(wild_clf.available),
        "reason": wild_clf.reason,
        "inference_ms": wild_ms,
        "error": None,
        "results": wild_results,
    })

    # ── Annotated preview (uses Stage-1 boxes) ──────────────────────────
    annotated = draw_detections(frame, detections)
    h, w = annotated.shape[:2]
    if w > 640:
        scale = 640 / w
        annotated = cv2.resize(annotated, (640, int(h * scale)))
    ok, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    image_b64 = ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None

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
        # Legacy flat fields — older test-panel renderers still read these.
        "detector_mode": detector.mode,
        "detector_available": detector.available,
        "detector_reason": detector.reason,
        "model_path": det_cfg.get("model_path"),
        "bird_species_mode": bird_clf.mode,
        "bird_species_reason": bird_clf.reason,
        "source": source,
        "camera_id": cam_id,
        "camera_name": camera_name,
        "inference_ms": infer_ms,
        "inference_error": err_msg,
        "detections": [d.to_dict() for d in detections],
        "image_b64": image_b64,
        "usb_info": usb_info,
        # New per-model breakdown.
        "models_run": models_run,
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

    from .detectors import (
        BirdSpeciesClassifier,
        CoralObjectDetector,
        WildlifeClassifier,
    )
    payload = request.get_json(silent=True) or {}
    folder_filter = (payload.get("folder") or "").strip()
    # Optional mode dispatch — see ALLOWED_MODES below. Default cascade
    # mirrors the previous behaviour byte-for-byte (plus the new
    # source_model tags).
    _ALLOWED_MODES = (
        "cascade", "coco_only", "bird_species_only",
        "wildlife_only", "all_independent",
    )
    mode = (payload.get("mode") or "cascade").strip()
    if mode not in _ALLOWED_MODES:
        return jsonify({
            "ok": False,
            "error": f"unknown mode: {mode!r}",
            "allowed": list(_ALLOWED_MODES),
        }), 400

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
    # COCO-less modes (bird_species_only, wildlife_only) tolerate the
    # detector being absent — they don't call detect_frame at all. Only
    # the modes that genuinely need COCO short-circuit on unavailability.
    _COCO_MODES = {"cascade", "coco_only", "all_independent"}
    if mode in _COCO_MODES and not detector.available:
        return jsonify({
            "ok": False,
            "error": "detector unavailable",
            "detector_mode": detector.mode,
            "detector_reason": detector.reason,
            "results": [],
        })

    # Build the per-stage classifiers based on the requested mode:
    #   - cascade            → existing behaviour (bird if cfg.enabled,
    #                          wildlife when wildlife folder + cfg ok)
    #   - bird_species_only  → bird classifier always (force-enabled)
    #   - wildlife_only      → wildlife classifier always (force-enabled)
    #   - all_independent    → both always (force-enabled)
    #   - coco_only          → neither
    _BIRD_FORCE = mode in {"bird_species_only", "all_independent"}
    _WL_FORCE = mode in {"wildlife_only", "all_independent"}

    if _BIRD_FORCE or bird_cfg.get("enabled"):
        bird_eff = dict(bird_cfg)
        if _BIRD_FORCE:
            bird_eff["enabled"] = True
        bird_clf = BirdSpeciesClassifier(bird_eff)
    else:
        bird_clf = None

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
    if _WL_FORCE or wildlife_settings_enabled or needs_wildlife:
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

    from .detectors import Detection as _Det

    def _classify_bird_full(frame_arg):
        """Run the bird classifier on the full frame; return Detection
        or None. Used by bird_species_only and all_independent modes."""
        if not (bird_clf and bird_clf.available):
            return None
        try:
            sp, sp_latin, sp_score = bird_clf.classify_crop(frame_arg)
        except Exception:
            return None
        if not sp:
            return None
        fh2, fw2 = frame_arg.shape[:2]
        return _Det(
            label="bird",
            score=float(sp_score) if sp_score is not None else 0.5,
            bbox=(0, 0, int(fw2), int(fh2)),
            raw_cls_id=-1,
            species=sp,
            species_latin=sp_latin,
            species_score=float(sp_score) if sp_score is not None else None,
        )

    def _classify_wildlife_full(frame_arg):
        """Run the wildlife classifier on the full frame; return
        (Detection|None, info_dict|None). Ungated — no folder check, no
        cat→squirrel override, no overlap suppression. Used by
        wildlife_only and all_independent."""
        if not (wl_clf and wl_clf.available):
            return None, None
        try:
            cat, raw_lbl, wscore = wl_clf.classify_crop(frame_arg)
        except Exception:
            return None, None
        fh2, fw2 = frame_arg.shape[:2]
        full_bbox = (0, 0, int(fw2), int(fh2))
        det = None
        if cat or raw_lbl:
            det = _Det(
                label=cat if cat else (raw_lbl or "?"),
                score=float(wscore) if wscore is not None else 0.0,
                bbox=full_bbox,
                raw_cls_id=-1,
                species=raw_lbl,
                species_latin=None,
                species_score=float(wscore) if wscore is not None else None,
            )
        info = None
        if raw_lbl is not None:
            info = {
                "label": cat,
                "imagenet": raw_lbl,
                "score": round(float(wscore), 3) if wscore is not None else None,
                "bbox": list(full_bbox),
            }
        return det, info

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
            # `tagged` carries (Detection, source_model_str) pairs so we
            # can serialise per-detection model attribution in one place
            # at the end of the loop body.
            tagged: list[tuple] = []
            ms = 0.0
            wildlife_info = None

            if mode in _COCO_MODES:
                try:
                    t0 = _time.perf_counter()
                    coco_dets = detector.detect_frame(frame)
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
            else:
                coco_dets = []

            if mode == "cascade":
                # Existing cascade flow — preserved byte-for-byte except
                # for the new source_model tagging.
                dets = list(coco_dets)
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
                if wl_clf is not None and wl_clf.available and d.name in _WILDLIFE_FOLDERS:
                    try:
                        cat, raw_lbl, wscore = wl_clf.classify_crop(frame)
                    except Exception:
                        cat, raw_lbl, wscore = None, None, None
                    fh, fw = frame.shape[:2]
                    refined_bbox: tuple[int, int, int, int] | None = None
                    if cat:
                        _DONORS = ("cat", "dog", "bear", "sheep", "cow", "teddy bear")
                        try:
                            low_dets = detector.detect_frame(frame, min_score=0.25) or []
                        except Exception:
                            low_dets = []
                        for ld in low_dets:
                            if ld.label in _DONORS:
                                refined_bbox = tuple(ld.bbox)
                                break
                        if cat == "squirrel" and float(wscore or 0) >= 0.55 and refined_bbox is not None:
                            from .camera_runtime import _bbox_iou as _iou
                            _DROP = {"cat", "dog", "bear", "teddy bear"}
                            dets = [
                                dd for dd in dets
                                if not (dd.label in _DROP and _iou(tuple(dd.bbox), refined_bbox) >= 0.3)
                            ]
                        promoted_bbox = refined_bbox if refined_bbox is not None else (0, 0, int(fw), int(fh))
                        # Promoted wildlife hit gets a "wildlife" tag.
                        tagged.append((_Det(
                            label=cat,
                            score=float(wscore) if wscore is not None else 0.5,
                            bbox=promoted_bbox,
                            raw_cls_id=-1,
                            species=raw_lbl,
                            species_latin=None,
                            species_score=float(wscore) if wscore is not None else None,
                        ), "wildlife"))
                    if raw_lbl is not None:
                        wildlife_info = {
                            "label": cat,
                            "imagenet": raw_lbl,
                            "score": round(float(wscore), 3) if wscore is not None else None,
                            "bbox": list(refined_bbox) if refined_bbox is not None else [0, 0, int(fw), int(fh)],
                        }
                        if cat:
                            wildlife_counts[cat] = wildlife_counts.get(cat, 0) + 1
                    stages_run.append("wildlife_classifier")
                # Surviving COCO detections come first so the response order
                # matches the legacy cascade ordering exactly.
                tagged = [(dd, "coco") for dd in dets] + tagged

            elif mode == "coco_only":
                tagged = [(dd, "coco") for dd in coco_dets]

            elif mode == "bird_species_only":
                bird_det = _classify_bird_full(frame)
                if bird_det is not None:
                    tagged.append((bird_det, "bird_species"))
                    if bird_det.species:
                        species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
                    stages_run.append("bird_classifier_full")

            elif mode == "wildlife_only":
                wl_det, wl_info = _classify_wildlife_full(frame)
                if wl_det is not None:
                    tagged.append((wl_det, "wildlife"))
                    if wl_det.label and wl_det.label != "?":
                        wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
                    stages_run.append("wildlife_classifier_full")
                wildlife_info = wl_info

            elif mode == "all_independent":
                # COCO entries come first, in their natural detector order.
                tagged = [(dd, "coco") for dd in coco_dets]
                # Bird classifier on full frame, ungated.
                bird_det = _classify_bird_full(frame)
                if bird_det is not None:
                    tagged.append((bird_det, "bird_species"))
                    if bird_det.species:
                        species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
                    stages_run.append("bird_classifier_full")
                # Wildlife on full frame, ungated. NO suppression, NO
                # cat→squirrel override — the whole point is to see the
                # raw, independent verdict from each model.
                wl_det, wl_info = _classify_wildlife_full(frame)
                if wl_det is not None:
                    tagged.append((wl_det, "wildlife"))
                    if wl_det.label and wl_det.label != "?":
                        wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
                    stages_run.append("wildlife_classifier_full")
                wildlife_info = wl_info
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
                    "source_model": src,
                } for (dd, src) in tagged],
                "wildlife": wildlife_info,
            })
            total_images += 1
            inference_times.append(ms)
            if tagged:
                with_detections += 1
                for (dd, _src) in tagged:
                    by_label[dd.label] = by_label.get(dd.label, 0) + 1
            # For wildlife folders, "hit" means either COCO found something
            # or wildlife classifier found fox/squirrel/hedgehog
            if wildlife_info and wildlife_info.get("label"):
                with_wildlife += 1

    # Per-model availability badge for the UI's status strip. Nicknames
    # come from the new _nickname_tflite helper so the test panel can
    # render short pill-friendly labels rather than the raw filenames.
    def _model_card(cfg, clf, default_reason):
        fname = Path((cfg or {}).get("model_path") or "").name
        return {
            "nickname": _nickname_tflite(fname),
            "available": bool(clf and clf.available),
            "reason": (clf.reason if clf else default_reason) or "ok",
        }
    models_active = {
        "coco":         _model_card(det_cfg, detector, "disabled"),
        "bird_species": _model_card(bird_cfg, bird_clf, "disabled"),
        "wildlife":     _model_card(wl_cfg, wl_clf, "disabled"),
    }
    response = {
        "ok": True,
        "mode": mode,
        "models_active": models_active,
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


def _nickname_tflite(filename: str) -> str:
    """Short pill-friendly badge name for a model file (≤ 16 chars).
    Used by the Coral test UI to tag each detection with the model that
    produced it. Filename heuristics — no model introspection."""
    low = (filename or "").lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low:
        return "COCO SSD"
    if 'efficientdet' in low:
        return "EfficientDet"
    if 'bavarian' in low and 'bird' in low:
        return "Vögel BY"
    if ('inat' in low and 'bird' in low) or 'inat_bird' in low:
        return "Vögel iNat"
    if 'imagenet' in low:
        return "Wildtiere"
    if 'bird' in low:
        return "Vögel"
    # Fallback: filename stem, no underscores, capped at 16 chars.
    stem = Path(filename or "").stem.replace("_", " ").strip()
    return (stem[:16] if stem else "Modell")


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
                "nickname": _nickname_tflite(p.name),
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
    """Switch the active model for ONE category. Routing is driven by
    the filename's category (_categorize_tflite); writing a wildlife or
    bird-species model into processing.detection.model_path would
    clobber the COCO detector, which is the bug this guard fixes.

    Path traversal protection: target must resolve inside /app/models/.
    """
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

    category = _categorize_tflite(target.name)
    if category == "other":
        return jsonify({
            "ok": False,
            "error": "Modell-Kategorie unbekannt — bitte Dateinamen prüfen",
        }), 400

    # Map category → settings.processing.<bucket> so each model writes
    # into its own bucket. cpu_model_path mirrors the EdgeTPU pick to
    # the non-edgetpu variant so the CPU fallback (or a no-Coral host)
    # loads the matching tflite without further config.
    bucket_by_cat = {
        "detection": "detection",
        "bird_species": "bird_species",
        "wildlife": "wildlife",
    }
    bucket_name = bucket_by_cat[category]
    proc = settings.data.setdefault("processing", {})
    bucket = proc.setdefault(bucket_name, {})
    bucket["model_path"] = str(target)
    cpu_candidate = str(target).replace("_edgetpu.tflite", ".tflite")
    if cpu_candidate != str(target) and Path(cpu_candidate).exists():
        bucket["cpu_model_path"] = cpu_candidate
    else:
        bucket.pop("cpu_model_path", None)
    # Detection always runs (it's the first stage); the second-stage
    # classifiers ship disabled-by-default so flipping enabled=True on
    # selection makes the model actually take effect. Mode flag mirrors
    # the legacy "coral" string so the runtime picks up the new path
    # via either branch.
    if category == "detection":
        bucket["mode"] = "coral"
    else:
        bucket["enabled"] = True
    settings.save()
    try:
        rebuild_runtimes()
    except Exception as e:
        logging.getLogger(__name__).warning("Coral model switch: rebuild_runtimes failed: %s", e)
    return jsonify({"ok": True, "path": str(target), "category": category})


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


# Serializes thumb-regen across parallel requests for the same sighting.
# A single global lock is overkill but the operation is rare (only fires
# when a thumb file is genuinely missing) and a per-path lock map would
# add bookkeeping for no measurable win.
_weather_thumb_regen_lock = threading.Lock()


def _regenerate_weather_thumb(clip_path: Path, thumb_path: Path) -> bool:
    """Extract a frame from roughly the middle of `clip_path` and write
    it as JPEG to `thumb_path` via temp-file + atomic rename. Returns
    True on success. cv2 is the same backend the original thumb writer
    uses so no new dependency."""
    try:
        cap = cv2.VideoCapture(str(clip_path))
        if not cap.isOpened():
            return False
        try:
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if n > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, n // 2))
            ok, frame = cap.read()
            if (not ok or frame is None) and n > 0:
                # Some codecs misreport frame count — first frame always
                # decodes if the file is otherwise valid.
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
            if not ok or frame is None:
                return False
            ok2, buf = cv2.imencode(".jpg", frame,
                                    [int(cv2.IMWRITE_JPEG_QUALITY), 88])
            if not ok2:
                return False
        finally:
            cap.release()
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        # Same-directory tempfile keeps the rename filesystem-local so
        # parallel readers never see a half-written JPEG.
        tmp = thumb_path.with_name(
            f".{thumb_path.name}.tmp.{os.getpid()}.{threading.get_ident()}"
        )
        tmp.write_bytes(buf.tobytes())
        os.replace(str(tmp), str(thumb_path))
        return True
    except Exception as e:
        logging.getLogger(__name__).warning(
            "[weather] thumb regen exception: %s", e)
        return False


@app.get('/api/weather/sightings/<sighting_id>/thumb')
def api_weather_sighting_thumb(sighting_id: str):
    if weather_service is None:
        return Response(status=503)
    m = weather_service.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("thumb_path", "")
    full = storage_root / rel
    try:
        if not str(full.resolve()).startswith(str(storage_root.resolve())):
            return Response(status=404)
    except (OSError, RuntimeError):
        return Response(status=404)
    if not full.exists():
        # Thumb JPG missing on disk — try to regenerate from the clip
        # before giving up. Both-missing is the only true 404 case.
        log = logging.getLogger(__name__)
        clip_rel = m.get("clip_path", "")
        clip_full = (storage_root / clip_rel) if clip_rel else None
        if not clip_full or not clip_full.exists():
            log.warning(
                "[weather] thumb 404 — clip and thumb both missing for %s",
                sighting_id)
            return Response(status=404)
        with _weather_thumb_regen_lock:
            # Re-check inside the lock — another request may have won.
            if not full.exists():
                if not _regenerate_weather_thumb(clip_full, full):
                    log.warning("[weather] thumb regen failed for %s",
                                sighting_id)
                    return Response(status=404)
                log.info("[weather] thumb regenerated for %s", sighting_id)
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


# /api/system lives in routes/bootstrap.py since R01.3.


if __name__ == '__main__':
    app.run(host=cfg.get('server', {}).get('host', '0.0.0.0'), port=int(cfg.get('server', {}).get('port', 8099)), threaded=True)

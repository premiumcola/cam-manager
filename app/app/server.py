
from __future__ import annotations

import copy as _copy
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask

# Centralised logging setup — installs the explicit StreamHandler with a
# parseable format, the in-memory buffer for the web UI, and the WARNING+
# rate-limit filter. Must run before any subsystem imports that emit logs.
from .logging_setup import console_level, setup_logging

setup_logging()

from . import app_state
from .camera_runtime import CameraRuntime
from .cat_identity import IdentityRegistry
from .config_loader import load_config
from .mqtt_service import MQTTService
from .settings_store import SettingsStore
from .storage import EventStore
from .telegram_bot import TelegramService
from .timelapse import TimelapseBuilder
from .tracking_worker import build_worker as build_tracking_worker
from .weather_service import WeatherService


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


# Boot-time migrations — see app/app/migrations.py. Each one spawns
# its own daemon thread; safe to re-run; idempotent.
from . import migrations as _migrations

_migrations.migrate_timelapse_events(storage_root=storage_root, settings=settings)
_migrations.generate_missing_thumbnails(storage_root=storage_root)
_migrations.migrate_timelapse_to_eventstore(
    storage_root=storage_root, settings=settings, store=store, base_cfg=base_cfg,
)


# All HTTP routes live under app/app/routes/ — see register_blueprints
# wired up earlier in this file. server.py owns boot only.


if __name__ == '__main__':
    app.run(host=cfg.get('server', {}).get('host', '0.0.0.0'), port=int(cfg.get('server', {}).get('port', 8099)), threaded=True)

from __future__ import annotations

import copy as _copy
import logging
import threading
import time
from datetime import datetime
from pathlib import Path

from flask import Flask

# Centralised logging setup — installs the explicit StreamHandler with a
# parseable format, the in-memory buffer for the web UI, and the WARNING+
# rate-limit filter. Must run before any subsystem imports that emit logs.
from .logging_setup import setup_logging

setup_logging()

from . import app_state
from .camera_runtime import CameraRuntime
from .cat_identity import IdentityRegistry
from .config_loader import load_config

# Boot helpers — moved to lifecycle.py during the modular refactor.
# The names re-exported here keep `from ..server import _BUILD_INFO,
# _PROCESS_START_ISO` (routes/bootstrap.py) and every in-file caller
# resolving without a path change.
from .lifecycle import (  # noqa: E402
    _emit_boot_inventory,
    _fetch_github_commit_count,
    _file_hash,
    _install_shutdown_hooks,
    _startup_media_scan,
)
from .maintenance import (  # noqa: E402
    _heartbeat_emit,
    _run_daily_cleanup,
    _run_daily_quest_rollover_check,
    _run_hourly_quest_eval,
)
from .mqtt_service import MQTTService
from .settings_store import SettingsStore
from .storage import EventStore
from .telegram_bot import TelegramService
from .timelapse import TimelapseBuilder
from .tracking_worker import build_worker as build_tracking_worker
from .weather_service import WeatherService

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

app = Flask(
    __name__, template_folder=str(web_root / "templates"), static_folder=str(web_root / "static")
)

# Jinja `?v=...` cache-bust helper — the template tag {{ static_v('app.css') }}
# calls _file_hash which lives in lifecycle.py post-refactor.
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
        "[migration] storage migration failed (continuing with existing state): %s",
        _e,
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
        "[migration] sun_timelapse split failed (continuing with existing state): %s",
        _e,
        exc_info=True,
    )
cfg = settings.export_effective_config(base_cfg)
cat_registry = IdentityRegistry(
    storage_root / "cat_registry.json",
    threshold=int(cfg.get("processing", {}).get("cat_identity", {}).get("match_threshold", 10)),
)
app_state.cat_registry = cat_registry
person_registry = IdentityRegistry(
    storage_root / "person_registry.json",
    threshold=int(cfg.get("processing", {}).get("person_identity", {}).get("match_threshold", 10)),
)
app_state.person_registry = person_registry
timelapse_builder = TimelapseBuilder(storage_root)
app_state.timelapse_builder = timelapse_builder
# F08 dossier service — owns storage/bird_dossiers.json. Camera runtimes
# call its on_new_species hook from the motion-finalize path; the API
# layer reads via app_state.bird_dossiers and triggers manual refetches.
from .bird_dossiers import BirdDossierService as _BirdDossierService

app_state.bird_dossiers = _BirdDossierService(storage_root / "bird_dossiers.json")
# F06 first-since detector — flags motion events that arrive after an
# unusually long gap for their class. Built once at boot; the recording
# finalize path reads it via app_state.first_since_detector. The
# settings handle is bound after settings is constructed (above), so
# the detector lazily resolves the merged effective config on each
# evaluate() call.
from .first_since import FirstSinceDetector as _FirstSinceDetector

app_state.first_since_detector = _FirstSinceDetector(
    store=store,
    settings=settings,
    storage_root=storage_root,
)
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


def _log_route_inventory(_app):
    """P26 · one INFO line summarising registered routes at boot.
    Anything that drops the count by ≥ 5 between deploys is a sign
    a blueprint failed to register silently. The DEBUG branch dumps
    each route so operators can grep for a specific path when
    diagnosing a 404."""
    log = logging.getLogger(__name__)
    routes = sorted(
        (str(r), sorted(r.methods - {"HEAD", "OPTIONS"}))
        for r in _app.url_map.iter_rules()
        if not str(r).startswith("/static")
    )
    log.info("[boot] %d routes registered", len(routes))
    if log.isEnabledFor(logging.DEBUG):
        for path, methods in routes:
            log.debug("[boot]   %s  %s", ",".join(methods), path)


_log_route_inventory(app)
# Capture boot time so /api/health can report uptime.
_BOOT_TS = time.time()


@app.get("/api/health")
def _api_health():
    """External monitoring endpoint. Stable JSON shape — bots and
    Telegram cron-pings poll this. Cheap: only reads in-memory
    counters, no settings/disk I/O."""
    from flask import jsonify
    try:
        from . import buildinfo as _bi  # type: ignore[no-redef]
        commit = getattr(_bi, "commit", "dev")
    except Exception:
        commit = "dev"
    routes_n = sum(
        1 for r in app.url_map.iter_rules() if not str(r).startswith("/static")
    )
    return jsonify({
        "ok": True,
        "build": commit,
        "uptime_seconds": int(time.time() - _BOOT_TS),
        "routes_registered": routes_n,
        "runtimes_active": len(runtimes),
    })

# Single-flight lock + last-applied snapshot for telegram reloads. The lock
# prevents two HTTP saves landing simultaneously from each starting a fresh
# polling thread; the snapshot avoids a 10 s slot-wait on every camera-config
# save when nothing telegram-related has actually changed. The timestamp
# debounce (T61) catches double-fires that slip past the snapshot guard —
# e.g. when a migration mutates the telegram cfg in a no-op-but-different
# way between two close-in-time reloads.
_telegram_reload_lock = threading.Lock()
_last_telegram_cfg_snapshot: dict | None = None
_last_telegram_reload_at: float = 0.0


# Single source of truth for both helpers lives in app_state; these
# thin wrappers used to live here and forwarded byte-for-byte to the
# same settings methods. Re-imported under the same names so the
# internal callers below need no rewrite.
from .app_state import get_camera_cfg, get_effective_config  # noqa: E402


def _reload_telegram_service():
    """Single source of truth for swapping the TelegramService.

    Stops the old instance fully (so Telegram's getUpdates slot is freed),
    waits 3 s for the API to release the slot, then constructs and starts
    a fresh instance. Skips entirely when the telegram config snapshot is
    unchanged — the common case for camera-config saves."""
    global telegram_service, _last_telegram_cfg_snapshot
    log = logging.getLogger(__name__)
    # T61 diagnostic — during the first 120 s after boot, log every
    # caller stack + cfg-snapshot diff so the double-fire on boot can
    # be traced to its source. Cheap (one log line per call), bounded
    # in time, no behavioural change.
    uptime_s = time.time() - _BOOT_TS
    if uptime_s < 120:
        import traceback as _tb
        stack = "".join(_tb.format_stack(limit=8))
        log.warning(
            "[tg] _reload_telegram_service called at uptime=%.1fs · caller stack:\n%s",
            uptime_s, stack,
        )
        try:
            _new_cfg = get_effective_config()
            _new_tg = _new_cfg.get("telegram", {}) or {}
            if _last_telegram_cfg_snapshot is None:
                log.warning("[tg] snapshot diff: prev=None")
            elif _last_telegram_cfg_snapshot == _new_tg:
                log.warning(
                    "[tg] snapshot diff: IDENTICAL — skip-guard should have fired",
                )
            else:
                a = _last_telegram_cfg_snapshot
                b = _new_tg
                only_in_a = sorted(set(a) - set(b))
                only_in_b = sorted(set(b) - set(a))
                changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])
                log.warning(
                    "[tg] snapshot diff: only_in_prev=%s · only_in_new=%s · changed_keys=%s",
                    only_in_a, only_in_b, changed,
                )
        except Exception as _e:
            log.warning("[tg] snapshot diff failed: %s", _e)
    global _last_telegram_reload_at
    with _telegram_reload_lock:
        new_cfg = get_effective_config()
        new_tg_cfg = new_cfg.get("telegram", {}) or {}
        # T61.3b · timestamp debounce. Snapshot equality is the primary
        # guard, but on boot a migration may rewrite the telegram
        # section between two close calls — fields stay semantically
        # the same but the dict comparison flips. Within 30 s of the
        # last successful reload AND with the same cfg, debounce.
        _now = time.time()
        if (
            telegram_service is not None
            and _now - _last_telegram_reload_at < 30
            and _last_telegram_cfg_snapshot == new_tg_cfg
        ):
            log.info(
                "[tg] Reload debounced (%.1fs since last, same cfg)",
                _now - _last_telegram_reload_at,
            )
            return
        if telegram_service is not None and _last_telegram_cfg_snapshot == new_tg_cfg:
            log.debug("[tg] Reload skipped — config unchanged")
            return
        was_polling = False
        if telegram_service is not None:
            try:
                was_polling = telegram_service.get_polling_status().get("state") in (
                    "active",
                    "starting",
                    "conflict",
                )
            except Exception:
                was_polling = False
            try:
                telegram_service.stop(reason="settings reload")
            except Exception as e:
                log.warning("[tg] Stop during reload failed: %s", e)
            telegram_service = None
            app_state.telegram_service = None
            # T61.3a · Telegram's server-side getUpdates slot can hold for
            # up to ~10 s after a long-poll is interrupted mid-cycle. The
            # python-telegram-bot maintainers recommend a 10 s pause for
            # forced restarts — anything shorter risks the new bot's first
            # poll colliding with the tail of the old long-poll and
            # tripping Conflict in a tight loop.
            if was_polling:
                log.info("[tg] Waiting 10 s for Telegram to release the getUpdates slot")
                time.sleep(10)
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
        _last_telegram_reload_at = _now
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
        cam_id
        for cam_id in set(current_ids) & new_ids
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
    # Per the dashboard simplification: every configured camera is
    # treated as active. The `enabled` field stays in settings.json
    # for forward-compat / external readers but no longer gates
    # runtime startup — the per-row toggle was removed from the UI,
    # and a stranded enabled=False from a previous version would
    # otherwise leave the camera permanently dark with no way back.
    # TODO: drop the `enabled` field entirely once a settings-store
    # migration scrubs it from existing JSONs.
    try:
        rt = CameraRuntime(
            cam_id,
            get_camera_cfg,
            cfg,
            store,
            telegram_service,
            mqtt=mqtt_service,
            cat_registry=cat_registry,
            person_registry=person_registry,
        )
        runtimes[cam_id] = rt
        _runtime_cfgs[cam_id] = _copy.deepcopy(cam_cfg)
        rt.start()
        if reason == "bound":
            log.info("[boot] cam %s: bound runtime", cam_id)
        else:
            log.info("[boot] cam %s: %s", cam_id, reason)
    except Exception as e:
        log.error("[boot] cam %s: constructor failed: %s — will retry", cam_id, e, exc_info=True)


def rebuild_runtimes():
    global cfg
    cfg = get_effective_config()
    rebuild_services()
    mqtt_service.publish("status/reload", {"time": datetime.now().isoformat(timespec="seconds")})

    # Auto-connect every configured camera regardless of the legacy
    # `enabled` flag (see restart_single_camera for context).
    new_cam_cfgs: dict = {}
    for cam in cfg.get("cameras", []):
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
    log.info(
        "[boot] runtimes ready: %d camera(s) (ids: %s)%s",
        len(running),
        ", ".join(running) if running else "—",
        f" — {len(missing)} skipped/failed: {', '.join(missing)}" if missing else "",
    )


rebuild_runtimes()
# Phase 1 object tracking — start the singleton worker right after the
# camera runtimes are up. detection_cfg_getter pulls the live processing
# block from settings on every job so a settings reload swaps the
# detector without restarting the worker thread.
_tracking_cfg_getter = lambda: (
    settings.export_effective_config(base_cfg).get("processing", {}).get("detection", {})
)
build_tracking_worker(
    storage_root=storage_root,
    detection_cfg_getter=_tracking_cfg_getter,
    cam_cfg_getter=lambda cam_id: settings.get_camera(cam_id) or {},
)
logging.getLogger("app.app.boot").info("[boot] ── inventory complete ──")


_startup_media_scan()


_run_daily_cleanup()


_run_hourly_quest_eval()
_run_daily_quest_rollover_check()


# Fire the first heartbeat 60 s after boot so the inventory block + first
# poll cycles have settled before the line lands; subsequent ticks every
# 5 minutes inside the timer loop.
_first_hb = threading.Timer(60.0, _heartbeat_emit)
_first_hb.daemon = True
_first_hb.start()


_install_shutdown_hooks()


# Boot-time migrations — see app/app/migrations.py. Each one spawns
# its own daemon thread; safe to re-run; idempotent.
from . import migrations as _migrations

_migrations.migrate_timelapse_events(storage_root=storage_root, settings=settings)
# Tidy loose root-level <event_id>.json (+ .tracks.json) into their date
# subfolders so the camera root stops collecting clutter. Reads use
# rglob, so this is purely cosmetic for the on-disk layout.
_migrations.relocate_root_event_jsons(storage_root=storage_root)
_migrations.generate_missing_thumbnails(storage_root=storage_root)
_migrations.migrate_timelapse_to_eventstore(
    storage_root=storage_root,
    settings=settings,
    store=store,
    base_cfg=base_cfg,
)
# Diagnostic only — logs a single line when older-schema tracks.json
# sidecars are present so the operator knows to hit
# /api/tracking/reindex-all. Never reindexes automatically.
_migrations.check_tracks_schema_version(storage_root=storage_root)


# All HTTP routes live under app/app/routes/ — see register_blueprints
# wired up earlier in this file. server.py owns boot only.


if __name__ == '__main__':
    app.run(
        host=cfg.get('server', {}).get('host', '0.0.0.0'),
        port=int(cfg.get('server', {}).get('port', 8099)),
        threaded=True,
    )

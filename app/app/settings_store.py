
from __future__ import annotations
from pathlib import Path
from copy import deepcopy
import json
import logging
import os
import shutil
import threading
import yaml

from .schema import (
    validate_and_coerce,
    CAMERA_SCHEMA,
    SECTION_SCHEMAS,
)

log = logging.getLogger(__name__)


class SettingsStore:
    def __init__(self, path: str | Path, base_config: dict):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.base_config = deepcopy(base_config)
        self.data = self._build_defaults(base_config)
        # Guards every mutation of data["runtime"]. Runtime data is touched
        # from Telegram callback threads, scheduler jobs and the camera
        # threads, so any read-modify-write needs the lock.
        self._runtime_lock = threading.RLock()
        self.load()

    # Global weather defaults. Same idempotent additive-merge pattern as
    # _TELEGRAM_PUSH_DEFAULTS — every key the WeatherService expects is
    # backfilled on each load() so a fresh install and an upgraded install
    # behave identically.
    _WEATHER_DEFAULTS: dict = {
        "enabled":       True,
        "poll_interval": 300,
        "events": {
            # lightning_potential is in J/kg from Open-Meteo's icon_d2 model.
            "thunder":    {"enabled": True,  "threshold": 1000.0, "cooldown_min": 30},
            "heavy_rain": {"enabled": True,  "threshold": 5.0, "hysteresis": 1.0, "cooldown_min": 30},
            "snow":       {"enabled": True,  "threshold": 0.5,  "cooldown_min": 60},
            "fog":        {"enabled": True,  "vis_max_m": 1000, "contrast_max": 0.25, "cooldown_min": 90},
            # Sunset: triggers once per day in the dusk window.
            "sunset":     {"enabled": True,  "alt_min": -2, "alt_max": 5,
                           "min_duration_min": 12, "cooldown_min": 720},
        },
        "clip": {
            "pre_roll_s":  5,
            "post_roll_s": 5,
            "fps":         15,
            "width":       1280,
        },
        "api": {
            "base_url": "https://api.open-meteo.com/v1/forecast",
            "model":    "icon_d2",
            "timezone": "Europe/Berlin",
        },
    }

    # Server.location fallback — Nuremberg (project HQ). Only applied when
    # the user hasn't entered coordinates; never overwrites existing values.
    _SERVER_LOCATION_DEFAULTS: dict = {
        "lat": 49.4521,
        "lon": 11.0767,
        "elevation": None,
    }

    # Default Telegram push schema. Kept as a class constant so a single
    # source of truth feeds both _build_defaults (fresh installs) and
    # _ensure_telegram_push_defaults (additive backfill on existing data).
    _TELEGRAM_PUSH_DEFAULTS: dict = {
        "enabled": True,
        "rate_limit_seconds": 30,
        "quiet_hours": {"start": "22:00", "end": "07:00"},
        "night_alert": {
            "enabled":    True,
            "armed_only": True,
            "use_sun":    True,
            "lat":        None,
            "lon":        None,
            # Fallback window when use_sun is off or lat/lon missing.
            "start": "22:00",
            "end":   "07:00",
        },
        "labels": {
            "person":   {"push": True,  "threshold": 0.85},
            "cat":      {"push": False, "threshold": 0.80},
            "dog":      {"push": True,  "threshold": 0.80},
            "bird":     {"push": False, "threshold": 0.90},
            "car":      {"push": True,  "threshold": 0.85},
            "squirrel": {"push": True,  "threshold": 0.80},
            "motion":   {"push": False, "threshold": 0.0},
        },
        "daily_report": {"enabled": True, "time": "22:00"},
        "highlight":    {"enabled": True, "time": "19:00"},
        "system":       {"enabled": True},
        "timelapse":    {"enabled": True},
        # Wetter-Sichtungen Push (Phase 3). Per-event toggles control whether
        # a successful weather clip triggers a Telegram send. min_score gates
        # everything — sightings below the bar are skipped regardless.
        "weather": {
            "enabled": True,
            "min_score": 0.4,
            "events": {
                "thunder":    True,
                "heavy_rain": True,
                "snow":       True,
                "fog":        False,   # default off — pretty rare to be interesting
                "sunset":     True,
            },
            "recap_push": True,        # ein Push pro fertigem Quartals-/Jahres-Recap
        },
    }

    _TL_DEFAULT_PROFILES = {
        "daily":   {"enabled": False, "target_seconds": 60,  "period_seconds": 86400},
        "weekly":  {"enabled": False, "target_seconds": 180, "period_seconds": 604800},
        "monthly": {"enabled": False, "target_seconds": 300, "period_seconds": 2592000},
        "custom":  {"enabled": False, "target_seconds": 30,  "period_seconds": 600},
    }

    def _default_camera(self, cam: dict | None = None) -> dict:
        cam = cam or {}
        _tl = cam.get("timelapse") or {}
        _existing_profiles = _tl.get("profiles") or {}
        _merged_profiles = {
            pname: {**pdefault, **(_existing_profiles.get(pname) or {})}
            for pname, pdefault in self._TL_DEFAULT_PROFILES.items()
        }
        return {
            "id": cam.get("id", ""),
            "name": cam.get("name", cam.get("id", "")),
            # Backfilled additively for legacy cameras: missing → "" so the
            # canonical id picks up "unknown" segments; the user fills these
            # in the camera-edit form when they want a semantic id.
            "manufacturer": cam.get("manufacturer", ""),
            "model": cam.get("model", ""),
            "location": cam.get("location", ""),
            "enabled": cam.get("enabled", True),
            "rtsp_url": cam.get("rtsp_url", ""),
            "snapshot_url": cam.get("snapshot_url", ""),
            "username": cam.get("username", ""),
            "password": cam.get("password", ""),
            "object_filter": cam.get("object_filter", ["person", "cat", "bird"]),
            # 0.0 = "auto" — runtime derives 1.4× motion_sensitivity (capped
            # at 1.0) so wildlife stays more sensitive than normal motion
            # without forcing the user to set both sliders.
            "wildlife_motion_sensitivity": cam.get("wildlife_motion_sensitivity", 0.0),
            "wildlife_min_score": cam.get("wildlife_min_score", 0.0),
            # Per-label confidence overrides — defaults push the bar high
            # for "person" because COCO SSD is prone to false positives on
            # human-shaped wood/shadow patterns at fixed surveillance angles.
            "label_thresholds": cam.get("label_thresholds", {"person": 0.72}),
            "timelapse": {
                "enabled": _tl.get("enabled", False),
                "fps": _tl.get("fps", 30),
                "period": _tl.get("period", "day"),
                "daily_target_seconds": _tl.get("daily_target_seconds", 60),
                "weekly_target_seconds": _tl.get("weekly_target_seconds", 180),
                "telegram_send": _tl.get("telegram_send", False),
                "profiles": _merged_profiles,
            },
            "zones": cam.get("zones", []),
            "masks": cam.get("masks", []),
            "armed": cam.get("armed", True),
            "telegram_enabled": cam.get("telegram_enabled", True),
            "mqtt_enabled": cam.get("mqtt_enabled", True),
            # Wetter-Sichtungen: opt-in per camera. The substream prebuffer +
            # API polling only spin up for cameras with weather.enabled=True;
            # everyone else stays at zero RAM/CPU cost.
            "weather": (cam.get("weather") or {"enabled": False}),
            # Unified per-camera schedule (replaces the old recording-schedule
            # top-level fields and the alerting-only schedule). Default off
            # = 24/7 in every dimension. See _migrate_schedules for the
            # one-time merge of the legacy fields.
            "schedule": cam.get("schedule", self._default_schedule()),
            "whitelist_names": cam.get("whitelist_names", []),
            "resolution": cam.get("resolution", "auto"),
            "frame_interval_ms": cam.get("frame_interval_ms", 350),
            "snapshot_interval_s": cam.get("snapshot_interval_s", 3),
            # Scroll-level per-camera tuning sliders — were missing from the
            # persisted dict so saves silently dropped them.
            "motion_sensitivity": float(cam.get("motion_sensitivity") or 0.5),
            "detection_min_score": float(cam.get("detection_min_score") or 0.0),
            "bottom_crop_px": int(cam.get("bottom_crop_px") or 0),
            "motion_enabled": cam.get("motion_enabled", True),
            "detection_trigger": cam.get("detection_trigger", "motion_and_objects"),
            "post_motion_tail_s": float(cam.get("post_motion_tail_s") or 0.0),
            "alarm_profile": (cam.get("alarm_profile") or "").strip(),
        }

    @staticmethod
    def _default_schedule() -> dict:
        # enabled=False → all three actions effectively 24/7.
        return {
            "enabled": False,
            "from": "21:00",
            "to":   "06:00",
            "actions": {"record": True, "telegram": True, "hard": True},
        }

    def _build_defaults(self, base_config: dict) -> dict:
        cams = [self._default_camera(cam) for cam in base_config.get("cameras", [])]
        return {
            "app": {
                "name": base_config.get("app", {}).get("name", "TAM-spy"),
                "tagline": base_config.get("app", {}).get("tagline", "Analyse · Sicherheit · Tierbeobachtung"),
                "logo": base_config.get("app", {}).get("logo", "🐈‍⬛"),
                "theme": base_config.get("app", {}).get("theme", "dark"),
            },
            "server": {
                "public_base_url": base_config.get("server", {}).get("public_base_url", ""),
                "default_discovery_subnet": base_config.get("server", {}).get("default_discovery_subnet", "192.168.1.0/24"),
            },
            "telegram": {
                "enabled": base_config.get("telegram", {}).get("enabled", False),
                "token": base_config.get("telegram", {}).get("token", ""),
                "chat_id": str(base_config.get("telegram", {}).get("chat_id", "")),
                "push": deepcopy(self._TELEGRAM_PUSH_DEFAULTS),
            },
            "mqtt": {
                "enabled": base_config.get("mqtt", {}).get("enabled", False),
                "host": base_config.get("mqtt", {}).get("host", "mqtt"),
                "port": int(base_config.get("mqtt", {}).get("port", 1883)),
                "username": base_config.get("mqtt", {}).get("username", ""),
                "password": base_config.get("mqtt", {}).get("password", ""),
                "base_topic": base_config.get("mqtt", {}).get("base_topic", "tam-spy"),
            },
            "cameras": cams,
            "telegram_actions": [],
            "review": {},
            "ui": {"wizard_completed": bool(cams)},
            "timelapse_settings": {
                "global_enabled": base_config.get("timelapse_settings", {}).get("global_enabled", False),
            },
            # Ephemeral runtime data (callback verdicts, suppress windows,
            # offline state). Persisted so a service reload doesn't lose
            # active mute timers or in-flight system_state.
            "runtime": {
                "event_feedback":       {},
                "suppress":             {},
                "system_state":         {},
                "alert_index":          {},
                "last_storage_warn_ts": 0,
                "last_coral_state":     "",
            },
        }

    def load(self):
        file_existed = self.path.exists()
        if file_existed:
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                self.data.update(loaded)
            except Exception:
                pass
        self._ensure_camera_defaults()
        self._migrate_schedules()
        self._ensure_timelapse_settings()
        self._ensure_timelapse_profiles()
        self._ensure_telegram_push_defaults()
        self._ensure_server_location_defaults()
        self._ensure_weather_defaults()
        self._ensure_runtime_defaults()
        self._repair_snapshot_urls()
        self.data.setdefault("ui", {}).setdefault("wizard_completed", bool(self.data.get("cameras")))
        # Persist additive defaults (push schema, runtime section) so the
        # UI in Phase 2 finds every key present.
        self.save()

    def _repair_snapshot_urls(self):
        """Repair cameras whose snapshot_url was corrupted with a dashboard display URL.

        This happens when quick-action saves (toggleCameraEnabled, saveTlCameraProfiles,
        etc.) spread state.cameras objects — which previously contained the display-only
        /api/camera/<id>/snapshot.jpg URL — back to /api/settings/cameras.
        For cameras present in base_config we restore both snapshot_url and rtsp_url.
        For others we clear the broken relative URL so the error becomes recoverable.
        """
        base_cam_map = {c.get("id"): c for c in self.base_config.get("cameras", [])}
        count = 0
        for cam in self.data.get("cameras", []):
            cam_id = cam.get("id", "")
            if cam.get("snapshot_url", "").startswith("/api/camera/"):
                base = base_cam_map.get(cam_id)
                if base:
                    cam["snapshot_url"] = base.get("snapshot_url", "")
                    # Also restore rtsp_url if base has one (was wiped by the same bad save)
                    if base.get("rtsp_url"):
                        cam["rtsp_url"] = base["rtsp_url"]
                    log.warning("settings: restored snapshot_url/rtsp_url for camera '%s' from base config", cam_id)
                else:
                    cam["snapshot_url"] = ""
                    log.warning("settings: cleared corrupted snapshot_url for camera '%s' (not in base config; re-enter URL)", cam_id)
                count += 1
        if count:
            self.save()

    def save(self):
        """Persist settings.json with a 2-deep backup rotation.

        Sequence on every save:
          1. Existing settings.json.bak  → settings.json.bak2  (oldest moves out)
          2. Existing settings.json      → settings.json.bak   (previous state preserved)
          3. New content                 → settings.json       (atomic via os.replace)

        The rotation runs before the write so a crash mid-write leaves the
        previous state recoverable from .bak. We deliberately do not rotate
        when self.path doesn't exist yet (first-run write)."""
        new_text = json.dumps(self.data, ensure_ascii=False, indent=2)
        bak = self.path.with_suffix(self.path.suffix + ".bak")
        bak2 = self.path.with_suffix(self.path.suffix + ".bak2")
        try:
            if bak.exists():
                shutil.copy2(str(bak), str(bak2))
            if self.path.exists():
                shutil.copy2(str(self.path), str(bak))
        except Exception as e:
            log.warning("settings: backup rotation failed: %s (continuing with save)", e)
        # Atomic write via temp file + os.replace, so a partial write never
        # leaves settings.json truncated.
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(new_text, encoding="utf-8")
        os.replace(str(tmp), str(self.path))

    def _ensure_timelapse_settings(self):
        self.data.setdefault("timelapse_settings", {"global_enabled": False})

    def _deep_merge_defaults(self, target: dict, defaults: dict):
        """Recursively fill missing keys in `target` from `defaults`.

        Existing user values are NEVER overwritten — only absent keys (and
        nested absent keys inside dicts) are added. Values whose existing
        type is not dict are left as-is even when the default is a dict;
        this protects against stomping on hand-edited overrides.
        """
        if not isinstance(target, dict):
            return
        for key, default_val in defaults.items():
            if isinstance(default_val, dict):
                sub = target.setdefault(key, {})
                if isinstance(sub, dict):
                    self._deep_merge_defaults(sub, default_val)
            else:
                target.setdefault(key, default_val)

    def _ensure_telegram_push_defaults(self):
        """Additively backfill telegram.push so every key the UI expects exists."""
        tg = self.data.setdefault("telegram", {})
        push = tg.setdefault("push", {})
        if not isinstance(push, dict):
            push = {}
            tg["push"] = push
        self._deep_merge_defaults(push, self._TELEGRAM_PUSH_DEFAULTS)
        # Backfill night-alert lat/lon from server.location when present —
        # avoids forcing the user to re-enter coordinates already known to
        # the system.
        night = push.get("night_alert") or {}
        srv_loc = (self.data.get("server", {}) or {}).get("location") or {}
        if night.get("lat") is None and srv_loc.get("lat") is not None:
            night["lat"] = srv_loc.get("lat")
        if night.get("lon") is None and srv_loc.get("lon") is not None:
            night["lon"] = srv_loc.get("lon")

    def _ensure_server_location_defaults(self):
        srv = self.data.setdefault("server", {})
        loc = srv.setdefault("location", {})
        if not isinstance(loc, dict):
            loc = {}
            srv["location"] = loc
        for k, v in self._SERVER_LOCATION_DEFAULTS.items():
            loc.setdefault(k, v)

    # Per-camera sun-timelapse defaults — both phases off until the user
    # opts in. Window/interval/fps match the spec defaults for a 24-second
    # reel over a 30-minute span.
    _SUN_TL_DEFAULTS: dict = {
        "sunrise": {"enabled": False, "window_min": 30, "interval_s": 3, "fps": 25},
        "sunset":  {"enabled": False, "window_min": 30, "interval_s": 3, "fps": 25},
    }

    # Per-camera event-timelapse defaults — opt-in master switch + per-trigger
    # toggles. Default OFF so existing weather cameras don't suddenly start
    # producing 60-min timelapses without explicit consent.
    _EVENT_TL_DEFAULTS: dict = {
        "enabled":    False,
        "window_min": 60,
        "interval_s": 6,
        "fps":        24,
        "triggers": {
            "thunder_rising": True,
            "front_passing":  True,
            "storm_front":    True,
        },
    }

    def _ensure_weather_defaults(self):
        """Additively backfill the global weather block + per-camera flag."""
        w = self.data.setdefault("weather", {})
        if not isinstance(w, dict):
            w = {}
            self.data["weather"] = w
        self._deep_merge_defaults(w, self._WEATHER_DEFAULTS)
        # Make sure every camera carries the opt-in flag in the new shape;
        # existing cameras with handcrafted weather dicts are left alone.
        # The sun_timelapse sub-block is added unconditionally — it's the
        # nested-default backfill the WeatherService relies on at startup.
        for cam in self.data.get("cameras", []):
            cw = cam.setdefault("weather", {"enabled": False})
            if not isinstance(cw, dict):
                cam["weather"] = {"enabled": False}
                continue
            cw.setdefault("enabled", False)
            sun_tl = cw.setdefault("sun_timelapse", {})
            if isinstance(sun_tl, dict):
                self._deep_merge_defaults(sun_tl, self._SUN_TL_DEFAULTS)
            evt_tl = cw.setdefault("event_timelapse", {})
            if isinstance(evt_tl, dict):
                self._deep_merge_defaults(evt_tl, self._EVENT_TL_DEFAULTS)

    def _ensure_runtime_defaults(self):
        rt = self.data.setdefault("runtime", {})
        if not isinstance(rt, dict):
            rt = {}
            self.data["runtime"] = rt
        rt.setdefault("event_feedback", {})
        rt.setdefault("suppress", {})
        rt.setdefault("system_state", {})
        rt.setdefault("alert_index", {})
        rt.setdefault("last_storage_warn_ts", 0)
        rt.setdefault("last_coral_state", "")

    # ── Runtime helpers (thread-safe) ────────────────────────────────────────
    # All callers go through these so the JSON file isn't corrupted by
    # concurrent writes from the camera, scheduler and callback threads.

    def runtime_get(self, key: str, default=None):
        with self._runtime_lock:
            return deepcopy(self.data.setdefault("runtime", {}).get(key, default))

    def runtime_set(self, key: str, value):
        with self._runtime_lock:
            self.data.setdefault("runtime", {})[key] = value
            self.save()

    def runtime_set_subkey(self, key: str, subkey: str, value):
        """Set runtime[key][subkey] = value. Creates the dict if absent."""
        with self._runtime_lock:
            sec = self.data.setdefault("runtime", {}).setdefault(key, {})
            if not isinstance(sec, dict):
                sec = {}
                self.data["runtime"][key] = sec
            sec[subkey] = value
            self.save()

    def runtime_get_subkey(self, key: str, subkey: str, default=None):
        with self._runtime_lock:
            sec = self.data.setdefault("runtime", {}).get(key) or {}
            if not isinstance(sec, dict):
                return default
            return deepcopy(sec.get(subkey, default))

    def runtime_alert_index_set(self, eid: str, payload: dict, cap: int = 200):
        """LRU-bounded write to runtime.alert_index. Cap protects against
        unbounded growth — at cap, the oldest insertion is evicted."""
        with self._runtime_lock:
            idx = self.data.setdefault("runtime", {}).setdefault("alert_index", {})
            if not isinstance(idx, dict):
                idx = {}
                self.data["runtime"]["alert_index"] = idx
            idx[eid] = payload
            while len(idx) > cap:
                # Python 3.7+ dicts preserve insertion order
                idx.pop(next(iter(idx)))
            self.save()

    def _ensure_timelapse_profiles(self):
        """Additively add missing timelapse profile keys to existing cameras."""
        for cam in self.data.get("cameras", []):
            tl = cam.setdefault("timelapse", {})
            profiles = tl.setdefault("profiles", {})
            for pname, pdefault in self._TL_DEFAULT_PROFILES.items():
                prof = profiles.setdefault(pname, {})
                for k, v in pdefault.items():
                    prof.setdefault(k, v)
            # Migrate: if old timelapse.enabled=True but no profile enabled, enable daily
            if tl.get("enabled") and not any(p.get("enabled") for p in profiles.values()):
                profiles["daily"]["enabled"] = True

    def _ensure_camera_defaults(self):
        cameras = self.data.setdefault("cameras", [])
        by_id = {c.get("id"): c for c in cameras}
        # Also index by display name so a seed cam that was renamed by the
        # storage_migration (e.g. "cam-Werkstatt.rechts.oben" →
        # "unknown_unknown_werkstatt_172") isn't blindly re-added under its
        # original id on the next boot. Two cams sharing the same name is
        # already handled elsewhere — this just stops the migration from
        # silently un-doing itself.
        by_name = {(c.get("name") or "").strip().lower(): c
                   for c in cameras if c.get("name")}
        for c in self.base_config.get("cameras", []):
            base_name = (c.get("name") or "").strip().lower()
            if c["id"] in by_id:
                target = by_id[c["id"]]
            elif base_name and base_name in by_name:
                target = by_name[base_name]
            else:
                cameras.append(self._default_camera(c))
                continue
            # Only add missing keys; never overwrite user-saved values.
            defaults = self._default_camera(c)
            for key, val in defaults.items():
                target.setdefault(key, val)

    @staticmethod
    def _window_minutes(start: str, end: str) -> int:
        """Length of an HH:MM window in minutes, supports midnight wrap.
        Empty/equal start+end → 1440 (always)."""
        def _p(s):
            try:
                h, m = (s or "").split(":", 1)
                return int(h) * 60 + int(m)
            except Exception:
                return 0
        s_min, e_min = _p(start), _p(end)
        if s_min == e_min:
            return 1440
        if e_min > s_min:
            return e_min - s_min
        return 1440 - s_min + e_min  # wraps midnight

    def _migrate_schedules(self):
        """One-time migration: collapse legacy recording_schedule_* and the
        old alerting-only schedule {enabled,start,end} into one unified
        schedule {enabled, from, to, actions:{record,telegram,hard}}.

        Idempotent — a camera whose schedule already carries the 'actions'
        key is left untouched. Logs one INFO line per camera that actually
        gets migrated, then strips the legacy top-level fields."""
        migrated = 0
        for cam in self.data.get("cameras", []):
            sch = cam.get("schedule")
            if isinstance(sch, dict) and "actions" in sch:
                # Already in the new shape; just make sure all sub-keys exist.
                sch.setdefault("from", sch.get("start", "21:00"))
                sch.setdefault("to",   sch.get("end",   "06:00"))
                acts = sch.setdefault("actions", {})
                acts.setdefault("record", True)
                acts.setdefault("telegram", True)
                acts.setdefault("hard", True)
                continue

            rec_enabled = bool(cam.get("recording_schedule_enabled"))
            rec_start = cam.get("recording_schedule_start", "08:00")
            rec_end   = cam.get("recording_schedule_end",   "22:00")
            ale_dict = sch if isinstance(sch, dict) else {}
            ale_enabled = bool(ale_dict.get("enabled"))
            ale_start = ale_dict.get("start", "22:00")
            ale_end   = ale_dict.get("end",   "06:00")

            if not rec_enabled and not ale_enabled:
                new_sched = {
                    "enabled": False, "from": "21:00", "to": "06:00",
                    "actions": {"record": True, "telegram": True, "hard": True},
                }
                src = "both-off"
            elif rec_enabled and not ale_enabled:
                new_sched = {
                    "enabled": True, "from": rec_start, "to": rec_end,
                    "actions": {"record": True, "telegram": True, "hard": False},
                }
                src = "recording-only"
            elif not rec_enabled and ale_enabled:
                new_sched = {
                    "enabled": True, "from": ale_start, "to": ale_end,
                    "actions": {"record": True, "telegram": True, "hard": True},
                }
                src = "alerting-only"
            else:
                # Both active — keep the larger window.
                rec_dur = self._window_minutes(rec_start, rec_end)
                ale_dur = self._window_minutes(ale_start, ale_end)
                if rec_dur >= ale_dur:
                    f, t = rec_start, rec_end
                else:
                    f, t = ale_start, ale_end
                new_sched = {
                    "enabled": True, "from": f, "to": t,
                    "actions": {"record": True, "telegram": True, "hard": True},
                }
                src = f"both-on (rec={rec_dur}m ale={ale_dur}m → wider)"

            cam["schedule"] = new_sched
            cam.pop("recording_schedule_enabled", None)
            cam.pop("recording_schedule_start", None)
            cam.pop("recording_schedule_end", None)
            log.info(
                "Schedule-Migration: %s → %s (%s → enabled=%s %s-%s actions=%s)",
                cam.get("id", "?"), src,
                "rec=%s/%s/%s ale=%s/%s/%s" % (
                    rec_enabled, rec_start, rec_end,
                    ale_enabled, ale_start, ale_end,
                ),
                new_sched["enabled"], new_sched["from"], new_sched["to"], new_sched["actions"],
            )
            migrated += 1
        if migrated:
            self.save()

    def get_camera(self, cam_id: str) -> dict | None:
        return next((c for c in self.data.get("cameras", []) if c.get("id") == cam_id), None)

    def upsert_camera(self, camera: dict):
        """Insert/update one camera. Returns the canonical id post-migration
        so the HTTP handler can detect a rename (manufacturer / model / name
        / rtsp_url change → build_camera_id rebuilds → migration renames
        folders + the cam id in settings.json) and rebind the live runtime
        accordingly."""
        camera = validate_and_coerce(camera, CAMERA_SCHEMA)
        merged = self._default_camera(camera)
        in_id = merged["id"]
        existing = self.get_camera(in_id)
        id_relevant_changed = False
        if existing:
            # Track whether any input that feeds build_camera_id actually
            # changed — only then is it worth running the per-camera storage
            # migration after the save. Unrelated edits (resolution, motion
            # sensitivity, …) skip the analysis pass entirely.
            for key in ("manufacturer", "model", "name", "rtsp_url"):
                if existing.get(key) != merged.get(key):
                    id_relevant_changed = True
                    break
            existing.update(merged)
        else:
            self.data.setdefault("cameras", []).append(merged)
            id_relevant_changed = True
        self.data.setdefault("ui", {})["wizard_completed"] = True
        # Migrate FIRST (it persists if the id needs to change), then write
        # one final save so any unrelated field updates also land. The
        # migration is idempotent — a no-op pass costs roughly one stat()
        # per legacy folder.
        if id_relevant_changed:
            try:
                from .storage_migration import migrate as _migrate
                _migrate(self, self.path.parent)
            except Exception as e:
                log.warning("[Settings] per-cam migration after save failed: %s", e)
        self.save()
        # Resolve the canonical id post-migration. The cam dict in
        # self.data was mutated in place by the migration, so we look it
        # up by the input identity (manufacturer/model/name/rtsp_url) and
        # return whatever id now points at the same record.
        for c in self.data.get("cameras", []) or []:
            same_record = (
                c.get("name") == merged.get("name")
                and c.get("rtsp_url") == merged.get("rtsp_url")
                and c.get("manufacturer", "") == merged.get("manufacturer", "")
                and c.get("model", "") == merged.get("model", "")
            )
            if same_record or c.get("id") == in_id:
                return c.get("id", in_id)
        return in_id

    def delete_camera(self, cam_id: str) -> bool:
        cameras = self.data.get("cameras", [])
        before = len(cameras)
        self.data["cameras"] = [c for c in cameras if c.get("id") != cam_id]
        if len(self.data["cameras"]) < before:
            self.save()
            return True
        return False

    def update_section(self, section: str, payload: dict):
        payload = payload or {}
        section_schema = SECTION_SCHEMAS.get(section)
        if section_schema:
            payload = validate_and_coerce(payload, section_schema)
        current = self.data.setdefault(section, {})
        # Deep-merge so partial UI saves to nested config (e.g. telegram.push.
        # labels.person.threshold) don't wipe sibling keys. A shallow .update
        # would replace the whole `push` dict, losing every other field the
        # client didn't echo back.
        self._deep_merge_into(current, payload)
        self.save()

    @staticmethod
    def _deep_merge_into(target: dict, src: dict):
        for key, val in (src or {}).items():
            if isinstance(val, dict) and isinstance(target.get(key), dict):
                SettingsStore._deep_merge_into(target[key], val)
            else:
                target[key] = val

    def log_action(self, action: dict):
        actions = self.data.setdefault("telegram_actions", [])
        actions.insert(0, action)
        del actions[80:]
        self.save()

    def set_review(self, event_key: str, review: dict):
        self.data.setdefault("review", {})[event_key] = review
        self.save()

    def get_review(self, event_key: str) -> dict | None:
        return (self.data.get("review") or {}).get(event_key)

    def export_effective_config(self, base_cfg: dict) -> dict:
        cfg = deepcopy(base_cfg)
        cfg["app"] = deepcopy(self.data.get("app", {}))
        cfg["server"] = {**deepcopy(base_cfg.get("server", {})), **deepcopy(self.data.get("server", {}))}
        cfg["telegram"] = deepcopy(self.data.get("telegram", {}))
        cfg["mqtt"] = deepcopy(self.data.get("mqtt", {}))
        cfg["cameras"] = deepcopy(self.data.get("cameras", []))
        # Wetter-Sichtungen — exported so the WeatherService and the web UI
        # both read from the same canonical config block.
        if "weather" in self.data:
            cfg["weather"] = deepcopy(self.data["weather"])
        # Merge processing overrides (e.g. coral_enabled, bird_species_enabled) from settings
        if "processing" in self.data:
            base_proc = deepcopy(base_cfg.get("processing", {}))
            for key, val in deepcopy(self.data["processing"]).items():
                if isinstance(val, dict) and isinstance(base_proc.get(key), dict):
                    base_proc[key] = {**base_proc[key], **val}
                else:
                    base_proc[key] = val
            cfg["processing"] = base_proc
        return cfg

    def export_serializable(self) -> dict:
        return deepcopy(self.data)

    def export_text(self, format: str = "json") -> str:
        payload = self.export_serializable()
        if format == "yaml":
            return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def import_text(self, text: str, format: str = "json"):
        loaded = yaml.safe_load(text) if format == "yaml" else json.loads(text)
        if not isinstance(loaded, dict):
            raise ValueError("Import muss ein Objekt enthalten")
        allowed = {"app", "server", "telegram", "mqtt", "cameras", "ui", "review", "telegram_actions", "timelapse_settings", "weather"}
        for key, value in loaded.items():
            if key in allowed:
                self.data[key] = value
        self._ensure_camera_defaults()
        self.data.setdefault("ui", {})["wizard_completed"] = bool(self.data.get("cameras")) or bool(self.data.get("ui", {}).get("wizard_completed"))
        self.save()

    def bootstrap_state(self) -> dict:
        ui = self.data.setdefault("ui", {})
        needs_wizard = not ui.get("wizard_completed", False)
        return {
            "wizard_completed": bool(ui.get("wizard_completed", False)),
            "needs_wizard": needs_wizard,
            "camera_count": len(self.data.get("cameras", [])),
            "telegram_configured": bool(self.data.get("telegram", {}).get("token")),
            "mqtt_configured": bool(self.data.get("mqtt", {}).get("host")),
        }

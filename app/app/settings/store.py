"""SettingsStore — source of truth for storage/settings.json.

Boot sequence: build_defaults() seeds self.data from base_config, load()
merges any persisted state on top, then runs every migration in
MIGRATIONS order, then save() persists the merged result.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
from copy import deepcopy
from pathlib import Path

import yaml

from ..schema import (
    CAMERA_SCHEMA,
    SECTION_SCHEMAS,
    validate_and_coerce,
)
from .defaults import build_defaults, default_camera
from .migrations import (
    migrate_alerting_schedules,
    migrate_camera_defaults,
    migrate_class_severity,
    migrate_runtime_defaults,
    migrate_schedules,
    migrate_server_location_defaults,
    migrate_telegram_push_defaults,
    migrate_timelapse_intervals,
    migrate_timelapse_profiles,
    migrate_timelapse_settings,
    migrate_weather_defaults,
)

log = logging.getLogger(__name__)


class SettingsStore:
    def __init__(self, path: str | Path, base_config: dict):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.base_config = deepcopy(base_config)
        self.data = build_defaults(base_config)
        # Guards every mutation of data["runtime"]. Runtime data is touched
        # from Telegram callback threads, scheduler jobs and the camera
        # threads, so any read-modify-write needs the lock.
        self._runtime_lock = threading.RLock()
        self.load()

    def load(self):
        file_existed = self.path.exists()
        if file_existed:
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                self.data.update(loaded)
            except Exception:
                pass
        # Migration sequence — order matches the original SettingsStore.load
        # call sequence; never reorder existing entries because some
        # migrations depend on the output of earlier ones.
        migrate_camera_defaults(self.data, self.base_config)
        schedule_migrated = migrate_schedules(self.data)
        migrate_class_severity(self.data)
        migrate_alerting_schedules(self.data)
        migrate_timelapse_settings(self.data)
        migrate_timelapse_profiles(self.data)
        migrate_telegram_push_defaults(self.data)
        migrate_server_location_defaults(self.data)
        migrate_weather_defaults(self.data)
        # E1 · runs AFTER weather_defaults so newly-added sun_timelapse /
        # event_timelapse blocks (from the additive backfill above)
        # already exist when the clamp tries to read interval_s / fps.
        migrate_timelapse_intervals(self.data)
        migrate_runtime_defaults(self.data)
        self._repair_snapshot_urls()
        # One-shot cleanup of any pre-existing duplicate camera rows.
        # Historically, a stale state.cameras array round-tripping through
        # /api/settings/cameras or migration churn around build_camera_id
        # could leave the same id present 2+ times. Every consumer
        # (weather scheduler, UI render, runtime registry) wants one
        # entry per id — collapse here so we never iterate ghosts again.
        removed = self._dedupe_cameras_by_id()
        if removed:
            log.warning("[Settings] removed %d duplicate camera entries during load", removed)
        self.data.setdefault("ui", {}).setdefault("wizard_completed", bool(self.data.get("cameras")))
        # schedule_migrated saves explicitly inside the original migrate
        # method; preserved here through the persist pass below.
        if schedule_migrated:
            self.save()
        # Persist additive defaults (push schema, runtime section) so the
        # UI in Phase 2 finds every key present.
        self.save()

    def _dedupe_cameras_by_id(self) -> int:
        """Collapse duplicate camera rows (same id) keeping the first
        occurrence; returns the number of dropped duplicates. The first
        entry wins because upsert_camera updates by first-match — any
        later dupe is a stale older copy."""
        cams = self.data.get("cameras") or []
        if len(cams) < 2:
            return 0
        seen: set = set()
        cleaned: list[dict] = []
        for c in cams:
            cid = c.get("id")
            if not cid:
                cleaned.append(c)
                continue
            if cid in seen:
                continue
            seen.add(cid)
            cleaned.append(c)
        removed = len(cams) - len(cleaned)
        if removed:
            self.data["cameras"] = cleaned
        return removed

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

    def get_camera(self, cam_id: str) -> dict | None:
        return next((c for c in self.data.get("cameras", []) if c.get("id") == cam_id), None)

    def upsert_camera(self, camera: dict):
        """Insert/update one camera. Returns the canonical id post-migration
        so the HTTP handler can detect a rename (manufacturer / model / name
        / rtsp_url change → build_camera_id rebuilds → migration renames
        folders + the cam id in settings.json) and rebind the live runtime
        accordingly.

        ja847 — for UPDATES the validated payload is merged directly onto
        the stored cam dict. The previous implementation funnelled the
        payload through ``default_camera()`` first, which rebuilt a fresh
        dict with only the keys it explicitly knew about — any field not
        listed there (icon, future-added fields, schema fields added
        without a default-builder line) silently fell on the floor every
        time the user pressed Speichern. The "tracking presets don't
        stick" fix from bw916 was a localised patch for four of those
        fields; the same bug pattern affected the whole Erkennung +
        Alerting + Allgemein tabs whenever the frontend sent a field
        default_camera didn't list. validate_and_coerce already
        preserves every key in ``camera`` (it only type-checks
        schema-known fields and copies unknown keys through unchanged),
        so handing it straight to existing.update is the
        non-destructive merge the user asked for. ``default_camera``
        still seeds NEW cameras with the full default skeleton.
        """
        camera = validate_and_coerce(camera, CAMERA_SCHEMA)
        in_id = camera.get("id", "")
        existing = self.get_camera(in_id)
        id_relevant_changed = False
        if existing:
            # Track whether any input that feeds build_camera_id actually
            # changed — only then is it worth running the per-camera storage
            # migration after the save. Unrelated edits (resolution, motion
            # sensitivity, …) skip the analysis pass entirely.
            for key in ("manufacturer", "model", "name", "rtsp_url"):
                if key in camera and existing.get(key) != camera.get(key):
                    id_relevant_changed = True
                    break
            # Non-destructive merge — every key the frontend sent lands
            # on the stored dict at its new value; keys the frontend
            # didn't send stay at their existing value (Python dict.update
            # semantics). Nested dicts (schedule, label_thresholds, …)
            # are still replaced wholesale because the frontend re-sends
            # the entire nested object on every save; partial nested
            # updates would need explicit deep-merge per section.
            existing.update(camera)
        else:
            merged = default_camera(camera)
            self.data.setdefault("cameras", []).append(merged)
            id_relevant_changed = True
        # Resolve the "post-merge canonical record" reference used by the
        # migration + return-id lookup further below. For updates we
        # already mutated existing in place; for inserts we just appended.
        merged = existing if existing else self.data["cameras"][-1]
        self.data.setdefault("ui", {})["wizard_completed"] = True
        # Migrate FIRST (it persists if the id needs to change), then write
        # one final save so any unrelated field updates also land. The
        # migration is idempotent — a no-op pass costs roughly one stat()
        # per legacy folder.
        if id_relevant_changed:
            try:
                from ..storage_migration import migrate as _migrate
                _migrate(self, self.path.parent)
            except Exception as e:
                log.warning("[Settings] per-cam migration after save failed: %s", e)
        # Migration may rename a cam id and leave a sibling entry with
        # the new id already present (rare, but possible when a discovery
        # re-add races with a manual rename) — dedupe before writing so
        # the on-disk file never carries the same id twice.
        self._dedupe_cameras_by_id()
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
        migrate_camera_defaults(self.data, self.base_config)
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

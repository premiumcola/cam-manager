
from __future__ import annotations
from pathlib import Path
from copy import deepcopy
import json
import yaml

DEFAULT_GROUPS = [
    {
        "id": "sicherheit",
        "name": "Sicherheit",
        "category": "Sicherheit",
        "alarm_profile": "hard",
        "coarse_objects": ["person", "car", "cat", "bird", "motion"],
        "fine_models": [],
        "schedule": {"enabled": True, "start": "22:00", "end": "06:00"},
    },
    {
        "id": "bereichsuebersicht",
        "name": "Bereichsübersicht",
        "category": "Bereichsübersicht",
        "alarm_profile": "soft",
        "coarse_objects": ["person", "car", "cat", "bird", "motion"],
        "fine_models": [],
        "schedule": {"enabled": False, "start": "00:00", "end": "00:00"},
    },
    {
        "id": "tierbeobachtung",
        "name": "Tierbeobachtung",
        "category": "Tierbeobachtung",
        "alarm_profile": "info",
        "coarse_objects": ["bird", "cat", "motion", "person"],
        "fine_models": ["bird_species", "squirrel"],
        "schedule": {"enabled": False, "start": "00:00", "end": "00:00"},
    },
    {
        "id": "eingangskamera",
        "name": "Eingangskamera",
        "category": "Eingangskamera",
        "alarm_profile": "medium",
        "coarse_objects": ["person", "cat", "bird", "motion"],
        "fine_models": ["cat_identity", "person_identity"],
        "schedule": {"enabled": True, "start": "23:00", "end": "06:00"},
    },
]


class SettingsStore:
    def __init__(self, path: str | Path, base_config: dict):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.base_config = deepcopy(base_config)
        self.data = self._build_defaults(base_config)
        self.load()

    def _default_camera(self, cam: dict | None = None) -> dict:
        cam = cam or {}
        return {
            "id": cam.get("id", ""),
            "name": cam.get("name", cam.get("id", "")),
            "location": cam.get("location", ""),
            "enabled": cam.get("enabled", True),
            "rtsp_url": cam.get("rtsp_url", ""),
            "snapshot_url": cam.get("snapshot_url", ""),
            "username": cam.get("username", ""),
            "password": cam.get("password", ""),
            "group_id": cam.get("group_id", "bereichsuebersicht"),
            "role": cam.get("role", cam.get("group_id", "Bereichsübersicht")),
            "object_filter": cam.get("object_filter", ["person", "cat", "bird"]),
            "timelapse": cam.get("timelapse", {"enabled": False, "fps": 12}),
            "zones": cam.get("zones", []),
            "masks": cam.get("masks", []),
            "armed": cam.get("armed", True),
            "telegram_enabled": cam.get("telegram_enabled", True),
            "mqtt_enabled": cam.get("mqtt_enabled", True),
            "schedule": cam.get("schedule", {"enabled": False, "start": "22:00", "end": "06:00"}),
            "whitelist_names": cam.get("whitelist_names", []),
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
            },
            "mqtt": {
                "enabled": base_config.get("mqtt", {}).get("enabled", False),
                "host": base_config.get("mqtt", {}).get("host", "mqtt"),
                "port": int(base_config.get("mqtt", {}).get("port", 1883)),
                "username": base_config.get("mqtt", {}).get("username", ""),
                "password": base_config.get("mqtt", {}).get("password", ""),
                "base_topic": base_config.get("mqtt", {}).get("base_topic", "tam-spy"),
            },
            "camera_groups": deepcopy(DEFAULT_GROUPS),
            "cameras": cams,
            "telegram_actions": [],
            "review": {},
            "ui": {"wizard_completed": bool(cams)},
        }

    def load(self):
        if self.path.exists():
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                self.data.update(loaded)
            except Exception:
                pass
        self._ensure_groups()
        self._ensure_camera_defaults()
        self.data.setdefault("ui", {}).setdefault("wizard_completed", bool(self.data.get("cameras")))
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    def _ensure_groups(self):
        existing = {g.get("id") for g in self.data.get("camera_groups", [])}
        for g in DEFAULT_GROUPS:
            if g["id"] not in existing:
                self.data.setdefault("camera_groups", []).append(deepcopy(g))

    def _ensure_camera_defaults(self):
        cameras = self.data.setdefault("cameras", [])
        by_id = {c.get("id"): c for c in cameras}
        for c in self.base_config.get("cameras", []):
            if c["id"] not in by_id:
                cameras.append(self._default_camera(c))
            else:
                # Keep previously saved fields but ensure new keys exist.
                merged = self._default_camera(by_id[c["id"]])
                by_id[c["id"]].update(merged)

    def get_camera(self, cam_id: str) -> dict | None:
        return next((c for c in self.data.get("cameras", []) if c.get("id") == cam_id), None)

    def upsert_camera(self, camera: dict):
        merged = self._default_camera(camera)
        existing = self.get_camera(merged["id"])
        if existing:
            existing.update(merged)
        else:
            self.data.setdefault("cameras", []).append(merged)
        self.data.setdefault("ui", {})["wizard_completed"] = True
        self.save()

    def delete_camera(self, cam_id: str) -> bool:
        cameras = self.data.get("cameras", [])
        before = len(cameras)
        self.data["cameras"] = [c for c in cameras if c.get("id") != cam_id]
        if len(self.data["cameras"]) < before:
            self.save()
            return True
        return False

    def upsert_group(self, group: dict):
        existing = next((g for g in self.data.get("camera_groups", []) if g.get("id") == group.get("id")), None)
        if existing:
            existing.update(group)
        else:
            self.data.setdefault("camera_groups", []).append(group)
        self.save()

    def update_section(self, section: str, payload: dict):
        current = self.data.setdefault(section, {})
        current.update(payload or {})
        self.save()

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
        cfg["camera_groups"] = deepcopy(self.data.get("camera_groups", []))
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
        allowed = {"app", "server", "telegram", "mqtt", "camera_groups", "cameras", "ui", "review", "telegram_actions"}
        for key, value in loaded.items():
            if key in allowed:
                self.data[key] = value
        self._ensure_groups()
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

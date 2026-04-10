from __future__ import annotations
from pathlib import Path
import os
import yaml


def load_config() -> dict:
    path = Path(os.environ.get("GARDEN_MONITOR_CONFIG", "/app/config/config.yaml"))
    if not path.exists():
        example = path.with_suffix(path.suffix + ".example")
        raise FileNotFoundError(f"Config fehlt: {path} (Beispiel: {example})")
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}

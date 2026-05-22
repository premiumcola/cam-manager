"""Module-level state shared across the server and its blueprints.

Step R01.1 of the server.py split. The Flask app + every route still
lives in `server.py`; what moves here is the set of singletons that
every future blueprint will need to reach (storage, settings,
services, runtimes). The originals stay defined in `server.py` as
local globals for the duration of the migration — `server.py` writes
both names on every assignment so a blueprint that imports `app_state`
sees the same instance the legacy in-file routes do.

Boot sequence:

  1. `server.py` constructs each object as today.
  2. Right after construction, `server.py` assigns
     `app_state.<name> = <name>`.
  3. `rebuild_services()` / `rebuild_runtimes()` mirror every
     reassignment to `app_state.*`.

Nothing here imports from `server.py`. Future blueprints import
`app_state` only — never the other way around — which is the
invariant that prevents circular imports as the split progresses.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type-only imports — no runtime dependency, so blueprints that
    # `from . import app_state` don't drag the heavy submodules into
    # their import path.
    from .bird_dossiers import BirdDossierService
    from .camera_runtime import CameraRuntime
    from .cat_identity import IdentityRegistry
    from .first_since import FirstSinceDetector
    from .mqtt_service import MQTTService
    from .settings_store import SettingsStore
    from .storage import EventStore
    from .telegram_bot import TelegramService
    from .timelapse import TimelapseBuilder
    from .weather_service import WeatherService


# ── Filesystem & config ────────────────────────────────────────────────────
storage_root: Path | None = None
base_cfg: dict | None = None

# ── Stores & registries (constructed once at boot) ────────────────────────
store: EventStore | None = None
settings: SettingsStore | None = None
cat_registry: IdentityRegistry | None = None
person_registry: IdentityRegistry | None = None
timelapse_builder: TimelapseBuilder | None = None
bird_dossiers: BirdDossierService | None = None
first_since_detector: FirstSinceDetector | None = None

# ── Services (mutable — rebuild_services() reassigns) ─────────────────────
mqtt_service: MQTTService | None = None
telegram_service: TelegramService | None = None
weather_service: WeatherService | None = None

# ── Camera runtimes (mutable — rebuild_runtimes() rewrites) ───────────────
runtimes: dict[str, CameraRuntime] = {}
_runtime_cfgs: dict[str, dict] = {}


def get_effective_config() -> dict:
    """Return the merged base_cfg + settings.json view used everywhere
    a route needs the live runtime config. Mirrors the original
    server.py helper byte-for-byte so the migration is a no-op."""
    assert settings is not None, "app_state.settings not initialised"
    return settings.export_effective_config(base_cfg)


def get_camera_cfg(cam_id: str) -> dict | None:
    """Return the per-camera config dict from settings.json, or None
    if the camera id is unknown. Same semantics as
    SettingsStore.get_camera — looks at settings.data, not the merged
    effective config; preserved as-is to keep the migration behavioural-
    change-free."""
    assert settings is not None, "app_state.settings not initialised"
    return settings.get_camera(cam_id)


# Convenience type alias for blueprints that want to declare the
# getter shape without importing the registry types directly.
EffectiveCfgGetter = Callable[[], dict]
CameraCfgGetter = Callable[[str], "dict | None"]

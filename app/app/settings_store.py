"""Compatibility shim — the real implementation now lives in
``app.app.settings``. Kept for one release cycle so external imports
(`from app.settings_store import SettingsStore` / `from .settings_store
import SettingsStore`) and the test suite keep working unchanged."""
from .settings import SettingsStore

__all__ = ["SettingsStore"]

"""Module-level constants, helpers, and tracker classes for weather_service.

Lives in its own file so mixin modules can import these without creating a
circular dependency with service.py (which imports the mixins).
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path


# Pinned logger name so log filters and grep keep matching the legacy module
# path after the package split.
log = logging.getLogger("app.weather_service")


# ── Public mappings (consumed by Phase-2 UI imports) ────────────────────────

# Short labels chosen for terse display in Telegram chips, the
# heartbeat status line, and the weather settings menu. Keep these
# in sync with WEATHER_TYPES.de in app/web/static/js/core/weather-types.js
# — the JS pill renderer also uses these as the visible chip text.
EVENT_LABEL_DE: dict[str, str] = {
    "thunder":    "Gewitter",
    "heavy_rain": "Starkregen",
    "snow":       "Schnee",
    "fog":        "Nebel",
    "sunset":     "Untergang",
}

EVENT_ICON_HEX: dict[str, str] = {
    "thunder":    "#facc15",  # yellow
    "heavy_rain": "#38bdf8",  # sky-blue
    "snow":       "#e2e8f0",  # near-white
    "fog":        "#94a3b8",  # slate
    "sunset":     "#fb923c",  # orange
}

# ── History (Wetterstatistik chart backend) ────────────────────────────────
# Numeric Open-Meteo parameters we persist + the cached sun altitude. Kept in
# a single deque of {ts, values} rows so callers can ship the buffer as JSON
# and the frontend can filter by time range without juggling 7 parallel
# arrays. Capacity = 288 samples ≈ 24 h at the default 5-min poll.
HISTORY_FIELDS: tuple[str, ...] = (
    "precipitation",
    "snowfall",
    "lightning_potential",
    "visibility",
    "wind_gusts_10m",
    "cloud_cover",
    "sun_altitude",
)

HISTORY_LABELS_DE: dict[str, str] = {
    "precipitation":       "Niederschlag",
    "snowfall":            "Schneefall",
    "lightning_potential": "Blitz-Potential",
    "visibility":          "Sicht",
    "wind_gusts_10m":      "Wind-Böen",
    "cloud_cover":         "Bewölkung",
    "sun_altitude":        "Sonnenhöhe",
}

HISTORY_UNITS: dict[str, str] = {
    "precipitation":       "mm/h",
    "snowfall":            "cm/h",
    "lightning_potential": "J/kg",
    "visibility":          "m",
    "wind_gusts_10m":      "km/h",
    "cloud_cover":         "%",
    "sun_altitude":        "°",
}

# Maps a HISTORY_FIELDS key to the event-type whose configured threshold is
# the natural "alarm" line for that parameter. Values whose key is missing
# are diagnostic-only and have no threshold.
HISTORY_FIELD_TO_EVENT: dict[str, str] = {
    "precipitation":       "heavy_rain",
    "snowfall":            "snow",
    "lightning_potential": "thunder",
    "visibility":          "fog",
}

HISTORY_MAXLEN = 8640  # 30 d @ 5 min — deque truncates oldest, ~1.5 MB on disk


# ── Helpers ─────────────────────────────────────────────────────────────────

def _safe_dt(s: str) -> datetime | None:
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _atomic_write_json(path: Path, payload: dict) -> None:
    """Write `payload` as JSON to `path` via temp + atomic rename so a
    concurrent reader never sees a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    os.replace(str(tmp), str(path))


def migrate_sun_timelapse_layout(storage_root: Path) -> dict:
    """One-shot, idempotent migration that splits the legacy shared
    `weather/<cam>/sun_timelapse/` directory into per-phase directories
    `sunrise_timelapse/` and `sunset_timelapse/`. Each manifest is
    backed up before its clip_path / thumb_path fields are rewritten,
    then the .json/.mp4/.jpg triplet is moved to the target dir. The
    legacy `weather/<cam>/sunset/` directory (sunset EVENT detections,
    NOT timelapses) is left untouched.

    Safe to call on every boot — the function skips entries that are
    already migrated.
    """
    weather_root = storage_root / "weather"
    summary = {"cams": 0, "moved": 0, "skipped": 0, "errors": 0}
    if not weather_root.exists():
        return summary
    ts_label = datetime.now().strftime("%Y%m%dT%H%M%S")
    for cam_dir in weather_root.iterdir():
        if not cam_dir.is_dir():
            continue
        legacy_dir = cam_dir / "sun_timelapse"
        if not legacy_dir.is_dir():
            continue
        summary["cams"] += 1
        for jf in sorted(legacy_dir.glob("*.json")):
            stem = jf.stem  # e.g. "2026-04-30_sunrise"
            try:
                manifest = json.loads(jf.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning("[migration] sun_timelapse: cannot read %s: %s", jf, e)
                summary["errors"] += 1
                continue
            phase = (manifest.get("sun_phase") or "").lower()
            if phase not in ("sunrise", "sunset"):
                # Fallback: derive phase from filename suffix.
                if stem.endswith("_sunrise") or stem.endswith("_rise"):
                    phase = "sunrise"
                elif stem.endswith("_sunset") or stem.endswith("_set"):
                    phase = "sunset"
                else:
                    log.warning(
                        "[migration] sun_timelapse: unknown phase for %s — skipping",
                        jf.name)
                    summary["errors"] += 1
                    continue
            target_dir_name = (
                "sunrise_timelapse" if phase == "sunrise" else "sunset_timelapse"
            )
            target_dir = cam_dir / target_dir_name
            target_json = target_dir / jf.name
            if target_json.exists():
                # Already migrated on a prior boot. Drop the leftover
                # source files so we don't keep iterating them every
                # restart.
                for ext in (".json", ".mp4", ".jpg"):
                    src = legacy_dir / f"{stem}{ext}"
                    if src.exists():
                        try:
                            src.unlink()
                            log.debug(
                                "[migration] sun_timelapse: dropped duplicate %s",
                                src.relative_to(storage_root))
                        except Exception as e:
                            log.warning(
                                "[migration] sun_timelapse: dup-delete failed %s: %s",
                                src, e)
                summary["skipped"] += 1
                continue
            try:
                # Manifest backup BEFORE rewrite, so a corrupted write
                # leaves a recoverable copy on disk.
                backup = jf.with_name(f"{jf.name}.bak.{ts_label}")
                shutil.copy2(str(jf), str(backup))
                cam_id = cam_dir.name
                manifest["clip_path"] = (
                    f"weather/{cam_id}/{target_dir_name}/{stem}.mp4"
                )
                manifest["thumb_path"] = (
                    f"weather/{cam_id}/{target_dir_name}/{stem}.jpg"
                )
                _atomic_write_json(target_json, manifest)
                # Move binaries — os.replace is atomic on POSIX. Skip
                # silently if a file is already at the destination
                # (e.g. partial prior migration) so we converge.
                for ext in (".mp4", ".jpg"):
                    src = legacy_dir / f"{stem}{ext}"
                    dst = target_dir / f"{stem}{ext}"
                    if not src.exists():
                        continue
                    if dst.exists():
                        try:
                            src.unlink()
                        except Exception:
                            pass
                        continue
                    try:
                        os.replace(str(src), str(dst))
                    except Exception as e:
                        log.warning(
                            "[migration] sun_timelapse: move %s → %s failed: %s",
                            src.name, dst, e)
                # Source manifest no longer needed — destination is
                # authoritative now.
                try:
                    jf.unlink()
                except Exception:
                    pass
                log.info(
                    "[migration] sun_timelapse: %s → %s/",
                    jf.name, target_dir_name)
                summary["moved"] += 1
            except Exception as e:
                log.error(
                    "[migration] sun_timelapse: %s migration failed: %s",
                    jf.name, e)
                summary["errors"] += 1
    if summary["moved"] or summary["skipped"] or summary["errors"]:
        log.info(
            "[migration] sun_timelapse split done — %d moved, %d skipped, %d errors across %d cam(s)",
            summary["moved"], summary["skipped"], summary["errors"], summary["cams"])
    return summary


class _CooldownTracker:
    """Per-(cam, event) cooldown: blocks subsequent triggers for N minutes."""

    def __init__(self):
        self._lock = threading.Lock()
        # key = (cam_id, event_type) -> unix ts when cooldown ends
        self._until: dict[tuple[str, str], float] = {}

    def check(self, cam_id: str, event: str) -> tuple[bool, int]:
        """Return (in_cooldown, minutes_remaining)."""
        with self._lock:
            until = self._until.get((cam_id, event), 0.0)
            now = time.time()
            if now < until:
                return True, int((until - now) // 60) + 1
            return False, 0

    def arm(self, cam_id: str, event: str, minutes: int):
        with self._lock:
            self._until[(cam_id, event)] = time.time() + max(1, int(minutes)) * 60


class _HysteresisState:
    """Per-(cam, event) on/off state for detectors that need it."""

    def __init__(self):
        self._lock = threading.Lock()
        self._state: dict[tuple[str, str], str] = {}  # "on" | "off"

    def get(self, cam_id: str, event: str) -> str:
        with self._lock:
            return self._state.get((cam_id, event), "off")

    def set(self, cam_id: str, event: str, value: str):
        with self._lock:
            self._state[(cam_id, event)] = value


def _is_quiet_now(quiet_hours: dict) -> bool:
    """Lightweight clone of telegram_helpers.is_quiet_now to keep this module
    free of a cross-import. Empty config → never quiet."""
    if not quiet_hours:
        return False
    def _p(s):
        try:
            h, m = (s or "").split(":", 1)
            return int(h) * 60 + int(m)
        except Exception:
            return 0
    s_min = _p(quiet_hours.get("start"))
    e_min = _p(quiet_hours.get("end"))
    if s_min == e_min:
        return False
    now = datetime.now()
    cur = now.hour * 60 + now.minute
    if s_min < e_min:
        return s_min <= cur < e_min
    return cur >= s_min or cur < e_min


def _safe_subset(d: dict, keys: list[str]) -> dict:
    if not isinstance(d, dict):
        return {}
    return {k: d.get(k) for k in keys if k in d}

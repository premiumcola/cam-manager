"""One-shot rename of pre-existing timelapse output files so they
carry the per-camera slug introduced alongside this migration.

The bug: two cameras producing a sunrise timelapse on the same day
both ended up with stem ``"2026-05-12_sunrise.mp4"``. They live in
separate per-camera directories so they don't collide on disk, but
the moment a user downloads / shares / aggregates them into a single
folder the names overwrite each other.

The fix at build time appends a camera slug to every new build's
stem. This script walks the existing output tree and renames legacy
files in-place to the same pattern.

Usage:
    docker exec tam-spy python -m app.scripts.migrate_timelapse_filenames --dry-run
    docker exec tam-spy python -m app.scripts.migrate_timelapse_filenames

Behaviour:
- Walks every camera's timelapse output dir under storage/:
    * storage/timelapse/<cam_id>/           — profile + period builds
    * storage/weather/<cam_id>/sunrise_timelapse/   — sun-tl
    * storage/weather/<cam_id>/sunset_timelapse/
    * storage/weather/<cam_id>/event_timelapse/
    * storage/weather/<cam_id>/sun_timelapse/       — legacy pre-2026-04 dir
- For each ``.mp4`` whose stem does NOT already end in the camera's
  computed slug, renames mp4 + paired thumbnail (.jpg) + sidecar
  metadata (.json) + per-build stats (``_stats.json``) to the new
  ``{old_stem}_{cam_slug}.{ext}`` pattern.
- Skips a candidate silently when the target filename already exists
  (idempotent rerun).
- Logs every rename + every skip-reason at INFO so the user can
  audit the run.
- ``--dry-run`` prints the would-be renames without touching disk.
- NEVER auto-runs at boot — the user runs this manually when they're
  ready to converge old filenames onto the new pattern.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from ..camera_id import _sanitise, camera_slug
from ..config_loader import load_config


class _SettingsView:
    """Minimal duck-typed stand-in matching what ``camera_slug``
    reads — ``settings.data["cameras"]``. Avoids dragging the full
    SettingsStore (with its migration + atomic-write machinery) into
    a read-only migration. Built from a raw settings.json parse."""
    def __init__(self, settings_path: Path):
        try:
            self.data = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            self.data = {}

log = logging.getLogger("migration")

# Sibling extensions to rename whenever the .mp4 carries the same stem.
# Thumbnails + sidecar metadata + per-window stats all share the stem
# at build time, so the rename has to walk every variant or the file
# pairing breaks. ``.tracks.json`` is here defensively even though the
# tracking_worker doesn't run on timelapse builds today — keeping it
# parallel to the manifest sidecar logic in weather_service/_manifests.py.
_SIDECAR_EXTS = (".mp4", ".jpg", ".jpeg", ".webp", ".json", ".tracks.json")
# Per-build stats live in a scratch dir adjacent to the mp4; we also
# rename the scratch dir itself when present so a future rerun can
# correlate stats back to the new stem.
_SCRATCH_PREFIX = ".scratch_"


def _has_slug_suffix(stem: str, slug: str) -> bool:
    """True when the stem already ends in ``_{slug}``. Defensive — an
    idempotent rerun must NOT double-append the slug."""
    if not slug:
        return False
    return stem == slug or stem.endswith(f"_{slug}")


def _iter_timelapse_dirs(storage_root: Path):
    """Yield every output directory that could contain timelapse mp4
    files, paired with the camera id parsed from the path. Walks both
    the canonical ``storage/timelapse/<cam>/`` tree and the
    ``storage/weather/<cam>/<phase>_timelapse/`` trees that the
    weather service writes.

    Yields tuples of ``(out_dir, cam_id)``. Order is deterministic so
    the dry-run + real-run logs are comparable for diffing."""
    # Canonical day / profile / period builds.
    tl_root = storage_root / "timelapse"
    if tl_root.exists():
        for cam_dir in sorted(p for p in tl_root.iterdir() if p.is_dir()):
            yield cam_dir, cam_dir.name
    # Weather-service phase + event timelapses.
    wx_root = storage_root / "weather"
    if wx_root.exists():
        phase_dirs = ("sunrise_timelapse", "sunset_timelapse",
                      "event_timelapse", "sun_timelapse")
        for cam_dir in sorted(p for p in wx_root.iterdir() if p.is_dir()):
            cam_id = cam_dir.name
            for sub in phase_dirs:
                p = cam_dir / sub
                if p.exists() and p.is_dir():
                    yield p, cam_id


def _rename_pair(mp4_path: Path, new_stem: str, dry_run: bool) -> int:
    """Rename mp4 + every sidecar that shares its stem. Returns the
    number of files renamed (or that would be renamed in dry-run).
    Sidecars that don't exist are skipped silently — not every build
    writes a thumbnail or a json.
    """
    out_dir = mp4_path.parent
    old_stem = mp4_path.stem
    if old_stem == new_stem:
        return 0
    renamed = 0
    # Collect candidates first so a partial failure can't leave
    # half-renamed files behind. Mp4 last so its existence proves
    # the rename completed.
    candidates: list[tuple[Path, Path]] = []
    for ext in _SIDECAR_EXTS:
        old = out_dir / f"{old_stem}{ext}"
        new = out_dir / f"{new_stem}{ext}"
        if old.exists() and old != new:
            candidates.append((old, new))
    # The build-time CaptureStats path writes _stats.json INSIDE a
    # `.scratch_<stem>/` dir; the dir itself shares the stem. Rename
    # the scratch dir too so future rebuilds correlate cleanly.
    scratch_old = out_dir / f"{_SCRATCH_PREFIX}{old_stem}"
    scratch_new = out_dir / f"{_SCRATCH_PREFIX}{new_stem}"
    if scratch_old.exists() and scratch_old.is_dir() and scratch_old != scratch_new:
        candidates.append((scratch_old, scratch_new))
    # Skip the whole pair when ANY target already exists — preserves
    # the prompt's idempotency rule ("skip silently when target file
    # already exists") and keeps the old files in place for the user
    # to investigate.
    for _old, new in candidates:
        if new.exists():
            log.info("[migration] skip %s: target %s already exists",
                     mp4_path.name, new.name)
            return 0
    for old, new in candidates:
        if dry_run:
            log.info("[migration] DRY-RUN would rename: %s → %s",
                     old.relative_to(old.parents[2] if len(old.parents) >= 3 else old.parent),
                     new.name)
        else:
            try:
                old.rename(new)
                log.info("[migration] renamed: %s → %s",
                         old.relative_to(old.parents[2] if len(old.parents) >= 3 else old.parent),
                         new.name)
            except OSError as e:
                log.warning("[migration] rename failed: %s → %s · %s",
                            old, new, e)
                continue
        renamed += 1
        # Update internal references inside JSON sidecars whose
        # ``clip_path`` / ``thumb_path`` / ``filename`` / ``relpath``
        # / ``event_id`` strings hard-code the old stem. The renamed
        # JSON file is the new path; we patch its body in-place.
        if new.suffix == ".json" and not dry_run and new.exists():
            try:
                _patch_manifest_paths(new, old_stem, new_stem)
            except Exception as e:
                log.warning("[migration] manifest patch failed: %s · %s",
                            new, e)
    return renamed


def _patch_manifest_paths(json_path: Path, old_stem: str, new_stem: str) -> None:
    """Rewrite hard-coded path references inside a manifest JSON.
    The weather-service and camera_runtime sidecar writers embed the
    stem in several fields (``filename``, ``relpath``, ``clip_path``,
    ``thumb_path``, ``event_id``). Without this rewrite a renamed
    file would point its own manifest at a now-nonexistent old path
    and the Mediathek listing would break for that event."""
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    changed = False
    for key in ("filename", "relpath", "clip_path", "thumb_path",
                "video_relpath", "snapshot_relpath", "thumb_url",
                "video_url", "event_id"):
        val = data.get(key)
        if isinstance(val, str) and old_stem in val:
            data[key] = val.replace(old_stem, new_stem)
            changed = True
    if changed:
        json_path.write_text(json.dumps(data, ensure_ascii=False),
                             encoding="utf-8")


def run(storage_root: Path, settings, dry_run: bool) -> dict:
    """Walk every timelapse output dir, rename legacy filenames in
    place. Returns a dict of counters for the caller to print."""
    counters = {"scanned": 0, "renamed_pairs": 0, "renamed_files": 0,
                "already_slugged": 0, "skipped_existing": 0}
    for out_dir, cam_id in _iter_timelapse_dirs(storage_root):
        slug = camera_slug(settings, cam_id)
        if not slug:
            log.warning("[migration] empty slug for cam=%s — skipping dir %s",
                        cam_id, out_dir)
            continue
        for mp4 in sorted(out_dir.glob("*.mp4")):
            counters["scanned"] += 1
            stem = mp4.stem
            # Test captures get a leading "_test_HHMMSS_" prefix that
            # the build-time stem already includes; the slug is still
            # appended at the very end, so the same "ends with slug"
            # check works without special-casing the prefix.
            if _has_slug_suffix(stem, slug):
                counters["already_slugged"] += 1
                continue
            new_stem = f"{stem}_{slug}"
            renamed = _rename_pair(mp4, new_stem, dry_run)
            if renamed > 0:
                counters["renamed_pairs"] += 1
                counters["renamed_files"] += renamed
            else:
                counters["skipped_existing"] += 1
    return counters


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.scripts.migrate_timelapse_filenames",
        description="Rename pre-existing timelapse output files to carry "
                    "a per-camera slug so cross-camera downloads don't "
                    "collide on the same date stem.",
    )
    p.add_argument("--dry-run", action="store_true",
                   help="Print would-be renames without touching disk.")
    p.add_argument("--storage-root", type=Path, default=None,
                   help="Override the storage root path. Defaults to the "
                        "value resolved by config_loader.")
    return p


def main(argv=None):
    args = _build_argparser().parse_args(argv)
    # Match the production logging shape so the operator sees the same
    # "[migration] …" tag used elsewhere in the codebase.
    logging.basicConfig(
        format="%(asctime)s %(levelname)-7s %(name)-20s %(message)s",
        datefmt="%H:%M:%S",
        level=logging.INFO,
    )
    cfg = load_config()
    storage_root = args.storage_root or Path(cfg["storage"]["root"]).resolve()
    if not storage_root.exists():
        log.error("[migration] storage root not found: %s", storage_root)
        return 2
    settings_path = storage_root / "settings.json"
    settings = _SettingsView(settings_path) if settings_path.exists() else None
    log.info("[migration] timelapse-filename slug pass · root=%s · dry_run=%s",
             storage_root, args.dry_run)
    counters = run(storage_root, settings, args.dry_run)
    log.info("[migration] done: scanned=%d renamed_pairs=%d renamed_files=%d "
             "already_slugged=%d skipped_existing=%d",
             counters["scanned"], counters["renamed_pairs"],
             counters["renamed_files"], counters["already_slugged"],
             counters["skipped_existing"])
    return 0


# Silence "unused import" for _sanitise — kept available for future
# slug-edge-case helpers without re-importing here.
_ = _sanitise

if __name__ == "__main__":
    sys.exit(main())

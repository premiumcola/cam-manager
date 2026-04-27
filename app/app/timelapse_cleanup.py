"""Reusable timelapse-frames cleanup helper.

Both the CLI script (``app/scripts/cleanup_invalid_timelapse_frames.py``)
and the admin endpoint (``POST /api/admin/timelapse/cleanup``) call into
the same ``cleanup()`` function so there's a single implementation to
keep correct.

Defensive: a single corrupt file never aborts the walk — errors are
logged and the next file is processed. Only the per-window JPEG
ringbuffer under ``storage/timelapse_frames/`` is touched; finalised
``.mp4`` files under ``storage/timelapse/`` are never read or deleted."""
from __future__ import annotations
from pathlib import Path
import logging

from .frame_helpers import is_valid_frame

log = logging.getLogger(__name__)


def cleanup(storage_root: str | Path, *, dry_run: bool = False,
            cam_id: str | None = None, profile: str | None = None
            ) -> list[dict]:
    """Walk timelapse_frames and delete invalid JPEGs.

    Args:
        storage_root: path to ``storage/`` (e.g. ``/app/storage``).
        dry_run: when True, log what would be deleted but don't unlink.
        cam_id: restrict to one camera id (None = all cams).
        profile: restrict to one profile name (None = all profiles).

    Returns one summary dict per ``<cam>/<profile>`` with keys
    ``cam_id``, ``profile``, ``scanned``, ``kept``, ``deleted``,
    ``deleted_paths`` (first 5 only, for the log line)."""
    import cv2  # local import keeps the module importable in cv2-less envs

    frames_root = Path(storage_root) / "timelapse_frames"
    if not frames_root.exists():
        log.warning("[cleanup] %s does not exist — nothing to do", frames_root)
        return []

    summaries: list[dict] = []
    cam_dirs = sorted(p for p in frames_root.iterdir() if p.is_dir())
    if cam_id:
        cam_dirs = [p for p in cam_dirs if p.name == cam_id]
    for cam_dir in cam_dirs:
        prof_dirs = sorted(p for p in cam_dir.iterdir() if p.is_dir())
        if profile:
            prof_dirs = [p for p in prof_dirs if p.name == profile]
        for prof_dir in prof_dirs:
            scanned = 0
            deleted = 0
            kept = 0
            deleted_paths: list[str] = []
            # window dirs are days for daily/weekly/monthly, timestamps for custom.
            for window_dir in sorted(p for p in prof_dir.iterdir() if p.is_dir()):
                for jpg in sorted(window_dir.glob("*.jpg")):
                    scanned += 1
                    try:
                        img = cv2.imread(str(jpg))
                    except Exception as e:
                        log.warning("[cleanup] read failed: %s (%s)", jpg, e)
                        continue
                    ok, reason = is_valid_frame(img)
                    if ok:
                        kept += 1
                        continue
                    deleted += 1
                    if len(deleted_paths) < 5:
                        deleted_paths.append(f"{jpg.name} ({reason})")
                    if not dry_run:
                        try:
                            jpg.unlink()
                        except Exception as e:
                            log.warning("[cleanup] unlink failed: %s (%s)", jpg, e)
            if scanned:
                summaries.append({
                    "cam_id": cam_dir.name,
                    "profile": prof_dir.name,
                    "scanned": scanned,
                    "kept": kept,
                    "deleted": deleted,
                    "deleted_paths": deleted_paths,
                    "dry_run": dry_run,
                })
                log.info(
                    "[cleanup] %s/%s: scanned %d, kept %d, %s %d (first 5: %s)",
                    cam_dir.name, prof_dir.name,
                    scanned, kept,
                    "would delete" if dry_run else "deleted",
                    deleted,
                    "; ".join(deleted_paths) if deleted_paths else "—",
                )
    return summaries

"""CLI shim — delegates to ``app.timelapse_cleanup.cleanup``.

Usage::

    python -m app.scripts.cleanup_invalid_timelapse_frames --dry-run
    python -m app.scripts.cleanup_invalid_timelapse_frames \\
        --cam-id cam-Werkstatt --profile daily

The actual logic lives in ``app/app/timelapse_cleanup.py`` so the same
implementation also drives the ``POST /api/admin/timelapse/cleanup``
endpoint. Keep this file thin: argparse + log config + delegate."""
from __future__ import annotations
from pathlib import Path
import argparse
import logging
import sys

# Allow running both as a script (``python cleanup_invalid_timelapse_frames.py``)
# and as a module (``python -m app.scripts.cleanup_invalid_timelapse_frames``).
if __package__ in (None, ""):
    _root = Path(__file__).resolve().parent.parent.parent
    if str(_root) not in sys.path:
        sys.path.insert(0, str(_root))

from app.timelapse_cleanup import cleanup  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Delete invalid JPEGs in timelapse_frames")
    p.add_argument("--storage", default="/app/storage",
                   help="Storage root (default: /app/storage)")
    p.add_argument("--cam-id", default=None,
                   help="Restrict to one camera id")
    p.add_argument("--profile", default=None,
                   help="Restrict to one profile (daily/weekly/...)")
    p.add_argument("--dry-run", action="store_true",
                   help="Log what would be deleted without unlinking")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="DEBUG-level logging")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )
    cleanup(Path(args.storage), dry_run=args.dry_run,
            cam_id=args.cam_id, profile=args.profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

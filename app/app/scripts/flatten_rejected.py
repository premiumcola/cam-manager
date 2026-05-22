"""One-shot migration that flattens a legacy ``_rejected/`` tree onto
the new top-level-family layout.

The old reject sink appended a band-location suffix to the subfolder
name (``horizontal_anomaly_band_y68_h4``, ``bottom_strip_bright_y92_h2``,
…) which caused parameter explosion: a single sunset test run with
86 ``horizontal_anomaly_band`` rejects ended up spread across 37
sibling folders. The new sink writes one folder per top-level reason
family (``horizontal_anomaly_band/``, ``bottom_strip_bright/``, …) and
keeps the per-file detail in the filename.

This script walks a single run's ``_rejected/`` tree, computes the
family name via :func:`frame_helpers.reason_family`, moves every file
into the corresponding family bucket, and removes the now-empty
parameter-suffix subdirs. Idempotent — re-running on an already-flat
tree is a no-op.

Usage::

    docker exec tam-spy python -m app.scripts.flatten_rejected <run_dir>
    docker exec tam-spy python -m app.scripts.flatten_rejected <run_dir> --dry-run

``<run_dir>`` may be either the run directory (containing ``_rejected/``)
or the ``_rejected/`` directory itself — both are accepted so the user
doesn't have to remember which path they hand it.

Filename collisions: when two source files would land at the same
target name in the family bucket, the migrator appends ``_<n>`` before
the suffix to disambiguate. Original frames are never overwritten.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from ..frame_helpers import reason_family

log = logging.getLogger("migration")


def _resolve_rejects_dir(arg: Path) -> Path | None:
    """Accept either the run dir or its ``_rejected/`` child. Returns
    the ``_rejected/`` directory on success, None when neither is
    present. Logs the resolution at INFO so the user sees which path
    the migrator picked when they pass an ambiguous root."""
    if arg.name == "_rejected" and arg.is_dir():
        return arg
    candidate = arg / "_rejected"
    if candidate.is_dir():
        return candidate
    return None


def _unique_target(bucket: Path, fname: str) -> Path:
    """Return a path inside ``bucket`` whose basename starts as
    ``fname`` but disambiguates (``stem_1.ext``, ``stem_2.ext``) when
    a file already exists at that name. Used so a migration never
    overwrites an existing reject — collisions are rare but possible
    when two old subdirs both held a ``slot00024_a0_…jpg``."""
    target = bucket / fname
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    for n in range(1, 1000):
        cand = bucket / f"{stem}_{n}{suffix}"
        if not cand.exists():
            return cand
    raise RuntimeError(f"too many filename collisions for {fname} in {bucket}")


def flatten(rejects_dir: Path, *, dry_run: bool = False) -> dict[str, int]:
    """Walk ``rejects_dir`` once and migrate every parameter-suffix
    subdir into its top-level family bucket. Returns a counters dict
    with ``moved``, ``skipped`` (already-flat), ``removed`` (subdirs
    deleted), ``errors``."""
    counters = {"moved": 0, "skipped": 0, "removed": 0, "errors": 0}
    for sub in sorted(p for p in rejects_dir.iterdir() if p.is_dir()):
        family = reason_family(sub.name)
        if family == sub.name:
            counters["skipped"] += 1
            log.debug("[flatten] %s already flat", sub.name)
            continue
        bucket = rejects_dir / family
        if not dry_run:
            try:
                bucket.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                log.error("[flatten] mkdir %s failed: %s", bucket, e)
                counters["errors"] += 1
                continue
        for fp in sorted(sub.iterdir()):
            if not fp.is_file():
                continue
            target = _unique_target(bucket, fp.name)
            log.info("[flatten] %s/%s -> %s/%s", sub.name, fp.name, family, target.name)
            if dry_run:
                counters["moved"] += 1
                continue
            try:
                fp.rename(target)
                counters["moved"] += 1
            except Exception as e:
                log.error("[flatten] rename %s -> %s failed: %s", fp, target, e)
                counters["errors"] += 1
        if dry_run:
            continue
        try:
            if not any(sub.iterdir()):
                sub.rmdir()
                counters["removed"] += 1
        except Exception as e:
            log.debug("[flatten] rmdir %s skipped: %s", sub, e)
    return counters


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "run_dir",
        type=Path,
        help="Path to either the run directory (containing _rejected/) "
        "or the _rejected/ directory itself.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log the would-be moves without touching disk.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    rej = _resolve_rejects_dir(args.run_dir)
    if rej is None:
        log.error("[flatten] no _rejected/ dir at or under %s", args.run_dir)
        return 1
    log.info("[flatten] target: %s%s", rej, " (dry-run)" if args.dry_run else "")
    counters = flatten(rej, dry_run=args.dry_run)
    log.info(
        "[flatten] done: moved=%d skipped=%d removed=%d errors=%d",
        counters["moved"],
        counters["skipped"],
        counters["removed"],
        counters["errors"],
    )
    return 0 if counters["errors"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())

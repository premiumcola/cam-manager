"""Per-camera weather-index diagnostic — what's on disk vs what the
index thinks. Walks ``storage/weather/<cam>/{sunrise,sunset,event}_
timelapse/`` and reports five counts per cam:

  mp4_on_disk   — total *.mp4 files in the phase dirs
  index_rows    — total *.json manifests in the same dirs
  matched       — index rows whose stored clip_path exists as-is
  needs_tolerant — index rows whose clip_path 404s but a glob on
                   ``<stem>*.mp4`` in the same dir hits a renamed
                   sibling (the cam-slug migration shape)
  orphan_mp4    — *.mp4 files with NO matching *.json next to them
  malformed     — files whose stem contains ``__`` or ends with
                   an underscore (trailing-underscore audit from
                   xb293)

When ``>30 %`` of index rows need tolerant resolve, prints a
``[DRIFT]`` line — that's the threshold the boot hook in
weather_service uses to trigger an automatic rescan.

Usage::

    docker exec squirreling-sightings python -m app.scripts.diag_weather_index
    docker exec squirreling-sightings python -m app.scripts.diag_weather_index --json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

log = logging.getLogger("diag_weather")

_PHASE_DIRS = ("sunrise_timelapse", "sunset_timelapse", "event_timelapse")


def _looks_malformed(name: str) -> bool:
    """True when the filename stem ends in an underscore or contains
    a double-underscore — both signatures of an empty slug segment
    slipping through the cam-slug helper."""
    stem = Path(name).stem
    if not stem:
        return False
    if stem.endswith("_"):
        return True
    if "__" in stem:
        return True
    return False


def _resolve_via_glob(stored_full: Path) -> Path | None:
    """Mirror of the tolerant_resolve logic in routes/weather.py.
    Glob the parent dir for ``<stem>*<ext>``; fall back to a
    ``<date>_<phase>`` prefix when the bare-stem glob misses."""
    parent = stored_full.parent
    if not parent.exists():
        return None
    stem = stored_full.stem
    ext = stored_full.suffix.lstrip(".") or "mp4"
    cand = list(parent.glob(f"{stem}*.{ext}"))
    if not cand:
        for token in ("_sunrise", "_sunset"):
            if token in stem:
                prefix = stem.split(token, 1)[0] + token
                cand = list(parent.glob(f"{prefix}*.{ext}"))
                if cand:
                    break
    if not cand:
        return None
    cand.sort(key=lambda p: (p.stem != stem, len(p.name)))
    return cand[0]


def scan(weather_root: Path) -> dict:
    """Return ``{cam_id: {counts…}}`` plus an aggregate summary."""
    out: dict[str, dict] = {}
    malformed_names: list[str] = []
    if not weather_root.exists():
        return {
            "by_cam": {},
            "summary": {
                "mp4_on_disk": 0,
                "index_rows": 0,
                "matched": 0,
                "needs_tolerant": 0,
                "orphan_mp4": 0,
                "malformed": 0,
                "drift_pct": 0.0,
            },
            "malformed_names": [],
        }
    for cam_dir in sorted(p for p in weather_root.iterdir() if p.is_dir()):
        if cam_dir.name.startswith(".") or cam_dir.name == "recaps":
            continue
        cam_id = cam_dir.name
        counts = {
            "mp4_on_disk": 0,
            "index_rows": 0,
            "matched": 0,
            "needs_tolerant": 0,
            "orphan_mp4": 0,
            "malformed": 0,
        }
        for phase in _PHASE_DIRS:
            phase_dir = cam_dir / phase
            if not phase_dir.is_dir():
                continue
            mp4_files = {}
            json_files = {}
            for f in phase_dir.iterdir():
                if f.name.startswith("."):
                    continue
                if _looks_malformed(f.name):
                    counts["malformed"] += 1
                    malformed_names.append(str(f.relative_to(weather_root)))
                if f.suffix == ".mp4":
                    counts["mp4_on_disk"] += 1
                    mp4_files[f.stem] = f
                elif f.suffix == ".json":
                    counts["index_rows"] += 1
                    json_files[f.stem] = f
            for _stem, jf in json_files.items():
                try:
                    m = json.loads(jf.read_text(encoding="utf-8"))
                except Exception:
                    continue
                rel = m.get("clip_path") or ""
                if not rel:
                    continue
                # Stored path is relative to storage root; resolve as
                # if served by the route, but we only have the weather
                # root here — so reconstruct via the manifest's mp4
                # filename + the phase dir we're scanning.
                guess = phase_dir / Path(rel).name
                if guess.exists():
                    counts["matched"] += 1
                else:
                    alt = _resolve_via_glob(guess)
                    if alt is not None and alt.exists():
                        counts["needs_tolerant"] += 1
            for stem, _mp4 in mp4_files.items():
                if stem not in json_files:
                    counts["orphan_mp4"] += 1
        out[cam_id] = counts
    # Aggregate.
    agg = {
        "mp4_on_disk": 0,
        "index_rows": 0,
        "matched": 0,
        "needs_tolerant": 0,
        "orphan_mp4": 0,
        "malformed": 0,
    }
    for counts in out.values():
        for k in agg:
            agg[k] += counts[k]
    agg["drift_pct"] = (
        100.0 * agg["needs_tolerant"] / agg["index_rows"] if agg["index_rows"] else 0.0
    )
    return {"by_cam": out, "summary": agg, "malformed_names": malformed_names}


def _print_human(report: dict) -> None:
    by_cam = report["by_cam"]
    agg = report["summary"]
    if not by_cam:
        log.info("[diag] no weather storage found")
        return
    log.info("[diag] per-camera counts:")
    for cam_id, c in sorted(by_cam.items()):
        log.info(
            "  %-50s mp4=%3d  index=%3d  matched=%3d  needs_tolerant=%3d  "
            "orphan_mp4=%3d  malformed=%3d",
            cam_id,
            c["mp4_on_disk"],
            c["index_rows"],
            c["matched"],
            c["needs_tolerant"],
            c["orphan_mp4"],
            c["malformed"],
        )
    log.info(
        "[diag] aggregate: mp4=%d  index=%d  matched=%d  "
        "needs_tolerant=%d  orphan_mp4=%d  malformed=%d  drift_pct=%.1f%%",
        agg["mp4_on_disk"],
        agg["index_rows"],
        agg["matched"],
        agg["needs_tolerant"],
        agg["orphan_mp4"],
        agg["malformed"],
        agg["drift_pct"],
    )
    if agg["drift_pct"] > 30.0:
        log.info(
            "[DRIFT] %.1f%% of index rows need tolerant-resolve "
            "fallback — auto-rescan should fire",
            agg["drift_pct"],
        )
    if report.get("malformed_names"):
        log.info("[diag] malformed filenames (trailing _ or __):")
        for name in report["malformed_names"][:40]:
            log.info("    %s", name)
        if len(report["malformed_names"]) > 40:
            log.info("    … (%d more)", len(report["malformed_names"]) - 40)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--json", action="store_true", help="emit machine-readable JSON instead of human log lines"
    )
    parser.add_argument(
        "--storage",
        type=Path,
        default=Path("/app/storage"),
        help="storage root (default /app/storage)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    report = scan(args.storage / "weather")
    if args.json:
        sys.stdout.write(json.dumps(report, indent=2, sort_keys=True))
        return 0
    _print_human(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())

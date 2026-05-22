"""Diagnose timelapse quality across a camera's recent sidecars.

Reads the ``<mp4>.qa.json`` sidecars produced by ``timelapse_qa.py``
and prints a markdown-friendly report the user can paste straight
into a chat / GitHub issue. No mp4 re-decoding — the sidecars carry
the playback measurements already.

Usage:
    docker exec tam-spy python -m app.scripts.diag_timelapse <camera_id>
    docker exec tam-spy python -m app.scripts.diag_timelapse <cam>
        --date 2026-05-12 [--profile sunrise] [--last 5]

Output (excerpt):
    # Timelapse quality · reolink_rlc811a_squirreltownnutbar_183
    Range: 2026-05-12 (1 sidecar)

    ## 2026-05-12_sunrise_squirreltownnutbar.mp4    ● red
    - declared 25 fps · effective 13.35 fps · unique 7.67 fps
    - dup_ratio 43 % · freezes 9 (total 6.18 s)
    - top reject: twilight_too_dark (142), grey_uniform (88), ...

    ## Aggregate (1 build)
    - mean unique_fps: 7.67
    - dominant reject reason: twilight_too_dark
    - auto-adjust events: none
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from ..config_loader import load_config

log = logging.getLogger("diag")

# Coloured-dot glyphs (unicode bullets + colour-name text) so the
# report stays emoji-free and renders cleanly in monospace pastes.
_GRADE_DOT = {"green": "●", "yellow": "●", "red": "●", "unknown": "○"}
_GRADE_COLOR = {"green": "green", "yellow": "yellow", "red": "red", "unknown": "grey"}


def _iter_qa_paths(storage_root: Path, camera_id: str):
    """Yield every ``<mp4>.qa.json`` for ``camera_id`` across both
    output trees (``storage/timelapse/<cam>/`` and
    ``storage/weather/<cam>/{sunrise,sunset,event,sun}_timelapse/``).
    Newest first."""
    candidates: list[tuple[float, Path]] = []
    tl_dir = storage_root / "timelapse" / camera_id
    if tl_dir.exists():
        for p in tl_dir.glob("*.qa.json"):
            candidates.append((p.stat().st_mtime, p))
    wx_dir = storage_root / "weather" / camera_id
    if wx_dir.exists():
        for sub in ("sunrise_timelapse", "sunset_timelapse", "event_timelapse", "sun_timelapse"):
            d = wx_dir / sub
            if d.exists():
                for p in d.glob("*.qa.json"):
                    candidates.append((p.stat().st_mtime, p))
    candidates.sort(key=lambda t: -t[0])
    for _, p in candidates:
        yield p


def _filter_by_date(records, date_str: str | None):
    """Filter by ISO date prefix on the build_at field. Sidecars
    written with ``%Y-%m-%dT%H:%M:%S%z`` start with the YYYY-MM-DD
    so substring-match is enough; sidecars from a different time
    zone still match the date the build STARTED on."""
    if not date_str:
        return records
    return [r for r in records if str(r.get("build_at") or "").startswith(date_str)]


def _filter_by_profile(records, profile_name: str | None):
    if not profile_name:
        return records
    return [r for r in records if r.get("profile_name") == profile_name]


def _emit_report(camera_id: str, sidecars: list[dict], date_filter: str | None) -> str:
    if not sidecars:
        return (
            f"# Timelapse quality · {camera_id}\n" "No sidecars found for the requested filters.\n"
        )
    lines: list[str] = []
    range_label = date_filter or "all dates"
    lines.append(f"# Timelapse quality · `{camera_id}`")
    lines.append(
        f"Range: {range_label} ({len(sidecars)} sidecar" f"{'s' if len(sidecars) != 1 else ''})"
    )
    lines.append("")
    # Per-mp4 blocks — chronological. The iterator is newest-first;
    # flip so the report reads top-to-bottom by build time.
    for s in reversed(sidecars):
        pb = s.get("playback") or {}
        cap = s.get("capture") or {}
        grade = (s.get("quality_grade") or "unknown").lower()
        dot = _GRADE_DOT.get(grade, "○")
        colour = _GRADE_COLOR.get(grade, "grey")
        lines.append(f"## {s.get('video', '?')}    {dot} {colour}")
        lines.append(
            f"- declared {pb.get('declared_fps', 0):g} fps · "
            f"effective {pb.get('effective_fps', 0):g} fps · "
            f"unique {pb.get('unique_fps', 0):g} fps"
        )
        dup_ratio = float(pb.get("duplicate_ratio") or 0.0)
        freezes = s.get("freezes") or []
        freeze_total = sum(float(f.get("duration_s") or 0.0) for f in freezes)
        lines.append(
            f"- dup_ratio {dup_ratio * 100:.0f} % · "
            f"freezes {len(freezes)} (total {freeze_total:.2f} s)"
        )
        reasons = cap.get("reject_reasons") or {}
        if reasons:
            top3 = sorted(reasons.items(), key=lambda kv: -kv[1])[:3]
            top3_str = ", ".join(f"{k} ({v})" for k, v in top3)
            lines.append(f"- top reject: {top3_str}")
        else:
            lines.append("- top reject: (no capture stats — sidecar lacks _stats.json)")
        if s.get("validator_profile_used"):
            lines.append(f"- profile: {s['validator_profile_used']}")
        if s.get("profile_name"):
            lines.append(f"- build profile: `{s['profile_name']}`")
        lines.append("")
    # Footer aggregate.
    unique_fps_vals = [float((s.get("playback") or {}).get("unique_fps") or 0) for s in sidecars]
    mean_unique = sum(unique_fps_vals) / len(unique_fps_vals) if unique_fps_vals else 0.0
    reason_totals: Counter[str] = Counter()
    for s in sidecars:
        for k, v in ((s.get("capture") or {}).get("reject_reasons") or {}).items():
            try:
                reason_totals[k] += int(v)
            except (TypeError, ValueError):
                pass
    dominant = reason_totals.most_common(1)[0][0] if reason_totals else "(none recorded)"
    lines.append(f"## Aggregate ({len(sidecars)} build" f"{'s' if len(sidecars) != 1 else ''})")
    lines.append(f"- mean unique_fps: {mean_unique:.2f}")
    lines.append(f"- dominant reject reason: {dominant}")
    # Auto-adjust events — best-effort scan of the recent log lines
    # would require log access; we surface the per-sidecar grade
    # distribution instead, which is what the user actually wants
    # to see (was today worse than yesterday?).
    grade_counts = Counter(s.get("quality_grade") or "unknown" for s in sidecars)
    grade_str = ", ".join(f"{g}={n}" for g, n in grade_counts.most_common())
    lines.append(f"- grade distribution: {grade_str}")
    return "\n".join(lines) + "\n"


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m app.scripts.diag_timelapse",
        description="Plain-text quality report from QA sidecars.",
    )
    p.add_argument("camera_id", help="Canonical camera id (manufacturer_model_name_octet).")
    p.add_argument(
        "--date",
        default=None,
        help="ISO date YYYY-MM-DD. Defaults to today; pass 'all' " "to range across every sidecar.",
    )
    p.add_argument(
        "--profile", default=None, help="Filter to one profile_name (sunrise/sunset/day/event/…)."
    )
    p.add_argument(
        "--last",
        type=int,
        default=None,
        help="Limit to the N most recent sidecars after filtering.",
    )
    p.add_argument("--storage-root", type=Path, default=None, help="Override storage root.")
    return p


def main(argv=None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        format="%(asctime)s %(levelname)-7s %(name)-8s %(message)s",
        datefmt="%H:%M:%S",
        level=logging.INFO,
    )
    cfg = load_config()
    storage_root = args.storage_root or Path(cfg["storage"]["root"]).resolve()
    date_filter = args.date
    if date_filter is None:
        date_filter = datetime.now().strftime("%Y-%m-%d")
    elif date_filter.lower() == "all":
        date_filter = None
    records: list[dict] = []
    for qa_path in _iter_qa_paths(storage_root, args.camera_id):
        try:
            records.append(json.loads(qa_path.read_text(encoding="utf-8")))
        except Exception as e:
            log.warning("skipping unreadable sidecar %s: %s", qa_path, e)
    records = _filter_by_date(records, date_filter)
    records = _filter_by_profile(records, args.profile)
    if args.last is not None and args.last > 0:
        records = records[: args.last]
    sys.stdout.write(_emit_report(args.camera_id, records, date_filter))
    return 0


if __name__ == "__main__":
    sys.exit(main())

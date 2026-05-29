"""E2 · offline wind-vs-animal motion-threshold calibration tool.

Reads the labeled motion samples accumulated by E1
(storage/_diag/motion_samples.jsonl) and, per camera, computes the
animal-vs-wind distributions of each cheap discriminator (net-displacement
fraction, wildlife-low blob area, solidity, trajectory straightness) and
RECOMMENDS per-camera thresholds that maximise animal recall while rejecting
wind. Writes storage/_diag/motion_calibration_<ts>.md.

READ-ONLY on settings — it recommends only; the operator applies the values
via the D3 cam-edit controls (roi_min_net_disp_frac, wildlife_motion_
sensitivity). If there are too few samples, or no clip labeled "wind" (no
windy day captured yet), it says so and exits WITHOUT inventing thresholds.

Stdlib-only (no app/Coral deps) → runs anywhere the storage dir is reachable.
From the repo root on the host:
    python3 app/scripts/motion_calibration.py
Or inside the container once scripts/ is baked into the image (next rebuild):
    docker exec -w /app -e PYTHONPATH=/app squirreling-sightings \
        python3 -m scripts.motion_calibration
"""

from __future__ import annotations

import json
import statistics as st
import sys
import time
from pathlib import Path

# Minimum evidence before any threshold is trustworthy. Conservative — a
# calibration on a handful of samples (or with no windy day) would overfit.
MIN_TOTAL = 30
MIN_PER_CLASS = 8


def _storage_root() -> Path:
    try:
        sys.path.insert(0, "/app")
        from app.config_loader import load_config  # type: ignore

        return Path(load_config()["storage"]["root"])
    except Exception:
        return Path("storage")


def _load(samples_path: Path):
    rows = []
    if not samples_path.exists():
        return rows
    for line in samples_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _sep_threshold(animal_vals, wind_vals, prefer="high"):
    """Recommend a separating threshold + the recall/rejection it achieves.
    prefer='high' → animals are expected ABOVE the threshold (e.g. net-disp).
    Picks the midpoint of the class medians, then reports separation."""
    if not animal_vals or not wind_vals:
        return None
    am, wm = st.median(animal_vals), st.median(wind_vals)
    thr = (am + wm) / 2.0
    if prefer == "high":
        recall = sum(1 for v in animal_vals if v >= thr) / len(animal_vals)
        reject = sum(1 for v in wind_vals if v < thr) / len(wind_vals)
    else:
        recall = sum(1 for v in animal_vals if v <= thr) / len(animal_vals)
        reject = sum(1 for v in wind_vals if v > thr) / len(wind_vals)
    return {
        "threshold": round(thr, 4),
        "animal_median": round(am, 4),
        "wind_median": round(wm, 4),
        "animal_recall": round(recall, 2),
        "wind_reject": round(reject, 2),
    }


def main():
    root = _storage_root()
    diag = root / "_diag"
    rows = _load(diag / "motion_samples.jsonl")
    # ts must be injected (Date.now is fine here — plain CPython script).
    ts = time.strftime("%Y%m%d_%H%M%S")
    out_path = diag / f"motion_calibration_{ts}.md"
    diag.mkdir(parents=True, exist_ok=True)

    n = len(rows)
    animals = [r for r in rows if r.get("label") == "animal"]
    winds = [r for r in rows if r.get("label") == "wind"]
    cams = sorted({r.get("cam", "?") for r in rows})

    lines = [
        "# Motion-threshold calibration (E2)",
        "",
        f"Generated {ts} · source `storage/_diag/motion_samples.jsonl` · "
        f"{n} sample(s) ({len(animals)} animal / {len(winds)} wind) across {len(cams)} camera(s).",
        "",
    ]

    insufficient = n < MIN_TOTAL or len(animals) < MIN_PER_CLASS or len(winds) < MIN_PER_CLASS
    if insufficient:
        lines += [
            "## NOT ENOUGH DATA YET",
            "",
            f"Need ≥ {MIN_TOTAL} total samples AND ≥ {MIN_PER_CLASS} of each class "
            "(animal **and** wind) before a recommendation is trustworthy.",
            "",
            f"- total: **{n}** / {MIN_TOTAL}",
            f"- animal: **{len(animals)}** / {MIN_PER_CLASS}",
            f"- wind: **{len(winds)}** / {MIN_PER_CLASS}",
            "",
            "The `wind` class only fills once the D-pipeline is live AND a windy "
            "day produces coherent-but-empty escalations. Until then there is no "
            "animal-vs-wind separation to calibrate — **no thresholds recommended** "
            "(inventing them would overfit). Re-run once clips accumulate.",
        ]
        out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[calib] {out_path}")
        print(
            f"[calib] NOT ENOUGH DATA — total={n} animal={len(animals)} wind={len(winds)} "
            f"(need ≥{MIN_TOTAL} total, ≥{MIN_PER_CLASS}/class). No thresholds recommended."
        )
        return

    lines += ["## Recommended per-camera thresholds", ""]
    for cam in cams:
        ca = [r for r in animals if r.get("cam") == cam]
        cw = [r for r in winds if r.get("cam") == cam]
        lines.append(f"### `{cam}` ({len(ca)} animal / {len(cw)} wind)")
        if len(ca) < MIN_PER_CLASS or len(cw) < MIN_PER_CLASS:
            lines += ["", "_too few per-class samples for this camera — skipped_", ""]
            continue

        def col(rows_, key):
            return [float(r[key]) for r in rows_ if r.get(key) is not None]

        net = _sep_threshold(col(ca, "net_disp_frac"), col(cw, "net_disp_frac"), "high")
        area = _sep_threshold(col(ca, "area_px"), col(cw, "area_px"), "high")
        sol = _sep_threshold(col(ca, "solidity"), col(cw, "solidity"), "high")
        straight = _sep_threshold(col(ca, "straightness"), col(cw, "straightness"), "high")
        lines += [""]
        if net:
            lines.append(
                f"- **roi_min_net_disp_frac** ≈ `{net['threshold']}` "
                f"(animal med {net['animal_median']} vs wind {net['wind_median']}; "
                f"recall {net['animal_recall']}, wind-reject {net['wind_reject']})"
            )
        if area:
            lines.append(
                f"- wildlife-low area floor ≈ `{int(area['threshold'])} px` "
                f"(animal med {int(area['animal_median'])} vs wind {int(area['wind_median'])}; "
                f"recall {area['animal_recall']}, wind-reject {area['wind_reject']})"
            )
        if sol:
            lines.append(
                f"- solidity support ≥ `{sol['threshold']}` "
                f"(recall {sol['animal_recall']}, wind-reject {sol['wind_reject']})"
            )
        if straight:
            lines.append(
                f"- straightness support ≥ `{straight['threshold']}` "
                f"(recall {straight['animal_recall']}, wind-reject {straight['wind_reject']})"
            )
        lines += [
            "",
            "_Apply via the cam-edit Erkennung tab (D3) — this tool recommends only._",
            "",
        ]

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[calib] {out_path}")
    print(f"[calib] recommended thresholds for {len(cams)} camera(s) from {n} samples.")


if __name__ == "__main__":
    main()

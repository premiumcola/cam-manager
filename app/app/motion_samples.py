"""E1 · labeled motion-sample sidecar for wind-vs-animal calibration.

When the D1 gate escalates a wildlife-low event and the D2 ROI pass runs, one
JSONL line is appended to ``storage/_diag/motion_samples.jsonl`` carrying the
coherent blob's discriminator features and a WEAK label derived from the
outcome: D2 kept an object ≈ "animal"; escalated-but-empty ≈ "wind/noise".

Append-only and additive — this NEVER touches settings.json. The offline
``scripts/motion_calibration.py`` tool (E2) reads these to recommend
per-camera thresholds once enough real (including windy) clips accumulate.
Sampling is best-effort: any error is swallowed so the capture loop is never
broken by a diagnostic write.
"""

from __future__ import annotations

import json
from pathlib import Path


def record_sample(
    storage_root, cam_id: str, blob, kept: bool, mode: str, ts: float, frame_w: int = 0
) -> None:
    """Append one labeled motion-sample line. `blob` is a D1 _BlobTrack."""
    try:
        diag = Path(storage_root or "storage") / "_diag"
        diag.mkdir(parents=True, exist_ok=True)
        x, y, w, h = blob.last_bbox
        net = float(blob.net_displacement)
        rec = {
            "ts": round(float(ts), 1),
            "cam": cam_id,
            "roi_mode": mode,
            # Weak label: a kept D2 object means the tiling pass confirmed a
            # real subject; an empty pass on a coherent blob is most likely
            # wind/noise. The operator can relabel in the calibration step.
            "label": "animal" if kept else "wind",
            "kept": bool(kept),
            "frame_w": int(frame_w),
            "area_px": int(max(0, w) * max(0, h)),
            "solidity": round(float(blob.median_solidity), 3),
            "net_disp_px": round(net, 1),
            "net_disp_frac": round(net / frame_w, 4) if frame_w else None,
            "path_len_px": round(float(blob.path_length), 1),
            "straightness": round(float(blob.straightness), 3),
            "age": int(blob.age),
        }
        with (diag / "motion_samples.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception:  # noqa: BLE001 — diagnostic sampling must never break capture
        pass

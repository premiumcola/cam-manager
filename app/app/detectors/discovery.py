"""Wildlife model auto-discovery — locate a MobileNet/ImageNet tflite
file under /app/models without forcing the user to edit config.yaml.

Carved out of `_legacy_classes.py` during R02.3.
"""

from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)


def discover_wildlife_paths(models_dir: str | Path = "/app/models") -> dict:
    """Look for a wildlife/mammal classifier in `models_dir`.

    Heuristic — accept any .tflite whose name matches one of the common
    naming patterns we have seen in the wild:
      - contains "mobilenet"   (the canonical ImageNet MobileNetV2)
      - contains "mobilenet_v2" / "mobilenet-v2" (underscore/dash variants)
      - contains "imagenet"    (some users rename to imagenet_*.tflite)
      - contains "wildlife"    (explicitly tagged drop-ins)
    Always reject SSD models (object detectors) and bird-iNat models —
    those have their own loaders.

    Returns a dict with keys model_path / cpu_model_path / labels_path
    when found, else an empty dict. Used as fallback when config.yaml has
    no `processing.wildlife.*` block — common case after a fresh install
    where the user just dropped the file into models/.
    """
    p = Path(models_dir)
    if not p.exists():
        log.debug("[wildlife-discover] models dir does not exist: %s", p)
        return {}

    def _matches(fname: str) -> bool:
        low = fname.lower()
        if "ssd" in low or "bird" in low:
            return False
        if "mobilenet" in low:  # mobilenet, mobilenet_v2, MobileNet-V2
            return True
        if "imagenet" in low:
            return True
        if "wildlife" in low:
            return True
        return False

    cands = [f for f in p.glob("*.tflite") if _matches(f.name)]
    if not cands:
        log.debug("[wildlife-discover] no candidate .tflite found in %s", p)
        return {}
    edge = next((f for f in cands if "edgetpu" in f.name.lower()), None)
    cpu = next((f for f in cands if "edgetpu" not in f.name.lower()), None)
    out = {
        "model_path": str(edge or cpu or cands[0]),
        "cpu_model_path": str(cpu or edge or cands[0]),
    }
    lbl = p / "imagenet_labels.txt"
    if lbl.exists():
        out["labels_path"] = str(lbl)
    log.debug(
        "[wildlife-discover] picked model_path=%s cpu_model_path=%s labels=%s",
        out.get("model_path"),
        out.get("cpu_model_path"),
        out.get("labels_path"),
    )
    return out

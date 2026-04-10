from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import logging
import cv2
import numpy as np

log = logging.getLogger(__name__)


def load_label_map(path: str | None) -> dict[int, str]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    text = p.read_text(encoding="utf-8", errors="ignore").splitlines()
    out: dict[int, str] = {}
    for line in text:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" in line:
            k, v = line.split(":", 1)
        elif " " in line:
            k, v = line.split(" ", 1)
        else:
            continue
        try:
            out[int(k.strip())] = v.strip()
        except Exception:
            continue
    return out


@dataclass
class Detection:
    label: str
    score: float
    bbox: tuple[int, int, int, int]
    species: str | None = None
    identity: str | None = None

    def to_dict(self):
        x1, y1, x2, y2 = self.bbox
        return {
            "label": self.label,
            "score": round(float(self.score), 4),
            "bbox": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
            "species": self.species,
            "identity": self.identity,
        }


class CoralObjectDetector:
    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = self.cfg.get("mode", "none") in {"coral", "future_coral"}
        self.available = False
        self.reason = "disabled"
        self.labels = load_label_map(self.cfg.get("labels_path"))
        self.min_score = float(self.cfg.get("min_score", 0.55))
        self.interpreter = None
        self.common = None
        self.detect = None
        self.device = self.cfg.get("device")
        if not self.enabled:
            return
        model_path = self.cfg.get("model_path")
        if not model_path:
            self.reason = "missing model_path"
            return
        try:
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
            from pycoral.adapters import common, detect  # type: ignore
            self.common = common
            self.detect = detect
            self.interpreter = make_interpreter(model_path, device=self.device)
            self.interpreter.allocate_tensors()
            self.available = True
            self.reason = "ok"
        except Exception as e:
            self.reason = f"pycoral unavailable: {e}"
            log.warning("Coral detector unavailable: %s", e)

    def detect_frame(self, frame: np.ndarray) -> list[Detection]:
        if not self.available:
            return []
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        width, height = self.common.input_size(self.interpreter)
        resized = cv2.resize(rgb, (width, height))
        self.common.set_input(self.interpreter, resized)
        self.interpreter.invoke()
        objs = self.detect.get_objects(self.interpreter, score_threshold=self.min_score)
        h, w = frame.shape[:2]
        out: list[Detection] = []
        sx = w / float(width)
        sy = h / float(height)
        for obj in objs:
            bbox = obj.bbox
            x1 = max(0, int(bbox.xmin * sx))
            y1 = max(0, int(bbox.ymin * sy))
            x2 = min(w, int(bbox.xmax * sx))
            y2 = min(h, int(bbox.ymax * sy))
            label = self.labels.get(int(obj.id), str(obj.id))
            out.append(Detection(label=label, score=float(obj.score), bbox=(x1, y1, x2, y2)))
        return out


class BirdSpeciesClassifier:
    """Optional second stage classifier for bird crops.

    Honest note: this only works if the user provides a compiled EdgeTPU/TFLite model
    plus matching labels. Without that, the system stays on generic 'bird'.
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = bool(self.cfg.get("enabled"))
        self.available = False
        self.reason = "disabled"
        self.labels = load_label_map(self.cfg.get("labels_path"))
        self.min_score = float(self.cfg.get("min_score", 0.45))
        self.interpreter = None
        self.common = None
        self.classify = None
        if not self.enabled:
            return
        model_path = self.cfg.get("model_path")
        if not model_path:
            self.reason = "missing model_path"
            return
        try:
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
            from pycoral.adapters import common, classify  # type: ignore
            self.common = common
            self.classify = classify
            self.interpreter = make_interpreter(model_path, device=self.cfg.get("device"))
            self.interpreter.allocate_tensors()
            self.available = True
            self.reason = "ok"
        except Exception as e:
            self.reason = f"classifier unavailable: {e}"
            log.warning("Bird species classifier unavailable: %s", e)

    def classify_crop(self, crop: np.ndarray) -> tuple[str | None, float | None]:
        if not self.available or crop is None or crop.size == 0:
            return None, None
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        width, height = self.common.input_size(self.interpreter)
        resized = cv2.resize(rgb, (width, height))
        self.common.set_input(self.interpreter, resized)
        self.interpreter.invoke()
        classes = self.classify.get_classes(self.interpreter, top_k=1, score_threshold=self.min_score)
        if not classes:
            return None, None
        c = classes[0]
        label = self.labels.get(int(c.id), str(c.id))
        return label, float(c.score)


def draw_detections(frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
    if frame is None:
        return frame
    out = frame.copy()
    colors = {
        "bird": (84, 214, 98),
        "cat": (160, 110, 255),
        "person": (110, 110, 255),
        "dog": (0, 176, 255),
    }
    for det in detections:
        x1, y1, x2, y2 = det.bbox
        color = colors.get(det.label, (255, 180, 0))
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        parts = [det.label]
        if det.species:
            parts.append(det.species)
        if det.identity:
            parts.append(det.identity)
        parts.append(f"{det.score:.2f}")
        text = " | ".join(parts)
        cv2.putText(out, text, (x1, max(24, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.58, color, 2, cv2.LINE_AA)
    return out

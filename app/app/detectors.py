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
    """Object detector with three-tier fallback:
    1. pycoral + EdgeTPU  → mode="coral"
    2. tflite-runtime CPU → mode="cpu"
    3. No detection       → mode="motion_only"
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = self.cfg.get("mode", "none") in {"coral", "future_coral"}
        self.available = False
        self.reason = "disabled"
        self.mode = "motion_only"  # "coral" | "cpu" | "motion_only"
        self.labels = load_label_map(self.cfg.get("labels_path"))
        self.min_score = float(self.cfg.get("min_score", 0.55))
        self.interpreter = None
        self.common = None
        self.detect = None
        self._cpu_mode = False  # True when using tflite-runtime instead of pycoral
        self.device = self.cfg.get("device")
        if not self.enabled:
            return
        model_path = self.cfg.get("model_path")
        if not model_path:
            self.reason = "missing model_path"
            return

        # ── Tier 1: pycoral + Coral TPU ────────────────────────────────────
        try:
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
            from pycoral.adapters import common, detect  # type: ignore
            self.common = common
            self.detect = detect
            self.interpreter = make_interpreter(model_path, device=self.device)
            self.interpreter.allocate_tensors()
            self.available = True
            self.mode = "coral"
            self.reason = "ok"
            log.info("Coral TPU aktiv: %s", model_path)
            return
        except Exception as e:
            log.warning("Coral TPU nicht verfügbar (%s) – versuche CPU-Fallback…", e)
            coral_error = str(e)

        # ── Tier 2: tflite-runtime CPU fallback ────────────────────────────
        # For EdgeTPU models (*_edgetpu.tflite) try the non-EdgeTPU variant.
        cpu_model = self.cfg.get("cpu_model_path")
        if not cpu_model:
            cpu_model = model_path.replace("_edgetpu.tflite", ".tflite")
            if cpu_model == model_path:
                cpu_model = None  # same path → no CPU variant available

        for try_path in filter(None, [cpu_model, model_path]):
            try:
                import tflite_runtime.interpreter as tflite  # type: ignore
                interp = tflite.Interpreter(model_path=try_path)
                interp.allocate_tensors()
                self.interpreter = interp
                self._cpu_mode = True
                self.available = True
                self.mode = "cpu"
                self.reason = f"cpu_fallback (coral: {coral_error})"
                log.info("CPU-Fallback aktiv: %s", try_path)
                return
            except Exception as e2:
                log.warning("CPU-Fallback fehlgeschlagen für %s: %s", try_path, e2)

        self.reason = f"pycoral: {coral_error}"
        log.warning("Kein Detektor verfügbar – nur Bewegungserkennung aktiv")

    def detect_frame(self, frame: np.ndarray) -> list[Detection]:
        if not self.available:
            return []
        if self._cpu_mode:
            return self._detect_cpu(frame)
        return self._detect_coral(frame)

    def _detect_coral(self, frame: np.ndarray) -> list[Detection]:
        """Inference via pycoral + EdgeTPU."""
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

    def _detect_cpu(self, frame: np.ndarray) -> list[Detection]:
        """Inference via tflite-runtime on CPU (SSD MobileNet layout)."""
        input_details = self.interpreter.get_input_details()
        output_details = self.interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if input_details[0]['dtype'] == np.float32:
            inp = (inp.astype(np.float32) - 127.5) / 127.5
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        # Standard SSD output order: boxes [N,4], classes [N], scores [N], count
        boxes   = self.interpreter.get_tensor(output_details[0]['index'])[0]
        classes = self.interpreter.get_tensor(output_details[1]['index'])[0]
        scores  = self.interpreter.get_tensor(output_details[2]['index'])[0]
        h, w = frame.shape[:2]
        out: list[Detection] = []
        for i in range(len(scores)):
            score = float(scores[i])
            if score < self.min_score:
                continue
            ymin, xmin, ymax, xmax = boxes[i]
            x1 = max(0, int(xmin * w))
            y1 = max(0, int(ymin * h))
            x2 = min(w, int(xmax * w))
            y2 = min(h, int(ymax * h))
            cls_id = int(classes[i])
            # tflite SSD models use 1-based COCO IDs in output (0=background)
            label = self.labels.get(cls_id + 1, self.labels.get(cls_id, str(cls_id)))
            out.append(Detection(label=label, score=score, bbox=(x1, y1, x2, y2)))
        return out


class BirdSpeciesClassifier:
    """Optional second stage classifier for bird crops.

    Tries pycoral (EdgeTPU) first, then tflite-runtime CPU fallback.
    Without a model file the system stays on generic 'bird'.
    """

    def __init__(self, cfg: dict):
        self.cfg = cfg or {}
        self.enabled = bool(self.cfg.get("enabled"))
        self.available = False
        self.reason = "disabled"
        self.mode = "none"  # "coral" | "cpu" | "none"
        self.labels = load_label_map(self.cfg.get("labels_path"))
        self.min_score = float(self.cfg.get("min_score", 0.45))
        self.interpreter = None
        self.common = None
        self.classify = None
        self._cpu_mode = False
        if not self.enabled:
            return
        model_path = self.cfg.get("model_path")
        if not model_path:
            self.reason = "missing model_path"
            return

        # ── Tier 1: pycoral ───────────────────────────────────────────────
        try:
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
            from pycoral.adapters import common, classify  # type: ignore
            self.common = common
            self.classify = classify
            self.interpreter = make_interpreter(model_path, device=self.cfg.get("device"))
            self.interpreter.allocate_tensors()
            self.available = True
            self.mode = "coral"
            self.reason = "ok"
            log.info("Bird classifier (Coral) aktiv: %s", model_path)
            return
        except Exception as e:
            log.warning("Bird classifier pycoral unavailable (%s) – CPU-Fallback…", e)
            coral_error = str(e)

        # ── Tier 2: tflite-runtime ────────────────────────────────────────
        cpu_model = self.cfg.get("cpu_model_path")
        if not cpu_model:
            cpu_model = model_path.replace("_edgetpu.tflite", ".tflite")
            if cpu_model == model_path:
                cpu_model = None

        for try_path in filter(None, [cpu_model, model_path]):
            try:
                import tflite_runtime.interpreter as tflite  # type: ignore
                interp = tflite.Interpreter(model_path=try_path)
                interp.allocate_tensors()
                self.interpreter = interp
                self._cpu_mode = True
                self.available = True
                self.mode = "cpu"
                self.reason = f"cpu_fallback (coral: {coral_error})"
                log.info("Bird classifier (CPU) aktiv: %s", try_path)
                return
            except Exception as e2:
                log.warning("Bird classifier CPU fehlgeschlagen für %s: %s", try_path, e2)

        self.reason = f"classifier unavailable: {coral_error}"
        log.warning("Bird species classifier nicht verfügbar")

    def classify_crop(self, crop: np.ndarray) -> tuple[str | None, float | None]:
        if not self.available or crop is None or crop.size == 0:
            return None, None
        if self._cpu_mode:
            return self._classify_cpu(crop)
        return self._classify_coral(crop)

    def _classify_coral(self, crop: np.ndarray) -> tuple[str | None, float | None]:
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

    def _classify_cpu(self, crop: np.ndarray) -> tuple[str | None, float | None]:
        input_details = self.interpreter.get_input_details()
        output_details = self.interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if input_details[0]['dtype'] == np.float32:
            inp = inp.astype(np.float32) / 255.0
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(output_details[0]['index'])[0]
        best_id = int(np.argmax(scores))
        best_score = float(scores[best_id])
        if best_score < self.min_score:
            return None, None
        label = self.labels.get(best_id, str(best_id))
        return label, best_score


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

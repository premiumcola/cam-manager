from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import logging
import cv2
import numpy as np

log = logging.getLogger(__name__)


# COCO classes that are physically implausible for a residential / garden /
# workshop camera in central Europe. When the object detector emits one of
# these (typically a low-quality hallucination on a dark blob: e.g. a crow
# coming back as "elephant"), we drop it instead of polluting the event log.
# Disable via config: processing.detection.region_filter_enabled = false
IMPOSSIBLE_LABELS: frozenset[str] = frozenset({
    "elephant", "bear", "zebra", "giraffe",
    "cow", "sheep", "horse",
    "airplane", "train", "bus", "truck", "boat",
    "surfboard", "snowboard", "skis",
    "baseball bat", "baseball_bat",
    "baseball glove", "baseball_glove",
    "frisbee", "skateboard", "kite",
    "fire hydrant", "fire_hydrant",
    "parking meter", "parking_meter",
    "stop sign", "stop_sign",
    "traffic light", "traffic_light",
})


def _apply_region_filter(dets: list["Detection"], enabled: bool) -> list["Detection"]:
    if not enabled:
        return dets
    return [d for d in dets if d.label not in IMPOSSIBLE_LABELS]


def load_label_map(path: str | None) -> dict[int, str]:
    """Load a TFLite label file.

    Supports two formats:
      A) numeric-prefixed (e.g. Coral COCO)   "16 bird"     / "16: bird"
      B) plain lines      (e.g. Coral iNat)   "Turdus merula (Common Blackbird)"

    In format B the line index (0-based) becomes the label id, which is what
    the classifier output layer uses for iNaturalist-style models.
    """
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    text = p.read_text(encoding="utf-8", errors="ignore").splitlines()
    out: dict[int, str] = {}
    lines_nonblank: list[str] = []
    for line in text:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        lines_nonblank.append(line)
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
    if not out and lines_nonblank:
        # Format B — plain labels, one per line, indexed by position.
        out = {i: s for i, s in enumerate(lines_nonblank)}
    return out


@dataclass
class Detection:
    label: str
    score: float
    bbox: tuple[int, int, int, int]
    species: str | None = None
    species_score: float | None = None
    identity: str | None = None
    raw_cls_id: int = -1  # unmapped class id as emitted by the model

    def to_dict(self):
        x1, y1, x2, y2 = self.bbox
        return {
            "label": self.label,
            "score": round(float(self.score), 4),
            "bbox": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
            "species": self.species,
            "species_score": round(float(self.species_score), 4) if self.species_score is not None else None,
            "identity": self.identity,
            "raw_cls_id": int(self.raw_cls_id),
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
        # Region filter: drop implausible COCO labels (elephant, zebra, …)
        # after detection. On by default. See IMPOSSIBLE_LABELS for the set.
        self._region_filter = bool(self.cfg.get("region_filter_enabled", True))
        self.interpreter = None
        self.common = None
        self.detect = None
        self._cpu_mode = False  # True when using tflite-runtime instead of pycoral
        self.device = self.cfg.get("device")
        if not self.enabled:
            return
        # Startup diagnostic: log the label file path + first 25 entries so
        # label-mapping mistakes surface immediately instead of showing up as
        # "crow detected as elephant" weeks later.
        lp = self.cfg.get("labels_path")
        sample = {k: self.labels[k] for k in sorted(self.labels)[:25]}
        log.info("CoralObjectDetector labels: %s — %d entries, head=%s", lp, len(self.labels), sample)
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

    def detect_frame(self, frame: np.ndarray, min_score: float | None = None) -> list[Detection]:
        if not self.available:
            return []
        threshold = float(min_score) if (min_score is not None and min_score > 0) else self.min_score
        if self._cpu_mode:
            return self._detect_cpu(frame, threshold)
        return self._detect_coral(frame, threshold)

    def _detect_coral(self, frame: np.ndarray, threshold: float | None = None) -> list[Detection]:
        """Inference via pycoral + EdgeTPU."""
        score_threshold = threshold if threshold is not None else self.min_score
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        width, height = self.common.input_size(self.interpreter)
        resized = cv2.resize(rgb, (width, height))
        self.common.set_input(self.interpreter, resized)
        self.interpreter.invoke()
        objs = self.detect.get_objects(self.interpreter, score_threshold=score_threshold)
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
            cid = int(obj.id)
            label = self.labels.get(cid, str(cid))
            out.append(Detection(label=label, score=float(obj.score), bbox=(x1, y1, x2, y2), raw_cls_id=cid))
        return _apply_region_filter(out, self._region_filter)

    def _detect_cpu(self, frame: np.ndarray, threshold: float | None = None) -> list[Detection]:
        """Inference via tflite-runtime on CPU (SSD MobileNet layout)."""
        score_threshold = threshold if threshold is not None else self.min_score
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
            if score < score_threshold:
                continue
            ymin, xmin, ymax, xmax = boxes[i]
            x1 = max(0, int(xmin * w))
            y1 = max(0, int(ymin * h))
            x2 = min(w, int(xmax * w))
            y2 = min(h, int(ymax * h))
            cls_id = int(classes[i])
            label = self.labels.get(cls_id, str(cls_id))
            out.append(Detection(label=label, score=score, bbox=(x1, y1, x2, y2), raw_cls_id=cls_id))
        return _apply_region_filter(out, self._region_filter)


# Latin binomial → German common name. Used to rewrite iNaturalist labels like
# "Turdus merula (Common Blackbird)" to the German "Amsel" for Bavarian garden
# birds. Falls back to the raw iNat label when a species is not in the table.
_BIRD_LATIN_TO_DE: dict[str, str] = {
    "Turdus merula":                  "Amsel",
    "Cyanistes caeruleus":            "Blaumeise",
    "Parus caeruleus":                "Blaumeise",
    "Parus major":                    "Kohlmeise",
    "Erithacus rubecula":             "Rotkehlchen",
    "Fringilla coelebs":              "Buchfink",
    "Chloris chloris":                "Grünfink",
    "Carduelis chloris":              "Grünfink",
    "Passer domesticus":              "Haussperling",
    "Passer montanus":                "Feldsperling",
    "Sturnus vulgaris":               "Star",
    "Pica pica":                      "Elster",
    "Corvus corone":                  "Rabenkrähe",
    "Corvus cornix":                  "Nebelkrähe",
    "Corvus monedula":                "Dohle",
    "Corvus frugilegus":              "Saatkrähe",
    "Columba palumbus":               "Ringeltaube",
    "Columba livia":                  "Straßentaube",
    "Streptopelia decaocto":          "Türkentaube",
    "Sitta europaea":                 "Kleiber",
    "Dendrocopos major":              "Buntspecht",
    "Troglodytes troglodytes":        "Zaunkönig",
    "Phoenicurus ochruros":           "Hausrotschwanz",
    "Phoenicurus phoenicurus":        "Gartenrotschwanz",
    "Motacilla alba":                 "Bachstelze",
    "Carduelis carduelis":            "Stieglitz",
    "Spinus spinus":                  "Erlenzeisig",
    "Coccothraustes coccothraustes":  "Kernbeißer",
    "Pyrrhula pyrrhula":              "Gimpel",
    "Prunella modularis":             "Heckenbraunelle",
    "Sylvia atricapilla":             "Mönchsgrasmücke",
    "Phylloscopus collybita":         "Zilpzalp",
    "Phylloscopus trochilus":         "Fitis",
    "Emberiza citrinella":            "Goldammer",
    "Garrulus glandarius":            "Eichelhäher",
    "Serinus serinus":                "Girlitz",
    "Aegithalos caudatus":            "Schwanzmeise",
    "Periparus ater":                 "Tannenmeise",
    "Lophophanes cristatus":          "Haubenmeise",
    "Poecile palustris":              "Sumpfmeise",
    "Turdus philomelos":              "Singdrossel",
    "Turdus pilaris":                 "Wacholderdrossel",
    "Turdus viscivorus":              "Misteldrossel",
    "Regulus regulus":                "Wintergoldhähnchen",
    "Regulus ignicapilla":            "Sommergoldhähnchen",
    "Certhia brachydactyla":          "Gartenbaumläufer",
    "Certhia familiaris":             "Waldbaumläufer",
    "Hirundo rustica":                "Rauchschwalbe",
    "Delichon urbicum":               "Mehlschwalbe",
    "Apus apus":                      "Mauersegler",
}


def _pretty_bird_label(raw: str | None) -> str | None:
    """Transform an iNaturalist label into its German common name when known.

    Input shapes:
      - "Turdus merula (Common Blackbird)"  → "Amsel"
      - "Turdus merula"                      → "Amsel"
      - "PARUS MAJOR"                        → "Kohlmeise"
      - "Passer_domesticus"                  → "Haussperling"
    Unknown species return the raw label unchanged so the UI still shows
    something useful (Latin + English).
    """
    if not raw:
        return raw
    base = str(raw).strip()
    if not base:
        return None
    # "Turdus merula (Common Blackbird)" → strip trailing parenthetical
    latin = base.split("(", 1)[0].strip().replace("_", " ")
    if not latin:
        return base
    # Normalize to "Genus species" casing for lookup
    parts = latin.split()
    if len(parts) >= 2:
        key = parts[0].capitalize() + " " + parts[1].lower()
        de = _BIRD_LATIN_TO_DE.get(key)
        if de:
            return de
    return base


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
        if not Path(model_path).exists():
            cpu_alt = self.cfg.get("cpu_model_path")
            if not (cpu_alt and Path(cpu_alt).exists()):
                self.reason = f"model file not found: {model_path}"
                log.warning("Bird classifier: %s", self.reason)
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
        raw = self.labels.get(int(c.id), str(c.id))
        return _pretty_bird_label(raw), float(c.score)

    def _classify_cpu(self, crop: np.ndarray) -> tuple[str | None, float | None]:
        input_details = self.interpreter.get_input_details()
        output_details = self.interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        in_dtype = input_details[0]['dtype']
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if in_dtype == np.float32:
            inp = inp.astype(np.float32) / 255.0
        else:
            inp = inp.astype(in_dtype)
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(output_details[0]['index'])[0]
        best_id = int(np.argmax(scores))
        raw_score = float(scores[best_id])
        # Quantized classifiers (uint8/int8) return raw logits in the integer
        # range — apply the TFLite quantization params to get a 0..1 probability.
        out_dtype = output_details[0]['dtype']
        if out_dtype in (np.uint8, np.int8):
            scale, zero_point = output_details[0].get('quantization', (0.0, 0))
            if scale:
                best_score = (raw_score - zero_point) * float(scale)
            else:
                best_score = raw_score / 255.0
        else:
            best_score = raw_score
        if best_score < self.min_score:
            return None, None
        raw = self.labels.get(best_id, str(best_id))
        return _pretty_bird_label(raw), best_score


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

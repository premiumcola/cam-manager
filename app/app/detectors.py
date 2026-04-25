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
    species: str | None = None          # display name (German when mapped, else raw iNat)
    species_latin: str | None = None    # "Genus species" binomial from the iNat label
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
            "species_latin": self.species_latin,
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

    # Per-label minimum bounding-box constraints. Surveillance cameras at
    # fixed positions almost never see a real person at <15% frame height
    # or <2% frame area — a small "person" box is overwhelmingly a false
    # positive (wood grain, shadow, distant silhouette). Keys are COCO
    # labels; values are (min_height_frac, min_area_frac).
    _LABEL_MIN_BBOX: dict[str, tuple[float, float]] = {
        "person": (0.15, 0.02),
    }

    def detect_frame(
        self,
        frame: np.ndarray,
        min_score: float | None = None,
        label_thresholds: dict[str, float] | None = None,
    ) -> list[Detection]:
        """Run detection.

        `min_score` is the global confidence floor (defaults to cfg).
        `label_thresholds` is an optional per-label override applied as a
        post-filter — any detection whose label appears in the dict is
        kept only if its score >= the dict value. Lets the user crank up
        the bar for "person" without sacrificing recall on cat/bird.
        """
        if not self.available:
            return []
        threshold = float(min_score) if (min_score is not None and min_score > 0) else self.min_score
        if self._cpu_mode:
            dets = self._detect_cpu(frame, threshold)
        else:
            dets = self._detect_coral(frame, threshold)
        return self._apply_label_filters(dets, frame, label_thresholds)

    def _apply_label_filters(
        self,
        dets: list[Detection],
        frame: np.ndarray,
        label_thresholds: dict[str, float] | None,
    ) -> list[Detection]:
        if not dets:
            return dets
        h, w = frame.shape[:2]
        frame_area = float(max(1, h * w))
        out: list[Detection] = []
        for d in dets:
            # Per-label confidence override.
            if label_thresholds:
                t = label_thresholds.get(d.label)
                if t is not None and d.score < float(t):
                    continue
            # Per-label size floor (currently only "person").
            min_h_frac, min_area_frac = self._LABEL_MIN_BBOX.get(d.label, (0.0, 0.0))
            if min_h_frac > 0.0 or min_area_frac > 0.0:
                x1, y1, x2, y2 = d.bbox
                bb_h = max(0, y2 - y1)
                bb_area = max(0, (x2 - x1) * (y2 - y1))
                if bb_h < min_h_frac * h:
                    continue
                if bb_area < min_area_frac * frame_area:
                    continue
            out.append(d)
        return out

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


import json

# Latin binomial → German common name. Lazily loaded from a JSON file so
# editing the list doesn't require a Python redeploy. The file is optional —
# when missing, classifier output simply stays in Latin/English.
_BIRD_LATIN_TO_DE_PATH_DEFAULT = "/app/config/inat_to_german.json"
_bird_latin_to_de_cache: dict[str, str] | None = None
_bird_latin_to_de_cache_path: str | None = None


def _load_bird_latin_to_de(path: str | None) -> dict[str, str]:
    """Cached load of the Latin→German map. `path` may be overridden per
    classifier instance; reloads only when the path changes or the file has
    not been read yet."""
    global _bird_latin_to_de_cache, _bird_latin_to_de_cache_path
    use_path = path or _BIRD_LATIN_TO_DE_PATH_DEFAULT
    if _bird_latin_to_de_cache is not None and _bird_latin_to_de_cache_path == use_path:
        return _bird_latin_to_de_cache
    data: dict[str, str] = {}
    try:
        with open(use_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        data = {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str) and not k.startswith("_")}
    except FileNotFoundError:
        log.info("Bird latin→de map: %s not found — species will show Latin names only.", use_path)
    except Exception as e:
        log.warning("Bird latin→de map: failed to parse %s: %s", use_path, e)
    _bird_latin_to_de_cache = data
    _bird_latin_to_de_cache_path = use_path
    if data:
        log.info("Bird latin→de map loaded from %s (%d entries)", use_path, len(data))
    return data


def _extract_latin(raw: str | None) -> str | None:
    """Pull a clean "Genus species" string out of any iNat label shape.

    Examples:
      "Turdus merula (Common Blackbird)"  → "Turdus merula"
      "PARUS MAJOR"                        → "Parus major"
      "Passer_domesticus"                  → "Passer domesticus"
    """
    if not raw:
        return None
    base = str(raw).strip()
    if not base:
        return None
    latin = base.split("(", 1)[0].strip().replace("_", " ")
    parts = latin.split()
    if len(parts) < 2:
        return latin or None
    return parts[0].capitalize() + " " + parts[1].lower()


def _pretty_bird_label(raw: str | None, mapping: dict[str, str] | None = None) -> tuple[str | None, str | None]:
    """Return (display_name, latin_binomial) for an iNaturalist label.

    The display name is the German common name when the species is in the
    mapping. For species not in the mapping we deliberately return the
    generic German "Vogel" rather than the raw iNat string — that string
    leads with the Latin binomial and would surface as the primary label
    in the UI ("Garrulus glandarius (Eurasian Jay)" instead of "Vogel ·
    Garrulus glandarius"). The Latin binomial is preserved separately so
    the UI can render it as parenthesised secondary text.
    """
    if not raw:
        return raw, None
    latin = _extract_latin(raw)
    m = mapping if mapping is not None else _load_bird_latin_to_de(None)
    de = m.get(latin) if latin else None
    if de:
        return de, latin
    # No German mapping for this Latin binomial → generic "Vogel" + Latin.
    return ("Vogel" if latin else str(raw).strip()), latin


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
        self.min_score = float(self.cfg.get("min_score", 0.25))
        self.latin_to_de = _load_bird_latin_to_de(self.cfg.get("latin_to_de_path"))
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

    def classify_crop(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
        """Return (display_name, latin_binomial, score).

        display_name is the German common name when the species is in the
        latin_to_de map, otherwise the raw iNat label. latin_binomial is
        always the clean "Genus species" form.
        """
        if not self.available or crop is None or crop.size == 0:
            return None, None, None
        if self._cpu_mode:
            return self._classify_cpu(crop)
        return self._classify_coral(crop)

    def _classify_coral(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
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
        display, latin = _pretty_bird_label(raw, self.latin_to_de)
        return display, latin, float(c.score)

    def _classify_cpu(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
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
            return None, None, None
        raw = self.labels.get(best_id, str(best_id))
        display, latin = _pretty_bird_label(raw, self.latin_to_de)
        return display, latin, best_score


# ──────────────────────────────────────────────────────────────────────────
# Wildlife classifier: ImageNet MobileNetV2 → fox / squirrel / hedgehog
# ──────────────────────────────────────────────────────────────────────────
#
# COCO SSD has 80 classes and does not contain fox, squirrel, or hedgehog —
# so when motion hits a garden camera we need a second-stage classifier that
# *can* name these animals. The classic ImageNet-1000 model includes:
#   • "red fox, Vulpes vulpes"        (idx 277)
#   • "fox squirrel, Sciurus niger"   (idx 335)
#   • "hedgehog, Erinaceus europaeus" (idx 334 in most label files)
#
# We map any ImageNet top-1 whose human-readable label matches one of those
# substrings down to our three target categories. Everything else is None.

# Substring→category rules. Case-insensitive match against the ImageNet
# human-readable label. Ordering matters — first hit wins, so put the more
# specific rule first (e.g. "red fox" before bare "fox" to avoid flying-fox
# or corsac-fox false positives).
_WILDLIFE_LABEL_RULES: tuple[tuple[str, str], ...] = (
    ("red fox",       "fox"),
    ("grey fox",      "fox"),
    ("gray fox",      "fox"),
    ("kit fox",       "fox"),
    ("arctic fox",    "fox"),
    ("fox squirrel",  "squirrel"),
    ("squirrel",      "squirrel"),
    ("hedgehog",      "hedgehog"),
)


def _wildlife_category(raw_label: str | None) -> str | None:
    """Map an ImageNet top-1 label to one of our wildlife categories, or None."""
    if not raw_label:
        return None
    low = str(raw_label).lower()
    for needle, cat in _WILDLIFE_LABEL_RULES:
        if needle in low:
            return cat
    return None


# Latin-genus → wildlife category. Substring match (case-insensitive)
# against the full iNaturalist label string, e.g.
# "Sciurus vulgaris (Eurasian Red Squirrel)" → "squirrel".
# Used by WildlifeClassifier when an iNat second-stage model is configured
# and its labels file contains mammal binomials. The bird-only iNat model
# shipped by default does NOT contain any of these genera — these rules
# only fire once a mammal-capable iNat model is dropped into models/ and
# pointed at via processing.wildlife.inat_*.
_INAT_WILDLIFE_RULES: tuple[tuple[str, str], ...] = (
    ("sciurus",   "squirrel"),     # Sciurus vulgaris, S. carolinensis, etc.
    ("tamias",    "squirrel"),     # chipmunk genus — close enough for our purposes
    ("vulpes",    "fox"),          # Vulpes vulpes, V. lagopus, V. corsac
    ("erinaceus", "hedgehog"),     # Erinaceus europaeus
    ("meles",     "hedgehog"),     # badger genus — optional fallback per spec
)


def _inat_wildlife_category(raw_label: str | None) -> str | None:
    """Map a full iNaturalist label string to a wildlife category, or None."""
    if not raw_label:
        return None
    low = str(raw_label).lower()
    for needle, cat in _INAT_WILDLIFE_RULES:
        if needle in low:
            return cat
    return None


def discover_wildlife_paths(models_dir: str | Path = "/app/models") -> dict:
    """Look for a MobileNet wildlife model in `models_dir`. Heuristic: any
    .tflite whose name contains "mobilenet" but neither "ssd" (object
    detector) nor "bird" (species classifier). Returns dict with keys
    model_path / cpu_model_path / labels_path when found, else empty dict.
    Used as fallback when config.yaml has no `processing.wildlife.*` block —
    common case after a fresh install where the user just dropped the file
    into models/."""
    p = Path(models_dir)
    if not p.exists():
        return {}
    cands = [f for f in p.glob("*.tflite")
             if "mobilenet" in f.name.lower()
             and "ssd" not in f.name.lower()
             and "bird" not in f.name.lower()]
    if not cands:
        return {}
    edge = next((f for f in cands if "edgetpu" in f.name.lower()), None)
    cpu  = next((f for f in cands if "edgetpu" not in f.name.lower()), None)
    out = {
        "model_path":     str(edge or cpu or cands[0]),
        "cpu_model_path": str(cpu or edge or cands[0]),
    }
    lbl = p / "imagenet_labels.txt"
    if lbl.exists():
        out["labels_path"] = str(lbl)
    return out


class WildlifeClassifier:
    """ImageNet MobileNetV2 (1000 classes) second-stage classifier used for
    mammals the COCO detector cannot name — fox, squirrel, hedgehog.

    Same three-tier fallback as BirdSpeciesClassifier:
      1. pycoral + EdgeTPU  → mode="coral"
      2. tflite-runtime CPU → mode="cpu"
      3. disabled           → mode="none"

    classify_crop() returns (category, imagenet_label, score) where
    `category` is one of "fox" / "squirrel" / "hedgehog" or None when the
    top-1 doesn't map to any wildlife class we track.
    """

    def __init__(self, cfg: dict, inat_cfg: dict | None = None):
        self.cfg = dict(cfg or {})
        self.enabled = bool(self.cfg.get("enabled"))
        self.available = False
        self.reason = "disabled"
        self.mode = "none"  # "coral" | "cpu" | "none"
        # Auto-discovery fallback: when the configured model path is missing
        # or absent on disk, try to locate a MobileNet ImageNet model in
        # /app/models. Lets users just drop a model in without editing yaml.
        configured = self.cfg.get("model_path")
        if not configured or not Path(configured).exists():
            disc = discover_wildlife_paths()
            for k, v in disc.items():
                self.cfg.setdefault(k, v)
                # If the configured value pointed at a missing file, replace
                # it with the discovered one so downstream logic uses the
                # path that actually exists on disk.
                if not self.cfg.get(k) or not Path(self.cfg[k]).exists():
                    self.cfg[k] = v
        self.labels = load_label_map(self.cfg.get("labels_path"))
        self.min_score = float(self.cfg.get("min_score", 0.35))
        self.interpreter = None
        # ── Optional iNaturalist second-stage backend ──────────────────────
        # When inat_cfg is supplied (typically the bird_species block, since
        # the user can re-use that path), we load a parallel TFLite
        # interpreter and run it on the wildlife crop. _classify_inat()
        # consults _INAT_WILDLIFE_RULES on the iNat label string. Stays None
        # when no path is configured or loading fails.
        self._inat_interpreter = None
        self._inat_labels: dict[int, str] = {}
        self._inat_common = None
        self._inat_classify = None
        self._inat_cpu_mode = False
        self._inat_min_score = 0.25
        self._inat_cfg = dict(inat_cfg) if inat_cfg else {}
        self.common = None
        self.classify = None
        self._cpu_mode = False
        # Some ImageNet label files include an extra "background" entry at
        # index 0 (1001 labels total). The model output then has 1001 bins
        # too, so no offset is required. When the labels file has exactly
        # 1000 entries and the model emits 1001, we shift by 1 on read.
        self._label_offset = 0
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
                log.warning("Wildlife classifier: %s", self.reason)
                return

        coral_error = ""
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
            log.info("Wildlife classifier (Coral) aktiv: %s — %d labels", model_path, len(self.labels))
            self._load_inat_backend()
            return
        except Exception as e:
            log.warning("Wildlife classifier pycoral unavailable (%s) – CPU-Fallback…", e)
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
                self.reason = f"cpu_fallback (coral: {coral_error})" if coral_error else "ok"
                log.info("Wildlife classifier (CPU) aktiv: %s — %d labels", try_path, len(self.labels))
                self._load_inat_backend()
                return
            except Exception as e2:
                log.warning("Wildlife classifier CPU fehlgeschlagen für %s: %s", try_path, e2)

        self.reason = f"classifier unavailable: {coral_error}" if coral_error else "classifier unavailable"
        log.warning("Wildlife classifier nicht verfügbar")

    def _load_inat_backend(self) -> None:
        """Try to load the iNaturalist tflite second-stage classifier from
        self._inat_cfg. No-op when the cfg is empty, the model file doesn't
        exist, or both Coral/CPU loaders fail. Logged outcome so the user
        sees a single line in the startup banner."""
        cfg = self._inat_cfg or {}
        model_path = cfg.get("model_path")
        if not model_path or not Path(model_path).exists():
            cpu_alt = cfg.get("cpu_model_path")
            if not (cpu_alt and Path(cpu_alt).exists()):
                return
            model_path = cpu_alt
        self._inat_min_score = float(cfg.get("min_score", 0.25))
        self._inat_labels = load_label_map(cfg.get("labels_path"))
        # Tier 1: pycoral
        try:
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
            from pycoral.adapters import common, classify  # type: ignore
            self._inat_common = common
            self._inat_classify = classify
            self._inat_interpreter = make_interpreter(model_path, device=cfg.get("device"))
            self._inat_interpreter.allocate_tensors()
            log.info("Wildlife · iNat-Backend (Coral) aktiv: %s — %d labels", model_path, len(self._inat_labels))
            return
        except Exception:
            pass
        # Tier 2: tflite-runtime
        try:
            import tflite_runtime.interpreter as tflite  # type: ignore
            cpu_path = cfg.get("cpu_model_path") or model_path
            self._inat_interpreter = tflite.Interpreter(model_path=cpu_path)
            self._inat_interpreter.allocate_tensors()
            self._inat_cpu_mode = True
            log.info("Wildlife · iNat-Backend (CPU) aktiv: %s — %d labels", cpu_path, len(self._inat_labels))
        except Exception as e:
            log.info("Wildlife · iNat-Backend nicht geladen: %s", e)
            self._inat_interpreter = None

    def classify_crop(self, crop: np.ndarray, min_score: float | None = None) -> tuple[str | None, str | None, float | None]:
        """Return (category, imagenet_label, score).

        category ∈ {"fox", "squirrel", "hedgehog", None}. None means the
        top-3 didn't match any wildlife rule we track (or score too low).
        `imagenet_label` is the raw model label for diagnostics.

        When `min_score` > 0, it overrides the global threshold for this
        single call (per-camera tuning). When the iNat second-stage
        backend is loaded, both models run; the iNat result wins if it
        produces a category with a higher score than MobileNet.
        """
        if not self.available or crop is None or crop.size == 0:
            return None, None, None
        # Apply per-camera min_score override by temporarily swapping the
        # instance value — both private inference paths read self.min_score.
        # Each WildlifeClassifier instance is camera-scoped (one per camera
        # process), so this is safe without locking.
        saved_thresh = self.min_score
        if min_score is not None and float(min_score) > 0:
            self.min_score = float(min_score)
        try:
            cat_a, lbl_a, score_a = (
                self._classify_cpu(crop) if self._cpu_mode else self._classify_coral(crop)
            )
            cat_b, lbl_b, score_b = (None, None, None)
            if self._inat_interpreter is not None:
                cat_b, lbl_b, score_b = self._classify_inat(crop)
        finally:
            self.min_score = saved_thresh
        # Pick the best between the two backends. iNat wins when it
        # actually identified a tracked mammal genus AND scored higher
        # than MobileNet (or MobileNet didn't categorise the crop).
        if cat_b and score_b is not None:
            if cat_a is None or score_a is None or score_b > score_a:
                return cat_b, lbl_b, score_b
        return cat_a, lbl_a, score_a

    def _classify_inat(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
        """Run the optional iNaturalist second-stage on the crop. Returns
        (category, raw_label, score) where category ∈ wildlife rules, or
        (None, raw_top_label, score) for diagnostics on a non-mammal hit."""
        if self._inat_interpreter is None:
            return None, None, None
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        if self._inat_cpu_mode:
            det = self._inat_interpreter.get_input_details()
            outd = self._inat_interpreter.get_output_details()
            in_h = det[0]['shape'][1]
            in_w = det[0]['shape'][2]
            in_dtype = det[0]['dtype']
            resized = cv2.resize(rgb, (in_w, in_h))
            inp = np.expand_dims(resized, axis=0)
            if in_dtype == np.float32:
                inp = (inp.astype(np.float32) - 127.5) / 127.5
            else:
                inp = inp.astype(in_dtype)
            self._inat_interpreter.set_tensor(det[0]['index'], inp)
            self._inat_interpreter.invoke()
            scores = self._inat_interpreter.get_tensor(outd[0]['index'])[0]
            top_ids = np.argsort(scores)[::-1][:3]
            out_dtype = outd[0]['dtype']
            scale, zp = (0.0, 0)
            if out_dtype in (np.uint8, np.int8):
                q = outd[0].get('quantization', (0.0, 0))
                scale = float(q[0]) if q and q[0] else 0.0
                zp = int(q[1]) if q else 0

            def _to_prob(raw: float) -> float:
                if out_dtype in (np.uint8, np.int8):
                    return (raw - zp) * scale if scale else raw / 255.0
                return float(raw)

            for i in top_ids:
                i = int(i)
                p = _to_prob(float(scores[i]))
                if p < self._inat_min_score:
                    break
                label = self._inat_labels.get(i, str(i))
                cat = _inat_wildlife_category(label)
                if cat:
                    return cat, label, p
            return None, None, None
        # Coral path
        width, height = self._inat_common.input_size(self._inat_interpreter)
        resized = cv2.resize(rgb, (width, height))
        self._inat_common.set_input(self._inat_interpreter, resized)
        self._inat_interpreter.invoke()
        classes = self._inat_classify.get_classes(
            self._inat_interpreter, top_k=3, score_threshold=self._inat_min_score,
        )
        for c in classes:
            label = self._inat_labels.get(int(c.id), str(c.id))
            cat = _inat_wildlife_category(label)
            if cat:
                return cat, label, float(c.score)
        return None, None, None

    def _classify_coral(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        width, height = self.common.input_size(self.interpreter)
        resized = cv2.resize(rgb, (width, height))
        self.common.set_input(self.interpreter, resized)
        self.interpreter.invoke()
        classes = self.classify.get_classes(self.interpreter, top_k=3, score_threshold=self.min_score)
        for c in classes:
            raw = self.labels.get(int(c.id), str(c.id))
            cat = _wildlife_category(raw)
            if cat:
                return cat, raw, float(c.score)
        # No match in top-3 — return the top-1 raw label for diagnostics only
        if classes:
            c0 = classes[0]
            raw0 = self.labels.get(int(c0.id), str(c0.id))
            return None, raw0, float(c0.score)
        return None, None, None

    def _classify_cpu(self, crop: np.ndarray) -> tuple[str | None, str | None, float | None]:
        input_details = self.interpreter.get_input_details()
        output_details = self.interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        in_dtype = input_details[0]['dtype']
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if in_dtype == np.float32:
            # ImageNet MobileNet V2 expects [-1, 1] normalisation
            inp = (inp.astype(np.float32) - 127.5) / 127.5
        else:
            inp = inp.astype(in_dtype)
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(output_details[0]['index'])[0]
        # Top-3 so we can fall through to the second-best if the first is
        # something like "hare" on a squirrel crop. NOTE: scores is uint8
        # for quantized models — `np.argsort(-scores)` would wrap around on
        # unsigned arithmetic and return index 0 first. Descending-sort the
        # array itself and reverse to get a correct top-K.
        top_ids = np.argsort(scores)[::-1][:3]
        out_dtype = output_details[0]['dtype']
        scale, zero_point = (0.0, 0)
        if out_dtype in (np.uint8, np.int8):
            q = output_details[0].get('quantization', (0.0, 0))
            scale = float(q[0]) if q and q[0] else 0.0
            zero_point = int(q[1]) if q else 0

        def _to_prob(raw: float) -> float:
            if out_dtype in (np.uint8, np.int8):
                return (raw - zero_point) * scale if scale else raw / 255.0
            return float(raw)

        best_raw_score = _to_prob(float(scores[int(top_ids[0])]))
        best_id = int(top_ids[0])
        best_label = self.labels.get(best_id - self._label_offset, str(best_id))
        # Detect 1000/1001 mismatch once, then keep using the offset
        if self._label_offset == 0 and len(self.labels) == 1000 and scores.shape[0] == 1001:
            self._label_offset = 1
            best_label = self.labels.get(best_id - 1, str(best_id))

        for i in top_ids:
            i = int(i)
            raw_score = _to_prob(float(scores[i]))
            if raw_score < self.min_score:
                break
            label = self.labels.get(i - self._label_offset, str(i))
            cat = _wildlife_category(label)
            if cat:
                return cat, label, raw_score
        # No wildlife match — return the top-1 anyway for UI diagnostics
        if best_raw_score >= self.min_score * 0.5:
            return None, best_label, best_raw_score
        return None, None, None


def draw_detections(frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
    if frame is None:
        return frame
    out = frame.copy()
    colors = {
        "bird": (84, 214, 98),
        "cat": (160, 110, 255),
        "person": (110, 110, 255),
        # BGR — same dark brown #7c2d12 (RGB 124,45,18) used everywhere else.
        "dog": (18, 45, 124),
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

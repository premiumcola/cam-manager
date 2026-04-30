from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
import logging
import re
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
    # Trigger flags inherited from the zone this detection passed through.
    # None when the detection didn't go through any zone (legacy or
    # zone-less camera) — caller treats that as "all flags True". A dict
    # like {"save_photo": True, "save_video": False, "send_telegram": True}
    # means the matching zone explicitly opted in/out for the listed actions.
    zone_flags: dict | None = None

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
        *,
        cam_id: str | None = None,
    ) -> list[Detection]:
        """Run detection.

        `min_score` is the global confidence floor (defaults to cfg).
        `label_thresholds` is an optional per-label override applied as a
        post-filter — any detection whose label appears in the dict is
        kept only if its score >= the dict value. Lets the user crank up
        the bar for "person" without sacrificing recall on cat/bird.
        `cam_id` is purely for diagnostic logging — when provided AND the
        ``app.app.detectors`` logger is at INFO or below, the detector
        emits a one-line "[det][cam:<id>] kept/dropped" trace.
        """
        if not self.available:
            return []
        threshold = float(min_score) if (min_score is not None and min_score > 0) else self.min_score
        if self._cpu_mode:
            dets = self._detect_cpu(frame, threshold)
        else:
            dets = self._detect_coral(frame, threshold)
        kept, drops = self._apply_label_filters_with_reasons(
            dets, frame, label_thresholds, threshold,
        )
        if cam_id and log.isEnabledFor(logging.INFO):
            try:
                self._log_decision(cam_id, kept, drops)
            except Exception:
                pass
        return kept

    def _apply_label_filters_with_reasons(
        self,
        dets: list[Detection],
        frame: np.ndarray,
        label_thresholds: dict[str, float] | None,
        global_threshold: float,
    ) -> tuple[list[Detection], list[tuple[Detection, str]]]:
        """Same gates as _apply_label_filters but also returns a parallel
        list of (detection, drop_reason) for the diagnostic logger. Hot
        path: the reason-string formatting only happens for dropped
        detections — the kept-list path is one append per kept det."""
        out: list[Detection] = []
        drops: list[tuple[Detection, str]] = []
        if not dets:
            return out, drops
        h, w = frame.shape[:2]
        frame_area = float(max(1, h * w))
        for d in dets:
            # Per-label confidence override.
            if label_thresholds:
                t = label_thresholds.get(d.label)
                if t is not None and d.score < float(t):
                    drops.append((d, f"label_threshold({d.label})={t} (got {d.score:.2f})"))
                    continue
            # Per-label size floor (currently only "person").
            min_h_frac, min_area_frac = self._LABEL_MIN_BBOX.get(d.label, (0.0, 0.0))
            if min_h_frac > 0.0 or min_area_frac > 0.0:
                x1, y1, x2, y2 = d.bbox
                bb_h = max(0, y2 - y1)
                bb_area = max(0, (x2 - x1) * (y2 - y1))
                if bb_h < min_h_frac * h:
                    drops.append((d, f"size_floor (h_frac={bb_h / h:.2f} < {min_h_frac:.2f})"))
                    continue
                if bb_area < min_area_frac * frame_area:
                    drops.append((d, f"size_floor (area_frac={bb_area / frame_area:.3f} < {min_area_frac:.3f})"))
                    continue
            out.append(d)
        return out, drops

    # Back-compat alias — anything that historically called
    # _apply_label_filters keeps the old single-return-value semantics.
    def _apply_label_filters(self, dets, frame, label_thresholds):
        kept, _ = self._apply_label_filters_with_reasons(
            dets, frame, label_thresholds,
            self.min_score,
        )
        return kept

    @staticmethod
    def _fmt_dets(dets, max_n: int = 8) -> str:
        if not dets:
            return "—"
        head = dets[:max_n]
        return ", ".join(f"{d.label} {int(round(d.score * 100))}%" for d in head) + (
            f" (+{len(dets) - max_n} weitere)" if len(dets) > max_n else ""
        )

    @staticmethod
    def _humanize_drop_reason(reason: str) -> str:
        """Translate the raw drop-reason emitted by _apply_label_filters
        into a German sentence the operator can read at a glance. Three
        shapes are produced upstream:

            label_threshold(person)=0.72 (got 0.67)
            size_floor (h_frac=0.12 < 0.18)
            size_floor (area_frac=0.005 < 0.012)

        Unknown shapes fall back to the raw string so we never silently
        lose information."""
        m = re.match(r"label_threshold\([^)]+\)=([\d.]+)\s*\(got\s+([\d.]+)\)", reason)
        if m:
            thr = float(m.group(1)) * 100
            got = float(m.group(2)) * 100
            return f"Schwellwert {thr:.0f}% nicht erreicht (war {got:.0f}%)"
        m = re.match(r"size_floor\s*\(h_frac=([\d.]+)\s*<\s*([\d.]+)\)", reason)
        if m:
            got = float(m.group(1)) * 100
            need = float(m.group(2)) * 100
            return f"zu klein im Bild: {got:.0f}% Höhe < {need:.0f}% nötig"
        m = re.match(r"size_floor\s*\(area_frac=([\d.]+)\s*<\s*([\d.]+)\)", reason)
        if m:
            got = float(m.group(1)) * 100
            need = float(m.group(2)) * 100
            return f"zu klein im Bild: {got:.1f}% Fläche < {need:.1f}% nötig"
        return reason

    @classmethod
    def _fmt_drops(cls, drops, max_n: int = 8) -> str:
        if not drops:
            return "—"
        head = drops[:max_n]
        return ", ".join(
            f"{d.label} {int(round(d.score * 100))}% ({cls._humanize_drop_reason(reason)})"
            for d, reason in head
        ) + (f" (+{len(drops) - max_n} weitere)" if len(drops) > max_n else "")

    def _log_decision(self, cam_id: str, kept: list, drops: list):
        """Emit one INFO line per detect_frame call when there's anything
        worth seeing. Decision tree:
          - kept ≥ 1 → "[det][cam:…] ✓ erkannt: … · ✗ verworfen: …"
          - kept == 0 AND drops > 0 → "[det][cam:…] ✗ verworfen: …"
          - kept == 0 AND drops == 0 → DEBUG "[det][cam:…] inference empty (raw=0)"
        ASCII check/cross markers stand out in `docker logs` greps.
        """
        if kept:
            if drops:
                log.info("[det][cam:%s] ✓ erkannt: %s · ✗ verworfen: %s",
                         cam_id, self._fmt_dets(kept), self._fmt_drops(drops))
            else:
                log.info("[det][cam:%s] ✓ erkannt: %s",
                         cam_id, self._fmt_dets(kept))
            return
        if drops:
            # Sort by score descending so "almost made it" labels come first.
            ordered = sorted(drops, key=lambda x: x[0].score, reverse=True)
            log.info("[det][cam:%s] ✗ verworfen: %s",
                     cam_id, self._fmt_drops(ordered))
            return
        log.debug("[det][cam:%s] inference empty (raw=0)", cam_id)

    def detect_frame_raw(self, frame: np.ndarray, threshold: float = 0.20) -> list[Detection]:
        """Run inference and return the raw model output BEFORE label
        filters / size floors / per-label thresholds. Used by the
        cam-edit "Erkennung jetzt simulieren" endpoint so the user can
        see what Coral actually found before filters narrow it down —
        each detection then gets a verdict (pass / below threshold /
        filtered by class) computed against the camera's current config.
        Threshold is intentionally low (0.20 default) so even
        almost-rejected hits show up in the simulation; the caller
        applies the user's actual thresholds afterwards.
        """
        if not self.available:
            return []
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

    Display name is the German common name when the Latin binomial is in
    the mapping. If no mapping exists we return (None, latin) so the UI
    keeps the generic COCO "bird" label and does not invent a fake species
    line. The caller can use a None display name as a signal to fall back
    to the next top-k candidate.
    """
    if not raw:
        return raw, None
    latin = _extract_latin(raw)
    m = mapping if mapping is not None else _load_bird_latin_to_de(None)
    de = m.get(latin) if latin else None
    if de:
        return de, latin
    # No German mapping → suppress fake species line, keep latin for logs.
    return None, latin


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
        classes = self.classify.get_classes(self.interpreter, top_k=3, score_threshold=self.min_score)
        if not classes:
            return None, None, None
        # Walk top-3 and return the first candidate that has a German mapping.
        # iNat's #1 is sometimes a North-American species while a European
        # cousin we know sits at #2/#3 — pick the one we can name.
        for c in classes:
            raw = self.labels.get(int(c.id), str(c.id))
            display, latin = _pretty_bird_label(raw, self.latin_to_de)
            if display:
                return display, latin, float(c.score)
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
            inp = inp.astype(np.float32) / 255.0
        else:
            inp = inp.astype(in_dtype)
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(output_details[0]['index'])[0]
        # Top-3 candidates, descending by score. Walk them and pick the first
        # one with a German mapping (iNat top-1 is often a North-American
        # species while a European cousin we know sits at #2/#3).
        out_dtype = output_details[0]['dtype']
        scale, zero_point = output_details[0].get('quantization', (0.0, 0)) if out_dtype in (np.uint8, np.int8) else (None, None)

        def _to_prob(raw_score: float) -> float:
            if out_dtype in (np.uint8, np.int8):
                if scale:
                    return (raw_score - zero_point) * float(scale)
                return raw_score / 255.0
            return raw_score

        top_ids = np.argsort(scores)[::-1][:3]
        for cid in top_ids:
            cid = int(cid)
            prob = _to_prob(float(scores[cid]))
            if prob < self.min_score:
                continue
            raw = self.labels.get(cid, str(cid))
            display, latin = _pretty_bird_label(raw, self.latin_to_de)
            if display:
                return display, latin, prob
        return None, None, None


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


# ImageNet labels MobileNetV2 commonly emits on European squirrel crops.
# These are NOT direct squirrel matches — using them alone would generate
# false positives on real hares/mongooses. They count as squirrel ONLY
# when an independent iNat-secondary check returns a Sciuridae genus
# (see classify_crop cross-validation).
_SQUIRREL_LIKELY_LABELS: tuple[str, ...] = (
    "hare", "mongoose", "mink", "weasel",
    "polecat", "ferret", "marmot",
    # Bias-from-American-training-set cases — already in
    # _WILDLIFE_LABEL_RULES as direct hits, but listed here too so the
    # cross-check can boost a soft 0.45-ish "fox squirrel" with a strong
    # iNat "Sciurus vulgaris".
    "fox squirrel", "gray squirrel",
)


def _is_squirrel_likely(label: str | None) -> bool:
    if not label:
        return False
    low = str(label).lower()
    return any(needle in low for needle in _SQUIRREL_LIKELY_LABELS)


# Sciuridae-family Latin genera the iNat secondary may emit on a squirrel
# crop. Used as the cross-check half of the "squirrel-likely" rule above.
_SCIURIDAE_GENERA: tuple[str, ...] = (
    "sciurus", "tamias", "marmota", "tamiasciurus", "callosciurus",
    "spermophilus", "glaucomys",
)


def _is_sciuridae_inat(label: str | None) -> bool:
    if not label:
        return False
    low = str(label).lower()
    return any(g in low for g in _SCIURIDAE_GENERA)


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
        if "mobilenet" in low:           # mobilenet, mobilenet_v2, MobileNet-V2
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
    cpu  = next((f for f in cands if "edgetpu" not in f.name.lower()), None)
    out = {
        "model_path":     str(edge or cpu or cands[0]),
        "cpu_model_path": str(cpu or edge or cands[0]),
    }
    lbl = p / "imagenet_labels.txt"
    if lbl.exists():
        out["labels_path"] = str(lbl)
    log.debug("[wildlife-discover] picked model_path=%s cpu_model_path=%s labels=%s",
              out.get("model_path"), out.get("cpu_model_path"), out.get("labels_path"))
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
        """Return (category, raw_label, score).

        category ∈ {"fox", "squirrel", "hedgehog", None}. None means
        neither MobileNet nor the iNat secondary classifier matched any
        wildlife rule we track. `raw_label` is the most informative
        diagnostic string (top-1 of MobileNet for misses; the matched
        rule's label for hits).

        Pipeline:
          1. Collect top-3 from MobileNet + (optionally) top-3 from iNat.
          2. Walk MobileNet top-3 → if any direct rule match, return it.
          3. Walk iNat top-3 → if any direct rule match, return it.
          4. Cross-validation: if MobileNet has a "squirrel-likely" label
             (hare / mongoose / mink / …) AND iNat has a Sciuridae genus,
             classify as squirrel with avg(score_a, score_b).
          5. Otherwise: no category, but return the MobileNet top-1 as a
             diagnostic label so the UI shows what the model "saw".
        """
        if not self.available or crop is None or crop.size == 0:
            return None, None, None
        # Per-camera min_score override — applied for the duration of the
        # call, restored in finally. Safe without locking because each
        # WildlifeClassifier instance is camera-scoped.
        saved_thresh = self.min_score
        if min_score is not None and float(min_score) > 0:
            self.min_score = float(min_score)
        try:
            top3_a = self._top3_mobilenet(crop)
            top3_b = self._top3_inat(crop) if self._inat_interpreter is not None else []
        finally:
            self.min_score = saved_thresh
        # Step 2: direct MobileNet rule hit on any of top-3.
        for lbl, sc in top3_a:
            cat = _wildlife_category(lbl)
            if cat:
                return cat, lbl, sc
        # Step 3: direct iNat rule hit on any of top-3.
        for lbl, sc in top3_b:
            cat = _inat_wildlife_category(lbl)
            if cat:
                return cat, lbl, sc
        # Step 4: cross-validation. MobileNet contains a squirrel-likely
        # label AND iNat independently confirms with a Sciuridae genus →
        # classify as squirrel with the averaged confidence. The combined
        # raw_label keeps both pieces of evidence visible in the UI/logs.
        likely_a = next(((lbl, sc) for lbl, sc in top3_a if _is_squirrel_likely(lbl)), None)
        sciuridae_b = next(((lbl, sc) for lbl, sc in top3_b if _is_sciuridae_inat(lbl)), None)
        if likely_a and sciuridae_b:
            avg_score = (float(likely_a[1]) + float(sciuridae_b[1])) / 2.0
            combined = f"{likely_a[0]} + {sciuridae_b[0]}"
            log.debug("[wildlife] cross-validated squirrel: mobilenet=%s (%.2f) iNat=%s (%.2f) → %.2f",
                      likely_a[0], likely_a[1], sciuridae_b[0], sciuridae_b[1], avg_score)
            return "squirrel", combined, avg_score
        # Step 5: nothing matched — return MobileNet's top-1 for UI diagnostics
        # provided it cleared half the threshold. Hides totally junk noise.
        if top3_a:
            top_lbl, top_sc = top3_a[0]
            if top_sc >= self.min_score * 0.5:
                return None, top_lbl, top_sc
        return None, None, None

    def _top3_mobilenet(self, crop: np.ndarray) -> list[tuple[str, float]]:
        """Run MobileNet inference and return up to 3 (label, score) tuples
        sorted by descending score. The collected list always contains the
        top-3 above min_score * 0.5 — half-threshold so the cross-check in
        classify_crop has access to weaker evidence (a squirrel-likely
        label at 0.40 still triggers the cross-check if iNat strongly
        confirms with Sciurus vulgaris)."""
        return self._top3_cpu(crop) if self._cpu_mode else self._top3_coral(crop)

    def _top3_coral(self, crop: np.ndarray) -> list[tuple[str, float]]:
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        width, height = self.common.input_size(self.interpreter)
        resized = cv2.resize(rgb, (width, height))
        self.common.set_input(self.interpreter, resized)
        self.interpreter.invoke()
        cls = self.classify.get_classes(
            self.interpreter, top_k=3,
            score_threshold=max(0.05, self.min_score * 0.5),
        )
        return [(self.labels.get(int(c.id), str(c.id)), float(c.score)) for c in cls]

    def _top3_cpu(self, crop: np.ndarray) -> list[tuple[str, float]]:
        input_details = self.interpreter.get_input_details()
        output_details = self.interpreter.get_output_details()
        in_h = input_details[0]['shape'][1]
        in_w = input_details[0]['shape'][2]
        in_dtype = input_details[0]['dtype']
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (in_w, in_h))
        inp = np.expand_dims(resized, axis=0)
        if in_dtype == np.float32:
            inp = (inp.astype(np.float32) - 127.5) / 127.5
        else:
            inp = inp.astype(in_dtype)
        self.interpreter.set_tensor(input_details[0]['index'], inp)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(output_details[0]['index'])[0]
        # Descending sort of the array values; argsort on negative scores
        # would wrap on uint8, so sort the array itself and reverse.
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

        # Detect 1000/1001 mismatch lazily as before.
        if self._label_offset == 0 and len(self.labels) == 1000 and scores.shape[0] == 1001:
            self._label_offset = 1

        floor = max(0.05, self.min_score * 0.5)
        out: list[tuple[str, float]] = []
        for i in top_ids:
            i = int(i)
            sc = _to_prob(float(scores[i]))
            if sc < floor:
                break
            lbl = self.labels.get(i - self._label_offset, str(i))
            out.append((lbl, sc))
        return out

    def _top3_inat(self, crop: np.ndarray) -> list[tuple[str, float]]:
        """Return up to 3 (label, score) tuples from the iNat second-stage
        backend. Same shape as _top3_mobilenet so classify_crop can apply
        rules and the cross-check uniformly."""
        if self._inat_interpreter is None:
            return []
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        floor = max(0.05, self._inat_min_score * 0.5)
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

            out: list[tuple[str, float]] = []
            for i in top_ids:
                i = int(i)
                p = _to_prob(float(scores[i]))
                if p < floor:
                    break
                out.append((self._inat_labels.get(i, str(i)), p))
            return out
        # Coral path
        width, height = self._inat_common.input_size(self._inat_interpreter)
        resized = cv2.resize(rgb, (width, height))
        self._inat_common.set_input(self._inat_interpreter, resized)
        self._inat_interpreter.invoke()
        classes = self._inat_classify.get_classes(
            self._inat_interpreter, top_k=3, score_threshold=floor,
        )
        return [(self._inat_labels.get(int(c.id), str(c.id)), float(c.score)) for c in classes]


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

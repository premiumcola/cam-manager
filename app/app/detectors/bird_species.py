"""BirdSpeciesClassifier — second-stage iNaturalist classifier for bird
crops. Same three-tier fallback as CoralObjectDetector.

Carved out of `_legacy_classes.py` during R02.2.
"""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ._label_loader import _load_bird_latin_to_de, _pretty_bird_label, load_label_map

log = logging.getLogger(__name__)


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
            from pycoral.adapters import classify, common  # type: ignore
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore

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
        classes = self.classify.get_classes(
            self.interpreter, top_k=3, score_threshold=self.min_score
        )
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
        scale, zero_point = (
            output_details[0].get('quantization', (0.0, 0))
            if out_dtype in (np.uint8, np.int8)
            else (None, None)
        )

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

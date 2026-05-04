"""WildlifeClassifier — ImageNet MobileNetV2 second-stage classifier
for mammals the COCO detector cannot name (fox, squirrel, hedgehog).

Carved out of `_legacy_classes.py` during R02.3. With this commit the
legacy single-file home is gone — every detector class now lives in
its own module.
"""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ._label_loader import load_label_map
from ._types import Detection
from ._wildlife_rules import (
    _inat_wildlife_category,
    _is_sciuridae_inat,
    _is_squirrel_likely,
    _wildlife_category,
)
from .discovery import discover_wildlife_paths

log = logging.getLogger(__name__)


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
        # Auto-discovery: locate a MobileNet ImageNet model + its labels
        # file in /app/models. Lets users drop a model in without editing
        # yaml. Always runs (cheap glob) so partial configs — common case:
        # model_path set but labels_path missing — still get the labels
        # filled in. setdefault only — never overwrite a user-supplied
        # value, even when the file is missing on disk. A non-existent
        # configured path is more often a transient mount issue at boot
        # than a bad config; silently swapping in the discovery default
        # would erase the operator's intent.
        disc = discover_wildlife_paths()
        for k, v in disc.items():
            if not self.cfg.get(k):
                self.cfg[k] = v
                continue
            if not Path(self.cfg[k]).exists():
                log.warning(
                    "Wildlife classifier: configured %s=%s does not exist; "
                    "leaving config as-is. Discovered alternative was %s.",
                    k, self.cfg[k], v,
                )
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
            from pycoral.adapters import classify, common  # type: ignore
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
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
            from pycoral.adapters import classify, common  # type: ignore
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
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



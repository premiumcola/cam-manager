"""CoralObjectDetector — three-tier (pycoral / tflite-runtime CPU /
motion-only) COCO-style object detector.

Carved out of `_legacy_classes.py` during R02.2.
"""
from __future__ import annotations

import logging
import re
import threading

import cv2
import numpy as np

from ._label_loader import load_label_map
from ._types import Detection, _apply_region_filter

log = logging.getLogger(__name__)


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
        # Serialise set_tensor → invoke → get_tensor. The interpreter is
        # NOT thread-safe — when the runtime loop and the simulate-now
        # endpoint hit it concurrently, two effects collide:
        #   1. tflite raises "There is at least 1 reference to internal
        #      data in the interpreter …" because a numpy view from a
        #      previous get_tensor() is still live when set_tensor() runs.
        #   2. EdgeTPU invokes can produce inconsistent output if a
        #      second invoke starts before the previous one's output
        #      tensors are read.
        # The lock covers the entire read-from-output phase so callers
        # always observe a consistent snapshot.
        self._infer_lock = threading.Lock()
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
            from pycoral.adapters import common, detect  # type: ignore
            from pycoral.utils.edgetpu import make_interpreter  # type: ignore
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
          - kept == 0 AND drops == 0 → silent (empty scene, no signal)
        ASCII check/cross markers stand out in `docker logs` greps.
        The previously-emitted "inference empty (raw=0)" DEBUG line is
        deliberately dropped: the inference loop runs at ~3 Hz per
        camera and ~99 % of frames on a quiet scene return 0 raw
        candidates, so the line was a per-frame heartbeat with zero
        diagnostic value. The real heartbeat in server.py already
        confirms each runtime is alive; if a camera silently stops
        producing frames, the [cam:…] connection logs surface that.
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
        """Inference via pycoral + EdgeTPU.

        Wrapped in ``_infer_lock`` so a concurrent simulate-now call
        can't start a second invoke while an outstanding get_objects()
        view is still tied to the previous run.
        """
        score_threshold = threshold if threshold is not None else self.min_score
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        with self._infer_lock:
            width, height = self.common.input_size(self.interpreter)
            resized = cv2.resize(rgb, (width, height))
            self.common.set_input(self.interpreter, resized)
            self.interpreter.invoke()
            # Materialise pycoral results into a plain list of (id, score, bbox)
            # tuples while still inside the lock so the underlying tensor
            # references are released before the next caller can run set_input.
            objs = self.detect.get_objects(self.interpreter, score_threshold=score_threshold)
            snapshot = [
                (int(o.id), float(o.score),
                 (float(o.bbox.xmin), float(o.bbox.ymin),
                  float(o.bbox.xmax), float(o.bbox.ymax)))
                for o in objs
            ]
        h, w = frame.shape[:2]
        sx = w / float(width)
        sy = h / float(height)
        out: list[Detection] = []
        for cid, score, (xmin, ymin, xmax, ymax) in snapshot:
            x1 = max(0, int(xmin * sx))
            y1 = max(0, int(ymin * sy))
            x2 = min(w, int(xmax * sx))
            y2 = min(h, int(ymax * sy))
            label = self.labels.get(cid, str(cid))
            out.append(Detection(label=label, score=score, bbox=(x1, y1, x2, y2), raw_cls_id=cid))
        return _apply_region_filter(out, self._region_filter)

    def _detect_cpu(self, frame: np.ndarray, threshold: float | None = None) -> list[Detection]:
        """Inference via tflite-runtime on CPU (SSD MobileNet layout).

        Both the lock AND ``np.copy()`` on the output tensors are
        required:
          • the lock prevents a parallel ``set_tensor`` call (from the
            simulate-now endpoint) from clashing with this thread's
            outstanding numpy views;
          • the copy detaches our return values from the interpreter's
            internal buffer so a downstream consumer can hold the
            arrays past the lock release without keeping the
            interpreter pinned.
        """
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
        with self._infer_lock:
            self.interpreter.set_tensor(input_details[0]['index'], inp)
            self.interpreter.invoke()
            # Standard SSD output order: boxes [N,4], classes [N], scores [N], count
            boxes   = np.copy(self.interpreter.get_tensor(output_details[0]['index'])[0])
            classes = np.copy(self.interpreter.get_tensor(output_details[1]['index'])[0])
            scores  = np.copy(self.interpreter.get_tensor(output_details[2]['index'])[0])
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

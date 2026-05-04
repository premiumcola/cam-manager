"""Coral test panel + per-camera test-detection.

Migrated from server.py during R01.5. The 421-line `api_coral_test_batch`
moves verbatim — R04 will shrink it from inside its new home; the goal
of this step is location, not refactor. The detector / classifier
classes are constructed per request because the test panel intentionally
mirrors what each model would say *with override flags* (force-enabled
second-stage classifiers), and reusing a long-lived instance would lose
that override semantic.
"""
from __future__ import annotations

import base64 as _b64
import logging
import os as _os
import subprocess as _sp
import time as _time
from pathlib import Path

import cv2
from flask import Blueprint, jsonify, request

from .. import app_state
from ._coral_helpers import (
    _MODELS_DIR,
    _TEST_VALID_EXT,
    _TEST_FOLDER_LABELS,
    _categorize_tflite,
    _describe_tflite,
    _labels_for_model,
    _nickname_tflite,
)

bp = Blueprint("coral", __name__)
log = logging.getLogger(__name__)


@bp.post('/api/coral/test')
def api_coral_test():
    """Run every classifier stage against a single frame and return a
    per-model breakdown. The user wants to see "what each model would
    say" in the Settings → Modelle test panel — including stages that
    are currently disabled in the runtime, so the test bypasses the
    .enabled flag for the second-stage classifiers.

    Response shape:
      {
        ok, source, camera_id, camera_name, image_b64, usb_info,
        models_run: [
          {category, model, mode, available, reason, inference_ms, results: [...]},
          ...
        ],
        # Legacy flat fields kept for the older test-panel UI:
        detector_mode, detector_available, detector_reason, inference_ms,
        detections, bird_species_mode, bird_species_reason,
      }
    """
    from ..detectors import (
        BirdSpeciesClassifier,
        CoralObjectDetector,
        WildlifeClassifier,
        draw_detections,
    )
    settings = app_state.settings
    runtimes = app_state.runtimes
    payload = request.get_json(silent=True) or {}
    cam_id = (payload.get("camera_id") or "").strip() or None

    eff = app_state.get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}
    wild_cfg = (eff.get("processing", {}) or {}).get("wildlife", {}) or {}

    # Source frame: camera runtime → snapshot; otherwise a test pattern
    frame = None
    source = "test_pattern"
    camera_name = None
    if cam_id:
        rt = runtimes.get(cam_id)
        if rt is not None:
            with rt.lock:
                # Prefer the clean H.264 sub-stream frame. The main-stream
                # rt.frame is OpenCV's software H.265 decode output, which is
                # riddled with pink/magenta artifacts and unusable for a
                # visual sanity check of Coral detection results.
                if getattr(rt, '_preview_frame', None) is not None:
                    frame = rt._preview_frame.copy()
                elif rt.preview is not None:
                    frame = rt.preview.copy()
                elif rt.frame is not None:
                    frame = rt.frame.copy()
            if frame is not None:
                source = "camera"
                cam_cfg = settings.get_camera(cam_id) or {}
                camera_name = cam_cfg.get("name", cam_id)
    if frame is None:
        import numpy as _np
        frame = _np.zeros((300, 300, 3), dtype=_np.uint8)
        frame[50:150, 50:150] = (255, 120, 0)
        frame[150:250, 100:200] = (80, 200, 0)
        frame[80:120, 200:280] = (50, 100, 180)

    models_run: list[dict] = []

    # ── Stage 1: COCO detection ──────────────────────────────────────────
    detector = CoralObjectDetector(det_cfg)
    detections: list = []
    infer_ms = 0.0
    err_msg = None
    if detector.available:
        try:
            t0 = _time.perf_counter()
            detections = detector.detect_frame(frame)
            infer_ms = round((_time.perf_counter() - t0) * 1000, 1)
        except Exception as e:
            err_msg = str(e)
    models_run.append({
        "category": "detection",
        "model": _os.path.basename(det_cfg.get("model_path") or "") or None,
        "mode": detector.mode,
        "available": bool(detector.available),
        "reason": detector.reason,
        "inference_ms": infer_ms,
        "error": err_msg,
        "results": [d.to_dict() for d in detections],
    })

    # ── Stage 2: bird species classifier ─────────────────────────────────
    # Test-mode override: ignore .enabled so the user can see what the
    # model would say even when the runtime has it switched off.
    bird_test_cfg = dict(bird_cfg)
    bird_test_cfg["enabled"] = True
    bird_clf = BirdSpeciesClassifier(bird_test_cfg)
    bird_results: list[dict] = []
    bird_ms = 0.0
    if bird_clf.available and detections:
        h_full, w_full = frame.shape[:2]
        t0 = _time.perf_counter()
        for d in detections:
            if d.label != "bird":
                continue
            x1, y1, x2, y2 = d.bbox
            pad = 6
            cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
            cx2 = min(w_full, x2 + pad); cy2 = min(h_full, y2 + pad)
            crop = frame[cy1:cy2, cx1:cx2]
            if crop is None or crop.size == 0:
                continue
            try:
                sp, sp_latin, sp_score = bird_clf.classify_crop(crop)
            except Exception:
                sp, sp_latin, sp_score = None, None, None
            if sp:
                d.species = sp
                d.species_latin = sp_latin
                d.species_score = float(sp_score) if sp_score is not None else None
                bird_results.append({
                    "species": sp,
                    "latin": sp_latin,
                    "score": round(float(sp_score), 4) if sp_score is not None else None,
                    "from_label": "bird",
                })
        bird_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append({
        "category": "bird_species",
        "model": _os.path.basename(bird_cfg.get("model_path") or "") or None,
        "mode": bird_clf.mode,
        "available": bool(bird_clf.available),
        "reason": bird_clf.reason,
        "inference_ms": bird_ms,
        "error": None,
        "results": bird_results,
    })

    # ── Stage 3: wildlife classifier (mammals not covered by COCO) ───────
    # Same test-mode override: enabled=True so a CPU-only setup can
    # validate that the wildlife pipeline would work, even if the
    # runtime currently has it disabled. Runs on every detection that
    # is NOT a bird and NOT a person — those are covered upstream.
    wild_test_cfg = dict(wild_cfg)
    wild_test_cfg["enabled"] = True
    wild_clf = WildlifeClassifier(wild_test_cfg)
    wild_results: list[dict] = []
    wild_ms = 0.0
    if wild_clf.available and detections:
        h_full, w_full = frame.shape[:2]
        t0 = _time.perf_counter()
        for d in detections:
            if d.label in ("bird", "person"):
                continue
            x1, y1, x2, y2 = d.bbox
            pad = 6
            cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
            cx2 = min(w_full, x2 + pad); cy2 = min(h_full, y2 + pad)
            crop = frame[cy1:cy2, cx1:cx2]
            if crop is None or crop.size == 0:
                continue
            try:
                category, imagenet_label, score = wild_clf.classify_crop(crop)
            except Exception:
                category, imagenet_label, score = None, None, None
            wild_results.append({
                "from_label": d.label,
                "imagenet": imagenet_label,
                "mapped": category,  # "squirrel" / "fox" / "hedgehog" / null
                "score": round(float(score), 4) if score is not None else None,
            })
        wild_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append({
        "category": "wildlife",
        "model": _os.path.basename(wild_cfg.get("model_path") or "") or None,
        "mode": wild_clf.mode,
        "available": bool(wild_clf.available),
        "reason": wild_clf.reason,
        "inference_ms": wild_ms,
        "error": None,
        "results": wild_results,
    })

    # ── Annotated preview (uses Stage-1 boxes) ──────────────────────────
    annotated = draw_detections(frame, detections)
    h, w = annotated.shape[:2]
    if w > 640:
        scale = 640 / w
        annotated = cv2.resize(annotated, (640, int(h * scale)))
    ok, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    image_b64 = ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None

    usb_info = None
    try:
        lsusb = _sp.check_output(['lsusb'], text=True, timeout=3, stderr=_sp.DEVNULL)
        for line in lsusb.splitlines():
            low = line.lower()
            if 'google' in low or 'coral' in low or '18d1' in low or '1a6e' in low:
                usb_info = line.strip()
                break
    except Exception:
        pass

    return jsonify({
        "ok": True,
        # Legacy flat fields — older test-panel renderers still read these.
        "detector_mode": detector.mode,
        "detector_available": detector.available,
        "detector_reason": detector.reason,
        "model_path": det_cfg.get("model_path"),
        "bird_species_mode": bird_clf.mode,
        "bird_species_reason": bird_clf.reason,
        "source": source,
        "camera_id": cam_id,
        "camera_name": camera_name,
        "inference_ms": infer_ms,
        "inference_error": err_msg,
        "detections": [d.to_dict() for d in detections],
        "image_b64": image_b64,
        "usb_info": usb_info,
        # New per-model breakdown.
        "models_run": models_run,
    })


@bp.get('/api/coral/test-images')
def api_coral_test_images():
    """List subfolders under storage/test_images/ with image counts so the
    Coral test-panel dropdown can populate a 'Testbilder' optgroup."""
    eff = app_state.get_effective_config()
    storage_root = Path(eff.get("storage", {}).get("root", "storage"))
    base = storage_root / "test_images"
    if not base.exists():
        return jsonify({"folders": [], "expected_at": str(base)})
    folders = []
    for d in sorted(base.iterdir()):
        if not d.is_dir() or d.name.startswith("_"):
            continue
        count = sum(
            1 for p in d.iterdir()
            if p.is_file() and p.suffix.lower() in _TEST_VALID_EXT
        )
        if count == 0:
            continue
        meta = _TEST_FOLDER_LABELS.get(d.name, {})
        folders.append({
            "name":  d.name,
            "count": count,
            "label": meta.get("label", d.name.capitalize()),
            "icon":  meta.get("icon", "📁"),
        })
    return jsonify({"folders": folders})


@bp.post('/api/coral/test-batch')
def api_coral_test_batch():
    """Run detect_frame on every image under storage/test_images/<folder>/.

    Body: {"folder": "bird"} runs only that folder. Empty body runs all.
    Returns a per-image breakdown (incl. annotated image_b64 with bounding
    boxes drawn on it) plus a summary of label counts so the user can
    sanity-check object-detection quality without live camera feeds."""
    from ..detectors import (
        BirdSpeciesClassifier,
        CoralObjectDetector,
        WildlifeClassifier,
    )
    payload = request.get_json(silent=True) or {}
    folder_filter = (payload.get("folder") or "").strip()
    # Optional mode dispatch — see ALLOWED_MODES below. Default cascade
    # mirrors the previous behaviour byte-for-byte (plus the new
    # source_model tags).
    _ALLOWED_MODES = (
        "cascade", "coco_only", "bird_species_only",
        "wildlife_only", "all_independent",
    )
    mode = (payload.get("mode") or "cascade").strip()
    if mode not in _ALLOWED_MODES:
        return jsonify({
            "ok": False,
            "error": f"unknown mode: {mode!r}",
            "allowed": list(_ALLOWED_MODES),
        }), 400

    eff = app_state.get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}
    wl_cfg = (eff.get("processing", {}) or {}).get("wildlife", {}) or {}
    storage_root = Path(eff.get("storage", {}).get("root", "storage"))
    base = storage_root / "test_images"
    if not base.exists():
        return jsonify({
            "ok": False,
            "error": "test_images directory not found",
            "expected_at": str(base),
            "results": [],
        }), 404

    if folder_filter:
        candidate_dirs = [base / folder_filter]
    else:
        candidate_dirs = sorted(
            d for d in base.iterdir()
            if d.is_dir() and not d.name.startswith("_")
        )

    detector = CoralObjectDetector(det_cfg)
    # COCO-less modes (bird_species_only, wildlife_only) tolerate the
    # detector being absent — they don't call detect_frame at all. Only
    # the modes that genuinely need COCO short-circuit on unavailability.
    _COCO_MODES = {"cascade", "coco_only", "all_independent"}
    if mode in _COCO_MODES and not detector.available:
        return jsonify({
            "ok": False,
            "error": "detector unavailable",
            "detector_mode": detector.mode,
            "detector_reason": detector.reason,
            "results": [],
        })

    # Build the per-stage classifiers based on the requested mode:
    #   - cascade            → existing behaviour (bird if cfg.enabled,
    #                          wildlife when wildlife folder + cfg ok)
    #   - bird_species_only  → bird classifier always (force-enabled)
    #   - wildlife_only      → wildlife classifier always (force-enabled)
    #   - all_independent    → both always (force-enabled)
    #   - coco_only          → neither
    _BIRD_FORCE = mode in {"bird_species_only", "all_independent"}
    _WL_FORCE = mode in {"wildlife_only", "all_independent"}

    if _BIRD_FORCE or bird_cfg.get("enabled"):
        bird_eff = dict(bird_cfg)
        if _BIRD_FORCE:
            bird_eff["enabled"] = True
        bird_clf = BirdSpeciesClassifier(bird_eff)
    else:
        bird_clf = None

    # Wildlife classifier (fox/squirrel/hedgehog via ImageNet MobileNetV2).
    # For test-batch we want to mirror the live pipeline AND give honest
    # diagnostics — so when any of the wildlife folders is being tested,
    # build the classifier even if `wildlife.enabled` is False in settings.
    # The user otherwise sees a stream of zeros and can't tell whether the
    # model is broken or simply switched off.
    _WILDLIFE_FOLDERS = {"fox", "hedgehog", "squirrel"}
    target_folders = {d.name for d in candidate_dirs if d.is_dir()}
    needs_wildlife = bool(target_folders & _WILDLIFE_FOLDERS)
    wildlife_settings_enabled = bool(wl_cfg.get("enabled"))
    wl_clf = None
    if _WL_FORCE or wildlife_settings_enabled or needs_wildlife:
        wl_cfg_eff = dict(wl_cfg)
        wl_cfg_eff["enabled"] = True
        wl_clf = WildlifeClassifier(wl_cfg_eff)
    # Surfaced to the response so the UI can explain a 0-detection result
    # in a wildlife folder when the user has wildlife disabled in settings.
    wildlife_disabled_warning = (
        "Wildlife-Erkennung ist deaktiviert — Eichhörnchen/Fuchs/Igel werden nicht erkannt. "
        "In Einstellungen aktivieren."
        if (needs_wildlife and not wildlife_settings_enabled) else None
    )

    results: list = []
    by_label: dict = {}
    total_images = 0
    with_detections = 0
    with_wildlife = 0
    inference_times: list = []
    species_counts: dict = {}
    wildlife_counts: dict = {}

    from ..detectors import Detection as _Det

    def _classify_bird_full(frame_arg):
        """Run the bird classifier on the full frame; return Detection
        or None. Used by bird_species_only and all_independent modes."""
        if not (bird_clf and bird_clf.available):
            return None
        try:
            sp, sp_latin, sp_score = bird_clf.classify_crop(frame_arg)
        except Exception:
            return None
        if not sp:
            return None
        fh2, fw2 = frame_arg.shape[:2]
        return _Det(
            label="bird",
            score=float(sp_score) if sp_score is not None else 0.5,
            bbox=(0, 0, int(fw2), int(fh2)),
            raw_cls_id=-1,
            species=sp,
            species_latin=sp_latin,
            species_score=float(sp_score) if sp_score is not None else None,
        )

    def _classify_wildlife_full(frame_arg):
        """Run the wildlife classifier on the full frame; return
        (Detection|None, info_dict|None). Ungated — no folder check, no
        cat→squirrel override, no overlap suppression. Used by
        wildlife_only and all_independent."""
        if not (wl_clf and wl_clf.available):
            return None, None
        try:
            cat, raw_lbl, wscore = wl_clf.classify_crop(frame_arg)
        except Exception:
            return None, None
        fh2, fw2 = frame_arg.shape[:2]
        full_bbox = (0, 0, int(fw2), int(fh2))
        det = None
        if cat or raw_lbl:
            det = _Det(
                label=cat if cat else (raw_lbl or "?"),
                score=float(wscore) if wscore is not None else 0.0,
                bbox=full_bbox,
                raw_cls_id=-1,
                species=raw_lbl,
                species_latin=None,
                species_score=float(wscore) if wscore is not None else None,
            )
        info = None
        if raw_lbl is not None:
            info = {
                "label": cat,
                "imagenet": raw_lbl,
                "score": round(float(wscore), 3) if wscore is not None else None,
                "bbox": list(full_bbox),
            }
        return det, info

    for d in candidate_dirs:
        if not d.is_dir():
            continue
        for img_path in sorted(d.iterdir()):
            if img_path.suffix.lower() not in _TEST_VALID_EXT:
                continue
            frame = cv2.imread(str(img_path))
            if frame is None:
                results.append({
                    "folder": d.name,
                    "filename": img_path.name,
                    "error": "could not read image",
                })
                continue
            stages_run: list[str] = []
            # `tagged` carries (Detection, source_model_str) pairs so we
            # can serialise per-detection model attribution in one place
            # at the end of the loop body.
            tagged: list[tuple] = []
            ms = 0.0
            wildlife_info = None

            if mode in _COCO_MODES:
                try:
                    t0 = _time.perf_counter()
                    coco_dets = detector.detect_frame(frame)
                    ms = round((_time.perf_counter() - t0) * 1000, 1)
                    stages_run.append("detector")
                except Exception as e:
                    results.append({
                        "folder": d.name,
                        "filename": img_path.name,
                        "error": str(e),
                        "stages_run": stages_run,
                    })
                    continue
            else:
                coco_dets = []

            if mode == "cascade":
                # Existing cascade flow — preserved byte-for-byte except
                # for the new source_model tagging.
                dets = list(coco_dets)
                # Species classification on each bird crop when the classifier is on
                if dets and bird_clf is not None and bird_clf.available:
                    hh, ww = frame.shape[:2]
                    for dd in dets:
                        if dd.label != "bird":
                            continue
                        x1, y1, x2, y2 = dd.bbox
                        pad = 6
                        cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
                        cx2 = min(ww, x2 + pad); cy2 = min(hh, y2 + pad)
                        crop = frame[cy1:cy2, cx1:cx2]
                        if crop is None or crop.size == 0:
                            continue
                        try:
                            sp, sp_latin, sp_score = bird_clf.classify_crop(crop)
                        except Exception:
                            sp, sp_latin, sp_score = None, None, None
                        if sp:
                            dd.species = sp
                            dd.species_latin = sp_latin
                            dd.species_score = float(sp_score) if sp_score is not None else None
                            species_counts[sp] = species_counts.get(sp, 0) + 1
                    stages_run.append("bird_classifier")
                # Wildlife (ImageNet) classification — only runs for folders
                # where COCO doesn't have a matching class.
                if wl_clf is not None and wl_clf.available and d.name in _WILDLIFE_FOLDERS:
                    try:
                        cat, raw_lbl, wscore = wl_clf.classify_crop(frame)
                    except Exception:
                        cat, raw_lbl, wscore = None, None, None
                    fh, fw = frame.shape[:2]
                    refined_bbox: tuple[int, int, int, int] | None = None
                    if cat:
                        _DONORS = ("cat", "dog", "bear", "sheep", "cow", "teddy bear")
                        try:
                            low_dets = detector.detect_frame(frame, min_score=0.25) or []
                        except Exception:
                            low_dets = []
                        for ld in low_dets:
                            if ld.label in _DONORS:
                                refined_bbox = tuple(ld.bbox)
                                break
                        if cat == "squirrel" and float(wscore or 0) >= 0.55 and refined_bbox is not None:
                            from ..camera_runtime import _bbox_iou as _iou
                            _DROP = {"cat", "dog", "bear", "teddy bear"}
                            dets = [
                                dd for dd in dets
                                if not (dd.label in _DROP and _iou(tuple(dd.bbox), refined_bbox) >= 0.3)
                            ]
                        promoted_bbox = refined_bbox if refined_bbox is not None else (0, 0, int(fw), int(fh))
                        # Promoted wildlife hit gets a "wildlife" tag.
                        tagged.append((_Det(
                            label=cat,
                            score=float(wscore) if wscore is not None else 0.5,
                            bbox=promoted_bbox,
                            raw_cls_id=-1,
                            species=raw_lbl,
                            species_latin=None,
                            species_score=float(wscore) if wscore is not None else None,
                        ), "wildlife"))
                    if raw_lbl is not None:
                        wildlife_info = {
                            "label": cat,
                            "imagenet": raw_lbl,
                            "score": round(float(wscore), 3) if wscore is not None else None,
                            "bbox": list(refined_bbox) if refined_bbox is not None else [0, 0, int(fw), int(fh)],
                        }
                        if cat:
                            wildlife_counts[cat] = wildlife_counts.get(cat, 0) + 1
                    stages_run.append("wildlife_classifier")
                # Surviving COCO detections come first so the response order
                # matches the legacy cascade ordering exactly.
                tagged = [(dd, "coco") for dd in dets] + tagged

            elif mode == "coco_only":
                tagged = [(dd, "coco") for dd in coco_dets]

            elif mode == "bird_species_only":
                bird_det = _classify_bird_full(frame)
                if bird_det is not None:
                    tagged.append((bird_det, "bird_species"))
                    if bird_det.species:
                        species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
                    stages_run.append("bird_classifier_full")

            elif mode == "wildlife_only":
                wl_det, wl_info = _classify_wildlife_full(frame)
                if wl_det is not None:
                    tagged.append((wl_det, "wildlife"))
                    if wl_det.label and wl_det.label != "?":
                        wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
                    stages_run.append("wildlife_classifier_full")
                wildlife_info = wl_info

            elif mode == "all_independent":
                # COCO entries come first, in their natural detector order.
                tagged = [(dd, "coco") for dd in coco_dets]
                # Bird classifier on full frame, ungated.
                bird_det = _classify_bird_full(frame)
                if bird_det is not None:
                    tagged.append((bird_det, "bird_species"))
                    if bird_det.species:
                        species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
                    stages_run.append("bird_classifier_full")
                # Wildlife on full frame, ungated. NO suppression, NO
                # cat→squirrel override — the whole point is to see the
                # raw, independent verdict from each model.
                wl_det, wl_info = _classify_wildlife_full(frame)
                if wl_det is not None:
                    tagged.append((wl_det, "wildlife"))
                    if wl_det.label and wl_det.label != "?":
                        wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
                    stages_run.append("wildlife_classifier_full")
                wildlife_info = wl_info
            # Encode the RAW frame for transport — bbox overlays are drawn
            # client-side onto a <canvas> so the user sees both COCO and
            # wildlife rectangles with the colour scheme the UI controls.
            # Original image dimensions are reported so the client can
            # rescale bbox coords to the canvas surface.
            orig_h, orig_w = frame.shape[:2]
            transport = frame
            if orig_w > 480:
                scale = 480 / orig_w
                transport = cv2.resize(frame, (480, int(orig_h * scale)))
            ok, buf = cv2.imencode('.jpg', transport, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            image_b64 = ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None
            results.append({
                "folder": d.name,
                "filename": img_path.name,
                "inference_ms": ms,
                "image_b64": image_b64,
                "image_w": int(orig_w),
                "image_h": int(orig_h),
                "stages_run": stages_run,
                "detections": [{
                    "label": dd.label,
                    "score": round(float(dd.score), 3),
                    "bbox": list(dd.bbox),
                    "raw_cls_id": int(dd.raw_cls_id),
                    "species": dd.species,
                    "species_latin": dd.species_latin,
                    "species_score": round(float(dd.species_score), 3) if dd.species_score is not None else None,
                    "source_model": src,
                } for (dd, src) in tagged],
                "wildlife": wildlife_info,
            })
            total_images += 1
            inference_times.append(ms)
            if tagged:
                with_detections += 1
                for (dd, _src) in tagged:
                    by_label[dd.label] = by_label.get(dd.label, 0) + 1
            # For wildlife folders, "hit" means either COCO found something
            # or wildlife classifier found fox/squirrel/hedgehog
            if wildlife_info and wildlife_info.get("label"):
                with_wildlife += 1

    # Per-model availability badge for the UI's status strip. Nicknames
    # come from the new _nickname_tflite helper so the test panel can
    # render short pill-friendly labels rather than the raw filenames.
    def _model_card(cfg, clf, default_reason):
        fname = Path((cfg or {}).get("model_path") or "").name
        return {
            "nickname": _nickname_tflite(fname),
            "available": bool(clf and clf.available),
            "reason": (clf.reason if clf else default_reason) or "ok",
        }
    models_active = {
        "coco":         _model_card(det_cfg, detector, "disabled"),
        "bird_species": _model_card(bird_cfg, bird_clf, "disabled"),
        "wildlife":     _model_card(wl_cfg, wl_clf, "disabled"),
    }
    response = {
        "ok": True,
        "mode": mode,
        "models_active": models_active,
        "detector_mode": detector.mode,
        "detector_reason": detector.reason,
        "bird_species_mode": bird_clf.mode if bird_clf else "none",
        "bird_species_reason": bird_clf.reason if bird_clf else "disabled",
        "wildlife_mode": wl_clf.mode if wl_clf else "none",
        "wildlife_reason": wl_clf.reason if wl_clf else "disabled",
        "wildlife_settings_enabled": wildlife_settings_enabled,
        "model_path": det_cfg.get("model_path"),
        "summary": {
            "total_images": total_images,
            "with_detections": with_detections,
            "with_wildlife": with_wildlife,
            "by_label": by_label,
            "by_species": species_counts,
            "by_wildlife": wildlife_counts,
            "avg_ms": round(sum(inference_times) / len(inference_times), 1) if inference_times else 0.0,
        },
        "results": results,
    }
    if wildlife_disabled_warning:
        response["wildlife_disabled_warning"] = wildlife_disabled_warning
    return jsonify(response)


@bp.get('/api/coral/models')
def api_coral_models():
    """List every .tflite model present in /app/models/, annotated with size,
    a filename-derived description, a purpose category, and the matching
    labels-file (if any). Flags which one is currently loaded per category."""
    eff = app_state.get_effective_config()
    proc = eff.get("processing") or {}
    active_by_category = {
        "detection":    (proc.get("detection") or {}).get("model_path"),
        "bird_species": (proc.get("bird_species") or {}).get("model_path"),
        "wildlife":     (proc.get("wildlife") or {}).get("model_path"),
    }
    # Current (legacy field) kept for backward compat
    current = active_by_category.get("detection")
    items: list = []
    if _MODELS_DIR.exists():
        for p in sorted(_MODELS_DIR.glob("*.tflite")):
            try:
                size = p.stat().st_size
            except Exception:
                size = 0
            category = _categorize_tflite(p.name)
            active_path = active_by_category.get(category)
            items.append({
                "filename": p.name,
                "path": str(p),
                "size_bytes": size,
                "size_mb": round(size / 1048576, 2),
                "description": _describe_tflite(p.name),
                "nickname": _nickname_tflite(p.name),
                "edgetpu": "_edgetpu" in p.name.lower(),
                "model_category": category,
                "labels": _labels_for_model(p.name),
                "active": str(p) == current,                       # legacy: detection only
                "active_in_category": str(p) == active_path,        # per-category flag
            })
    return jsonify({
        "ok": True,
        "models": items,
        "current": current,
        "active_by_category": active_by_category,
        "models_dir": str(_MODELS_DIR),
    })


@bp.post('/api/coral/models/select')
def api_coral_models_select():
    """Switch the active model for ONE category. Routing is driven by
    the filename's category (_categorize_tflite); writing a wildlife or
    bird-species model into processing.detection.model_path would
    clobber the COCO detector, which is the bug this guard fixes.

    Path traversal protection: target must resolve inside /app/models/.
    """
    from ..server import rebuild_runtimes
    settings = app_state.settings
    payload = request.get_json(silent=True) or {}
    raw_path = (payload.get("path") or "").strip()
    if not raw_path:
        return jsonify({"ok": False, "error": "path required"}), 400
    try:
        target = Path(raw_path).resolve()
        target.relative_to(_MODELS_DIR.resolve())
    except Exception:
        return jsonify({"ok": False, "error": "path must be inside /app/models"}), 400
    if not target.exists() or target.suffix.lower() != ".tflite":
        return jsonify({"ok": False, "error": "model not found"}), 404

    category = _categorize_tflite(target.name)
    if category == "other":
        return jsonify({
            "ok": False,
            "error": "Modell-Kategorie unbekannt — bitte Dateinamen prüfen",
        }), 400

    # Map category → settings.processing.<bucket> so each model writes
    # into its own bucket. cpu_model_path mirrors the EdgeTPU pick to
    # the non-edgetpu variant so the CPU fallback (or a no-Coral host)
    # loads the matching tflite without further config.
    bucket_by_cat = {
        "detection": "detection",
        "bird_species": "bird_species",
        "wildlife": "wildlife",
    }
    bucket_name = bucket_by_cat[category]
    proc = settings.data.setdefault("processing", {})
    bucket = proc.setdefault(bucket_name, {})
    bucket["model_path"] = str(target)
    cpu_candidate = str(target).replace("_edgetpu.tflite", ".tflite")
    if cpu_candidate != str(target) and Path(cpu_candidate).exists():
        bucket["cpu_model_path"] = cpu_candidate
    else:
        bucket.pop("cpu_model_path", None)
    # Detection always runs (it's the first stage); the second-stage
    # classifiers ship disabled-by-default so flipping enabled=True on
    # selection makes the model actually take effect. Mode flag mirrors
    # the legacy "coral" string so the runtime picks up the new path
    # via either branch.
    if category == "detection":
        bucket["mode"] = "coral"
    else:
        bucket["enabled"] = True
    settings.save()
    try:
        rebuild_runtimes()
    except Exception as e:
        log.warning("Coral model switch: rebuild_runtimes failed: %s", e)
    return jsonify({"ok": True, "path": str(target), "category": category})


@bp.post('/api/cameras/<cam_id>/test-detection')
def api_test_detection(cam_id: str):
    """Run Coral inference on the camera's most-recent frame and return
    each raw detection alongside a verdict — pass / belowthresh /
    filtered — computed against the camera's current configuration
    (detection_min_score, label_thresholds, object_filter). The cam-
    edit "Erkennung jetzt simulieren" button hits this and renders the
    snapshot inline with coloured bounding boxes so the user can see
    exactly what Coral found and which filter dropped what.

    No fresh capture: we read the runtime's last cached frame
    (rt.frame). That frame is at most one frame_interval_ms old and
    avoids the cost / racing of a second RTSP open. Inference runs at
    a low 0.20 threshold so even almost-rejected hits surface in the
    visualisation; the user's actual thresholds are applied afterwards
    to compute the per-detection verdict.
    """
    settings = app_state.settings
    runtimes = app_state.runtimes
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    rt = runtimes.get(cam_id)
    if rt is None:
        return jsonify({"error": "Kamera-Runtime nicht aktiv (deaktiviert?)"}), 503
    frame = rt.frame.copy() if rt.frame is not None else None
    if frame is None:
        return jsonify({"error": "Noch kein Frame vorhanden — Kamera startet?"}), 503
    detector = getattr(rt, "detector", None)
    if not detector or not getattr(detector, "available", False):
        return jsonify({"error": "Coral nicht verfügbar (motion-only?)"}), 503
    try:
        raw = detector.detect_frame_raw(frame, threshold=0.20)
    except Exception as e:
        log.warning("[test-detection] %s inference failed: %s", cam_id, e)
        return jsonify({"error": f"Inference fehlgeschlagen: {e}"}), 500
    # Resolve the global confidence floor — empty/zero on the camera
    # means "use the global processing.detection.min_score". This must
    # match what camera_runtime actually applies at runtime so the
    # simulation result reflects what would happen in production.
    global_floor = float(cam.get("detection_min_score") or 0.0)
    if global_floor <= 0:
        proc = (app_state.get_effective_config().get("processing") or {})
        global_floor = float((proc.get("detection") or {}).get("min_score") or 0.55)
    per_class = cam.get("label_thresholds") or {}
    obj_filter = set(cam.get("object_filter") or [])
    out = []
    for d in raw:
        cls_thresh = float(per_class.get(d.label, global_floor))
        if obj_filter and d.label not in obj_filter:
            verdict = "filtered"
            reason = f"Klasse '{d.label}' nicht im Filter"
        elif d.score < cls_thresh:
            verdict = "belowthresh"
            reason = f"unter Schwelle {int(round(cls_thresh * 100))} %"
        else:
            verdict = "pass"
            reason = ""
        x1, y1, x2, y2 = d.bbox
        out.append({
            "label":   d.label,
            "score":   round(float(d.score), 4),
            "bbox":    [int(x1), int(y1), int(max(0, x2 - x1)), int(max(0, y2 - y1))],
            "verdict": verdict,
            "reason":  reason,
        })
    out.sort(key=lambda r: r["score"], reverse=True)
    # Encode the frame as a base64 data URL so the frontend can display
    # it inline without a separate snapshot fetch (and so the snapshot
    # is the same frame the boxes were computed against).
    try:
        import base64
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
        snapshot = f"data:image/jpeg;base64,{base64.b64encode(jpg.tobytes()).decode()}" if ok else None
    except Exception as e:
        log.warning("[test-detection] %s encode failed: %s", cam_id, e)
        snapshot = None
    h, w = frame.shape[:2]
    return jsonify({
        "ok":         True,
        "snapshot":   snapshot,
        "frame_size": {"w": int(w), "h": int(h)},
        "detections": out,
    })

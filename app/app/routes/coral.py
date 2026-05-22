"""Coral test panel + per-camera test-detection.

Migrated from server.py during R01.5. R04 decomposed the 421-line
`api_coral_test_batch` into a route shell plus per-mode pipeline
helpers in `_coral_pipeline.py`. The detector / classifier classes
are still constructed per request because the test panel intentionally
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
    _TEST_FOLDER_LABELS,
    _TEST_VALID_EXT,
    _categorize_tflite,
    _describe_tflite,
    _labels_for_model,
    _nickname_tflite,
)
from ._coral_pipeline import (
    ALLOWED_MODES,
    COCO_MODES,
    WILDLIFE_FOLDERS,
    build_classifiers_for_mode,
    build_models_active,
    resolve_candidate_dirs,
    run_mode_all_independent,
    run_mode_bird_only,
    run_mode_cascade,
    run_mode_coco_only,
    run_mode_wildlife_only,
    serialise_image_b64,
    serialise_result_row,
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
    models_run.append(
        {
            "category": "detection",
            "model": _os.path.basename(det_cfg.get("model_path") or "") or None,
            "mode": detector.mode,
            "available": bool(detector.available),
            "reason": detector.reason,
            "inference_ms": infer_ms,
            "error": err_msg,
            "results": [d.to_dict() for d in detections],
        }
    )

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
            cx1 = max(0, x1 - pad)
            cy1 = max(0, y1 - pad)
            cx2 = min(w_full, x2 + pad)
            cy2 = min(h_full, y2 + pad)
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
                bird_results.append(
                    {
                        "species": sp,
                        "latin": sp_latin,
                        "score": round(float(sp_score), 4) if sp_score is not None else None,
                        "from_label": "bird",
                    }
                )
        bird_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append(
        {
            "category": "bird_species",
            "model": _os.path.basename(bird_cfg.get("model_path") or "") or None,
            "mode": bird_clf.mode,
            "available": bool(bird_clf.available),
            "reason": bird_clf.reason,
            "inference_ms": bird_ms,
            "error": None,
            "results": bird_results,
        }
    )

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
            cx1 = max(0, x1 - pad)
            cy1 = max(0, y1 - pad)
            cx2 = min(w_full, x2 + pad)
            cy2 = min(h_full, y2 + pad)
            crop = frame[cy1:cy2, cx1:cx2]
            if crop is None or crop.size == 0:
                continue
            try:
                category, imagenet_label, score = wild_clf.classify_crop(crop)
            except Exception:
                category, imagenet_label, score = None, None, None
            wild_results.append(
                {
                    "from_label": d.label,
                    "imagenet": imagenet_label,
                    "mapped": category,  # "squirrel" / "fox" / "hedgehog" / null
                    "score": round(float(score), 4) if score is not None else None,
                }
            )
        wild_ms = round((_time.perf_counter() - t0) * 1000, 1)
    models_run.append(
        {
            "category": "wildlife",
            "model": _os.path.basename(wild_cfg.get("model_path") or "") or None,
            "mode": wild_clf.mode,
            "available": bool(wild_clf.available),
            "reason": wild_clf.reason,
            "inference_ms": wild_ms,
            "error": None,
            "results": wild_results,
        }
    )

    # ── Annotated preview (uses Stage-1 boxes) ──────────────────────────
    annotated = draw_detections(frame, detections)
    h, w = annotated.shape[:2]
    if w > 640:
        scale = 640 / w
        annotated = cv2.resize(annotated, (640, int(h * scale)))
    ok, buf = cv2.imencode('.jpg', annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
    image_b64 = (
        ("data:image/jpeg;base64," + _b64.b64encode(buf.tobytes()).decode('ascii')) if ok else None
    )

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

    return jsonify(
        {
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
        }
    )


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
        count = sum(1 for p in d.iterdir() if p.is_file() and p.suffix.lower() in _TEST_VALID_EXT)
        if count == 0:
            continue
        meta = _TEST_FOLDER_LABELS.get(d.name, {})
        folders.append(
            {
                "name": d.name,
                "count": count,
                "label": meta.get("label", d.name.capitalize()),
                "icon": meta.get("icon", "📁"),
            }
        )
    return jsonify({"folders": folders})


@bp.post('/api/coral/test-batch')
def api_coral_test_batch():
    """Run detect_frame on every image under storage/test_images/<folder>/.

    Body: {"folder": "bird"} runs only that folder. Empty body runs all.
    Returns a per-image breakdown (incl. annotated image_b64 with bounding
    boxes drawn on it) plus a summary of label counts so the user can
    sanity-check object-detection quality without live camera feeds."""
    payload = request.get_json(silent=True) or {}
    folder_filter = (payload.get("folder") or "").strip()
    mode = (payload.get("mode") or "cascade").strip()
    if mode not in ALLOWED_MODES:
        return jsonify(
            {
                "ok": False,
                "error": f"unknown mode: {mode!r}",
                "allowed": list(ALLOWED_MODES),
            }
        ), 400

    eff = app_state.get_effective_config()
    det_cfg = (eff.get("processing", {}) or {}).get("detection", {}) or {}
    bird_cfg = (eff.get("processing", {}) or {}).get("bird_species", {}) or {}
    wl_cfg = (eff.get("processing", {}) or {}).get("wildlife", {}) or {}
    storage_root = Path(eff.get("storage", {}).get("root", "storage"))

    candidate_dirs, err = resolve_candidate_dirs(storage_root, folder_filter)
    if err is not None:
        return jsonify(err), 404

    target_folders = {d.name for d in candidate_dirs if d.is_dir()}
    needs_wildlife = bool(target_folders & WILDLIFE_FOLDERS)
    wildlife_settings_enabled = bool(wl_cfg.get("enabled"))

    detector, bird_clf, wl_clf, wildlife_disabled_warning = build_classifiers_for_mode(
        mode,
        det_cfg,
        bird_cfg,
        wl_cfg,
        needs_wildlife,
    )
    # COCO-less modes (bird_species_only, wildlife_only) tolerate the
    # detector being absent — they don't call detect_frame at all. Only
    # the modes that genuinely need COCO short-circuit on unavailability.
    if mode in COCO_MODES and not detector.available:
        return jsonify(
            {
                "ok": False,
                "error": "detector unavailable",
                "detector_mode": detector.mode,
                "detector_reason": detector.reason,
                "results": [],
            }
        )

    results: list = []
    counters: dict = {"by_label": {}, "species": {}, "wildlife": {}}
    total_images = 0
    with_detections = 0
    with_wildlife = 0
    inference_times: list = []

    for d in candidate_dirs:
        if not d.is_dir():
            continue
        for img_path in sorted(d.iterdir()):
            if img_path.suffix.lower() not in _TEST_VALID_EXT:
                continue
            frame = cv2.imread(str(img_path))
            if frame is None:
                results.append(
                    {
                        "folder": d.name,
                        "filename": img_path.name,
                        "error": "could not read image",
                    }
                )
                continue
            try:
                if mode == "cascade":
                    tagged, wildlife_info, stages_run, ms = run_mode_cascade(
                        frame,
                        detector,
                        bird_clf,
                        wl_clf,
                        d.name,
                        counters,
                    )
                elif mode == "coco_only":
                    tagged, wildlife_info, stages_run, ms = run_mode_coco_only(
                        frame,
                        detector,
                    )
                elif mode == "bird_species_only":
                    tagged, wildlife_info, stages_run, ms = run_mode_bird_only(
                        frame,
                        bird_clf,
                        counters,
                    )
                elif mode == "wildlife_only":
                    tagged, wildlife_info, stages_run, ms = run_mode_wildlife_only(
                        frame,
                        wl_clf,
                        counters,
                    )
                else:  # all_independent
                    tagged, wildlife_info, stages_run, ms = run_mode_all_independent(
                        frame,
                        detector,
                        bird_clf,
                        wl_clf,
                        counters,
                    )
            except Exception as e:
                # Match the legacy error-row shape: stages_run is empty
                # because the failure is the COCO detect_frame call inside
                # the helper, which happens before any stage append.
                results.append(
                    {
                        "folder": d.name,
                        "filename": img_path.name,
                        "error": str(e),
                        "stages_run": [],
                    }
                )
                continue

            image_b64, orig_w, orig_h = serialise_image_b64(frame)
            results.append(
                serialise_result_row(
                    d.name,
                    img_path.name,
                    ms,
                    image_b64,
                    orig_w,
                    orig_h,
                    stages_run,
                    tagged,
                    wildlife_info,
                )
            )
            total_images += 1
            inference_times.append(ms)
            if tagged:
                with_detections += 1
                for dd, _src in tagged:
                    counters["by_label"][dd.label] = counters["by_label"].get(dd.label, 0) + 1
            # For wildlife folders, "hit" means either COCO found something
            # or wildlife classifier found fox/squirrel/hedgehog
            if wildlife_info and wildlife_info.get("label"):
                with_wildlife += 1

    response = {
        "ok": True,
        "mode": mode,
        "models_active": build_models_active(
            detector,
            bird_clf,
            wl_clf,
            det_cfg,
            bird_cfg,
            wl_cfg,
        ),
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
            "by_label": counters["by_label"],
            "by_species": counters["species"],
            "by_wildlife": counters["wildlife"],
            "avg_ms": round(sum(inference_times) / len(inference_times), 1)
            if inference_times
            else 0.0,
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
        "detection": (proc.get("detection") or {}).get("model_path"),
        "bird_species": (proc.get("bird_species") or {}).get("model_path"),
        "wildlife": (proc.get("wildlife") or {}).get("model_path"),
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
            items.append(
                {
                    "filename": p.name,
                    "path": str(p),
                    "size_bytes": size,
                    "size_mb": round(size / 1048576, 2),
                    "description": _describe_tflite(p.name),
                    "nickname": _nickname_tflite(p.name),
                    "edgetpu": "_edgetpu" in p.name.lower(),
                    "model_category": category,
                    "labels": _labels_for_model(p.name),
                    "active": str(p) == current,  # legacy: detection only
                    "active_in_category": str(p) == active_path,  # per-category flag
                }
            )
    return jsonify(
        {
            "ok": True,
            "models": items,
            "current": current,
            "active_by_category": active_by_category,
            "models_dir": str(_MODELS_DIR),
        }
    )


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
        return jsonify(
            {
                "ok": False,
                "error": "Modell-Kategorie unbekannt — bitte Dateinamen prüfen",
            }
        ), 400

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
        log.warning("[coral] model switch: rebuild_runtimes failed: %s", e)
    return jsonify({"ok": True, "path": str(target), "category": category})



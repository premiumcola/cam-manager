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
    (rt.frame). The main loop refills that buffer on every successful
    grab (~frame_interval_ms cadence). To guarantee the simulation
    actually reflects the CURRENT scene — the user-visible bug was
    snapshots 2+ minutes old when the stream had stalled — the
    handler does a fresh-frame check: if the cached frame is older
    than ~1.5 s OR 3× the camera's frame_interval_ms, it waits up to
    2 s for the main loop to advance ``frame_ts``. If the buffer
    never moves, returns 503 so the operator sees a clear "stream
    stuck" instead of inferring on a stale frame. Inference runs at a
    low 0.20 threshold so even almost-rejected hits surface in the
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

    # ── Fresh + decoder-strip frame contract ──────────────────────────
    # Poll up to 2.5 s for a frame whose timestamp is NEWER than this
    # request AND passes the cheap ``has_corrupt_strip`` H.264 chroma-
    # buffer-flush check. The richer ``is_valid_frame`` validator
    # (bright_outlier_dark_scene, grey_toned, dead_area, …) is
    # deliberately NOT applied here: it was designed to gate the alarm
    # / notification pipeline against frames that look broken to the
    # human, but the live-preview / Simulieren use case is exactly the
    # opposite — show what Coral sees on the camera's CURRENT frame,
    # whatever it looks like. Letting the validator gate the live
    # preview produced ~60 % rejection on the Garten-Dachterrasse
    # twilight scene (one patio light + low-chroma terrace) and made
    # the UI show stale state. The human eye on the live video
    # decides whether a frame is "trustworthy" — Coral's verdict on
    # whatever frame is current is the data the user is asking for.
    # has_corrupt_strip stays in because pink/rainbow bottom-strip is
    # a narrow decoder-artefact signature that would just produce
    # spurious detections on garbage chroma; the alarm-pipeline path
    # in camera_runtime/_main_loop already filters those out
    # independently.
    from ..frame_helpers import (
        has_corrupt_strip,
        pick_profile_from_baseline,
    )

    request_started_at = _time.time()
    deadline = _time.monotonic() + 2.5
    frame = None
    frame_ts_accepted = 0.0
    last_candidate_ts = 0.0
    saw_frame = False
    saw_fresh_candidate = False
    retries = 0
    final_outcome = "no_frame"
    # H1 · track the most recent validator rejection reason across the
    # 2.5 s wait loop. When outcome ends up "corrupt" we surface this
    # in BOTH the log line and the JSON response so the user can see
    # WHICH gate (horizontal_anomaly_band / dead_area / pink_artifact
    # …) flagged every candidate frame, without flipping the log
    # level to DEBUG. This is the single-line answer that splits
    # Stage ① (RTSP/decoder corruption — pink_artifact dominates) from
    # a validator-too-strict regression (e.g. horizontal_anomaly_band
    # spam on a Reolink in IR-cut transition).
    last_validator_reason: str = ""
    active_profile = None
    while _time.monotonic() < deadline:
        with rt.lock:
            candidate = rt.frame.copy() if rt.frame is not None else None
            candidate_ts = float(getattr(rt, "frame_ts", 0.0) or 0.0)
        retries += 1
        if candidate is None:
            _time.sleep(0.05)
            continue
        saw_frame = True
        last_candidate_ts = max(last_candidate_ts, candidate_ts)
        if candidate_ts < request_started_at:
            final_outcome = "stale"
            _time.sleep(0.05)
            continue
        saw_fresh_candidate = True
        # Profile pick stays — kept for the response payload so the
        # diag panel can show whether the scene was classified
        # DAY/TWILIGHT/NIGHT for context, even though no profile-
        # specific validator runs on this path anymore.
        active_profile = pick_profile_from_baseline([candidate])
        if has_corrupt_strip(candidate):
            final_outcome = "corrupt"
            last_validator_reason = "has_corrupt_strip"
            log.info(
                "[test-detection] %s rejected candidate · strip=True",
                cam_id,
            )
            _time.sleep(0.05)
            continue
        # Accepted — fresh, no decoder-strip artefact.
        frame = candidate
        frame_ts_accepted = candidate_ts
        final_outcome = "ok"
        break

    waited_s = _time.time() - request_started_at
    if frame is None:
        # Pick the most precise outcome the loop observed.
        if not saw_frame:
            code, msg = "no_frame", "Kamera liefert noch keine Frames"
        elif not saw_fresh_candidate:
            code, msg = "stale", "Stream-Puffer hinkt zurück — kein frischer Frame innerhalb 2.5 s"
        else:
            code, msg = "corrupt", "Stream liefert nur korrupte Frames"
        # Best-effort age of the most recent rt.frame_ts we saw so the
        # frontend can colour the banner against the existing
        # frame_age_ms semantic. 0 means we never saw a frame at all.
        if last_candidate_ts > 0:
            frame_age_ms_attempt = int((_time.time() - last_candidate_ts) * 1000)
        else:
            frame_age_ms_attempt = 0
        # WARNING: no usable frame is a stream-side regression worth
        # the higher log level. Same key set as the success log line
        # below so an operator's grep matches both shapes.
        # H1 · last_validator_reason carries the gate that flagged the
        # most-recent rejected frame — single source for the stage-1
        # diagnostic. Empty string on "no_frame" / "stale" branches
        # because no frame ever reached the validator in those cases.
        log.warning(
            "[test-detection] cam=%s outcome=%s waited=%.2fs retries=%d "
            "frame_age_ms=%d frame_src=- raw=0 pass=0 belowthresh=0 "
            "filtered=0 inference_ms=0 top_raw=[] "
            "validator_reason=%r profile=%s",
            cam_id,
            code,
            waited_s,
            retries,
            frame_age_ms_attempt,
            last_validator_reason or "-",
            (active_profile.name if active_profile else "-"),
        )
        return jsonify(
            {
                "ok": False,
                "error": msg,
                "code": code,
                "frame_age_ms": frame_age_ms_attempt,
                # H1 · expose the validator reason so the in-modal Diagnose
                # panel can render "frames rejected by horizontal_anomaly
                # _band" instead of just "corrupt frames".
                "validator_reason": last_validator_reason or None,
                "validator_profile": (active_profile.name if active_profile else None),
            }
        ), 503
    frame_age_ms = int((_time.time() - frame_ts_accepted) * 1000)
    # rt.frame is written by camera_runtime/_main_loop on every successful
    # MAIN stream grab (RTSP main URL via cv2.VideoCapture). The sub-stream
    # never touches it — so frame_src is always 'main' here. We capture the
    # resolution explicitly so the operator-visible diag panel can flag a
    # mis-routed sub-stream as soon as one is introduced.
    src_h_raw, src_w_raw = frame.shape[:2]
    frame_src_label = f"main {src_w_raw}×{src_h_raw}"
    detector = getattr(rt, "detector", None)
    if not detector or not getattr(detector, "available", False):
        # WARNING level: a Coral-disabled test request is almost always
        # a config bug worth surfacing in docker logs even when the
        # frontend already shows a "Coral nicht verfügbar" banner.
        log.warning(
            "[test-detection] cam=%s outcome=coral_unavailable waited=%.2fs "
            "retries=%d frame_age_ms=%d frame_src=%s raw=0 pass=0 "
            "belowthresh=0 filtered=0 top_raw=[]",
            cam_id,
            waited_s,
            retries,
            frame_age_ms,
            frame_src_label,
        )
        return jsonify({"error": "Coral nicht verfügbar (motion-only?)"}), 503
    inference_t0 = _time.monotonic()
    try:
        raw = detector.detect_frame_raw(frame, threshold=0.20)
    except Exception as e:
        log.warning("[test-detection] %s inference failed: %s", cam_id, e)
        return jsonify({"error": f"Inference fehlgeschlagen: {e}"}), 500
    inference_ms = int(round((_time.monotonic() - inference_t0) * 1000))
    # Resolve the global confidence floor — empty/zero on the camera
    # means "use the global processing.detection.min_score". This must
    # match what camera_runtime actually applies at runtime so the
    # simulation result reflects what would happen in production.
    global_floor = float(cam.get("detection_min_score") or 0.0)
    if global_floor <= 0:
        proc = app_state.get_effective_config().get("processing") or {}
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
        out.append(
            {
                "label": d.label,
                "score": round(float(d.score), 4),
                "bbox": [int(x1), int(y1), int(max(0, x2 - x1)), int(max(0, y2 - y1))],
                "verdict": verdict,
                "reason": reason,
            }
        )
    out.sort(key=lambda r: r["score"], reverse=True)
    # ``?no_snapshot=1`` — Simulieren v2 (kr493): frontend drives the
    # video via the continuous MJPEG stream and only needs the bbox
    # payload + frame dimensions here. Skipping the resize + base64
    # encode cuts the response from ~106 kB to ~1 kB AND eliminates
    # the cv2.imencode + base64 cost (which on a 1080p frame is the
    # dominant time budget after Coral inference itself). Bbox coords
    # stay in SOURCE pixel space so the SVG viewBox math still lines
    # up against the live MJPEG.
    src_h, src_w = frame.shape[:2]
    skip_snapshot = (request.args.get("no_snapshot") or "").strip() in ("1", "true", "yes")
    snap_scale = 1.0
    snap_w, snap_h = src_w, src_h
    snapshot = None
    if not skip_snapshot:
        # ── Downscale the snapshot to ≤960 px wide ────────────────────
        # Inference already ran on the full-resolution frame (above).
        # What the frontend renders inside the panel is only the JPEG
        # that lives in the base64 data URL — a 1920×1080 snapshot at
        # 1 Hz turns iOS Safari into molasses without any actual stream
        # problem. Bbox coordinates land in the same coordinate space
        # as the encoded JPEG (frame_size), so the SVG viewBox lines
        # up regardless of the source resolution. Quality 65 +
        # JPEG-OPTIMIZE gives a progressive render that iOS paints
        # incrementally.
        target_w = 960
        if src_w > target_w:
            snap_scale = target_w / float(src_w)
            snap_w = target_w
            snap_h = max(2, int(round(src_h * snap_scale)) // 2 * 2)
            snap_frame = cv2.resize(frame, (snap_w, snap_h), interpolation=cv2.INTER_AREA)
        else:
            snap_frame = frame
        # Rewrite bbox coords into the downscaled space when we
        # actually resized. Skip the multiplication entirely on the
        # no-op path so rounding never nudges an integer bbox off the
        # source frame.
        if snap_scale != 1.0:
            for d in out:
                x, y, w_box, h_box = d["bbox"]
                d["bbox"] = [
                    int(round(x * snap_scale)),
                    int(round(y * snap_scale)),
                    int(round(w_box * snap_scale)),
                    int(round(h_box * snap_scale)),
                ]
        try:
            import base64

            ok, jpg = cv2.imencode(
                ".jpg",
                snap_frame,
                [
                    int(cv2.IMWRITE_JPEG_QUALITY),
                    65,
                    int(cv2.IMWRITE_JPEG_OPTIMIZE),
                    1,
                ],
            )
            snapshot = (
                f"data:image/jpeg;base64,{base64.b64encode(jpg.tobytes()).decode()}" if ok else None
            )
        except Exception as e:
            log.warning("[test-detection] %s encode failed: %s", cam_id, e)
            snapshot = None
    # Frontend uses these dims to size the SVG viewBox; must match the
    # bbox + snapshot coordinate space, not the source resolution.
    w, h = snap_w, snap_h
    # ── Decision trace ──────────────────────────────────────────
    # Walk every gate from capture → telegram and record a one-line
    # human-readable verdict for each. The frontend renders this list
    # verbatim in a green-on-black terminal block so the user can iterate
    # on settings without grepping container logs. We evaluate the
    # downstream gates (matrix / armed / schedule_notify / cooldown)
    # even when nothing passed — "what WOULD have happened if a hit
    # passed" is often the actual debugging question.
    from ..event_logic import compute_severity_from_matrix, is_schedule_window_active

    trace: list[str] = []
    trace.append(
        f"[capture] frame {w}×{h} · age {frame_age_ms} ms · "
        f"interval ≤{cam.get('frame_interval_ms', 350)} ms"
    )
    trace.append(
        f"[coral] threshold floor {global_floor:.2f} · per-class: "
        f"{dict(per_class) if per_class else '(none)'}"
    )
    trace.append(
        f"[coral] object_filter: {sorted(obj_filter) if obj_filter else '(none — all classes accepted)'}"
    )
    trace.append(f"[coral] raw detections: {len(raw)}")
    for d in out:
        pct = int(round(d["score"] * 100))
        if d["verdict"] == "pass":
            trace.append(f"[det] {d['label']} {pct}% → PASS (above class threshold)")
        elif d["verdict"] == "belowthresh":
            trace.append(f"[det] {d['label']} {pct}% → REJECTED ({d['reason']})")
        elif d["verdict"] == "filtered":
            trace.append(f"[det] {d['label']} {pct}% → FILTERED ({d['reason']})")
    pass_dets = [d for d in out if d["verdict"] == "pass"]
    if not pass_dets:
        trace.append(
            "[verdict] no detection survived the threshold/filter gates · alarm pipeline NOT triggered"
        )
    class_sev_cfg = cam.get("class_severity") or {}
    trace.append(
        f"[matrix] class_severity: "
        f"{class_sev_cfg if class_sev_cfg else '(empty — falling back to legacy alarm_profile)'}"
    )
    severity = "—"
    if pass_dets:
        labels_pass = sorted({d["label"] for d in pass_dets})
        if class_sev_cfg:
            severity = compute_severity_from_matrix(class_sev_cfg, labels_pass)
        else:
            severity = "alarm"
        trace.append(f"[matrix] resolved severity for {labels_pass}: {severity}")
    trace.append(f"[armed] camera armed={bool(cam.get('armed', True))}")
    trace.append(
        f"[telegram_enabled] cam.telegram_enabled={bool(cam.get('telegram_enabled', True))}"
    )
    sch_notify = cam.get("schedule_notify") or {}
    if sch_notify:
        try:
            active_now = is_schedule_window_active(sch_notify)
        except Exception as e:
            active_now = f"(eval failed: {e})"
        trace.append(
            f"[schedule_notify] enabled={bool(sch_notify.get('enabled', False))} "
            f"window={sch_notify.get('from','?')}→{sch_notify.get('to','?')} · active_now={active_now}"
        )
    else:
        trace.append("[schedule_notify] (none — falling back to legacy schedule)")
    # Cooldown peek — best-effort. Mirrors the keying + lookup in
    # telegram_bot/_outbound.py so the trace matches what would actually
    # happen at notify-time. Swallows any structural drift between the
    # notifier internals and this read-only inspection.
    notifier = getattr(app_state, "telegram_service", None)
    try:
        if notifier is not None and pass_dets:
            top_label = pass_dets[0]["label"]
            key = (cam_id, top_label)
            last_mono = getattr(notifier, "_last_notify", {}).get(key, 0.0)
            cd_cfg = cam.get("notification_cooldown") or {}
            cd_seconds = int(cd_cfg.get(top_label, 60))
            if last_mono:
                import time as _t

                elapsed = _t.monotonic() - last_mono
                if elapsed < cd_seconds:
                    trace.append(
                        f"[cooldown] {top_label}@{cam_id}: last push {int(elapsed)}s ago · "
                        f"{int(cd_seconds - elapsed)}s remaining → would SKIP"
                    )
                else:
                    trace.append(
                        f"[cooldown] {top_label}@{cam_id}: idle (last {int(elapsed)}s ago, "
                        f"threshold {cd_seconds}s) → would PASS"
                    )
            else:
                trace.append(f"[cooldown] {top_label}@{cam_id}: never pushed → would PASS")
    except Exception as e:
        trace.append(f"[cooldown] lookup failed: {e}")
    if not pass_dets:
        trace.append("[final] no push (no detection passed)")
    else:
        trace.append(
            f"[final] {len(pass_dets)} detection(s) would route through the push pipeline "
            f"(subject to gates above)"
        )
    # C2 · freshness + gate-count log line. The operator can grep
    # `[test-detection]` to confirm rt.frame is advancing AND see at a
    # glance which gate dropped detections on this tick.
    #   raw          — count of detections Coral returned at threshold 0.20
    #   pass         — count that survived per-class threshold + object_filter
    #   belowthresh  — count rejected by per-class / global threshold
    #   filtered     — count dropped by object_filter
    #   top_raw      — up to 3 highest-scoring raw hits (label, pct),
    #                  including the ones that ended up filtered. With
    #                  raw=0 the field collapses to [] — that single
    #                  data point answers the "Coral returned nothing
    #                  for this frame" question without DevTools.
    # WARNING level when raw=0 OR outcome != ok so a regression
    # surfaces in docker logs without --tail digging.
    belowthresh_n = sum(1 for d in out if d["verdict"] == "belowthresh")
    filtered_n = sum(1 for d in out if d["verdict"] == "filtered")
    top_raw_pairs = [(d["label"], int(round(d["score"] * 100))) for d in out[:3]]
    top_raw_str = "[" + ", ".join(f"({lab},{pct}%)" for lab, pct in top_raw_pairs) + "]"
    log_fn = log.info if (final_outcome == "ok" and len(raw) > 0) else log.warning
    # H1 · object_filter + global_floor surfaced in the log so the
    # Stage 3 case (raw>0 but filter eats everything → pass=0
    # filtered=raw) is identifiable from the same line. The filter
    # is a set; format as a sorted list for grep stability. An empty
    # filter prints as "[]" and means "all classes accepted".
    _obj_filter_str = "[" + ",".join(sorted(obj_filter)) + "]"
    log_fn(
        "[test-detection] cam=%s outcome=%s waited=%.2fs retries=%d "
        "frame_age_ms=%d frame_src=%s raw=%d pass=%d belowthresh=%d "
        "filtered=%d inference_ms=%d top_raw=%s "
        "obj_filter=%s min_score=%.2f profile=%s",
        cam_id,
        final_outcome,
        waited_s,
        retries,
        frame_age_ms,
        frame_src_label,
        len(raw),
        len(pass_dets),
        belowthresh_n,
        filtered_n,
        inference_ms,
        top_raw_str,
        _obj_filter_str,
        float(global_floor),
        (active_profile.name if active_profile else "-"),
    )
    # ── Decoder-backlog heuristic ────────────────────────────────────
    # The runtime tracks an EMA of the wall-clock interval between
    # successive frame_ts writes. If that average is well below the
    # camera's CONFIGURED frame_interval_ms (≤ 0.4×) the decoder is
    # almost certainly draining a buffered burst at us faster than the
    # camera actually emits frames — i.e. "vor 0.2 s" would be true
    # for "when we decoded it" but lying about "when the camera shot
    # it". 0.4 chosen so a normally-cadenced stream (e.g. 350 ms config
    # with a slightly fast 280 ms EMA) doesn't false-positive but a
    # genuine 5–10× burst does. interval_ms taken from the saved cam
    # config so the threshold tracks user intent, not autodetected
    # fps that may be skewed by the same backlog.
    interval_ms = int(cam.get("frame_interval_ms", 350) or 350)
    ema_ms = float(getattr(rt, "_frame_interval_ema_ms", 0.0) or 0.0)
    backlog = ema_ms > 0 and interval_ms > 0 and ema_ms < 0.4 * interval_ms
    # C3 · diagnostic payload for the in-modal panel. Structured so
    # the frontend doesn't have to re-derive counts from `detections`
    # (and so future regression hunts have one canonical shape to
    # read against). All values either appear in the WARNING log
    # line above or extend it (per_class thresholds, inference_ms).
    diag = {
        "frame_src": "main",
        "frame_size": {"w": int(src_w_raw), "h": int(src_h_raw)},
        "frame_age_ms": int(frame_age_ms),
        "coral_available": bool(getattr(detector, "available", False)),
        "inference_ms": int(inference_ms),
        "gates": {
            "raw": int(len(raw)),
            "pass": int(len(pass_dets)),
            "belowthresh": int(belowthresh_n),
            "filtered": int(filtered_n),
        },
        "top_raw": [{"label": d["label"], "score": d["score"]} for d in out[:3]],
        "thresholds": {
            "global": round(float(global_floor), 3),
            "per_class": dict(per_class) if per_class else {},
        },
        # H1 · Stage 3 visibility — surface the object_filter the
        # endpoint actually applies so the in-modal Diagnose panel can
        # render "Filter aktiv: [person, cat]" or "(keine Klassen-
        # filter — alle passieren)" and the user spots a stale empty-
        # filter regression without DevTools.
        "object_filter": sorted(obj_filter) if obj_filter else [],
        # H1 · validator profile + (when validation rejected during
        # the wait loop) the last rejection reason. On the success
        # path this is empty; on a corrupt-outcome 503 it carries
        # the single most-informative diagnostic.
        "validator_profile": (active_profile.name if active_profile else None),
        "validator_reason": last_validator_reason or None,
    }
    return jsonify(
        {
            "ok": True,
            "snapshot": snapshot,
            "frame_size": {"w": int(w), "h": int(h)},
            "frame_age_ms": frame_age_ms,
            "detections": out,
            "decision_trace": trace,
            "diag": diag,
            "frame_interval_avg_ms": int(round(ema_ms)) if ema_ms > 0 else 0,
            "decoder_backlog_suspected": bool(backlog),
        }
    )

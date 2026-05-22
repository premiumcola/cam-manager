"""Per-mode pipeline helpers for /api/coral/test-batch.

Extracted from routes/coral.py during R04. Each `run_mode_*` helper is a
pure function that takes the live classifiers + counters dict and
returns the mode-shaped tuple. The route shell composes them with
shared image-loop bookkeeping (folder iteration, error rows, summary).

Counters dict shape:

    {
        "by_label": {label: count},   # owned by the route shell
        "species":  {species: count},  # mutated by cascade / bird_only / all_independent
        "wildlife": {label: count},    # mutated by wildlife_only / all_independent
    }

Per-mode return tuple:

    (tagged, wildlife_info, stages_run, coco_inference_ms)

    tagged              list[(Detection, source_model_str)]
    wildlife_info       dict | None  (cascade / wildlife / all_indep populate it)
    stages_run          list[str]    (in append order)
    coco_inference_ms   float        (0.0 for modes that don't run COCO)

The COCO inference call lives inside helpers that need it (cascade,
coco_only, all_independent). Failures propagate; the route shell
catches and emits the legacy error row.
"""

from __future__ import annotations

import base64
import time
from pathlib import Path

import cv2

from ..detectors import (
    BirdSpeciesClassifier,
    CoralObjectDetector,
    Detection,
    WildlifeClassifier,
)
from ._coral_helpers import _nickname_tflite

# ── Mode + folder constants ────────────────────────────────────────────────
ALLOWED_MODES = (
    "cascade",
    "coco_only",
    "bird_species_only",
    "wildlife_only",
    "all_independent",
)
COCO_MODES = {"cascade", "coco_only", "all_independent"}
WILDLIFE_FOLDERS = {"fox", "hedgehog", "squirrel"}
BIRD_FORCE_MODES = {"bird_species_only", "all_independent"}
WL_FORCE_MODES = {"wildlife_only", "all_independent"}


# ── Build phase ────────────────────────────────────────────────────────────
def build_classifiers_for_mode(mode, det_cfg, bird_cfg, wl_cfg, needs_wildlife):
    """Build the three classifier instances based on the requested mode.

    Returns ``(detector, bird_clf, wl_clf, wildlife_disabled_warning)``
    where any of the classifier slots may be ``None``. The warning
    string is non-None only when the user is testing a wildlife folder
    while ``wildlife.enabled`` is False — surfaced to the response so
    the UI can explain a 0-detection result instead of looking broken.
    """
    detector = CoralObjectDetector(det_cfg)
    bird_force = mode in BIRD_FORCE_MODES
    wl_force = mode in WL_FORCE_MODES

    if bird_force or bird_cfg.get("enabled"):
        bird_eff = dict(bird_cfg)
        if bird_force:
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
    wildlife_settings_enabled = bool(wl_cfg.get("enabled"))
    wl_clf = None
    if wl_force or wildlife_settings_enabled or needs_wildlife:
        wl_cfg_eff = dict(wl_cfg)
        wl_cfg_eff["enabled"] = True
        wl_clf = WildlifeClassifier(wl_cfg_eff)

    wildlife_disabled_warning = (
        "Wildlife-Erkennung ist deaktiviert — Eichhörnchen/Fuchs/Igel werden nicht erkannt. "
        "In Einstellungen aktivieren."
        if (needs_wildlife and not wildlife_settings_enabled)
        else None
    )
    return detector, bird_clf, wl_clf, wildlife_disabled_warning


def resolve_candidate_dirs(storage_root, folder_filter):
    """Resolve the list of folder paths to scan. Returns
    ``(candidate_dirs, error_payload)``; ``error_payload`` is None on
    success, otherwise a dict suitable for ``jsonify(...)`` with a 404.
    """
    base = storage_root / "test_images"
    if not base.exists():
        return None, {
            "ok": False,
            "error": "test_images directory not found",
            "expected_at": str(base),
            "results": [],
        }
    if folder_filter:
        candidate_dirs = [base / folder_filter]
    else:
        candidate_dirs = sorted(
            d for d in base.iterdir() if d.is_dir() and not d.name.startswith("_")
        )
    return candidate_dirs, None


# ── Full-frame classifier helpers ──────────────────────────────────────────
def classify_bird_full(frame, bird_clf):
    """Run the bird classifier on the full frame; return Detection
    or None. Used by bird_species_only and all_independent modes."""
    if not (bird_clf and bird_clf.available):
        return None
    try:
        sp, sp_latin, sp_score = bird_clf.classify_crop(frame)
    except Exception:
        return None
    if not sp:
        return None
    fh2, fw2 = frame.shape[:2]
    return Detection(
        label="bird",
        score=float(sp_score) if sp_score is not None else 0.5,
        bbox=(0, 0, int(fw2), int(fh2)),
        raw_cls_id=-1,
        species=sp,
        species_latin=sp_latin,
        species_score=float(sp_score) if sp_score is not None else None,
    )


def classify_wildlife_full(frame, wl_clf):
    """Run the wildlife classifier on the full frame; return
    (Detection|None, info_dict|None). Ungated — no folder check, no
    cat→squirrel override, no overlap suppression. Used by
    wildlife_only and all_independent."""
    if not (wl_clf and wl_clf.available):
        return None, None
    try:
        cat, raw_lbl, wscore = wl_clf.classify_crop(frame)
    except Exception:
        return None, None
    fh2, fw2 = frame.shape[:2]
    full_bbox = (0, 0, int(fw2), int(fh2))
    det = None
    if cat or raw_lbl:
        det = Detection(
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


# ── Run-mode helpers ───────────────────────────────────────────────────────
def run_mode_cascade(frame, detector, bird_clf, wl_clf, folder_name, counters):
    """Existing cascade flow — preserved byte-for-byte except for the
    new source_model tagging:
      COCO → bird-classify each bird crop → folder-gated wildlife pass
      with cat→squirrel override + overlap suppression.
    Mutates counters["species"] / counters["wildlife"]."""
    stages_run: list[str] = []
    tagged: list[tuple] = []
    wildlife_info = None

    t0 = time.perf_counter()
    coco_dets = detector.detect_frame(frame)
    ms = round((time.perf_counter() - t0) * 1000, 1)
    stages_run.append("detector")

    dets = list(coco_dets)
    species_counts = counters["species"]
    wildlife_counts = counters["wildlife"]
    # Species classification on each bird crop when the classifier is on
    if dets and bird_clf is not None and bird_clf.available:
        hh, ww = frame.shape[:2]
        for dd in dets:
            if dd.label != "bird":
                continue
            x1, y1, x2, y2 = dd.bbox
            pad = 6
            cx1 = max(0, x1 - pad)
            cy1 = max(0, y1 - pad)
            cx2 = min(ww, x2 + pad)
            cy2 = min(hh, y2 + pad)
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
    if wl_clf is not None and wl_clf.available and folder_name in WILDLIFE_FOLDERS:
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
                    dd
                    for dd in dets
                    if not (dd.label in _DROP and _iou(tuple(dd.bbox), refined_bbox) >= 0.3)
                ]
            promoted_bbox = refined_bbox if refined_bbox is not None else (0, 0, int(fw), int(fh))
            # Promoted wildlife hit gets a "wildlife" tag.
            tagged.append(
                (
                    Detection(
                        label=cat,
                        score=float(wscore) if wscore is not None else 0.5,
                        bbox=promoted_bbox,
                        raw_cls_id=-1,
                        species=raw_lbl,
                        species_latin=None,
                        species_score=float(wscore) if wscore is not None else None,
                    ),
                    "wildlife",
                )
            )
        if raw_lbl is not None:
            wildlife_info = {
                "label": cat,
                "imagenet": raw_lbl,
                "score": round(float(wscore), 3) if wscore is not None else None,
                "bbox": list(refined_bbox)
                if refined_bbox is not None
                else [0, 0, int(fw), int(fh)],
            }
            if cat:
                wildlife_counts[cat] = wildlife_counts.get(cat, 0) + 1
        stages_run.append("wildlife_classifier")
    # Surviving COCO detections come first so the response order
    # matches the legacy cascade ordering exactly.
    tagged = [(dd, "coco") for dd in dets] + tagged
    return tagged, wildlife_info, stages_run, ms


def run_mode_coco_only(frame, detector):
    """Bare COCO detection. No second-stage classifiers."""
    stages_run: list[str] = []
    t0 = time.perf_counter()
    coco_dets = detector.detect_frame(frame)
    ms = round((time.perf_counter() - t0) * 1000, 1)
    stages_run.append("detector")
    tagged = [(dd, "coco") for dd in coco_dets]
    return tagged, None, stages_run, ms


def run_mode_bird_only(frame, bird_clf, counters):
    """Bird classifier on the full frame — no COCO call. Mutates
    counters["species"]."""
    stages_run: list[str] = []
    tagged: list[tuple] = []
    species_counts = counters["species"]
    bird_det = classify_bird_full(frame, bird_clf)
    if bird_det is not None:
        tagged.append((bird_det, "bird_species"))
        if bird_det.species:
            species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
        stages_run.append("bird_classifier_full")
    return tagged, None, stages_run, 0.0


def run_mode_wildlife_only(frame, wl_clf, counters):
    """Wildlife classifier on the full frame — no COCO call, no
    cat→squirrel override, no overlap suppression. Mutates
    counters["wildlife"]."""
    stages_run: list[str] = []
    tagged: list[tuple] = []
    wildlife_counts = counters["wildlife"]
    wl_det, wl_info = classify_wildlife_full(frame, wl_clf)
    if wl_det is not None:
        tagged.append((wl_det, "wildlife"))
        if wl_det.label and wl_det.label != "?":
            wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
        stages_run.append("wildlife_classifier_full")
    return tagged, wl_info, stages_run, 0.0


def run_mode_all_independent(frame, detector, bird_clf, wl_clf, counters):
    """COCO + bird-on-full-frame + wildlife-on-full-frame. No
    suppression, no overrides — the whole point is to see the raw,
    independent verdict from each model. Mutates counters["species"]
    and counters["wildlife"]."""
    stages_run: list[str] = []
    species_counts = counters["species"]
    wildlife_counts = counters["wildlife"]

    t0 = time.perf_counter()
    coco_dets = detector.detect_frame(frame)
    ms = round((time.perf_counter() - t0) * 1000, 1)
    stages_run.append("detector")

    # COCO entries come first, in their natural detector order.
    tagged: list[tuple] = [(dd, "coco") for dd in coco_dets]
    # Bird classifier on full frame, ungated.
    bird_det = classify_bird_full(frame, bird_clf)
    if bird_det is not None:
        tagged.append((bird_det, "bird_species"))
        if bird_det.species:
            species_counts[bird_det.species] = species_counts.get(bird_det.species, 0) + 1
        stages_run.append("bird_classifier_full")
    # Wildlife on full frame, ungated. NO suppression, NO
    # cat→squirrel override — the whole point is to see the
    # raw, independent verdict from each model.
    wl_det, wl_info = classify_wildlife_full(frame, wl_clf)
    if wl_det is not None:
        tagged.append((wl_det, "wildlife"))
        if wl_det.label and wl_det.label != "?":
            wildlife_counts[wl_det.label] = wildlife_counts.get(wl_det.label, 0) + 1
        stages_run.append("wildlife_classifier_full")
    return tagged, wl_info, stages_run, ms


# ── Serialisation ──────────────────────────────────────────────────────────
def serialise_image_b64(frame, max_w=480):
    """Encode the RAW frame for transport — bbox overlays are drawn
    client-side onto a <canvas> so the user sees both COCO and wildlife
    rectangles with the colour scheme the UI controls. Returns the
    data-URL string (or None on encode failure) plus the ORIGINAL (w, h)
    so the client can rescale bbox coords to the canvas surface."""
    orig_h, orig_w = frame.shape[:2]
    transport = frame
    if orig_w > max_w:
        scale = max_w / orig_w
        transport = cv2.resize(frame, (max_w, int(orig_h * scale)))
    ok, buf = cv2.imencode('.jpg', transport, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    image_b64 = (
        ("data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode('ascii'))
        if ok
        else None
    )
    return image_b64, int(orig_w), int(orig_h)


def serialise_result_row(
    folder_name, filename, ms, image_b64, orig_w, orig_h, stages_run, tagged, wildlife_info
):
    """Render the per-image result dict that the test-panel UI consumes."""
    return {
        "folder": folder_name,
        "filename": filename,
        "inference_ms": ms,
        "image_b64": image_b64,
        "image_w": int(orig_w),
        "image_h": int(orig_h),
        "stages_run": stages_run,
        "detections": [
            {
                "label": dd.label,
                "score": round(float(dd.score), 3),
                "bbox": list(dd.bbox),
                "raw_cls_id": int(dd.raw_cls_id),
                "species": dd.species,
                "species_latin": dd.species_latin,
                "species_score": round(float(dd.species_score), 3)
                if dd.species_score is not None
                else None,
                "source_model": src,
            }
            for (dd, src) in tagged
        ],
        "wildlife": wildlife_info,
    }


def build_models_active(detector, bird_clf, wl_clf, det_cfg, bird_cfg, wl_cfg):
    """Per-model availability badges for the UI's status strip.
    Nicknames come from `_nickname_tflite` so the test panel can render
    short pill-friendly labels rather than the raw filenames."""

    def _card(cfg, clf, default_reason):
        fname = Path((cfg or {}).get("model_path") or "").name
        return {
            "nickname": _nickname_tflite(fname),
            "available": bool(clf and clf.available),
            "reason": (clf.reason if clf else default_reason) or "ok",
        }

    return {
        "coco": _card(det_cfg, detector, "disabled"),
        "bird_species": _card(bird_cfg, bird_clf, "disabled"),
        "wildlife": _card(wl_cfg, wl_clf, "disabled"),
    }

from __future__ import annotations

# ruff: noqa: F401
# Comprehensive import block — some symbols are unused in this mixin
# but kept for parity so methods can be moved between mixins without
# import bookkeeping. Trim later if a mixin grows enough to warrant it.
import json as _json_mod
import logging
import shutil as _shutil
import subprocess as _subprocess
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
import requests

from ..detection_confirmer import DetectionConfirmer
from ..detectors import (
    BirdSpeciesClassifier,
    CoralObjectDetector,
    Detection,
    WildlifeClassifier,
    draw_detections,
)
from ..event_logic import (
    choose_alarm_level,
    compute_severity_from_matrix,
    is_schedule_window_active,
    schedule_action_active,
)
from ._consts import (
    _FFMPEG_AVAILABLE,
    _PROFILES,
    _PROFILE_PERIOD_DEFAULTS,
    _SPECIES_TO_ACH_ID,
    _WILDLIFE_BBOX_DONORS,
    _bbox_iou,
    _refine_wildlife_bbox,
    _suppress_overlap,
    log,
    log_cam,
    log_tl,
)


class ZonesMixin:
    """Inclusion/exclusion polygon helpers and detection filters.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def _ensure_mask_image(self, log_summary: bool = False):
        """Build / refresh the binary exclusion-mask image from the camera's
        polygon list. White (255) = active detection area, black (0) = masked
        out. The image is sized 720×1280 — each frame gets resized to match
        at filter time so any frame resolution works. Rebuilds only when the
        mask config signature changes, so the per-frame filter path stays
        cheap."""
        cam_masks = self.cfg.get("masks", []) or []
        # Signature: stable serialisation of all polygons. Compared against
        # the cached signature to decide whether a rebuild is needed.
        try:
            sig = _json_mod.dumps(cam_masks, sort_keys=True, separators=(',', ':'))
        except Exception:
            sig = repr(cam_masks)
        if sig == self._mask_sig:
            return  # no change
        self._mask_sig = sig
        if not cam_masks:
            self._mask_image = None
            if log_summary:
                log.info("[%s] exclusion masks: none", self.camera_id)
            return
        h, w = 720, 1280
        mask = np.ones((h, w), dtype=np.uint8) * 255
        # The pre-baked image is used by motion detection and represents only
        # GLOBAL masks (no `labels` filter). Labeled masks restrict specific
        # object classes and are evaluated per-detection in
        # _filter_masked_detections — they shouldn't suppress motion.
        # pn834 — polygons may carry their own source_w / source_h
        # (recorded by the editor at save time). Scale points into the
        # 1280×720 canvas before fillPoly so a mask drawn against a
        # 640×360 substream snapshot covers the correct area at this
        # canonical resolution. Legacy polygons without source_w/h
        # default to 1280×720 (no scale).
        for poly in cam_masks:
            if isinstance(poly, dict) and poly.get("labels"):
                continue
            pts_list = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts_list, list) or len(pts_list) < 3:
                continue
            src_w = int(poly.get("source_w") or w) if isinstance(poly, dict) else w
            src_h = int(poly.get("source_h") or h) if isinstance(poly, dict) else h
            sx = float(w) / max(1, src_w)
            sy = float(h) / max(1, src_h)
            pts = np.array([[int(p.get('x', 0) * sx), int(p.get('y', 0) * sy)] for p in pts_list], dtype=np.int32)
            pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
            cv2.fillPoly(mask, [pts], 0)
        self._mask_image = mask
        if log_summary:
            total_verts = 0
            for p in cam_masks:
                pts_list = p.get("points", p) if isinstance(p, dict) else p
                if isinstance(pts_list, list):
                    total_verts += len(pts_list)
            log.info("[%s] Loaded %d exclusion masks (%d total vertices)",
                     self.camera_id, len(cam_masks), total_verts)

    def _polys_for_label(self, polys_field: str, label: str | None) -> list:
        """Return the polygons (raw [{x,y},…] lists) that apply to a label.

        A polygon applies when:
          - it has no `labels` array (or empty) → global, applies to every
            label (legacy behaviour), or
          - its `labels` array contains the given label.

        Pure-list legacy polygons ([[{x,y},…], …]) are treated as global.
        """
        cfg_list = self.cfg.get(polys_field) or []
        out: list = []
        for poly in cfg_list:
            pts = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts, list) or len(pts) < 3:
                continue
            labels = (poly.get("labels") if isinstance(poly, dict) else None) or []
            if not labels or (label and label in labels):
                out.append(pts)
        return out

    @staticmethod
    def _point_in_poly(
        cx: int, cy: int, points: list, frame_w: int, frame_h: int,
        source_w: int = 1280, source_h: int = 720,
    ) -> bool:
        """pn834 — polygon points sit in their own source coord space
        (recorded on save as source_w / source_h). Rescale the frame
        centre into that space before the point-in-polygon test so a
        polygon drawn against a 640×360 substream snapshot still
        suppresses detections in a 2560×1440 main-stream frame
        correctly. Legacy polygons without source_w/h fall back to
        the historical 1280×720 default the caller passes here."""
        sx = float(source_w) / max(1, frame_w)
        sy = float(source_h) / max(1, frame_h)
        try:
            arr = np.array([[int(p.get('x', 0)), int(p.get('y', 0))] for p in points], dtype=np.int32)
        except Exception:
            return False
        if len(arr) < 3:
            return False
        return cv2.pointPolygonTest(arr, (float(cx) * sx, float(cy) * sy), False) >= 0

    def _filter_masked_detections(self, frame, detections: list) -> list:
        """Drop detections whose bbox-centre lands inside a masked region.

        Two-stage:
          1. Global masks are pre-baked into _mask_image and tested with a
             single pixel lookup — fast path, applies to every label.
          2. Labeled masks are evaluated per detection so a mask scoped to
             {"person"} only suppresses that label and lets cats/birds
             through the same area.
        """
        if not detections:
            return detections
        self._ensure_mask_image()
        h_f, w_f = frame.shape[:2]
        # Stage 1: global mask via pre-baked image.
        mask_resized = None
        if self._mask_image is not None:
            h_m, w_m = self._mask_image.shape[:2]
            if (h_m, w_m) != (h_f, w_f):
                mask_resized = cv2.resize(self._mask_image, (w_f, h_f), interpolation=cv2.INTER_NEAREST)
            else:
                mask_resized = self._mask_image
        # Pre-collect per-label labeled polygons so we don't re-scan cfg
        # for every detection.
        cam_masks = self.cfg.get("masks") or []
        has_labeled = any(isinstance(m, dict) and m.get("labels") for m in cam_masks)
        kept: list = []
        for d in detections:
            x1, y1, x2, y2 = d.bbox
            cx = max(0, min(w_f - 1, (x1 + x2) // 2))
            cy = max(0, min(h_f - 1, (y1 + y2) // 2))
            if mask_resized is not None and mask_resized[cy, cx] == 0:
                log.debug("[%s] Detection '%s' (%.0f%%) suppressed by global mask at (%d,%d)",
                          self.camera_id, d.label, d.score * 100, cx, cy)
                continue
            if has_labeled:
                # Walk only labeled masks here — globals were handled in
                # stage 1 via the prebaked image.
                dropped = False
                for m in cam_masks:
                    if not (isinstance(m, dict) and m.get("labels")):
                        continue
                    if d.label not in m.get("labels", []):
                        continue
                    pts = m.get("points") or []
                    src_w = int(m.get("source_w") or 1280)
                    src_h = int(m.get("source_h") or 720)
                    if self._point_in_poly(cx, cy, pts, w_f, h_f, src_w, src_h):
                        log.debug("[%s] Detection '%s' (%.0f%%) suppressed by label-mask",
                                  self.camera_id, d.label, d.score * 100)
                        dropped = True
                        break
                if dropped:
                    continue
            kept.append(d)
        return kept

    def _ensure_zone_image(self, log_summary: bool = False):
        """Build / refresh the inclusion-zone image. Inverse logic vs. mask:
        the canvas starts BLACK and each zone polygon is filled with WHITE,
        so a pixel inside any zone is active (detect here). When no zones
        are configured, _zone_image stays None and the whole frame is
        active — behaviour equivalent to "no filter". Rebuilds only when
        the zones config signature changes, so the per-frame path stays
        cheap."""
        cam_zones = self.cfg.get("zones", []) or []
        try:
            sig = _json_mod.dumps(cam_zones, sort_keys=True, separators=(',', ':'))
        except Exception:
            sig = repr(cam_zones)
        if sig == self._zone_sig:
            return
        self._zone_sig = sig
        # Only GLOBAL zones (no `labels` filter) are baked into the motion-
        # suppression image. Labeled zones live alongside, evaluated per-
        # detection in _filter_zoned_detections so each label sees its own
        # inclusion area.
        global_zones = [
            z for z in cam_zones
            if not (isinstance(z, dict) and z.get("labels"))
        ]
        if not global_zones:
            # Even if labeled zones exist, motion detection has no label
            # context — so when no global zones are configured the motion
            # path treats the entire frame as active.
            self._zone_image = None
            if log_summary:
                if cam_zones:
                    log.info("[%s] inclusion zones: %d label-scoped (motion path unrestricted)",
                             self.camera_id, len(cam_zones))
                else:
                    log.info("[%s] inclusion zones: none (entire frame active)", self.camera_id)
            return
        h, w = 720, 1280
        zone = np.zeros((h, w), dtype=np.uint8)  # start all black (inactive)
        # pn834 — same per-polygon source_w/source_h scaling as the
        # mask path above. Polygons without source_w/h fall back to
        # the canvas dimensions (no scale).
        for poly in global_zones:
            pts_list = poly.get("points", poly) if isinstance(poly, dict) else poly
            if not isinstance(pts_list, list) or len(pts_list) < 3:
                continue
            src_w = int(poly.get("source_w") or w) if isinstance(poly, dict) else w
            src_h = int(poly.get("source_h") or h) if isinstance(poly, dict) else h
            sx = float(w) / max(1, src_w)
            sy = float(h) / max(1, src_h)
            pts = np.array([[int(p.get('x', 0) * sx), int(p.get('y', 0) * sy)] for p in pts_list], dtype=np.int32)
            pts[:, 0] = np.clip(pts[:, 0], 0, w - 1)
            pts[:, 1] = np.clip(pts[:, 1], 0, h - 1)
            cv2.fillPoly(zone, [pts], 255)  # white = active zone
        self._zone_image = zone
        if log_summary:
            total_verts = 0
            for p in cam_zones:
                pts_list = p.get("points", p) if isinstance(p, dict) else p
                if isinstance(pts_list, list):
                    total_verts += len(pts_list)
            log.info("[%s] Loaded %d inclusion zones (%d total vertices) — outside zones = ignored",
                     self.camera_id, len(cam_zones), total_verts)

    def _filter_zoned_detections(self, frame, detections: list) -> list:
        """Keep only detections whose bbox-centre lands inside an applicable
        inclusion zone.

        Per-label semantics:
          - If a label has at least one applicable zone (global or its label
            specifically named), the detection MUST be inside one of them.
          - If no zone applies to that label, the detection passes through
            (this lets the user define "person only inside this polygon"
            without restricting cat/bird).
        """
        if not detections:
            return detections
        cam_zones = self.cfg.get("zones") or []
        if not cam_zones:
            return detections  # no zones at all → unrestricted
        self._ensure_zone_image()
        h_f, w_f = frame.shape[:2]
        # Stage 1: prebaked global-zone image. Labels covered by at least
        # one global zone go through this fast path. Cheap pixel lookup.
        zone_resized = None
        if self._zone_image is not None:
            h_z, w_z = self._zone_image.shape[:2]
            if (h_z, w_z) != (h_f, w_f):
                zone_resized = cv2.resize(self._zone_image, (w_f, h_f), interpolation=cv2.INTER_NEAREST)
            else:
                zone_resized = self._zone_image
        # Build the per-label zone list AND a parallel "global zones"
        # list. Both carry full polygon dicts (not just points) so we can
        # extract trigger flags (save_photo/save_video/send_telegram) from
        # the matching zone and tag them onto the surviving detection.
        labeled: dict[str, list] = {}
        global_polys: list = []
        for z in cam_zones:
            if not isinstance(z, dict):
                continue
            pts = z.get("points") or []
            if not isinstance(pts, list) or len(pts) < 3:
                continue
            zlabels = z.get("labels") or []
            if not zlabels:
                global_polys.append(z)
            else:
                for L in zlabels:
                    labeled.setdefault(L, []).append(z)
        kept: list = []
        for d in detections:
            x1, y1, x2, y2 = d.bbox
            cx = max(0, min(w_f - 1, (x1 + x2) // 2))
            cy = max(0, min(h_f - 1, (y1 + y2) // 2))
            global_applies = zone_resized is not None
            label_zones = labeled.get(d.label, [])
            if not global_applies and not label_zones:
                # No zone targets this label at all → pass through freely.
                kept.append(d)
                continue
            matched_zone = None
            # Prefer a label-scoped zone match (more specific) over global.
            for z in label_zones:
                z_sw = int(z.get("source_w") or 1280)
                z_sh = int(z.get("source_h") or 720)
                if self._point_in_poly(cx, cy, z.get("points") or [], w_f, h_f, z_sw, z_sh):
                    matched_zone = z
                    break
            if matched_zone is None and global_applies and zone_resized[cy, cx] > 0:
                # Locate which global polygon contains the point so we can
                # forward its trigger flags. The prebaked image only tells
                # us "yes, inside SOMETHING" — we need the dict for flags.
                for z in global_polys:
                    z_sw = int(z.get("source_w") or 1280)
                    z_sh = int(z.get("source_h") or 720)
                    if self._point_in_poly(cx, cy, z.get("points") or [], w_f, h_f, z_sw, z_sh):
                        matched_zone = z
                        break
            if matched_zone is not None:
                d.zone_flags = {
                    "save_photo":    bool(matched_zone.get("save_photo",    True)),
                    "save_video":    bool(matched_zone.get("save_video",    True)),
                    "send_telegram": bool(matched_zone.get("send_telegram", True)),
                }
                kept.append(d)
            else:
                log.debug("[%s] Detection '%s' (%.0f%%) outside applicable zones at (%d,%d)",
                          self.camera_id, d.label, d.score * 100, cx, cy)
        return kept


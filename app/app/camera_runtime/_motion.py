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


class MotionMixin:
    """Background-subtractor motion detection + event metadata builder.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def _motion_detect(self, frame):
        """Returns (labels: list[str], motion_bbox: tuple|None).
        motion_bbox is (x, y, w, h) bounding rect of all motion combined.
        Applies per-camera exclusion masks and motion_sensitivity threshold.
        Brightness-normalises both frames before diff to suppress cloud/sun transitions."""
        # Per-camera kill-switch — skips all motion work (saves CPU when
        # the camera is in objects-only mode).
        if not self.cfg.get("motion_enabled", True):
            return [], None, False
        proc = self.global_cfg.get("processing", {}).get("motion", {})
        if not proc.get("enabled", True):
            return [], None, False
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur_size = int(proc.get("blur_size", 15))
        if blur_size % 2 == 0:
            blur_size += 1
        gray = cv2.GaussianBlur(gray, (blur_size, blur_size), 0)
        # Reset if frame dimensions changed (e.g. bottom_crop_px config change)
        if self.prev_gray is not None and self.prev_gray.shape != gray.shape:
            self.prev_gray = None
        if self.prev_gray is None:
            self.prev_gray = gray
            return [], None, False
        # Brightness normalisation: scale current frame to match previous mean so that
        # gradual global illumination changes (clouds, day/night) don't produce diff.
        mean_prev = float(np.mean(self.prev_gray))
        mean_curr = float(np.mean(gray))
        if mean_curr > 1:
            scale = mean_prev / mean_curr
            if 0.5 < scale < 2.0:  # only correct moderate shifts; ignore extreme jumps
                gray = np.clip(gray.astype(np.float32) * scale, 0, 255).astype(np.uint8)
        diff = cv2.absdiff(self.prev_gray, gray)
        self.prev_gray = gray
        _, thresh = cv2.threshold(diff, 28, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=2)
        # Apply camera exclusion masks: zero out masked regions. Reuses
        # the cached mask image (_ensure_mask_image() rebuilds only on
        # signature changes) so this stays cheap per frame.
        self._ensure_mask_image()
        if self._mask_image is not None:
            h_t, w_t = thresh.shape[:2]
            if self._mask_image.shape[:2] != (h_t, w_t):
                mask_resized = cv2.resize(self._mask_image, (w_t, h_t), interpolation=cv2.INTER_NEAREST)
            else:
                mask_resized = self._mask_image
            thresh = cv2.bitwise_and(thresh, mask_resized)
        # Apply inclusion zones — keep only motion that happens inside at
        # least one zone. The cached _zone_image is None when no zones are
        # configured, in which case this is a no-op.
        self._ensure_zone_image()
        if self._zone_image is not None:
            h_t, w_t = thresh.shape[:2]
            if self._zone_image.shape[:2] != (h_t, w_t):
                zone_resized = cv2.resize(self._zone_image, (w_t, h_t), interpolation=cv2.INTER_NEAREST)
            else:
                zone_resized = self._zone_image
            thresh = cv2.bitwise_and(thresh, zone_resized)
        # Per-camera sensitivity → scales minimum contour area
        sensitivity = self.cfg.get("motion_sensitivity")
        h_f, w_f = frame.shape[:2]
        frame_area = h_f * w_f
        base_min_area = frame_area * 0.005
        if sensitivity is not None:
            sensitivity = float(sensitivity)
            min_area = int(base_min_area / max(0.1, sensitivity))
        else:
            min_area = int(proc.get("min_area", 3000))
        # Wildlife uses a parallel, more sensitive threshold so small animals
        # (squirrel/fox/hedgehog) can wake the wildlife classifier even when
        # the normal motion gate doesn't fire. 0.0 = "auto" → 1.4× the normal
        # sensitivity, capped at 1.0.
        wl_sens = self.cfg.get("wildlife_motion_sensitivity")
        if wl_sens is None or float(wl_sens) <= 0.0:
            base_sens = float(sensitivity) if sensitivity is not None else 0.5
            wl_sens = min(1.0, base_sens * 1.4)
        else:
            wl_sens = float(wl_sens)
        wl_min_area = int(base_min_area / max(0.1, wl_sens))
        # Minimum changed-pixel count: a global brightness shift produces many small
        # changed pixels but no large contour. We use a 0.5% floor (down from 1%)
        # so a single squirrel/fox can still trigger the wildlife threshold —
        # the actual per-contour size check below remains the primary filter
        # for real motion vs. noise.
        h_f2, w_f2 = thresh.shape[:2]
        if int(np.sum(thresh > 0)) < int(h_f2 * w_f2 * 0.005):
            return [], None, False
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        # Two parallel checks against the same contour set — cheap.
        big_normal = [c for c in contours if cv2.contourArea(c) >= min_area]
        big_wl     = [c for c in contours if cv2.contourArea(c) >= wl_min_area]
        wildlife_motion_low = bool(big_wl) and not big_normal
        if not big_normal:
            # Normal motion didn't trigger — but tell the caller whether the
            # lower wildlife threshold did so the wildlife stage can still
            # run. No labels/bbox returned in this case (no event).
            return [], None, wildlife_motion_low
        all_pts = np.concatenate(big_normal)
        bbox = cv2.boundingRect(all_pts)
        return ["motion"], bbox, wildlife_motion_low

    def _crop(self, frame, bbox):
        x1, y1, x2, y2 = bbox
        return frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]

    def _build_event_meta(self, ts: datetime, labels: list, detections: list,
                          drawn_frame, effective_bbox) -> dict:
        """Snapshot of all event metadata at the moment motion recording starts."""
        event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
        top_det = max(detections, key=lambda d: d.score, default=None)
        cat_match = next((d.identity for d in detections if d.label == "cat" and d.identity), None)
        person_match = next((d.identity for d in detections if d.label == "person" and d.identity), None)
        bird_species = next((d.species for d in detections if d.label == "bird" and d.species), None)
        sched = self.cfg.get("schedule") or {}
        # "Hart-Modus" — when active, person → alarm regardless of profile.
        # When the schedule is disabled this is treated as 24/7 active so a
        # user with no schedule still gets the historic person→alarm
        # promotion via choose_alarm_level's profile rules.
        hard_active = schedule_action_active(sched, "hard")
        whitelisted = bool(person_match and (person_match in (self.cfg.get("whitelist_names") or [])))
        if self.person_registry and person_match:
            p = self.person_registry.get_profile(person_match) or {}
            whitelisted = whitelisted or bool(p.get("whitelisted"))
        profile = (self.cfg.get("alarm_profile") or "").strip() or "soft"
        level, notify = choose_alarm_level(profile, list(sorted(set(labels))), hard_active, whitelisted)
        # Per-class severity matrix — new source of truth. When the
        # camera carries a non-empty class_severity dict, the matrix
        # overrides the legacy alarm_profile-derived notify decision:
        # severity=alarm/info → notify=True (route to push), severity=
        # off → notify=False (skip). Whitelisted detections still
        # short-circuit notification regardless of severity.
        class_severity_cfg = self.cfg.get("class_severity") or {}
        if class_severity_cfg and not whitelisted:
            severity = compute_severity_from_matrix(
                class_severity_cfg, list(sorted(set(labels))),
            )
            notify = (severity != "off")
        else:
            # Fall back to deriving severity from the legacy decision so
            # downstream consumers (telegram_bot silent kwarg, MQTT
            # event payload) always have a value to read.
            severity = "alarm" if level == "alarm" else ("info" if notify else "off")
        # "Stumm" kill-switch: armed=false suppresses all Telegram alerts
        # but keeps the event recording and archive path intact.
        if not self.cfg.get("armed", True):
            notify = False
        # Encode thumbnail for Telegram (in memory, never written as JPEG to disk)
        thumb_bytes = None
        if drawn_frame is not None:
            save_thumb = drawn_frame.copy()
            if effective_bbox is not None:
                mx, my, mw, mh = effective_bbox
                cv2.rectangle(save_thumb, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2)
            h_px, w_px = save_thumb.shape[:2]
            if w_px > 1280:
                scale = 1280 / w_px
                save_thumb = cv2.resize(save_thumb, (1280, int(h_px * scale)), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode('.jpg', save_thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                thumb_bytes = buf.tobytes()
        # Aggregate per-zone trigger flags across all surviving detections.
        # OR-rule: if ANY detection sits in a zone that allows snapshot/
        # video/telegram, the event keeps that channel on. A detection
        # without zone_flags (no zones configured, or motion-only event)
        # contributes True for all three — preserves legacy behaviour.
        ev_save_photo = False
        ev_save_video = False
        ev_send_tg    = False
        any_with_flags = False
        for d in detections:
            f = getattr(d, "zone_flags", None)
            if f is None:
                ev_save_photo = ev_save_video = ev_send_tg = True
            else:
                any_with_flags = True
                if f.get("save_photo",    True): ev_save_photo = True
                if f.get("save_video",    True): ev_save_video = True
                if f.get("send_telegram", True): ev_send_tg    = True
        if not any_with_flags and not detections:
            # Motion-only event: keep legacy defaults.
            ev_save_photo = ev_save_video = ev_send_tg = True
        return {
            "event_id": event_id,
            "time": ts,
            "labels": sorted(set(labels)),
            "top_label": top_det.label if top_det else labels[0],
            "detections": [d.to_dict() for d in detections],
            "bird_species": bird_species,
            "cat_name": cat_match,
            "person_name": person_match,
            "whitelisted": whitelisted,
            "alarm_level": level,
            # New severity field driven by the class_severity matrix. The
            # notifier reads this to pick silent vs. loud Telegram pushes
            # ("info" → silent, "alarm" → loud) and MQTT publishes it as
            # part of the event payload so Home Assistant can route by
            # severity. Falls back to a legacy-derived value when the
            # matrix is empty so consumers always have a non-empty key.
            "severity": severity,
            # `after_hours` historically meant "alerting schedule active"; we
            # keep the key for read-side compatibility (event JSONs already on
            # disk) but its value is now the schedule's hard-mode gate.
            "after_hours": hard_active,
            "notify": notify,
            "thumb_bytes": thumb_bytes,
            # Per-event recording switches derived from zone trigger flags.
            "save_photo":    ev_save_photo,
            "save_video":    ev_save_video,
            "send_telegram": ev_send_tg,
        }


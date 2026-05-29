from __future__ import annotations

# ruff: noqa: F401
# Comprehensive import block — some symbols are unused in this mixin
# but kept for parity so methods can be moved between mixins without
# import bookkeeping. Trim later if a mixin grows enough to warrant it.
import json as _json_mod
import logging
import os
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
from ..detection_tiling import tiled_detect
from ..motion_samples import record_sample as record_motion_sample
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
    _PROFILE_PERIOD_DEFAULTS,
    _PROFILES,
    _SPECIES_TO_ACH_ID,
    _WILDLIFE_BBOX_DONORS,
    _bbox_iou,
    _refine_wildlife_bbox,
    _suppress_overlap,
    log,
    log_cam,
    log_tl,
)


class MainLoopMixin:
    """The 530-line per-camera orchestrator (_loop).

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def _loop(self):
        if self.cfg.get("rtsp_url"):
            interval = max(
                0.05,
                float(
                    self.cfg.get("frame_interval_ms")
                    or self.global_cfg.get("processing", {})
                    .get("motion", {})
                    .get("frame_interval_ms", 150)
                )
                / 1000.0,
            )
        else:
            interval = max(1.0, float(self.cfg.get("snapshot_interval_s") or 3))
        cooldown = max(
            10, int(self.global_cfg.get("processing", {}).get("event_cooldown_seconds", 10))
        )

        # ── Watchdog: hard-kill a wedged capture handle ──────────────────
        # CAP_PROP_READ_TIMEOUT_MSEC isn't reliably honoured across every
        # OpenCV/FFmpeg build — some combos still block forever on a dead
        # TCP half-open. The watchdog releases the capture after 20 s of
        # silence so the next loop iteration is guaranteed to enter the
        # reconnect branch via self.capture becoming None / not-opened.
        # Updated on every successful frame inside the loop below.
        self._last_activity = time.time()

        def _watchdog():
            while self.running:
                time.sleep(10.0)
                if not self.running:
                    return
                if self.cfg.get("rtsp_url") and (time.time() - self._last_activity) > 20:
                    log_cam.warning(
                        "[%s] watchdog: capture silent >20s, requesting reconnect", self.camera_id
                    )
                    # Hand off to the main loop — calling release() from
                    # this thread races against the main-loop's read()
                    # and segfaults libav on corrupt HEVC streams (exit
                    # 139). The main loop already handles _force_reconnect
                    # at the top of every iteration.
                    self._force_reconnect = True
                    self._last_activity = time.time()

        threading.Thread(target=_watchdog, daemon=True, name=f"cam-wd-{self.camera_id}").start()

        while self.running:
            # Timelapse threads may request a forced reconnect when they detect a stale stream
            if self._force_reconnect:
                self._force_reconnect = False
                self._stale_streak = 0
                log_cam.warning(
                    "[cam:%s] forced reconnect — stale-feed recovery "
                    "(stale_streak=%d, last_frame_age=%.0fs, reconnects_24h=%d)",
                    self.camera_id,
                    self._stale_streak,
                    (time.time() - self.frame_ts) if self.frame_ts > 0 else 0,
                    self._reconnect_count_24h(),
                )
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                self._reconnect_count += 1
                self._reconnect_log.append(time.time())
                time.sleep(2.0)
                continue
            try:
                frame = self._grab_frame()
                # Always store raw frame so status → "active" and snapshots work.
                # Also update the inter-frame EMA so the test-detection
                # endpoint can spot a decoder backlog (frames arriving
                # faster than the camera's configured cadence = bursting
                # a buffer, not real-time). EMA is wall-clock so it
                # tracks decode arrivals, not capture timing.
                _now_grab = time.time()
                with self.lock:
                    prev_ts = self.frame_ts
                    self.frame = frame
                    self.frame_ts = _now_grab
                    if prev_ts > 0:
                        delta_ms = (_now_grab - prev_ts) * 1000.0
                        # Filter spurious "reconnect gap" deltas: any
                        # interval > 30 s reflects an outage, not a
                        # capture cadence, and would yank the EMA up
                        # for thousands of subsequent frames if we let
                        # it in. Treat it as a reset.
                        if delta_ms > 30_000:
                            self._frame_interval_ema_ms = 0.0
                        elif self._frame_interval_ema_ms <= 0:
                            self._frame_interval_ema_ms = delta_ms
                        else:
                            self._frame_interval_ema_ms = (
                                0.9 * self._frame_interval_ema_ms + 0.1 * delta_ms
                            )
                # First decoded frame after an open() — log latency so the
                # operator can confirm a reconnect actually recovered the
                # stream. Only fires once per open cycle.
                if self._rtsp_opened_at and not self._rtsp_first_frame_logged:
                    latency_ms = int((time.time() - self._rtsp_opened_at) * 1000)
                    masked = self._masked_rtsp_url()
                    log_cam.info(
                        "[cam:%s] RTSP opened — %s · first frame in %d ms",
                        self.camera_id,
                        masked,
                        latency_ms,
                    )
                    self._rtsp_first_frame_logged = True
                    self._last_rtsp_success_ts = time.time()
                # Feed the watchdog — any successful grab resets the silence clock.
                self._last_activity = time.time()
                if self._error_streak > 0:
                    downtime_s = int(
                        time.time()
                        - (self._last_rtsp_success_ts or self._rtsp_opened_at or time.time())
                    )
                    log_cam.info(
                        "[cam:%s] frame flow recovered after %d errors (downtime≈%ds)",
                        self.camera_id,
                        self._error_streak,
                        downtime_s,
                    )
                self.last_error = None
                self._error_streak = 0
                # Apply bottom crop before processing (removes corrupt H.264 bottom strip)
                bottom_crop_px = int(self.cfg.get("bottom_crop_px", 0))
                if bottom_crop_px > 0 and frame.shape[0] > bottom_crop_px:
                    proc_frame = frame[:-bottom_crop_px, :, :]
                else:
                    proc_frame = frame
                # Skip frames with corrupt bottom strip (high-saturation codec artifact)
                if self._has_corrupt_strip(proc_frame):
                    log.debug("[%s] corrupt strip detected, frame skipped", self.camera_id)
                    time.sleep(interval)
                    continue
                # Quality gate: skip corrupt/uniform/artifact frames for events only
                if not self._is_frame_valid(proc_frame):
                    if self._recording:
                        self._rec_corrupt_frames += 1
                    time.sleep(interval)
                    continue
                # Stream warmup: ignore first 3 s after connect to skip transition frames
                if self.connect_time and time.time() - self.connect_time < 3.0:
                    time.sleep(interval)
                    continue
                motion_labels, motion_bbox, wildlife_motion_low, wl_blobs = self._motion_detect(
                    proc_frame
                )
                # D1 · feed the wildlife-low blobs to the cross-frame
                # MotionBlobTracker and ask whether any shows COHERENT net
                # translation (a real animal crossing) vs in-place shimmer
                # (wind). Only a coherent blob is allowed to escalate to the
                # D2 ROI/tiling re-detection further down. Per-camera tunable
                # min net-displacement fraction (D3); falls back to the
                # conservative module default when unset.
                self._blob_tracker.update(wl_blobs)
                _min_net = self.cfg.get("roi_min_net_disp_frac")
                if _min_net:
                    _coherent_blob = self._blob_tracker.coherent_track(
                        proc_frame.shape[1], min_net_frac=float(_min_net)
                    )
                else:
                    _coherent_blob = self._blob_tracker.coherent_track(proc_frame.shape[1])
                # Multi-frame confirmation: only trigger on motion in ≥2 of last 3 frames.
                # Two parallel deques — one for the regular threshold (which gates
                # event recording + COCO) and one for the lower wildlife threshold
                # (which extends the gate for the wildlife classifier only).
                self._motion_confirm.append(1 if motion_labels else 0)
                # Wildlife deque counts BOTH normal motion and wildlife-only motion;
                # wildlife is by definition more sensitive, so anything that
                # registers as normal motion must also register as wildlife motion.
                self._motion_confirm_wl.append(1 if (motion_labels or wildlife_motion_low) else 0)
                motion_confirmed = sum(self._motion_confirm) >= 2
                wlmotion_confirmed = sum(self._motion_confirm_wl) >= 2
                wildlife_motion_only = wlmotion_confirmed and not motion_confirmed
                effective_motion = motion_labels if motion_confirmed else []
                effective_bbox = motion_bbox if motion_confirmed else None
                # Per-label confidence overrides (e.g. {"person": 0.72}).
                # In the two-tier tracker design these become the SPAWN
                # floor for that label — a "person" detection below 0.72
                # can still EXTEND an existing person-track (continuation)
                # via the tracker's tentative-tier path. Cold-start
                # gating still happens here because the confirmer's 3-of-5s
                # rule trumps the tracker for fresh sightings.
                label_thresholds = self.cfg.get("label_thresholds") or None
                _t0 = time.time()
                # Pull EVERY hit above the tracker's continuation floor —
                # the tracker classifies them into confirmed (≥ spawn) vs
                # tentative (floor ≤ score < spawn) downstream. Per-camera
                # detection_min_score is no longer the live cutoff — it
                # would defeat the point of the tracker's two-tier flow.
                detections = self.detector.detect_frame_raw(
                    proc_frame,
                    threshold=self._tracker.floor,
                )
                # Rolling-average Coral inference latency for the /status
                # bubble. Cost is unchanged from detect_frame() — same
                # underlying invoke; only the post-filter threshold differs.
                self._inference_times_ms.append((time.time() - _t0) * 1000.0)
                allowed = set(self.cfg.get("object_filter") or [])
                if allowed:
                    detections = [d for d in detections if d.label in allowed]
                # Exclusion mask first: drop detections inside masked
                # regions before zone filtering or the tracker runs. A
                # tracked subject must NOT survive into a masked region.
                detections = self._filter_masked_detections(proc_frame, detections)
                # Inclusion zones next: if any zones are defined, keep
                # only detections whose centre lies inside a zone.
                # Masks + zones compose: detect inside zones BUT exclude
                # masked areas within zones.
                detections = self._filter_zoned_detections(proc_frame, detections)
                # ── D2 · ROI / tiling rescue ─────────────────────────────
                # When the full-frame HD detect found NO kept object but D1
                # saw a coherent moving blob, re-detect with the camera's
                # tiling/ROI mode on the SAME main frame, NMS-merge with a
                # full-frame pass, then re-apply object_filter + masks +
                # zones so the merged hits flow through the EXISTING tracker
                # + confirmer + recording path unchanged. cat→"dog" is
                # accepted as "animal present". COST GUARD: this fires only
                # on the escalated wildlife-low + coherent-motion case —
                # never every frame.
                det_mode = (self.cfg.get("roi_mode") or "off").strip().lower()
                if (
                    not detections
                    and _coherent_blob is not None
                    and det_mode in ("roi", "2x2", "3x3")
                ):
                    mbox = _coherent_blob.last_bbox if det_mode == "roi" else None
                    roi_dets, _sahi = tiled_detect(
                        self.detector,
                        proc_frame,
                        det_mode,
                        threshold=self._tracker.floor,
                        motion_box=mbox,
                    )
                    if allowed:
                        roi_dets = [d for d in roi_dets if d.label in allowed]
                    roi_dets = self._filter_masked_detections(proc_frame, roi_dets)
                    roi_dets = self._filter_zoned_detections(proc_frame, roi_dets)
                    for _d in roi_dets:
                        _d.via_roi = True  # D4 provenance
                    if roi_dets:
                        log.info(
                            "[%s] D2 ROI rescue (%s): %d hit(s) on coherent blob "
                            "net=%.0fpx straight=%.2f → %s",
                            self.camera_id,
                            det_mode,
                            len(roi_dets),
                            _coherent_blob.net_displacement,
                            _coherent_blob.straightness,
                            ",".join(sorted({d.label for d in roi_dets})),
                        )
                    # E1 · persist a labeled motion sample (kept ≈ animal,
                    # empty ≈ wind/noise) for offline threshold calibration.
                    record_motion_sample(
                        self.global_cfg.get("storage", {}).get("root"),
                        self.camera_id,
                        _coherent_blob,
                        bool(roi_dets),
                        det_mode,
                        time.time(),
                        proc_frame.shape[1],
                    )
                    detections = roi_dets
                # ── Two-tier tracker ────────────────────────────────────
                # Classifies each surviving detection into confirmed
                # (≥ per-label spawn threshold) vs tentative (above floor,
                # below spawn). Confirmed dets can spawn or extend tracks;
                # tentative dets can only extend a still-unmatched IoU
                # partner. Subjects survive short low-conf dips while
                # genuine cold-start gating stays the confirmer's job.
                spawn_for = lambda _lbl: self._tracker.spawn_default
                if label_thresholds:
                    _lt = dict(label_thresholds)
                    _default = self._tracker.spawn_default
                    spawn_for = lambda lbl, _lt=_lt, _d=_default: (
                        float(_lt[lbl]) if lbl in _lt else _d
                    )
                # Effective fps for grace-window math. Falls back to a
                # conservative 3 Hz when the rolling measurement hasn't
                # warmed up yet (first ~5 s of a camera's session).
                _eff_fps = max(1.0, float(getattr(self, "_main_fps", 0.0) or 3.0))
                detections = self._tracker.step(
                    detections,
                    t_s=time.monotonic(),
                    fps=_eff_fps,
                    spawn_for=spawn_for,
                )
                if log.isEnabledFor(logging.DEBUG) and detections:
                    log.debug(
                        "[%s] tracker: %d dets survived (active=%d)",
                        self.camera_id,
                        len(detections),
                        self._tracker.active_count(),
                    )
                labels = effective_motion + [d.label for d in detections]
                if self.bird_classifier.available:
                    for d in detections:
                        if d.label == "bird":
                            crop = self._crop(proc_frame, d.bbox)
                            species, species_latin, species_score = (
                                self.bird_classifier.classify_crop(crop)
                            )
                            if species:
                                d.species = species
                                d.species_latin = species_latin
                                d.species_score = (
                                    float(species_score) if species_score is not None else None
                                )
                # Wildlife second-stage: catches fox / squirrel / hedgehog —
                # none of which have a COCO class. Gating logic:
                #   - Confident COCO bird / dog / person → skip wildlife.
                #     These animals genuinely look like themselves to COCO,
                #     no point second-guessing.
                #   - Confident COCO cat (≥0.92) → skip wildlife. Anything
                #     below that threshold is a "soft cat" that COCO often
                #     emits on frontal-sitting squirrels; we keep wildlife
                #     in the running and let it overrule a soft cat below.
                hard_skip_labels = ("bird", "dog", "person")
                soft_cat = next(
                    (d for d in detections if d.label == "cat" and d.score < 0.92),
                    None,
                )
                hard_cat = any(d.label == "cat" and d.score >= 0.92 for d in detections)
                if (
                    (motion_confirmed or wildlife_motion_only)
                    and self.wildlife_classifier.available
                    and not any(d.label in hard_skip_labels for d in detections)
                    and not hard_cat
                ):
                    try:
                        wl_min = self.cfg.get("wildlife_min_score") or None
                        cat, raw_lbl, wscore = self.wildlife_classifier.classify_crop(
                            proc_frame,
                            min_score=wl_min,
                        )
                    except Exception:
                        cat, raw_lbl, wscore = None, None, None
                    if cat and (not allowed or cat in allowed):
                        h0, w0 = proc_frame.shape[:2]
                        # Localise the animal: re-run COCO at a low threshold
                        # and pick the bbox of any animal-shaped class
                        # (cat/dog/bear/sheep/cow). The label is wrong but
                        # the geometry is right — we only borrow the bbox.
                        # Falls back to the motion bbox, then the full frame.
                        bb = _refine_wildlife_bbox(
                            self.detector,
                            proc_frame,
                            effective_bbox,
                            (w0, h0),
                        )
                        wl_det = Detection(
                            label=cat,
                            score=float(wscore) if wscore is not None else 0.5,
                            bbox=bb,
                            species=raw_lbl,
                            species_score=float(wscore) if wscore is not None else None,
                        )
                        survivors = self._filter_masked_detections(proc_frame, [wl_det])
                        survivors = self._filter_zoned_detections(proc_frame, survivors)
                        if survivors:
                            # Cat-vs-squirrel override: COCO often calls a
                            # frontal squirrel "cat" with moderate
                            # confidence. If wildlife is sure enough, drop
                            # the soft-cat detection and let squirrel win.
                            if (
                                cat == "squirrel"
                                and soft_cat is not None
                                and float(wscore or 0) >= 0.45
                            ):
                                log.info(
                                    "[%s] cat→squirrel override: cat %.2f replaced by wildlife squirrel %.2f",
                                    self.camera_id,
                                    soft_cat.score,
                                    float(wscore),
                                )
                                detections = [d for d in detections if d is not soft_cat]
                                labels = [L for L in labels if L != "cat"]
                            # Confident squirrel → suppress overlapping COCO
                            # false-positives (cat/dog/bear/teddy bear) so
                            # the event isn't double-labelled. The whole
                            # project's purpose is squirrel detection — once
                            # the wildlife model is sure, COCO's misreads on
                            # the same patch become noise.
                            if cat == "squirrel" and float(wscore or 0) >= 0.55:
                                pre = len(detections)
                                detections = _suppress_overlap(
                                    detections,
                                    bb,
                                    drop_labels=("cat", "dog", "bear", "teddy bear"),
                                    iou_min=0.3,
                                )
                                if len(detections) != pre:
                                    labels = [
                                        L
                                        for L in labels
                                        if L not in ("cat", "dog", "bear", "teddy bear")
                                        or any(d.label == L for d in detections)
                                    ]
                            detections.append(wl_det)
                            labels.append(cat)
                if self.cat_registry:
                    for d in detections:
                        if d.label == "cat":
                            crop = self._crop(proc_frame, d.bbox)
                            m = self.cat_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                if self.person_registry:
                    for d in detections:
                        if d.label == "person":
                            crop = self._crop(proc_frame, d.bbox)
                            m = self.person_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                drawn = draw_detections(proc_frame, detections)
                with self.lock:
                    self.preview = drawn
                # ── MAD glitch check vs previous accepted frame ───────────────
                if self.cfg.get("rtsp_url") and self._is_frame_too_different(
                    proc_frame, self._prev_good_frame
                ):
                    log.warning("[%s] Frame MAD>60 (glitch/corrupt), skipped", self.camera_id)
                    time.sleep(interval)
                    continue
                self._prev_good_frame = proc_frame  # no copy — proc_frame is already a new array

                # N-of-M confirmation gate. Dedupe by label per frame so a
                # frame with three concurrent persons counts as ONE hit
                # for "person" — the window measures temporal persistence,
                # not per-frame multiplicity. Detections still appear in
                # the live preview overlay (drawn already paints them);
                # only the trigger pipeline downstream filters on the
                # confirmed labels.
                #
                # Score gate: only detections at-or-above the per-label
                # spawn threshold count toward the confirmation window.
                # The two-tier tracker keeps a track alive on tentative
                # (< spawn) samples once it has been spawned at-or-above
                # threshold, so an unconditional confirmer.check() would
                # fire on the low-confidence tail of a sighting whose
                # CURRENT score is well under the configured threshold
                # (e.g. a person briefly seen at 60%, then dropping to
                # 23% for many frames — old behaviour: confirmation
                # stayed live, sub-threshold dips even re-fired after
                # the 2× window decay). Ongoing sightings still
                # propagate via is_confirmed so an already-running clip
                # carries the label across its tail.
                cw_cfg = self.cfg.get("confirmation_window") or {}
                confirmed_object_labels: list[str] = []
                _seen_this_frame: set[str] = set()
                for d in detections:
                    if d.label in _seen_this_frame:
                        if self._confirmer.is_confirmed(self.camera_id, d.label):
                            confirmed_object_labels.append(d.label)
                        continue
                    _seen_this_frame.add(d.label)
                    cw = cw_cfg.get(d.label) or {}
                    n = max(1, int(cw.get("n", 3)))
                    secs = max(0.5, float(cw.get("seconds", 5.0)))
                    spawn_threshold = spawn_for(d.label)
                    if float(d.score) < spawn_threshold:
                        # Sub-threshold continuation — counts in tracking
                        # but NOT toward the recording-trigger
                        # confirmation. Surface ongoing sightings only.
                        if self._confirmer.is_confirmed(self.camera_id, d.label):
                            confirmed_object_labels.append(d.label)
                        log.debug(
                            "[det][cam:%s] ↓ sub-threshold: %s %d%% "
                            "(< spawn %d%%) — Bestätigung unverändert",
                            self.camera_id,
                            d.label,
                            int(round(d.score * 100)),
                            int(round(spawn_threshold * 100)),
                        )
                        continue
                    fired = self._confirmer.check(self.camera_id, d.label, n, secs)
                    if fired:
                        cur = self._confirmer.current_count(self.camera_id, d.label)
                        log.info(
                            "[det][cam:%s] ✅ BESTÄTIGT: %s — %d Treffer in %.1fs → Alert ausgelöst",
                            self.camera_id,
                            d.label,
                            cur,
                            secs,
                        )
                        confirmed_object_labels.append(d.label)
                    elif self._confirmer.is_confirmed(self.camera_id, d.label):
                        confirmed_object_labels.append(d.label)
                    else:
                        cur = self._confirmer.current_count(self.camera_id, d.label)
                        log.info(
                            "[det][cam:%s] ⏳ wartend: %s %d%% (Bestätigung %d/%d in %.1fs)",
                            self.camera_id,
                            d.label,
                            int(round(d.score * 100)),
                            cur,
                            n,
                            secs,
                        )

                now_dt = datetime.now()
                # Per-camera trigger mode:
                #   motion_and_objects (default) — motion OR object fires event
                #   objects_only                 — motion alone ignored; objects
                #                                  still carry motion in metadata
                #   motion_only                  — only motion fires; objects
                #                                  are still labelled for metadata
                trigger_mode = self.cfg.get("detection_trigger", "motion_and_objects")
                # Trigger logic uses CONFIRMED labels only — unconfirmed
                # detections still appear in the preview overlay but do
                # not propagate to event recording / Telegram. The full
                # detections list is still written into the event meta
                # below so the saved JSON keeps the complete frame info.
                object_labels = list(confirmed_object_labels)
                if trigger_mode == "objects_only":
                    has_motion = bool(object_labels)
                    labels = sorted(set(effective_motion + object_labels)) if has_motion else []
                elif trigger_mode == "motion_only":
                    has_motion = bool(effective_motion)
                    labels = sorted(set(effective_motion + object_labels)) if has_motion else []
                else:
                    # motion_and_objects: motion alone OR confirmed object fires
                    has_motion = bool(effective_motion) or bool(object_labels)
                    labels = sorted(set(effective_motion + object_labels)) if has_motion else []

                # Per-camera recording schedule — outside the configured
                # window (or when recording_enabled is off entirely) we
                # still detect, but never start a new on-disk event.
                # In-progress recordings finalize normally (gate only fires
                # when has_motion AND we're not already recording).
                # New schedule_record dict gates by time window; the
                # recording_enabled toggle is the master record on/off.
                if has_motion and not self._recording:
                    if not self.cfg.get("recording_enabled", True):
                        time.sleep(interval)
                        continue
                    if not is_schedule_window_active(self.cfg.get("schedule_record") or {}):
                        time.sleep(interval)
                        continue

                if self.cfg.get("rtsp_url"):
                    # ── RTSP: pre-buffer + per-session video recording ────────
                    # Measure main-stream FPS over a rolling 5s window
                    self._main_fps_frames += 1
                    _fps_el = time.time() - self._main_fps_window_start
                    if _fps_el >= 5.0:
                        self._main_fps = round(self._main_fps_frames / _fps_el, 1)
                        self._main_fps_frames = 0
                        self._main_fps_window_start = time.time()

                    # Clip boundary knobs (configurable); ffmpeg stream-copy ignores pre-buffer
                    _clip_max = int(
                        self.global_cfg.get("processing", {}).get("clip_max_duration_s", 120)
                    )
                    _post_tail = float(
                        self.cfg.get("post_motion_tail_s")
                        or self.global_cfg.get("processing", {}).get("post_motion_tail_s", 3.0)
                    )
                    # Pre-buffer only matters for the OpenCV fallback path
                    if not _FFMPEG_AVAILABLE:
                        self._pre_buffer.append((proc_frame.copy(), time.time()))

                    if has_motion:
                        self._last_motion_ts = now_dt
                        if not self._recording:
                            has_person = "person" in labels
                            elapsed = (now_dt - self.last_event_at).total_seconds()
                            if has_person or elapsed >= cooldown:
                                rec_meta = self._build_event_meta(
                                    now_dt, labels, detections, drawn, effective_bbox
                                )
                                # Zone trigger flag: if every detection in
                                # this event sits in a zone with save_video
                                # turned off, skip recording entirely. Cheap
                                # short-circuit before ffmpeg launches.
                                if not rec_meta.get("save_video", True):
                                    log.debug(
                                        "[%s] event %s: save_video=False, skipping clip",
                                        self.camera_id,
                                        rec_meta.get("event_id"),
                                    )
                                    continue
                                started = False
                                if _FFMPEG_AVAILABLE:
                                    started = self._start_ffmpeg_recording(now_dt, rec_meta)
                                if started:
                                    self._recording = True
                                    self._rec_start_time = now_dt
                                    self._rec_corrupt_frames = 0
                                    self._rec_event_meta = rec_meta
                                    self.last_event_at = now_dt
                                    self.event_counter_today += 1
                                else:
                                    # OpenCV fallback (legacy path)
                                    self._recording = True
                                    self._rec_start_time = now_dt
                                    self._rec_corrupt_frames = 0
                                    pre_cutoff = time.time() - 3.0
                                    self._rec_frames = [
                                        f for f, ts in self._pre_buffer if ts >= pre_cutoff
                                    ]
                                    self._rec_event_meta = rec_meta
                                    self.last_event_at = now_dt
                                    self.event_counter_today += 1
                                    log.info(
                                        "[%s] Motion recording started (OpenCV, labels=%s, prebuf=%d frames)",
                                        self.camera_id,
                                        labels,
                                        len(self._rec_frames),
                                    )
                        # Append frames only in OpenCV mode — ffmpeg records itself
                        if self._recording and self._ffmpeg_proc is None:
                            self._rec_frames.append(proc_frame.copy())

                    elif self._recording:
                        since_last = (
                            (now_dt - self._last_motion_ts).total_seconds()
                            if self._last_motion_ts
                            else 999
                        )
                        since_start = (
                            (now_dt - self._rec_start_time).total_seconds()
                            if self._rec_start_time
                            else 0
                        )
                        # In OpenCV mode we keep accumulating tail frames
                        if self._ffmpeg_proc is None:
                            self._rec_frames.append(proc_frame.copy())
                        if since_last >= _post_tail or since_start >= _clip_max:
                            if self._rec_corrupt_frames > 5:
                                log.warning(
                                    "[%s] %d corrupt frames rejected in this clip",
                                    self.camera_id,
                                    self._rec_corrupt_frames,
                                )
                            if self._ffmpeg_proc is not None:
                                # ffmpeg mode: stop subprocess + queue re-encode
                                self._stop_ffmpeg_and_queue_reencode()
                                self._recording = False
                                self._rec_start_time = None
                                self._last_motion_ts = None
                                self._rec_event_meta = None
                                self._rec_corrupt_frames = 0
                            else:
                                # OpenCV fallback: finalize from frame buffer
                                frames_snap = self._rec_frames[:]
                                meta_snap = self._rec_event_meta
                                measured_fps = (
                                    max(5.0, min(30.0, len(frames_snap) / since_start))
                                    if since_start > 0.5
                                    else (self._main_fps or 10.0)
                                )
                                self._recording = False
                                self._rec_frames = []
                                self._rec_start_time = None
                                self._last_motion_ts = None
                                self._rec_event_meta = None
                                self._rec_corrupt_frames = 0
                                if meta_snap and len(frames_snap) >= 3:
                                    threading.Thread(
                                        target=self._finalize_motion_clip,
                                        args=(frames_snap, meta_snap, measured_fps),
                                        daemon=True,
                                    ).start()

                else:
                    # ── Snapshot camera: save JPEG event (unchanged behaviour) ─
                    has_person = "person" in labels
                    elapsed = (now_dt - self.last_event_at).total_seconds()
                    if labels and (has_person or elapsed >= cooldown):
                        self.last_event_at = now_dt
                        self.event_counter_today += 1
                        ts = now_dt
                        event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
                        day_dir = (
                            Path(self.global_cfg["storage"]["root"])
                            / "motion_detection"
                            / self.camera_id
                            / ts.strftime("%Y-%m-%d")
                        )
                        day_dir.mkdir(parents=True, exist_ok=True)
                        # Build event meta first so we know whether the
                        # zone(s) the detections fell into actually want a
                        # photo saved. save_photo:false zones still log the
                        # event JSON but skip the JPEG write.
                        ev_meta = self._build_event_meta(
                            ts, labels, detections, drawn, effective_bbox
                        )
                        snap_path = day_dir / f"{event_id}.jpg"
                        rel = snap_path.relative_to(Path(self.global_cfg["storage"]["root"]))
                        public_base = (
                            self.global_cfg.get("server", {}).get("public_base_url") or ""
                        ).rstrip("/")
                        snapshot_url = None
                        if ev_meta.get("save_photo", True):
                            save_frame = drawn.copy()
                            if effective_bbox is not None:
                                mx, my, mw, mh = effective_bbox
                                cv2.rectangle(
                                    save_frame, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2
                                )
                            h_px, w_px = save_frame.shape[:2]
                            if w_px > 1280:
                                scale = 1280 / w_px
                                save_frame = cv2.resize(
                                    save_frame,
                                    (1280, int(h_px * scale)),
                                    interpolation=cv2.INTER_AREA,
                                )
                            cv2.imwrite(
                                str(snap_path), save_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60]
                            )
                            snapshot_url = (
                                f"{public_base}/media/{rel.as_posix()}" if public_base else None
                            )
                        event = {
                            "event_id": event_id,
                            "camera_id": self.camera_id,
                            "camera_name": self.cfg.get("name", self.camera_id),
                            "armed": bool(self.cfg.get("armed", True)),
                            "after_hours": ev_meta["after_hours"],
                            "alarm_level": ev_meta["alarm_level"],
                            "time": ts.isoformat(timespec="seconds"),
                            "labels": ev_meta["labels"],
                            "top_label": ev_meta["top_label"],
                            "bird_species": ev_meta["bird_species"],
                            "cat_name": ev_meta["cat_name"],
                            "person_name": ev_meta["person_name"],
                            "whitelisted": ev_meta["whitelisted"],
                            "detections": ev_meta["detections"],
                            "snapshot_url": snapshot_url,
                            "snapshot_relpath": rel.as_posix() if snapshot_url else None,
                            "video_url": None,
                            "video_relpath": None,
                        }
                        self.store.add_event(self.camera_id, event)
                        if self.mqtt and self.cfg.get("mqtt_enabled", True):
                            self.mqtt.publish(f"events/{self.camera_id}", event)
                        _send_tg = ev_meta["notify"] and self.cfg.get("telegram_enabled", True)
                        # Defensive: "Stumm" cameras never send Telegram.
                        if not self.cfg.get("armed", True):
                            _send_tg = False
                        if not ev_meta.get("send_telegram", True):
                            _send_tg = False
                        if _send_tg and self.notifier:
                            # Only attach the JPEG when one was actually
                            # written. If save_photo was off, fall back to
                            # the in-memory thumb_bytes from ev_meta.
                            thumb = ev_meta.get("thumb_bytes")
                            if snapshot_url:
                                try:
                                    with open(snap_path, "rb") as fh:
                                        thumb = fh.read()
                                except Exception:
                                    pass
                            self.notifier.send_alert_sync(
                                caption=(
                                    f"ℹ️ {', '.join(ev_meta['labels'])}\n"
                                    f"📷 {self.cfg.get('name', self.camera_id)}\n"
                                    f"🕒 {event['time']}"
                                ),
                                jpeg_bytes=thumb,
                                snapshot_url=snapshot_url,
                                dashboard_url=public_base,
                                camera_id=self.camera_id,
                            )
                self.last_error = None
            except Exception as e:
                self._error_streak += 1
                self.last_error = str(e)
                # V81 · per-failure diagnostic. Env-gated so non-flapping
                # installs pay zero log overhead. Uses the existing
                # _last_rtsp_success_ts (set on every successful grab)
                # as the "since last good frame" timestamp.
                if os.getenv("FLAP_DIAG", "").lower() in ("1", "true", "yes"):
                    _last_ok = self._last_rtsp_success_ts or 0.0
                    _since = (time.time() - _last_ok) if _last_ok else -1.0
                    _reconnects_24h = len(
                        [t for t in self._reconnect_log if time.time() - t < 86400]
                    )
                    log.info(
                        "[cam:%s][flap] streak=%d err=%s:%s since_last_ok=%.1fs reconnects_24h=%d",
                        self.camera_id,
                        self._error_streak,
                        type(e).__name__,
                        str(e)[:200],
                        _since,
                        _reconnects_24h,
                    )
                if self._error_streak == 1:
                    log.debug("[%s] Frame lesen fehlgeschlagen: %s", self.camera_id, e)
                elif self._error_streak == 5:
                    log_cam.warning(
                        "[%s] Verbindungsprobleme – %d aufeinanderfolgende Fehler: %s",
                        self.camera_id,
                        self._error_streak,
                        e,
                    )
                elif self._error_streak == 15 or (
                    self._error_streak > 15 and self._error_streak % 30 == 0
                ):
                    log.error(
                        "[%s] Stream verloren (streak=%d): %s",
                        self.camera_id,
                        self._error_streak,
                        e,
                    )
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                self._reconnect_count += 1
                self._reconnect_log.append(time.time())
                # Short backoff for transient dropouts, longer for persistent failures
                sleep_t = (
                    2.0
                    if self._error_streak <= 3
                    else min(30.0, 5.0 * (self._error_streak // 5 + 1))
                )
                time.sleep(sleep_t)
            time.sleep(interval)

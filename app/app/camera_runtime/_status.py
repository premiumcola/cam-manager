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


class StatusMixin:
    """Snapshot encoders + /status payload + masked URL helpers.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def snapshot_jpeg(self, quality=88):
        """Thread-safe snapshot encoder. Reads only from shared frame buffers.
        Priority: sub-stream clean frame → annotated main-stream frame → raw main-stream frame.
        All three live in self.lock — safe to call from multiple HTTP threads concurrently."""
        with self.lock:
            frame = (
                self._preview_frame
                if self._preview_frame is not None
                else (self.preview if self.preview is not None else self.frame)
            )
            if frame is None:
                return None
            frame = frame.copy()  # copy under lock so encoding happens outside
        ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes() if ok else None

    def snapshot_jpeg_hires(self, quality=92):
        """Like `snapshot_jpeg` but never falls back to the sub-stream
        preview frame — meant for timelapse capture, where main-stream
        resolution (e.g. 2560×1440 on Reolink) is the whole point. Order
        of preference: raw main-stream frame → annotated main-stream
        frame. The annotated path is only used if the raw frame is
        somehow None (cold start), since the annotation overlay shows
        detection boxes that look weird in a finished timelapse video.

        Returns None when neither main-stream buffer has been populated
        yet, e.g. during the first few seconds after the cam connects.
        Caller is expected to retry — see frame_helpers.grab_valid_frame."""
        with self.lock:
            frame = self.frame if self.frame is not None else self.preview
            if frame is None:
                return None
            frame = frame.copy()
        # Lazily log the first hires snapshot per-runtime so an operator
        # can confirm in `docker logs` that timelapses pulled from the
        # main stream after this change shipped.
        if not getattr(self, "_hires_snapshot_logged", False):
            self._hires_snapshot_logged = True
            try:
                h, w = frame.shape[:2]
                log.info(
                    "[cam:%s] hires snapshot active — main-stream %dx%d",
                    self.camera_id,
                    w,
                    h,
                )
            except Exception:
                pass
        ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        return buf.tobytes() if ok else None

    def status(self):
        cfg = self.cfg
        now_t = time.time()
        frame_age_s = round(now_t - self.frame_ts, 1) if self.frame_ts > 0 else None
        det_mode = getattr(self.detector, "mode", "motion_only")
        # `detector.available` means "any detection works" (Coral OR CPU).
        # The UI's `coral_available` field is supposed to mean "TPU is the
        # active engine" — derive it from mode so the chip can show
        # green/orange/grey/red without conflating "detector is up" with
        # "TPU is up". Mismatches between mode and detector.available are
        # logged as a defensive tripwire below.
        det_ready = bool(getattr(self.detector, "available", False))
        coral_avail = det_mode == "coral"
        prev_warned = getattr(self, "_det_state_warned", None)
        cur_state = (det_mode, det_ready)
        if det_mode in ("coral", "cpu") and not det_ready and prev_warned != cur_state:
            log.warning(
                "[det] inconsistent state: cam=%s mode=%s detector_ready=false",
                self.camera_id,
                det_mode,
            )
            self._det_state_warned = cur_state
        # Explicit coral_mode for the cam-edit Erkennung-tab status strip:
        # collapses (detection_mode, coral_available) into one of three
        # display states the frontend can map to a dot variant without
        # re-deriving the combination.
        if det_mode == "coral" and det_ready:
            coral_mode = "tpu"  # green dot, "Coral läuft"
        elif det_mode == "cpu":
            coral_mode = "cpu_fallback"  # orange pulse, "CPU-Notfall"
        else:
            coral_mode = "off"  # grey dot, "Coral aus" / motion-only / disabled
        return {
            "id": self.camera_id,
            "name": cfg.get("name", self.camera_id),
            "location": cfg.get("location", ""),
            "enabled": cfg.get("enabled", True),
            "armed": cfg.get("armed", True),
            "source": "rtsp" if cfg.get("rtsp_url") else "snapshot",
            "last_error": self.last_error,
            "status": "error"
            if self._error_streak >= 10
            else ("active" if self.frame is not None else "starting"),
            "today_events": self.event_counter_today,
            "timelapse_enabled": bool((cfg.get("timelapse") or {}).get("enabled")),
            "detection_mode": det_mode,
            "coral_mode": coral_mode,
            "coral_available": coral_avail,
            "coral_reason": getattr(self.detector, "reason", "disabled"),
            "bird_species_available": getattr(self.bird_classifier, "available", False),
            "bird_species_mode": getattr(self.bird_classifier, "mode", "none"),
            # Connection health diagnostics
            "frame_age_s": frame_age_s,
            "reconnect_count": self._reconnect_count,
            "stale_incidents": self._stale_incidents,
            "error_streak": self._error_streak,
            "stale_streak": self._stale_streak,
            # Stream activity
            "preview_fps": self._preview_fps,
            "preview_resolution": self._preview_resolution,
            "live_viewers": self._live_viewers,
            "stream_mode": "live" if self._live_viewers > 0 else "baseline",
            "supervisor_restarts": self._supervisor_restarts,
            "inference_avg_ms": (sum(self._inference_times_ms) / len(self._inference_times_ms))
            if self._inference_times_ms
            else None,
            "reconnect_count_24h": self._reconnect_count_24h(),
        }

    def _masked_rtsp_url(self) -> str:
        """Return the configured rtsp_url with the password replaced by
        '•••' so log lines and operator messages don't leak credentials.
        Falls back to the bare host when the URL has no embedded creds."""
        url = self.cfg.get("rtsp_url", "") or ""
        if not url or "://" not in url:
            return url
        try:
            scheme, rest = url.split("://", 1)
            if "@" in rest:
                creds, host = rest.rsplit("@", 1)
                if ":" in creds:
                    user, _ = creds.split(":", 1)
                    return f"{scheme}://{user}:•••@{host}"
        except Exception:
            pass
        return url

    def _reconnect_count_24h(self) -> int:
        """Prune reconnect log entries older than 24 h on each read, then
        return the count. Cheap because the log only ever contains
        reconnect events (rare on a healthy cam, capped naturally by the
        stream-watchdog cadence on a flaky one)."""
        cutoff = time.time() - 86400
        log = self._reconnect_log
        while log and log[0] < cutoff:
            log.popleft()
        return len(log)

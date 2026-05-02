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


class LifecycleMixin:
    """Process lifecycle: start/stop/supervised wrapper + viewer counters.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    @property
    def cfg(self):
        return self.config_getter(self.camera_id) or {"id": self.camera_id, "name": self.camera_id}

    def add_viewer(self):
        """Increment live viewer count (called when MJPEG client connects)."""
        with self._viewers_lock:
            self._live_viewers += 1

    def remove_viewer(self):
        """Decrement live viewer count (called when MJPEG client disconnects)."""
        with self._viewers_lock:
            self._live_viewers = max(0, self._live_viewers - 1)

    def _supervised(self, target, name: str):
        """Run target in a restart loop with exponential backoff on crash.

        Exits cleanly when target() returns while self.running is False.
        Resets the backoff counter after 300 s of stable uptime so a
        camera that ran fine for a long time doesn't keep the high delay.
        """
        attempt = 0
        while self.running:
            t_start = time.time()
            try:
                target()
            except Exception as exc:
                if not self.running:
                    return
                elapsed = time.time() - t_start
                if elapsed >= 300:
                    attempt = 0
                wait = min(2 ** attempt, 60)
                self._supervisor_restarts += 1
                log.error(
                    "[%s][supervisor] Thread '%s' crashed: %s — restarting in %ds",
                    self.camera_id, name, exc, wait,
                )
                attempt += 1
                deadline = time.time() + wait
                while self.running and time.time() < deadline:
                    time.sleep(0.5)
            else:
                return

    def start(self):
        self.running = True
        # Clean up stale frame directories from previous runs before starting
        try:
            self._cleanup_stale_timelapse_frames()
        except Exception as _e:
            log.warning("[%s] stale timelapse frame cleanup error: %s", self.camera_id, _e)
        # Main ingest loop — sole reader of self.capture (RTSP / HTTP snapshot)
        self.thread = threading.Thread(
            target=self._supervised, args=(self._loop, "loop"), daemon=True,
        )
        self.thread.start()
        # Sub-stream preview loop — sole reader of self.preview_cap
        threading.Thread(
            target=self._supervised, args=(self._preview_loop, "preview_loop"), daemon=True,
        ).start()
        # Per-profile timelapse threads — read from self.frame (no direct camera access)
        for prof_name in _PROFILES:
            t = threading.Thread(
                target=self._supervised,
                args=(lambda pn=prof_name: self._timelapse_profile_loop(pn), f"timelapse_{prof_name}"),
                daemon=True,
            )
            t.start()
            self._tl_threads[prof_name] = t
        # Legacy loop for cameras with old timelapse.enabled=True and no profiles configured
        tl = self.cfg.get("timelapse") or {}
        has_profiles = any((tl.get("profiles") or {}).get(p, {}).get("enabled") for p in _PROFILES)
        if tl.get("enabled") and not has_profiles:
            self._tl_thread = threading.Thread(target=self._timelapse_loop, daemon=True)
            self._tl_thread.start()

    def stop(self):
        self.running = False
        # Release main capture (only _loop touches this, so safe after running=False)
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:
                pass
            self.capture = None
        # Release sub-stream capture under its dedicated lock
        with self._preview_cap_lock:
            if self.preview_cap is not None:
                try:
                    self.preview_cap.release()
                except Exception:
                    pass
                self.preview_cap = None


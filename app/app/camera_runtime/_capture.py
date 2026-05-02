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


class CaptureMixin:
    """RTSP open/grab + frame validity guards + sub-stream preview loop.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    @staticmethod
    def _sub_stream_url(url: str) -> str | None:
        """Derive H.264 sub-stream URL from main-stream URL.
        Handles both Reolink H.264 and H.265 main streams:
          - h264Preview_01_main → h264Preview_01_sub (RLC-810A, older firmware)
          - h265Preview_01_main → h264Preview_01_sub (CX810, newer firmware — H.265 on main, H.264 on sub)
        """
        if "/h264Preview_01_main" in url:
            return url.replace("/h264Preview_01_main", "/h264Preview_01_sub")
        if "/h265Preview_01_main" in url:
            # Newer Reolink cameras (CX810 etc.) use H.265 on main stream.
            # Sub-stream is always H.264 regardless of main-stream codec.
            return url.replace("/h265Preview_01_main", "/h264Preview_01_sub")
        return None

    def _open_capture(self):
        src = self.cfg.get("rtsp_url") or self.cfg.get("snapshot_url")
        if not src:
            raise RuntimeError(f"Kamera {self.camera_id}: keine Quelle gesetzt")
        if self.cfg.get("rtsp_url"):
            import os
            rtsp_url = self.cfg["rtsp_url"]

            # ── Main stream: motion detection + event snapshots ──────────────
            # TCP + software decode to prevent H.265 tile-split pink artifact.
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|hwaccel;none"
            cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            # Read timeout — without this, cap.read() blocks indefinitely
            # when the network pipe goes black mid-stream and the main loop
            # can't check self._force_reconnect / self.running until a frame
            # eventually arrives (which may never happen). 6 s is long
            # enough that healthy streams with occasional packet loss don't
            # trip it, short enough that a real dropout reaches the
            # exception handler and reconnect path quickly.
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000)
            _RES_MAP = {"720p": (1280, 720), "1080p": (1920, 1080), "4k": (3840, 2160)}
            _res = self.cfg.get("resolution", "auto")
            if _res in _RES_MAP:
                _w, _h = _RES_MAP[_res]
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, _w)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, _h)
            if not cap.isOpened():
                raise RuntimeError(f"Kamera {self.camera_id}: RTSP konnte nicht geöffnet werden")
            self.capture = cap
            # Mark the RTSP-open moment so the [cam:<id>] RTSP opened line
            # can include the first-frame latency. Picked up by _loop()
            # the next time a fresh frame is decoded.
            self._rtsp_opened_at = time.time()
            self._rtsp_first_frame_logged = False

            # ── Sub-stream: H.264 preview for dashboard (no pink) ────────────
            # Opened under _preview_cap_lock so _preview_loop sees a consistent handle.
            sub_url = self._sub_stream_url(rtsp_url)
            if sub_url:
                try:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
                    pcap = cv2.VideoCapture(sub_url, cv2.CAP_FFMPEG)
                    pcap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    pcap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000)
                    with self._preview_cap_lock:
                        old = self.preview_cap
                        if pcap.isOpened():
                            self.preview_cap = pcap
                            log_cam.info("[%s] Sub-stream opened for preview: %s", self.camera_id, sub_url)
                        else:
                            pcap.release()
                            self.preview_cap = None
                    # Release old handle outside the lock to avoid blocking _preview_loop
                    if old is not None:
                        try:
                            old.release()
                        except Exception:
                            pass
                except Exception as e:
                    log_cam.warning("[%s] Sub-stream open failed: %s", self.camera_id, e)
                    with self._preview_cap_lock:
                        self.preview_cap = None

            self.connect_time = time.time()
            self.prev_gray = None  # reset motion state on reconnect
        else:
            self.capture = None

    def _preview_loop(self):
        """Dedicated thread: sole reader of self.preview_cap (sub-stream).
        Stores clean frames into self._preview_frame under self.lock.
        No other thread touches preview_cap or _preview_frame directly.
        """
        while self.running:
            with self._preview_cap_lock:
                cap = self.preview_cap
            if cap is None:
                time.sleep(0.5)
                continue
            try:
                with self._preview_cap_lock:
                    # Re-check under lock: cap may have been replaced during reconnect
                    cap = self.preview_cap
                    if cap is None or not cap.isOpened():
                        time.sleep(0.2)
                        continue
                    ok, frame = cap.read()
                if ok and frame is not None:
                    r = float(frame[:, :, 2].mean())
                    b = float(frame[:, :, 0].mean())
                    if not (r > b * 2.5 and r > 150):  # skip pink/artifact frames
                        h, w = frame.shape[:2]
                        self._preview_resolution = f"{w}×{h}"
                        with self.lock:
                            self._preview_frame = frame
                        # Wetter-Sichtungen prebuffer hook — only spends CPU
                        # on JPEG encoding when a WeatherService has actually
                        # attached a buffer to this camera.
                        if self.weather_prebuffer is not None:
                            self.weather_prebuffer.push(frame)
                        # Measure sub-stream FPS over a rolling 5s window
                        self._preview_fps_frames += 1
                        elapsed = time.time() - self._preview_fps_window_start
                        if elapsed >= 5.0:
                            self._preview_fps = round(self._preview_fps_frames / elapsed, 1)
                            self._preview_fps_frames = 0
                            self._preview_fps_window_start = time.time()
            except Exception:
                time.sleep(0.2)

    def _grab_frame(self):
        if self.cfg.get("rtsp_url"):
            if self.capture is None or not self.capture.isOpened():
                self._open_capture()
            ok, frame = self.capture.read()
            if not ok or frame is None:
                raise RuntimeError(f"Kamera {self.camera_id}: Frame lesen fehlgeschlagen")
            # Reject H.265 pink/magenta corruption frames (hardware decode artifact)
            r = float(frame[:, :, 2].mean())
            b = float(frame[:, :, 0].mean())
            if r > b * 2.5 and r > 150:
                log.debug("[%s] Pink frame discarded (R=%.0f B=%.0f)", self.camera_id, r, b)
                for _ in range(3):
                    ok2, frame2 = self.capture.read()
                    if ok2 and frame2 is not None:
                        r2 = float(frame2[:, :, 2].mean())
                        b2 = float(frame2[:, :, 0].mean())
                        if not (r2 > b2 * 2.5 and r2 > 150):
                            return frame2
                raise RuntimeError(f"Kamera {self.camera_id}: Frame nach Pink-Discard fehlgeschlagen")
            return frame
        url = self.cfg.get("snapshot_url")
        auth = None
        if self.cfg.get("username") and self.cfg.get("password"):
            auth = (self.cfg.get("username"), self.cfg.get("password"))
        resp = requests.get(url, auth=auth, timeout=8)
        resp.raise_for_status()
        frame = cv2.imdecode(np.frombuffer(resp.content, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError(f"Kamera {self.camera_id}: Snapshot lesen fehlgeschlagen")
        return frame

    def _is_frame_valid(self, frame) -> bool:
        """Reject corrupt, uniform-gray, white, pink-artifact, or near-black frames.
        Also rejects frames with large solid-color quadrants (RTSP corruption pattern)
        and frames with JPEG block artifacts (abnormally uniform 8×8 blocks).
        False-positive analysis: cam-Werkstatt.rechts.oben fires heavily during cloud/sun
        transitions and whenever H.265 decode produces solid magenta quadrants — both
        pass the simple channel-mean test but fail quadrant-HSV and block-variance checks."""
        if frame is None or frame.size == 0:
            return False
        h, w = frame.shape[:2]
        if w < 64 or h < 48:
            return False
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mean_val = float(np.mean(gray))
        if mean_val < 8 or mean_val > 250:
            return False
        b_ch, g_ch, r_ch = cv2.split(frame)
        mean_r = float(r_ch.mean())
        mean_g = float(g_ch.mean())
        # Reject H.265 pink/magenta corruption: dominant red channel + low green/blue
        if mean_r > 180 and mean_r > mean_g * 2:
            return False
        # Reject frames where >40% of pixels are R≈G≈B (uniform gray/white)
        uniform = np.sum(
            (np.abs(r_ch.astype(np.int16) - g_ch.astype(np.int16)) < 10) &
            (np.abs(r_ch.astype(np.int16) - b_ch.astype(np.int16)) < 10)
        )
        if uniform > 0.4 * h * w:
            return False
        # Quadrant solid-color check: reject if any quadrant is >60% high-saturation
        # pink/magenta (H=135–165 in OpenCV's 0–179 scale, which maps 270–330°)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        hh, hw = h // 2, w // 2
        for qy, qx in [(0, 0), (0, hw), (hh, 0), (hh, hw)]:
            q = hsv[qy:qy + hh, qx:qx + hw]
            q_h, q_s, q_v = q[:, :, 0], q[:, :, 1], q[:, :, 2]
            vivid = (q_s > 178) & (q_v > 127)
            pink = vivid & (q_h >= 135) & (q_h <= 165)
            qpix = hh * hw
            if qpix > 0 and float(np.sum(pink)) / qpix > 0.60:
                log.debug("[%s] Corrupt quadrant (pink/magenta >60%%), frame rejected", self.camera_id)
                return False
        # JPEG block-artifact check: if >50% of sampled 8×8 blocks have near-zero
        # variance the image is a solid-fill decode artifact, not a real scene.
        bs = 8
        low_var = 0
        total_blocks = 0
        for by in range(0, h - bs, bs * 3):
            for bx in range(0, w - bs, bs * 3):
                blk = gray[by:by + bs, bx:bx + bs]
                if float(np.var(blk)) < 2.0:
                    low_var += 1
                total_blocks += 1
        if total_blocks > 0 and low_var > total_blocks * 0.50:
            log.debug("[%s] Block-artifact frame rejected (%d/%d uniform blocks)",
                      self.camera_id, low_var, total_blocks)
            return False
        return True

    def _is_frame_too_different(self, frame, prev_frame) -> bool:
        """Return True if mean absolute difference vs previous frame exceeds 60 (glitch/corrupt)."""
        if prev_frame is None or frame.shape != prev_frame.shape:
            return False
        mad = float(np.mean(np.abs(frame.astype(np.int16) - prev_frame.astype(np.int16))))
        return mad > 60

    @staticmethod
    def _has_corrupt_strip(frame, strip_height: int = 60) -> bool:
        """Detect H.264 corrupt bottom strip (pink/rainbow codec artifact)."""
        if frame is None or frame.shape[0] < strip_height * 2:
            return False
        strip = frame[-strip_height:, :, :]
        hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
        sat = hsv[:, :, 1].astype(np.float32)
        return float(sat.mean()) > 120 and float(sat.std()) > 60


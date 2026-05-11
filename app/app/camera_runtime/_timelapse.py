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
from ..io_utils import atomic_write_json
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


class TimelapseMixin:
    """Periodic timelapse capture/finalize loops + achievement unlocks.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def _cleanup_stale_timelapse_frames(self):
        """Scan timelapse frame directories on startup and log what was found.
        - Previous-day directories: preserved so _finalize_orphaned_windows can encode
          them when the profile loop starts (restart-safe behavior).
        - Today's directories: all except the newest per profile are cleaned up
          (mid-run windows that were abandoned without encode).
        Called once on startup before any profile thread begins."""
        import shutil
        storage_root = Path(self.global_cfg["storage"]["root"])
        today = datetime.now().strftime("%Y-%m-%d")
        tl_base = storage_root / "timelapse_frames" / self.camera_id
        if not tl_base.exists():
            return
        for profile_dir in tl_base.iterdir():
            if not profile_dir.is_dir():
                continue
            all_windows = sorted([d for d in profile_dir.iterdir() if d.is_dir()])
            for i, window_dir in enumerate(all_windows):
                dir_date = window_dir.name[:10]
                if dir_date < today:
                    # Previous day: keep frames on disk — the profile loop will call
                    # _finalize_orphaned_windows() which encodes and then deletes them.
                    n = len(list(window_dir.glob("*.jpg")))
                    log_tl.info(
                        "[%s][media] previous-day frames preserved for encoding: "
                        "%s/%s (%d frames) — will be encoded on profile startup",
                        self.camera_id, profile_dir.name, window_dir.name, n)
                elif dir_date == today and i < len(all_windows) - 1:
                    # Today but not the newest window → abandoned mid-run, safe to delete
                    try:
                        shutil.rmtree(str(window_dir))
                        log_tl.info("[%s][media] cleaned abandoned window (today): %s/%s",
                                 self.camera_id, profile_dir.name, window_dir.name)
                    except Exception as e:
                        log_tl.warning("[%s][media] abandoned cleanup failed for %s: %s",
                                    self.camera_id, window_dir, e)

    def _finalize_timelapse_window(self, profile_name: str, window_key: str,
                                   target_s: int, target_fps: int, period_s: int = 0):
        """Encode a completed timelapse window into a video, write a sidecar metadata JSON
        next to the video (NOT in EventStore), then delete the frame directory.
        Called from _timelapse_profile_loop only."""
        import json as _json
        import shutil

        from ..timelapse import TimelapseBuilder as _TLB
        storage_root = Path(self.global_cfg["storage"]["root"])
        frames_dir = storage_root / "timelapse_frames" / self.camera_id / profile_name / window_key
        if not frames_dir.exists():
            log_tl.debug("[%s][%s] finalize: no frames dir for window %s",
                      self.camera_id, profile_name, window_key)
            return
        images = sorted(frames_dir.glob("*.jpg"))
        n = len(images)
        if n < 2:
            log_tl.debug("[%s][%s] finalize: only %d frames in window %s — skipping encode",
                      self.camera_id, profile_name, n, window_key)
            try:
                shutil.rmtree(str(frames_dir))
                log_tl.debug("[%s][%s] cleaned sparse dir: %s", self.camera_id, profile_name, frames_dir.name)
            except Exception as e:
                log_tl.warning("[%s][%s] cleanup failed: %s", self.camera_id, profile_name, e)
            return

        log_tl.info("[%s][timelapse] encoding window %s/%s (%d frames → %ds @ %dfps)",
                 self.camera_id, profile_name, window_key, n, target_s, target_fps)
        out_dir = storage_root / "timelapse" / self.camera_id
        out_dir.mkdir(parents=True, exist_ok=True)

        builder = _TLB(storage_root)
        stem = builder.make_output_name(window_key, profile_name, period_s, target_s)
        out_path = out_dir / f"{stem}.mp4"
        _t0 = time.monotonic()
        path = builder._write_video(images, out_path, target_s, target_fps)
        elapsed = time.monotonic() - _t0

        if path:
            size_mb = round(out_path.stat().st_size / 1024 / 1024, 2) if out_path.exists() else 0
            log_tl.info("[%s][timelapse] encoded %s: %d frames → %ds video in %.1fs real time (%.1f MB)",
                        self.camera_id, out_path.name, n, target_s, elapsed, size_mb)
            # Extract a thumbnail from the middle frame of the finished video
            thumb_path = out_dir / f"{stem}.jpg"
            if not thumb_path.exists():
                try:
                    import cv2 as _cv2
                    cap = _cv2.VideoCapture(str(out_path))
                    total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                    if total > 0:
                        cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                    ok_t, frame_t = cap.read()
                    cap.release()
                    if ok_t and frame_t is not None:
                        tw = frame_t.shape[1]
                        if tw > 640:
                            scale = 640 / tw
                            frame_t = _cv2.resize(frame_t, (640, int(frame_t.shape[0] * scale)))
                        _cv2.imwrite(str(thumb_path), frame_t,
                                     [int(_cv2.IMWRITE_JPEG_QUALITY), 82])
                except Exception as _te:
                    log_tl.debug("[%s][timelapse] thumb failed: %s", self.camera_id, _te)
            # Write sidecar JSON next to the video — kept as fast index for the
            # /api/camera/<id>/timelapse/list endpoint
            try:
                meta = {
                    "event_id": f"tl_{stem}",
                    "camera_id": self.camera_id,
                    "type": "timelapse",
                    "profile": profile_name,
                    "window_key": window_key,
                    "period_s": period_s,
                    "target_s": target_s,
                    "frame_count": n,
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "filename": out_path.name,
                    "relpath": f"timelapse/{self.camera_id}/{out_path.name}",
                    "size_mb": size_mb,
                }
                # Merge per-window capture stats (_stats.json next to the
                # frames). Empty dict if missing — the build still writes a
                # sidecar with everything else.
                from ..frame_helpers import read_capture_stats
                cap_stats = read_capture_stats(frames_dir)
                if cap_stats:
                    meta["capture_stats"] = cap_stats
                meta_path = out_dir / f"{stem}.json"
                atomic_write_json(meta_path, meta)
                log_tl.debug("[%s][timelapse] sidecar JSON written: %s", self.camera_id, meta_path.name)
            except Exception as e:
                log_tl.warning("[%s][timelapse] sidecar write failed: %s", self.camera_id, e)
            # Register a unified EventStore entry so the media grid and filters
            # treat timelapse like any other event.
            try:
                public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
                video_rel = f"timelapse/{self.camera_id}/{out_path.name}"
                thumb_rel = f"timelapse/{self.camera_id}/{stem}.jpg" if thumb_path.exists() else None
                tl_event = {
                    "event_id": f"tl_{stem}",
                    "camera_id": self.camera_id,
                    "camera_name": self.cfg.get("name", self.camera_id),
                    "type": "timelapse",
                    "labels": ["timelapse"],
                    "top_label": "timelapse",
                    "time": datetime.now().isoformat(timespec="seconds"),
                    "profile": profile_name,
                    "window_key": window_key,
                    "period_s": period_s,
                    "target_s": target_s,
                    "frame_count": n,
                    "filename": out_path.name,
                    "video_relpath": video_rel,
                    "video_url": f"{public_base}/media/{video_rel}" if public_base else f"/media/{video_rel}",
                    "snapshot_relpath": thumb_rel,
                    "snapshot_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "thumb_url": (f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}") if thumb_rel else None,
                    "size_mb": size_mb,
                    "duration_s": 0.0,
                    "file_size_bytes": out_path.stat().st_size if out_path.exists() else 0,
                    # Timelapse uses the same event shape as motion clips
                    # so the lightbox + grid render uniformly, but the
                    # detection-pipeline fields don't apply here — the
                    # frontend sees `mode: "timelapse"` and shows the
                    # scrubber-only chrome (no settings panel).
                    "recording_settings": {"mode": "timelapse"},
                }
                self.store.add_event(self.camera_id, tl_event)
                log_tl.info("[%s][timelapse] event registered: %s", self.camera_id, tl_event["event_id"])
            except Exception as e:
                log_tl.warning("[%s][timelapse] EventStore register failed: %s", self.camera_id, e)
            # Push the finished video to Telegram. Gated by push.timelapse.enabled
            # inside the notifier, so a global toggle disables this without
            # touching the camera config.
            try:
                if self.notifier and hasattr(self.notifier, "send_timelapse_alert"):
                    profile_de = {
                        "daily":   "Tag",
                        "weekly":  "Woche",
                        "monthly": "Monat",
                        "custom":  "Custom",
                    }.get(profile_name, profile_name)
                    self.notifier.send_timelapse_alert(
                        video_path=out_path,
                        cam_name=self.cfg.get("name", self.camera_id),
                        profile_de=profile_de,
                        duration_s=int(target_s),
                        rel_path=video_rel,
                    )
            except Exception as e:
                log_tl.warning("[%s][timelapse] push failed: %s", self.camera_id, e)
        else:
            log_tl.warning("[%s][timelapse] encode failed for window %s/%s", self.camera_id, profile_name, window_key)

        # Always clean up frames regardless of encode outcome
        try:
            shutil.rmtree(str(frames_dir))
            log_tl.info("[%s][timelapse] cleaned %d frames for window %s/%s",
                     self.camera_id, n, profile_name, window_key)
        except Exception as e:
            log_tl.warning("[%s][timelapse] frame cleanup failed: %s", self.camera_id, e)

    def _finalize_orphaned_windows(self, profile_name: str, current_key: str,
                                    target_s: int, target_fps: int, period_s: int):
        """Scan the profile's frame directory for any windows other than current_key and finalize them.
        Called after a new window is started so stale/abandoned windows get encoded and cleaned."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        profile_dir = storage_root / "timelapse_frames" / self.camera_id / profile_name
        if not profile_dir.exists():
            return
        for window_dir in sorted(profile_dir.iterdir()):
            if not window_dir.is_dir() or window_dir.name == current_key:
                continue
            log_tl.info("[%s][%s] orphaned window found: %s — finalizing",
                     self.camera_id, profile_name, window_dir.name)
            self._finalize_timelapse_window(profile_name, window_dir.name, target_s, target_fps, period_s)

    def _timelapse_loop(self):
        """Legacy single-profile timelapse. Reads latest frame from main loop — no direct camera access."""
        _period_map = {"day": 86400, "hour": 3600, "rolling_10min": 600}
        while self.running:
            tl = self.cfg.get("timelapse") or {}
            if not tl.get("enabled"):
                time.sleep(10)
                continue
            target_s = int(tl.get("daily_target_seconds", 60))
            target_fps = int(tl.get("fps", 25))
            period_s = _period_map.get(tl.get("period", "day"), 86400)
            total_frames = max(1, target_s * target_fps)
            interval_s = max(0.5, period_s / total_frames)
            jpeg_q = 50 if interval_s < 1.0 else 72
            # Read latest frame from shared buffer — no independent camera connection
            with self.lock:
                frame = self.frame.copy() if self.frame is not None else None
            if frame is not None:
                try:
                    tl_dir = (Path(self.global_cfg["storage"]["root"])
                              / "timelapse_frames" / self.camera_id
                              / datetime.now().strftime("%Y-%m-%d"))
                    tl_dir.mkdir(parents=True, exist_ok=True)
                    ts = datetime.now().strftime("%H%M%S")
                    out = tl_dir / f"{ts}.jpg"
                    cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])
                    log_tl.debug("[%s] timelapse frame saved: %s (interval=%.2fs, q=%d)", self.camera_id, out.name, interval_s, jpeg_q)
                except Exception as e:
                    log_tl.debug("[%s] timelapse frame write error: %s", self.camera_id, e)
            deadline = time.time() + interval_s
            while self.running and time.time() < deadline:
                time.sleep(1)

    def _timelapse_profile_loop(self, profile_name: str):
        """Per-profile timelapse capture loop. Reads latest frame from main loop — no direct camera access.
        Tracks period windows: encodes, registers, and cleans up frames when each window ends.
        - custom: fixed-duration rolling windows (period_seconds long each)
        - daily/weekly/monthly: one window per calendar day, encoded at day boundary
        """
        from ..frame_helpers import (
            CaptureStats as _CaptureStats,
            DAY_PROFILE as _DAY_PROFILE,
            hamming_distance as _ph_hamming,
            is_valid_frame as _fh_valid,
            perceptual_hash as _ph_phash,
            pick_profile_from_baseline as _pick_profile,
        )
        window_key: str | None = None
        window_start_t: float = 0.0
        _last_frame_ts: float = 0.0   # frame_ts at last capture — detects stale buffer
        # Capture-side dedup guard. The frame_ts == _last_frame_ts test
        # below catches "RTSP buffer literally hasn't changed", but the
        # main loop assigns a new frame_ts on every grab regardless of
        # pixel content — so a stuck camera that hands us the same
        # buffer with a fresh timestamp slips past. The pHash leg here
        # rejects frames whose perceptual hash is within hamming-4 of
        # the most recently saved frame: replicated buffers never
        # write to disk, the encoder never has to filter them, and the
        # storage footprint shrinks too. Reset on window roll-over.
        _last_saved_phash: int = 0
        _saved_dup_dropped: int = 0
        # Per-camera adaptive validator profile. Re-evaluated every 5 min
        # using the most-recent shared frame buffer (no extra snapshot
        # call — the camera_runtime main loop already keeps `self.frame`
        # fresh). Defaults to DAY so the first iteration before any
        # baseline pick keeps the historic behaviour.
        active_profile = _DAY_PROFILE
        next_profile_repick_t: float = 0.0
        # Per-window stats. Replaced when the window key rolls over so each
        # day/period gets its own _stats.json next to its frames.
        stats: _CaptureStats | None = None
        stats_window_key: str | None = None
        # Per-profile stale streak — local instead of a self. attribute so
        # two profiles running at different cadences don't corrupt each
        # other's counter. self._stale_streak is still written for the
        # status UI (acts as a "max recent" mirror).
        stale_streak: int = 0

        while self.running:
            tl = self.cfg.get("timelapse") or {}
            prof = (tl.get("profiles") or {}).get(profile_name) or {}
            if not prof.get("enabled"):
                if window_key is not None:
                    log_tl.debug("[%s][%s] profile disabled — resetting window %s", self.camera_id, profile_name, window_key)
                window_key = None
                window_start_t = 0.0
                time.sleep(10)
                continue

            target_s = int(prof.get("target_seconds", 60))
            # Per-profile fps falls back to the camera-level fps, then 25.
            target_fps = int(prof.get("fps") or tl.get("fps") or 25)
            period_s = int(prof.get("period_seconds", _PROFILE_PERIOD_DEFAULTS.get(profile_name, 86400)))
            total_frames = max(1, target_s * target_fps)
            interval_s = max(0.5, period_s / total_frames)
            jpeg_q = 50 if interval_s < 1.0 else 72

            now = datetime.now()
            now_t = time.time()

            # ── Determine current window key and handle period boundaries ─────
            if profile_name == "custom":
                if window_key is None:
                    # Start first window
                    window_start_t = now_t
                    window_key = now.strftime("%Y-%m-%d_%H%M%S")
                    log_tl.info("[%s][timelapse] custom window started: %s (period=%ds interval=%.0fs)",
                             self.camera_id, window_key, period_s, interval_s)
                elif now_t - window_start_t >= period_s:
                    # Period elapsed — finalize current window and start fresh
                    old_key = window_key
                    self._finalize_timelapse_window(profile_name, old_key, target_s, target_fps, period_s)
                    window_start_t = now_t
                    window_key = now.strftime("%Y-%m-%d_%H%M%S")
                    log_tl.info("[%s][timelapse] custom new window: %s", self.camera_id, window_key)
                    # Scan for any other abandoned windows and clean them
                    self._finalize_orphaned_windows(profile_name, window_key, target_s, target_fps, period_s)
            else:
                # Calendar-based: one window per calendar day
                new_key = now.strftime("%Y-%m-%d")
                if window_key is not None and new_key != window_key:
                    # Day rolled over — finalize the completed day
                    old_key = window_key
                    self._finalize_timelapse_window(profile_name, old_key, target_s, target_fps, period_s)
                    log_tl.info("[%s][timelapse] %s day boundary: finalized %s, starting %s",
                             self.camera_id, profile_name, old_key, new_key)
                if window_key is None or new_key != window_key:
                    window_key = new_key
                    log_tl.info("[%s][timelapse] %s window: %s (period=%ds interval=%.0fs)",
                             self.camera_id, profile_name, window_key, period_s, interval_s)
                    # Scan for abandoned windows from prior days
                    self._finalize_orphaned_windows(profile_name, window_key, target_s, target_fps, period_s)

            # ── Capture frame into the current window directory ───────────────
            with self.lock:
                frame = self.frame.copy() if self.frame is not None else None
                frame_ts = self.frame_ts
            if frame is not None and window_key is not None:
                try:
                    # Staleness guard: skip only when the frame buffer hasn't been updated
                    # since the last capture — this means the RTSP stream is genuinely stuck.
                    # A static scene (identical content, new timestamp) is intentionally saved.
                    if frame_ts == _last_frame_ts:
                        age_s = time.time() - frame_ts
                        self._stale_incidents += 1
                        stale_streak += 1
                        self._stale_streak = stale_streak  # mirror for status UI
                        # Noise control: only surface streak 1 and 5 at
                        # WARNING (first sign + "this is getting bad"),
                        # everything in between goes to DEBUG. The reconnect
                        # decision still uses the full streak.
                        if stale_streak in (1, 5):
                            log_tl.warning("[%s][%s] stale frame buffer (age=%.0fs, streak=%d) — RTSP stream may be stuck",
                                          self.camera_id, profile_name, age_s, stale_streak)
                        else:
                            log_tl.debug("[%s][%s] stale frame buffer (age=%.0fs, streak=%d)",
                                         self.camera_id, profile_name, age_s, stale_streak)
                        # After 15 consecutive stale intervals, request a forced RTSP reconnect
                        if stale_streak >= 15 and not self._force_reconnect:
                            log_tl.error("[%s][%s] stale streak exceeded threshold — requesting RTSP reconnect",
                                        self.camera_id, profile_name)
                            self._force_reconnect = True
                        # Don't advance _last_frame_ts so we keep detecting stale each interval
                    else:
                        _last_frame_ts = frame_ts
                        if stale_streak > 0:
                            log_cam.info("[%s][%s] stream recovered after %d stale intervals",
                                         self.camera_id, profile_name, stale_streak)
                        stale_streak = 0  # reset local streak on any fresh frame
                        self._stale_streak = 0  # clear the UI mirror too
                        # Resolve the per-window stats container (lazy: first
                        # frame in a window gets a fresh CaptureStats keyed
                        # to that window's frame directory).
                        tl_dir = (Path(self.global_cfg["storage"]["root"])
                                  / "timelapse_frames" / self.camera_id
                                  / profile_name / window_key)
                        if stats is None or stats_window_key != window_key:
                            tl_dir.mkdir(parents=True, exist_ok=True)
                            stats = _CaptureStats(out_dir=tl_dir,
                                                  expected_frames=int(period_s / max(0.5, interval_s)))
                            stats_window_key = window_key
                            # Reset the dedup pHash on a fresh window —
                            # a window-boundary scene shift would
                            # otherwise look like a "duplicate" of the
                            # last frame of the previous window.
                            _last_saved_phash = 0
                            _saved_dup_dropped = 0
                        # Adaptive validator profile re-pick — every 5 min,
                        # using the freshest shared frame as the baseline so
                        # there's no extra capture cost. A camera that
                        # transitions from DAY to TWILIGHT to NIGHT over a
                        # full diurnal cycle gets the right thresholds at
                        # each phase without manual config.
                        _now_t = time.time()
                        if _now_t >= next_profile_repick_t:
                            try:
                                new_prof = _pick_profile([frame])
                                if new_prof is not active_profile:
                                    log_tl.info(
                                        "[timelapse] %s/%s profile-switch %s → %s",
                                        self.camera_id, profile_name,
                                        active_profile.name.upper(),
                                        new_prof.name.upper(),
                                    )
                                    active_profile = new_prof
                            except Exception:
                                pass
                            next_profile_repick_t = _now_t + 300.0
                        # Three-attempt validity check. The shared frame buffer
                        # is refreshed by the main RTSP loop, so a 0.7 s pause
                        # between attempts gives the decode loop time to
                        # produce a fresh frame past the hickup. We only
                        # attempt up to 3 times — past that the slot stays
                        # empty (gap-tolerant: ffmpeg concat just skips it).
                        ok, reason = _fh_valid(frame, profile=active_profile)
                        attempt_used = 0
                        # For the daily profile we emit a per-rejection INFO
                        # line on every failed attempt — diagnostic to
                        # explain dawn-hour gaps in the assembled video.
                        # Other profiles stay on the existing post-3-attempts
                        # summary to keep the log volume sane.
                        if not ok and profile_name == "daily":
                            log_tl.info(
                                "[timelapse] %s/daily reject @ %s (attempt 1): %s",
                                self.camera_id, now.strftime("%H:%M:%S"), reason,
                            )
                        if not ok:
                            for retry in range(1, 3):
                                time.sleep(0.7)
                                with self.lock:
                                    cand = self.frame.copy() if self.frame is not None else None
                                if cand is None:
                                    continue
                                ok, reason = _fh_valid(cand, profile=active_profile)
                                if not ok and profile_name == "daily":
                                    log_tl.info(
                                        "[timelapse] %s/daily reject @ %s (attempt %d): %s",
                                        self.camera_id, datetime.now().strftime("%H:%M:%S"),
                                        retry + 1, reason,
                                    )
                                if ok:
                                    frame = cand
                                    attempt_used = retry
                                    break
                        if not ok:
                            stats.record_invalid(reason)
                            log_tl.info("[timelapse] %s frame %s: invalid grabs, leaving slot empty (%s)",
                                        self.camera_id, now.strftime("%H%M%S_%f")[:10], reason)
                        else:
                            # Capture-side dedup guard — drop the frame
                            # before it hits disk if its perceptual hash
                            # is within hamming-4 of the most recently
                            # saved frame. Without this, a stuck stream
                            # that delivers the same buffer with a fresh
                            # timestamp inflates the on-disk footprint
                            # AND produces frozen-time runs in the
                            # encoded video.
                            this_phash = _ph_phash(frame)
                            if (_last_saved_phash != 0
                                    and _ph_hamming(_last_saved_phash, this_phash) <= 4):
                                _saved_dup_dropped += 1
                                if _saved_dup_dropped in (1, 5, 25, 100):
                                    log_tl.info(
                                        "[timelapse] %s/%s skipped duplicate frame "
                                        "(pHash match) — total dropped this run: %d",
                                        self.camera_id, profile_name, _saved_dup_dropped,
                                    )
                            else:
                                ts = now.strftime("%H%M%S_%f")[:10]
                                out = tl_dir / f"{ts}.jpg"
                                cv2.imwrite(str(out), frame, [int(cv2.IMWRITE_JPEG_QUALITY), jpeg_q])
                                stats.record_capture(attempt_used=attempt_used)
                                _last_saved_phash = this_phash
                                log_tl.debug("[%s][%s] frame saved: %s window=%s (%.2fs/frame, q=%d, attempt=%d)",
                                          self.camera_id, profile_name, out.name, window_key, interval_s, jpeg_q,
                                          attempt_used + 1)
                        # Cheap to flush each interval; lets the build path
                        # see partial-window stats if it runs while capture
                        # is still going.
                        stats.flush()
                except Exception as e:
                    log_tl.debug("[%s][%s] frame write error: %s", self.camera_id, profile_name, e)

            deadline = time.time() + interval_s
            while self.running and time.time() < deadline:
                time.sleep(1)

    def _try_unlock_achievement(self, species_name: str, species_label: str) -> bool:
        """Unlock achievement for a bird/animal species. Returns True if newly unlocked."""
        ach_id = _SPECIES_TO_ACH_ID.get(species_name.lower().strip())
        if not ach_id:
            return False
        try:
            with self._ach_lock:
                data: dict = {}
                if self._ach_path.exists():
                    try:
                        data = _json_mod.loads(self._ach_path.read_text(encoding="utf-8"))
                    except Exception:
                        data = {}
                if ach_id in data:
                    return False  # already unlocked
                data[ach_id] = {
                    "date": datetime.now().isoformat(timespec="seconds"),
                    "camera_id": self.camera_id,
                    "species": species_label,
                }
                atomic_write_json(self._ach_path, data)
            log.info("[%s] Achievement unlocked: %s (%s)", self.camera_id, ach_id, species_label)
            return True
        except Exception as e:
            log.warning("[%s] Achievement unlock failed: %s", self.camera_id, e)
            return False


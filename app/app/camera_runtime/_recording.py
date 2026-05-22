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


class RecordingMixin:
    """Motion-clip lifecycle: ffmpeg start/stop + reencode + finalize + adhoc.

    Mixin for CameraRuntime. Methods access shared state via `self.*`
    (frame buffers, lock, config, etc.) which live on the concrete class.
    """

    def _write_clip_ffmpeg(self, frames, fps, out_path) -> bool:
        """Encode raw BGR frames to H.264/mp4 via ffmpeg pipe.

        Browsers cannot decode the mp4v codec cv2.VideoWriter produces.
        Piping raw BGR into libx264 yields a faststart-optimised mp4 that plays
        natively in every modern browser. Returns False on any failure so the
        caller can fall back to mp4v.
        """
        import subprocess as _sp

        if not frames:
            return False
        h, w = frames[0].shape[:2]
        fps_c = max(5.0, min(30.0, float(fps)))
        cmd = [
            'ffmpeg',
            '-y',
            '-f',
            'rawvideo',
            '-vcodec',
            'rawvideo',
            '-pix_fmt',
            'bgr24',
            '-s',
            f'{w}x{h}',
            '-r',
            str(fps_c),
            '-i',
            'pipe:0',
            '-vcodec',
            'libx264',
            '-preset',
            'fast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            str(out_path),
        ]
        try:
            proc = _sp.Popen(cmd, stdin=_sp.PIPE, stdout=_sp.PIPE, stderr=_sp.PIPE)
            last_good = frames[0]
            for f in frames:
                if self._is_frame_valid(f) and not self._is_frame_too_different(f, last_good):
                    proc.stdin.write(f.tobytes())
                    last_good = f
                else:
                    proc.stdin.write(last_good.tobytes())
            proc.stdin.close()
            _, stderr = proc.communicate(timeout=120)
            if proc.returncode != 0:
                log.error(
                    '[%s] ffmpeg encode failed: %s',
                    self.camera_id,
                    stderr.decode(errors='replace')[-800:],
                )
                return False
            return True
        except FileNotFoundError:
            log.warning('[%s] ffmpeg not found — falling back to mp4v', self.camera_id)
            return False
        except Exception as e:
            log.error('[%s] ffmpeg pipe error: %s', self.camera_id, e)
            return False

    def _write_recording_event_stub(
        self, event_id: str, meta: dict, start_time: datetime, status: str = "recording"
    ):
        """Write the event JSON for a clip whose encode is still in flight.
        Video fields are null; the frontend shows a 'recording'/'processing' state."""
        event = {
            "event_id": event_id,
            "camera_id": self.camera_id,
            "camera_name": self.cfg.get("name", self.camera_id),
            "armed": bool(self.cfg.get("armed", True)),
            "after_hours": meta["after_hours"],
            "alarm_level": meta["alarm_level"],
            "time": start_time.isoformat(timespec="seconds"),
            "labels": meta["labels"],
            "top_label": meta["top_label"],
            "bird_species": meta["bird_species"],
            "cat_name": meta["cat_name"],
            "person_name": meta["person_name"],
            "whitelisted": meta["whitelisted"],
            "detections": meta["detections"],
            "snapshot_url": None,
            "snapshot_relpath": None,
            "thumb_url": None,
            "video_url": None,
            "video_relpath": None,
            "duration_s": 0.0,
            "file_size_bytes": 0,
            "status": status,
            "recording_settings": self._build_recording_settings_snapshot(),
        }
        # The ffmpeg stream-copy path (this caller) starts the encoder
        # at trigger time — no in-memory pre-buffer. Override the
        # snapshot's default 3 s pre-roll so the lightbox timeline
        # renders the correct leading region.
        event["recording_settings"]["pre_motion_seconds"] = 0
        self.store.add_event(self.camera_id, event)

    def _start_ffmpeg_recording(self, start_time: datetime, meta: dict) -> bool:
        """Launch an ffmpeg subprocess that stream-copies the RTSP feed to disk.
        Returns True on success, False to let the caller fall back to OpenCV."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        day_dir = (
            storage_root / "motion_detection" / self.camera_id / start_time.strftime("%Y-%m-%d")
        )
        day_dir.mkdir(parents=True, exist_ok=True)
        event_id = start_time.strftime("%Y%m%d-%H%M%S-%f")
        raw_path = day_dir / f"{event_id}.raw.mp4"
        rtsp_url = self.cfg.get("rtsp_url")
        if not rtsp_url:
            return False
        cmd = [
            'ffmpeg',
            '-y',
            '-rtsp_transport',
            'tcp',
            '-i',
            rtsp_url,
            '-c',
            'copy',
            '-movflags',
            '+frag_keyframe+empty_moov',
            str(raw_path),
        ]
        try:
            proc = _subprocess.Popen(
                cmd,
                stdin=_subprocess.PIPE,
                stdout=_subprocess.DEVNULL,
                stderr=_subprocess.PIPE,
            )
        except FileNotFoundError:
            log.warning(
                "[%s] ffmpeg not found — using OpenCV frame buffer "
                "(playback speed may be incorrect)",
                self.camera_id,
            )
            return False
        except Exception as e:
            log.error("[%s] ffmpeg spawn failed: %s", self.camera_id, e)
            return False
        self._ffmpeg_proc = proc
        self._ffmpeg_out_path = raw_path
        self._ffmpeg_start_time = start_time
        self._rec_event_id = event_id
        # Persist a 'recording' stub so the dashboard can show the clip immediately
        try:
            self._write_recording_event_stub(event_id, meta, start_time, status="recording")
        except Exception as e:
            log.warning("[%s] recording stub write failed: %s", self.camera_id, e)
        log.info("[%s] Recording started via ffmpeg (%s)", self.camera_id, raw_path.name)
        return True

    def _stop_ffmpeg_and_queue_reencode(self):
        """Stop the running ffmpeg subprocess gracefully, then kick off a background
        thread that re-encodes the raw stream-copy to browser-friendly H.264."""
        proc = self._ffmpeg_proc
        raw_path = self._ffmpeg_out_path
        event_id = self._rec_event_id
        meta = self._rec_event_meta
        start_time = self._ffmpeg_start_time
        # Reset state so a new recording can start immediately
        self._ffmpeg_proc = None
        self._ffmpeg_out_path = None
        self._ffmpeg_start_time = None
        self._rec_event_id = None
        if proc is None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.write(b'q\n')
                    proc.stdin.flush()
                except Exception:
                    pass
            try:
                proc.wait(timeout=5)
            except _subprocess.TimeoutExpired:
                log.warning("[%s] ffmpeg did not exit on 'q', terminating", self.camera_id)
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except _subprocess.TimeoutExpired:
                    proc.kill()
        except Exception as e:
            log.warning("[%s] ffmpeg stop error: %s", self.camera_id, e)
        log.info(
            "[%s] Recording stopped (%s), queuing re-encode",
            self.camera_id,
            raw_path.name if raw_path else "?",
        )
        if raw_path is None or event_id is None or meta is None or start_time is None:
            return
        # Update status → processing so the UI shows the intermediate state
        try:
            ev = self.store.get_event(self.camera_id, event_id) or {}
            ev["status"] = "processing"
            self.store.update_event(self.camera_id, event_id, ev)
        except Exception:
            pass
        threading.Thread(
            target=self._reencode_motion_clip,
            args=(raw_path, event_id, meta, start_time),
            daemon=True,
        ).start()

    def _reencode_motion_clip(
        self, raw_path: Path, event_id: str, meta: dict, start_time: datetime
    ):
        """Background: transcode raw stream-copy → browser-friendly H.264.
        On success: delete the raw file, set video_url/snapshot/thumb/status=ready.
        On failure: keep raw as fallback, set encode_error on the event."""
        storage_root = Path(self.global_cfg["storage"]["root"])
        public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
        day_dir = raw_path.parent
        vid_path = day_dir / f"{event_id}.mp4"

        video_url = None
        video_relpath = None
        duration_s = 0.0
        file_size_bytes = 0
        encode_error = None
        try:
            if not raw_path.exists() or raw_path.stat().st_size < 1024:
                raise RuntimeError(
                    f"raw clip missing/empty ({raw_path.stat().st_size if raw_path.exists() else 0} bytes)"
                )
            cmd = [
                'ffmpeg',
                '-y',
                '-i',
                str(raw_path),
                '-vcodec',
                'libx264',
                '-preset',
                'fast',
                '-crf',
                '22',
                '-pix_fmt',
                'yuv420p',
                '-movflags',
                '+faststart',
                '-an',
                str(vid_path),
            ]
            r = _subprocess.run(cmd, capture_output=True, timeout=300)
            if r.returncode != 0 or not vid_path.exists() or vid_path.stat().st_size < 1024:
                stderr_text = (r.stderr or b'').decode('utf-8', errors='replace')
                raise RuntimeError(f"ffmpeg re-encode rc={r.returncode}: {stderr_text[-300:]}")
            # Verify
            check = cv2.VideoCapture(str(vid_path))
            fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
            cfps = check.get(cv2.CAP_PROP_FPS) or 0.0
            check.release()
            duration_s = round(fc / cfps, 2) if cfps > 0 else 0.0
            file_size_bytes = vid_path.stat().st_size
            rel = vid_path.relative_to(storage_root)
            video_url = (
                f"{public_base}/media/{rel.as_posix()}"
                if public_base
                else f"/media/{rel.as_posix()}"
            )
            video_relpath = rel.as_posix()
            # Delete raw on success
            try:
                raw_path.unlink()
            except Exception:
                pass
            log.info(
                "[%s] Re-encode complete: %s (%.1fs %dKB)",
                self.camera_id,
                vid_path.name,
                duration_s,
                file_size_bytes // 1024,
            )
        except Exception as e:
            log.error("[%s] Re-encode failed: %s", self.camera_id, e)
            encode_error = str(e)
            # Fallback: raw may still be playable — expose it if so
            if raw_path.exists() and raw_path.stat().st_size > 1024:
                rel = raw_path.relative_to(storage_root)
                video_url = (
                    f"{public_base}/media/{rel.as_posix()}"
                    if public_base
                    else f"/media/{rel.as_posix()}"
                )
                video_relpath = rel.as_posix()
                file_size_bytes = raw_path.stat().st_size

        # Thumbnail from whichever file is present
        thumb_source = vid_path if vid_path.exists() else (raw_path if raw_path.exists() else None)
        thumb_rel = None
        thumb_url = None
        if thumb_source is not None:
            thumb_path = day_dir / f"{event_id}.jpg"
            try:
                cap = cv2.VideoCapture(str(thumb_source))
                total_f = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                if total_f > 3:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, total_f // 3)
                ok_th, frame_th = cap.read()
                cap.release()
                if ok_th and frame_th is not None:
                    tw = frame_th.shape[1]
                    if tw > 640:
                        scale = 640 / tw
                        frame_th = cv2.resize(frame_th, (640, int(frame_th.shape[0] * scale)))
                    if cv2.imwrite(str(thumb_path), frame_th, [int(cv2.IMWRITE_JPEG_QUALITY), 75]):
                        thumb_rel = thumb_path.relative_to(storage_root).as_posix()
                        thumb_url = (
                            f"{public_base}/media/{thumb_rel}"
                            if public_base
                            else f"/media/{thumb_rel}"
                        )
            except Exception as _te:
                log.debug("[%s] motion thumb (post-encode) failed: %s", self.camera_id, _te)

        # Update the event JSON: transition from 'processing' → 'ready' (or 'error')
        try:
            ev = self.store.get_event(self.camera_id, event_id) or {}
            ev["video_url"] = video_url
            ev["video_relpath"] = video_relpath
            ev["duration_s"] = duration_s
            ev["file_size_bytes"] = file_size_bytes
            ev["snapshot_url"] = thumb_url
            ev["snapshot_relpath"] = thumb_rel
            ev["thumb_url"] = thumb_url
            ev["status"] = "ready" if video_url else "error"
            if encode_error:
                ev["encode_error"] = encode_error
            self.store.update_event(self.camera_id, event_id, ev)
        except Exception as e:
            log.warning("[%s] event JSON update failed: %s", self.camera_id, e)

        # MQTT + Telegram (best-effort, only when we actually produced a video)
        if video_url and self.mqtt and self.cfg.get("mqtt_enabled", True):
            try:
                self.mqtt.publish(
                    f"events/{self.camera_id}",
                    {
                        "event_id": event_id,
                        "labels": meta["labels"],
                        "time": start_time.isoformat(timespec="seconds"),
                        "video_url": video_url,
                        "snapshot_url": thumb_url,
                    },
                )
            except Exception:
                pass

        # Tracking sidecar — enqueue once per finalized clip so the
        # next Mediathek open finds <event>.tracks.json on disk. The
        # ffmpeg re-encode path used to skip this step; the legacy
        # OpenCV-buffer finalize did it, so the Lightbox kept showing
        # "Tracking wird generiert" on every first open of an
        # ffmpeg-recorded clip. video_relpath is the source of truth
        # for the playable file (vid_path on success, raw_path on
        # fallback) — derive the absolute path from it.
        if video_url and video_relpath:
            playable = storage_root / video_relpath
            snap = (storage_root / thumb_rel) if thumb_rel else None
            self._enqueue_tracks_for_clip(event_id, playable, snap)
        # Telegram alert is fired once, by the modern push pipeline in
        # _finalize_motion_clip via TelegramService.send_event_alert. The
        # legacy send_alert_sync alert that used to live here was a duplicate
        # — it produced a second bubble per detection with a different button
        # layout and confused users. Removed.

    def _enqueue_tracks_for_clip(
        self, event_id: str, video_path: Path, snapshot_path: Path | None
    ) -> None:
        """Hand the freshly-finalized clip to the post-clip tracking worker so
        the next Mediathek open finds a populated <video>.tracks.json sidecar.

        Called from BOTH finalize paths (ffmpeg re-encode AND OpenCV
        fallback) so every recorded clip ships with a sidecar — the
        Lightbox's reindex banner is meant for genuinely missing/corrupt
        sidecars, not for every fresh recording.
        """
        if not video_path or not video_path.exists():
            return
        try:
            from ..tracking_worker import TrackingJob, singleton as _tw_singleton

            worker = _tw_singleton()
            if worker is None:
                return
            worker.enqueue(
                TrackingJob(
                    event_id=event_id,
                    video_path=video_path,
                    snapshot_path=snapshot_path,
                    camera_id=self.camera_id,
                )
            )
        except Exception as _te:
            log.debug("[%s] tracking enqueue failed: %s", self.camera_id, _te)

    def _build_recording_settings_snapshot(self) -> dict:
        """Capture the detection config active at clip-finalize time.

        Stored under event["recording_settings"] so the lightbox can
        replay "what config produced this clip" without having to
        guess at the camera's current state when the user reviews it
        weeks later. Pure read of self.cfg + tiny normalisation; no
        side effects.
        """
        cw_global = (self.cfg.get("confirmation_window") or {}).get("global") or {}
        obj_filter = self.cfg.get("object_filter") or []
        return {
            "conf_thresh_general": float(self.cfg.get("detection_min_score") or 0.0),
            "conf_thresh_per_class": dict(self.cfg.get("label_thresholds") or {}),
            # null when the filter is empty — distinguishes "no filter
            # configured" from "filter has zero allowed classes" on
            # the frontend without a sentinel value.
            "object_filter": list(obj_filter) if obj_filter else None,
            "confirm_n": int(cw_global.get("n", 3)),
            "confirm_seconds": int(cw_global.get("seconds", 5)),
            "sample_interval_ms": int(self.cfg.get("frame_interval_ms") or 350),
            # Raw 0..1 float (same units as the schema). The frontend
            # multiplies by 100 for display so the rest of the API
            # surface — settings.json, /api/cameras — keeps the same
            # representation it has used since the wizard shipped.
            "motion_pretrigger_sensitivity": float(self.cfg.get("motion_sensitivity") or 0.5),
            # Pre-roll window — only the OpenCV-fallback recording path
            # uses an actual in-memory pre-buffer (3.0 s, hard-coded in
            # _main_loop's pre_cutoff). The ffmpeg stream-copy path
            # starts the encoder at trigger time, so pre-roll is 0 s
            # there. _finalize_motion_clip (this caller) IS the OpenCV
            # path; the ffmpeg re-encode path overrides this field
            # back to 0 inside _reencode_motion_clip's event update.
            "pre_motion_seconds": 3,
            "post_motion_seconds": int(self.cfg.get("post_motion_tail_s") or 0),
        }

    def _build_achievement_snapshot(self) -> dict:
        """Capture "what the configured settings actually produced"
        at finalize time. Only fields we can compute cheaply here go
        in synchronously — the post-hoc tracks.json-derived stats
        (tracks_by_class, peak_score_by_class, confirm_hits_by_track)
        are added by tracking_worker once it finishes its pass over
        the clip. Missing fields are intentionally omitted; the
        frontend renders "—" for what isn't there.

        Inference status mirrors the cam-edit Erkennung status strip:
          coral mode + low ms      → "ok"
          coral mode + ≥ 50 ms avg → "elevated"
          cpu fallback             → "cpu_emergency"
        """
        ach: dict = {}
        # inference_avg_ms — rolling mean from the runtime's deque.
        try:
            ms = getattr(self, "_inference_times_ms", None)
            if ms:
                ach["inference_avg_ms"] = round(sum(ms) / len(ms), 1)
        except Exception:
            pass
        # inference_status from detector.mode + average.
        try:
            det_mode = getattr(self.detector, "mode", "motion_only")
            avg = ach.get("inference_avg_ms")
            if det_mode == "cpu":
                ach["inference_status"] = "cpu_emergency"
            elif det_mode == "coral":
                ach["inference_status"] = "elevated" if avg is not None and avg >= 50.0 else "ok"
            # "motion_only" / "off" → no inference, omit the field.
        except Exception:
            pass
        # The very fact that we're in _finalize_motion_clip means the
        # pre-trigger fired. Peak motion score isn't tracked in the
        # current motion pipeline (contour-area thresholding has no
        # 0..1 score), so we intentionally omit it.
        ach["motion_pretrigger_fired"] = True
        return ach

    def _finalize_motion_clip(self, frames: list, meta: dict, fps: float = 10.0):
        """Save MP4 clip (H.264 via ffmpeg, mp4v fallback), verify, write event JSON, send Telegram."""
        start_time: datetime = meta["time"]
        event_id: str = meta["event_id"]
        storage_root = Path(self.global_cfg["storage"]["root"])
        public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")

        vid_path = None
        video_url = None
        video_relpath = None
        duration_s: float = 0.0
        file_size_bytes: int = 0
        encode_error: str | None = None
        fps_clamped = max(5.0, min(30.0, float(fps)))
        try:
            day_dir = (
                storage_root / "motion_detection" / self.camera_id / start_time.strftime("%Y-%m-%d")
            )
            day_dir.mkdir(parents=True, exist_ok=True)
            vid_path = day_dir / f"{event_id}.mp4"
            ok = self._write_clip_ffmpeg(frames, fps, vid_path)
            if not ok:
                # Fallback: legacy mp4v (may not play in browser)
                log.warning("[%s] H.264 encode unavailable, writing mp4v fallback", self.camera_id)
                encode_error = encode_error or "ffmpeg h264 encode failed — mp4v fallback"
                h, w = frames[0].shape[:2]
                writer = cv2.VideoWriter(
                    str(vid_path), cv2.VideoWriter_fourcc(*'mp4v'), fps_clamped, (w, h)
                )
                last_good = frames[0]
                for f in frames:
                    if self._is_frame_valid(f) and not self._is_frame_too_different(f, last_good):
                        writer.write(f)
                        last_good = f
                    else:
                        writer.write(last_good)
                writer.release()

            # Verify output: must exist, have size, and be a readable video with real duration
            if not vid_path.exists() or vid_path.stat().st_size < 1024:
                raise RuntimeError(
                    f"clip empty/missing ({vid_path.stat().st_size if vid_path.exists() else 0} bytes)"
                )
            check = cv2.VideoCapture(str(vid_path))
            fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
            cfps = check.get(cv2.CAP_PROP_FPS) or fps_clamped
            check.release()
            dur = fc / cfps if cfps > 0 else 0.0
            if fc < 3 or dur < 0.3:
                raise RuntimeError(f"clip broken: frames={fc} dur={dur:.2f}s")

            duration_s = round(dur, 2)
            file_size_bytes = vid_path.stat().st_size
            rel = vid_path.relative_to(storage_root)
            video_url = (
                f"{public_base}/media/{rel.as_posix()}"
                if public_base
                else f"/media/{rel.as_posix()}"
            )
            video_relpath = rel.as_posix()
            # Extract a representative thumbnail frame (~1/3 into the clip) and
            # downscale to max 640px wide. The motion card + lightbox both use
            # snapshot_relpath as their preview image.
            thumb_path = day_dir / f"{event_id}.jpg"
            try:
                check_thumb = cv2.VideoCapture(str(vid_path))
                total_f = int(check_thumb.get(cv2.CAP_PROP_FRAME_COUNT))
                if total_f > 0:
                    check_thumb.set(cv2.CAP_PROP_POS_FRAMES, min(total_f // 3, total_f - 1))
                ok_th, frame_th = check_thumb.read()
                check_thumb.release()
                if ok_th and frame_th is not None:
                    tw = frame_th.shape[1]
                    if tw > 640:
                        scale = 640 / tw
                        frame_th = cv2.resize(frame_th, (640, int(frame_th.shape[0] * scale)))
                    cv2.imwrite(str(thumb_path), frame_th, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            except Exception as _te:
                log.debug("[%s] motion thumb failed: %s", self.camera_id, _te)
            log.info(
                "[%s] Motion clip saved: %s (%d frames %.1fs @ %.1ffps %dKB)",
                self.camera_id,
                vid_path.name,
                len(frames),
                dur,
                fps_clamped,
                file_size_bytes // 1024,
            )
        except Exception as e:
            log.error("[%s] Motion clip save error: %s", self.camera_id, e)
            if encode_error is None:
                encode_error = str(e)

        # Fallback: primary path failed but file exists — the mp4v writer output may
        # still be playable even without faststart. Re-check via OpenCV.
        if video_url is None and vid_path is not None and vid_path.exists():
            try:
                size_bytes = vid_path.stat().st_size
                if size_bytes > 0:
                    check = cv2.VideoCapture(str(vid_path))
                    fc = int(check.get(cv2.CAP_PROP_FRAME_COUNT))
                    cfps = check.get(cv2.CAP_PROP_FPS) or fps_clamped
                    check.release()
                    dur = fc / cfps if cfps > 0 else 0.0
                    if fc >= 3 and dur >= 0.3:
                        duration_s = round(dur, 2)
                        file_size_bytes = size_bytes
                        rel = vid_path.relative_to(storage_root)
                        video_url = (
                            f"{public_base}/media/{rel.as_posix()}"
                            if public_base
                            else f"/media/{rel.as_posix()}"
                        )
                        video_relpath = rel.as_posix()
                        log.warning(
                            "[%s] Motion clip recovered via fallback: %s (%d frames %.2fs, encode_error=%s)",
                            self.camera_id,
                            vid_path.name,
                            fc,
                            dur,
                            encode_error,
                        )
                    else:
                        log.error(
                            "[%s] Fallback: clip unreadable (frames=%d dur=%.2fs) — removing",
                            self.camera_id,
                            fc,
                            dur,
                        )
                        vid_path.unlink()
                else:
                    vid_path.unlink()
            except Exception as fe:
                log.error("[%s] Fallback read failed: %s", self.camera_id, fe)
                try:
                    vid_path.unlink()
                except Exception:
                    pass

        # Resolve thumbnail path (may have been created above after a successful encode)
        thumb_rel = None
        thumb_url = None
        try:
            if 'thumb_path' in locals() and thumb_path.exists():
                thumb_rel = thumb_path.relative_to(storage_root).as_posix()
                thumb_url = (
                    f"{public_base}/media/{thumb_rel}" if public_base else f"/media/{thumb_rel}"
                )
        except Exception:
            pass

        # Recording settings snapshot + achievement metrics. The first
        # block captures the detection config active at clip-finalize
        # time so each event.json carries the exact thresholds /
        # filters / cadence it was shot under. The second block
        # captures what those settings actually produced — inference
        # cadence + motion pretrigger state. Track-derived achievement
        # fields (tracks_by_class, peak_score_by_class,
        # confirm_hits_by_track) are filled in later by
        # tracking_worker once its pass over the mp4 completes; we
        # don't synthesise them here.
        recording_settings = self._build_recording_settings_snapshot()
        achievement = self._build_achievement_snapshot()

        # Write event JSON
        event = {
            "event_id": event_id,
            "camera_id": self.camera_id,
            "camera_name": self.cfg.get("name", self.camera_id),
            "armed": bool(self.cfg.get("armed", True)),
            "after_hours": meta["after_hours"],
            "alarm_level": meta["alarm_level"],
            "severity": meta.get("severity", "off"),
            "time": start_time.isoformat(timespec="seconds"),
            "labels": meta["labels"],
            "top_label": meta["top_label"],
            "bird_species": meta["bird_species"],
            "cat_name": meta["cat_name"],
            "person_name": meta["person_name"],
            "whitelisted": meta["whitelisted"],
            "detections": meta["detections"],
            "snapshot_url": thumb_url,
            "snapshot_relpath": thumb_rel,
            "thumb_url": thumb_url,
            "video_url": video_url,
            "video_relpath": video_relpath,
            "duration_s": duration_s,
            "file_size_bytes": file_size_bytes,
            "recording_settings": recording_settings,
            "achievement": achievement,
        }
        if encode_error:
            event["encode_error"] = encode_error

        # F06 first-since marker — runs BEFORE add_event so the JSON on
        # disk carries the marker for downstream consumers (lightbox
        # badge, /api/insights/first-since later). The detector reads
        # the prior event of the same class via EventStore; cheap
        # because list_events is indexed and we cap at limit=10.
        try:
            from .. import app_state as _app_state

            fs = getattr(_app_state, "first_since_detector", None)
            if fs is not None:
                marker = fs.evaluate(event)
                if marker:
                    event["first_since"] = marker
                    # Surface on the meta dict too so the telegram path
                    # below picks up the headline label/gap without a
                    # second store read.
                    meta["first_since"] = marker
        except Exception as _fe:
            log.debug("[%s] first_since skipped: %s", self.camera_id, _fe)

        self.store.add_event(self.camera_id, event)

        # Phase 1 object tracking — enqueue a background pass that
        # writes <event_id>.tracks.json next to the mp4. Fire-and-
        # forget; the recording finalize must not block on it. Skip
        # when the clip never produced a playable mp4 (encode_error
        # set) or when the tracking worker hasn't been built yet
        # (early boot).
        if video_relpath and vid_path is not None and vid_path.exists():
            snap = (storage_root / thumb_rel) if thumb_rel else None
            self._enqueue_tracks_for_clip(event_id, vid_path, snap)

        if self.mqtt and self.cfg.get("mqtt_enabled", True):
            self.mqtt.publish(f"events/{self.camera_id}", event)

        # Achievement unlock
        bird_species = meta.get("bird_species")
        if bird_species:
            newly_unlocked = self._try_unlock_achievement(bird_species, bird_species)
            if newly_unlocked and self.notifier:
                try:
                    ach_msg = (
                        f"🌿 Neue Sichtung entdeckt: {bird_species}!\n"
                        f"📷 Kamera: {self.cfg.get('name', self.camera_id)}"
                    )
                    threading.Thread(
                        target=self.notifier.send_alert_sync,
                        kwargs={"caption": ach_msg},
                        daemon=True,
                    ).start()
                except Exception:
                    pass

        # Quest re-evaluation (F09). Best-effort: every motion event
        # triggers a full re-eval. Performance is fine — running over a
        # year of events is a few-ms disk walk. The hourly job in
        # server.py is the safety net; this trigger keeps the pinboard
        # in sync without waiting up to an hour. Wrapped tightly so a
        # quest-eval bug never poisons the recording pipeline.
        try:
            from ..quests import reevaluate_and_save

            threading.Thread(target=reevaluate_and_save, daemon=True).start()
        except Exception as _qe:
            log.debug("[%s] quest re-eval skipped: %s", self.camera_id, _qe)

        # Bird dossier hook (F08). For every detection in this event
        # carrying a `species_latin`, register it with the dossier
        # service — first sighting kicks off a Wikipedia + Xeno-canto
        # fetch, repeats just bump the counter. Late-binding via
        # app_state so the runtime keeps working when the service
        # isn't wired (e.g. older configs).
        try:
            from .. import app_state as _app_state

            svc = getattr(_app_state, "bird_dossiers", None)
            if svc is not None:
                seen_latin: set[str] = set()
                for det in meta.get("detections") or []:
                    latin = (det.get("species_latin") or "").strip()
                    if not latin or latin in seen_latin:
                        continue
                    seen_latin.add(latin)
                    common_de = det.get("species") or None
                    svc.on_new_species(latin, common_de, event_id, self.camera_id)
        except Exception as _de:
            log.debug("[%s] dossier hook skipped: %s", self.camera_id, _de)

        # Telegram — gate the event through the same camera-level switches
        # the old code respected (armed, zone send_telegram, telegram_enabled,
        # notify-from-alarm-profile), then hand the event to the push system
        # which makes the final decision (label-config, threshold, suppress,
        # rate-limit, quiet/night).
        notify = meta.get("notify", False)
        if not self.cfg.get("armed", True):
            notify = False
        if not meta.get("send_telegram", True):
            notify = False
        # Diagnose: one ROUTING line per finalized event, BEFORE any further
        # gating. Surfaces the exact reason an alert is dropped without
        # forcing a DEBUG log level. Companion line on successful handoff
        # below confirms the notifier accepted the event.
        log.info(
            "[trigger][cam:%s] alert routing: labels=%s notify=%s armed=%s "
            "telegram_enabled=%s send_telegram_meta=%s alarm_level=%s",
            self.camera_id,
            ",".join(sorted(set(meta.get("labels", [])))),
            notify,
            self.cfg.get("armed", True),
            self.cfg.get("telegram_enabled", True),
            meta.get("send_telegram", True),
            meta.get("alarm_level"),
        )
        if notify and self.cfg.get("telegram_enabled", True) and self.notifier:
            try:
                snap_path = (
                    (Path(self.global_cfg["storage"]["root"]) / thumb_rel) if thumb_rel else None
                )
                if hasattr(self.notifier, "send_event_alert"):
                    self.notifier.send_event_alert(
                        meta=meta,
                        camera_id=self.camera_id,
                        snapshot_path=snap_path,
                    )
                else:
                    # Older notifier: fall back to legacy caption builder so
                    # local dev environments without the push system still
                    # produce alerts.
                    labels = meta["labels"]
                    level = meta.get("alarm_level")
                    caption = (
                        f"{'🚨' if level == 'alarm' else 'ℹ️'} "
                        f"{', '.join(sorted(set(labels)))} · "
                        f"{self.cfg.get('name', self.camera_id)}"
                    )
                    self.notifier.send_alert_sync(
                        caption=caption,
                        jpeg_bytes=meta.get("thumb_bytes"),
                        snapshot_url=video_url,
                        dashboard_url=public_base,
                        camera_id=self.camera_id,
                    )
                log.info(
                    "[trigger][cam:%s] alert handed off to notifier (event_id=%s)",
                    self.camera_id,
                    meta.get("event_id"),
                )
            except Exception as e:
                log.warning("[%s] telegram event push failed: %s", self.camera_id, e)

    def record_adhoc_clip(self, seconds: int) -> str | None:
        """Capture a `seconds`-long mp4 from the live RTSP stream.

        Used by the Telegram menu's "Clip 5/15/30 s". Stream-copies the
        camera's H.264 directly into mp4 — no transcode, fast, ~1× wallclock.
        Returns the absolute path on success, None on failure.
        """
        if seconds <= 0 or seconds > 60:
            return None
        rtsp = self.cfg.get("rtsp_url")
        if not rtsp:
            return None
        if not _FFMPEG_AVAILABLE:
            log.warning("[%s] adhoc clip: ffmpeg unavailable", self.camera_id)
            return None
        out_dir = Path(self.global_cfg["storage"]["root"]) / "adhoc_clips" / self.camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        out_path = out_dir / f"adhoc-{ts}-{seconds}s.mp4"
        cmd = [
            "ffmpeg",
            "-y",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp,
            "-t",
            str(int(seconds)),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(out_path),
        ]
        try:
            # Generous timeout: allow seconds + 5s startup + 5s flush.
            proc = _subprocess.run(cmd, capture_output=True, timeout=int(seconds) + 10)
            if proc.returncode != 0 or not out_path.exists() or out_path.stat().st_size < 1024:
                log.warning(
                    "[%s] adhoc clip ffmpeg rc=%s stderr=%s",
                    self.camera_id,
                    proc.returncode,
                    proc.stderr.decode("utf-8", "replace")[-300:],
                )
                return None
            log.info(
                "[%s] adhoc clip recorded: %s (%d bytes)",
                self.camera_id,
                out_path.name,
                out_path.stat().st_size,
            )
            return str(out_path)
        except Exception as e:
            log.warning("[%s] adhoc clip failed: %s", self.camera_id, e)
            return None

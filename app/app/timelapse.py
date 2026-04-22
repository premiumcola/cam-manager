from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
import cv2
import hashlib
import logging
import numpy as np
import os
import subprocess
import tempfile

log = logging.getLogger(__name__)

# Maximum output width for timelapse videos. 4K source frames are downscaled to this
# width to keep file sizes manageable for mobile/web playback.
_MAX_OUTPUT_WIDTH = 1920


def _period_label(period_s: int) -> str:
    """Convert period seconds to a short human-readable label for filenames."""
    if period_s <= 0:
        return "custom"
    if period_s < 3600:
        mins = round(period_s / 60)
        return f"{mins}min" if mins > 0 else f"{period_s}s"
    if period_s < 86400:
        hours = round(period_s / 3600)
        return f"{hours}h"
    if period_s < 604800:
        return "daily"
    if period_s < 2592000:
        return "weekly"
    return "monthly"


def _duration_label(target_s: int) -> str:
    """Convert target duration seconds to a short label for filenames."""
    if target_s < 60:
        return f"{target_s}sec"
    mins = target_s // 60
    return f"{mins}min"


class TimelapseBuilder:
    def __init__(self, storage_root: str | Path):
        self.root = Path(storage_root)
        self.media_root = self.root / "media"
        self.out_root = self.root / "timelapse"
        self.out_root.mkdir(parents=True, exist_ok=True)

    def _timelapse_frames_dir(self, camera_id: str) -> Path:
        return self.root / "timelapse_frames" / camera_id

    def _camera_images_for_day(self, camera_id: str, day: str):
        cam_dir = self.media_root / camera_id
        if not cam_dir.exists():
            return []
        prefix = day.replace("-", "") + "-"
        return sorted(cam_dir.glob(f"{prefix}*.jpg"))

    @staticmethod
    def _is_valid_frame(img) -> tuple[bool, str]:
        """Validate a decoded frame before it enters a timelapse video.
        Returns (is_valid, reason_if_rejected).
        Conservative thresholds — night/dark and IR (B=G=R) frames pass as long as
        they have spatial detail. Do NOT reject based on color uniformity: many cameras
        output grayscale (B=G=R) in nighttime/IR mode and these are fully valid frames."""
        if img is None or img.size == 0:
            return False, "null/empty"
        h, w = img.shape[:2]
        if w < 32 or h < 24:
            return False, "too_small"
        b = float(img[:, :, 0].mean())
        g = float(img[:, :, 1].mean())
        r = float(img[:, :, 2].mean())
        brightness = (b + g + r) / 3.0
        # Completely black frame
        if brightness < 2.0:
            return False, f"too_dark(brightness={brightness:.1f})"
        # Completely white/oversaturated
        if brightness > 253.0:
            return False, f"too_bright(brightness={brightness:.1f})"
        # Full-frame pink/magenta H.265 artifact: heavy red dominance
        if r > 160 and r > g * 2.5 and r > b * 2.5:
            return False, f"pink_artifact(r={r:.0f},g={g:.0f},b={b:.0f})"
        # Quadrant-level partial pink check (stricter threshold to catch partial corruption)
        qh, qw = h // 2, w // 2
        for qi, (rs, cs) in enumerate([(slice(0, qh), slice(0, qw)),
                                        (slice(0, qh), slice(qw, None)),
                                        (slice(qh, None), slice(0, qw)),
                                        (slice(qh, None), slice(qw, None))]):
            sub = img[rs, cs]
            sb = float(sub[:, :, 0].mean())
            sg = float(sub[:, :, 1].mean())
            sr = float(sub[:, :, 2].mean())
            if sr > 180 and sr > sg * 3.0 and sr > sb * 3.0:
                return False, f"partial_pink_q{qi}(r={sr:.0f},g={sg:.0f},b={sb:.0f})"
        # No spatial detail: std < 2.0 means a completely solid/flat frame
        # (works for both color and grayscale; a solid gray or solid color both fail this)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray_std = float(gray.std())
        if gray_std < 2.0:
            return False, f"no_detail(std={gray_std:.2f})"
        return True, ""

    @staticmethod
    def _scale_dims(w: int, h: int, max_w: int = _MAX_OUTPUT_WIDTH) -> tuple[int, int]:
        """Return output (w, h) capped at max_w, height always divisible by 2 (H.264 req)."""
        if w <= max_w:
            # Still ensure even dimensions
            return (w // 2 * 2, h // 2 * 2)
        scale = max_w / w
        return (max_w, int(h * scale) // 2 * 2)

    def _write_video_ffmpeg(self, valid_paths: list, out_path: Path,
                            fps: float, ref_size: tuple[int, int]) -> str | None:
        """Encode valid JPEG frames to H.264 MP4 via ffmpeg concat demuxer.
        No frame data is loaded into Python memory — ffmpeg reads files directly.
        Returns path string on success, None on failure."""
        w, h = ref_size
        out_w, out_h = self._scale_dims(w, h)
        frame_dur = 1.0 / fps

        concat_fd, concat_path = tempfile.mkstemp(suffix=".txt")
        try:
            with os.fdopen(concat_fd, "w") as f:
                for p in valid_paths:
                    # ffmpeg concat requires forward slashes even on Windows
                    f.write(f"file '{str(p).replace(chr(92), '/')}'\n")
                    f.write(f"duration {frame_dur:.6f}\n")
                # Repeat last frame entry without duration (ffmpeg concat requirement)
                if valid_paths:
                    f.write(f"file '{str(valid_paths[-1]).replace(chr(92), '/')}'\n")

            cmd = [
                "ffmpeg", "-y", "-loglevel", "error",
                "-f", "concat", "-safe", "0", "-i", concat_path,
                "-vf", f"scale={out_w}:{out_h}",
                "-c:v", "libx264",
                "-crf", "28",           # good quality/size balance
                "-preset", "fast",
                "-movflags", "+faststart",  # progressive download / iOS
                "-pix_fmt", "yuv420p",  # required for broad iOS/Android compat
                str(out_path),
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=180)
            if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                log.debug("timelapse: ffmpeg encoded %s (%d frames → H.264 %dx%d)",
                          out_path.name, len(valid_paths), out_w, out_h)
                return str(out_path)
            if result.returncode != 0:
                log.warning("timelapse: ffmpeg failed for %s: %s",
                            out_path.name, result.stderr.decode(errors="replace")[-300:])
        except Exception as e:
            log.warning("timelapse: ffmpeg exception for %s: %s", out_path.name, e)
        finally:
            try:
                os.unlink(concat_path)
            except Exception:
                pass
        return None

    def _write_video_opencv(self, valid_paths: list, out_path: Path,
                            fps: float, ref_size: tuple[int, int]) -> str | None:
        """Fallback encoder using OpenCV VideoWriter (mp4v/MPEG-4 Part 2).
        Reads and writes one frame at a time to keep peak memory low."""
        w, h = ref_size
        out_w, out_h = self._scale_dims(w, h)
        writer = cv2.VideoWriter(
            str(out_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps, (out_w, out_h)
        )
        if not writer.isOpened():
            writer.release()
            writer = cv2.VideoWriter(
                str(out_path),
                cv2.VideoWriter_fourcc(*"DIVX"),
                fps, (out_w, out_h)
            )
        for img_path in valid_paths:
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            if (img.shape[1], img.shape[0]) != (out_w, out_h):
                img = cv2.resize(img, (out_w, out_h))
            writer.write(img)
            del img
        writer.release()
        if out_path.exists() and out_path.stat().st_size > 0:
            return str(out_path)
        return None

    def _write_thumbnail(self, img_path: Path, out_path: Path) -> None:
        """Write a thumbnail .jpg alongside the video. Max 640px wide."""
        try:
            img = cv2.imread(str(img_path))
            if img is None:
                return
            tw, th = img.shape[1], img.shape[0]
            if tw > 640:
                scale = 640 / tw
                img = cv2.resize(img, (640, int(th * scale)))
            thumb_path = out_path.with_suffix(".jpg")
            cv2.imwrite(str(thumb_path), img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            log.debug("timelapse: thumbnail written: %s", thumb_path.name)
        except Exception as e:
            log.debug("timelapse: thumbnail write failed: %s", e)

    def _write_video(self, images: list, out_path: Path,
                     target_duration_s: int, target_fps: int) -> str | None:
        """Subsample images, deduplicate, validate each frame, skip corrupt ones, write to out_path.
        Uses ffmpeg (H.264, small files, iOS-safe) with OpenCV mp4v as fallback.
        Two-pass: Pass 1 validates + deduplicates (no frame data kept in memory),
        Pass 2 encodes. FPS is computed from actual unique frame count so the encoded
        video length honours target_duration_s regardless of how many frames were captured.
        Also writes a .jpg thumbnail (middle valid frame, ≤640 px wide).
        Returns path string or None on failure."""
        # Record original frame count for completeness reporting
        frames_on_disk = len(images)
        expected_frames = max(2, target_duration_s * target_fps)

        # Limit source to what we'd need at target_fps — avoids processing thousands of frames
        if frames_on_disk > expected_frames:
            step = frames_on_disk / expected_frames
            images = [images[int(i * step)] for i in range(expected_frames)]

        # ── Pass 1: validate + duplicate diagnostic ──────────────────────────
        # Duplicates are NOT filtered here — they may represent legitimate static scenes.
        # Capture-time dedup (_timelapse_profile_loop) already prevents stuck-stream frames
        # from accumulating on disk. Encode-time dedup is diagnostic only.
        seen_hashes: set = set()
        valid_paths: list = []
        skipped = 0
        dup_count = 0
        ref_size: tuple[int, int] | None = None

        for img_path in images:
            img = cv2.imread(str(img_path))
            ok, reason = self._is_valid_frame(img)
            if not ok:
                log.debug("timelapse: skip corrupt frame %s — %s", img_path.name, reason)
                skipped += 1
                if img is not None:
                    del img
                continue
            # Count duplicates for diagnostics (sample every 8th pixel)
            fhash = hashlib.md5(img[::8, ::8].tobytes()).hexdigest()
            if ref_size is None:
                ref_size = (img.shape[1], img.shape[0])
            del img  # free immediately — do NOT accumulate
            if fhash in seen_hashes:
                dup_count += 1
            else:
                seen_hashes.add(fhash)
            valid_paths.append(img_path)  # keep all valid frames regardless of duplicates

        total_input = skipped + len(valid_paths)
        if skipped > 0:
            log.info("timelapse: skipped %d/%d corrupt frames for %s",
                     skipped, total_input, out_path.name)
        if dup_count > 0:
            dup_ratio = dup_count / max(1, len(valid_paths))
            if dup_ratio > 0.6:
                log.warning("timelapse: %.0f%% duplicate frames detected in %s (%d/%d) — "
                            "check if camera stream was stuck during capture window",
                            dup_ratio * 100, out_path.name, dup_count, len(valid_paths))
            else:
                log.debug("timelapse: %d/%d duplicate frames in %s (static scene?)",
                          dup_count, len(valid_paths), out_path.name)

        if len(valid_paths) < 2:
            log.warning("timelapse: only %d valid frames (of %d total) — "
                        "skipping encode for %s", len(valid_paths), total_input, out_path.name)
            return None

        # ── Compute fps to honour target_duration_s ──────────────────────────
        # fps = frames / desired_duration, capped at target_fps.
        # This ensures: actual video length ≈ target_duration_s regardless of
        # how many source frames were captured in the window.
        n = len(valid_paths)
        fps = n / max(1.0, float(target_duration_s))
        fps = min(float(target_fps), max(1.0, fps))
        actual_duration = n / fps
        if fps < 15.0:
            log.warning(
                "timelapse: %s will play at %.1f fps (< 15) — video will look "
                "choppy; only %d frames for a %ds target. Lower target_seconds "
                "or capture more frequently (shorter interval).",
                out_path.name, fps, n, target_duration_s,
            )

        # ── Completeness report ───────────────────────────────────────────────
        coverage_pct = min(100.0, 100.0 * frames_on_disk / expected_frames)
        shorter = actual_duration < target_duration_s * 0.95
        log.info(
            "timelapse: %s\n"
            "  config   : %ds @ %dfps = %d frames expected\n"
            "  on disk  : %d frames (%.0f%% of expected%s)\n"
            "  corrupt  : %d frames dropped (%.1f%%)\n"
            "  result   : %.1fs video%s",
            out_path.name,
            target_duration_s, target_fps, expected_frames,
            frames_on_disk, coverage_pct,
            "" if coverage_pct >= 99 else " — app was down/restarting for part of window",
            skipped, 100.0 * skipped / max(1, skipped + n),
            actual_duration,
            f" ⚠ shorter than target {target_duration_s}s" if shorter else " ✓"
        )

        # ── Pass 2: encode ────────────────────────────────────────────────────
        path = self._write_video_ffmpeg(valid_paths, out_path, fps, ref_size)
        if path is None:
            log.debug("timelapse: ffmpeg unavailable/failed, falling back to OpenCV for %s",
                      out_path.name)
            path = self._write_video_opencv(valid_paths, out_path, fps, ref_size)

        if path is None:
            log.warning("timelapse: encode failed for %s", out_path.name)
            return None

        # ── Thumbnail from middle valid frame ─────────────────────────────────
        self._write_thumbnail(valid_paths[n // 2], out_path)
        return path

    # ── Naming helpers ────────────────────────────────────────────────────────

    def make_output_name(self, window_key: str, profile_name: str,
                         period_s: int, target_s: int) -> str:
        """Generate a human-readable filename stem.
        Example: '2026-04-14_020435_custom_1min_to_10sec'"""
        p_label = _period_label(period_s)
        d_label = _duration_label(target_s)
        return f"{window_key}_{profile_name}_{p_label}_to_{d_label}"

    # ── Profile-based (new) ───────────────────────────────────────────────────

    def frame_count(self, camera_id: str, profile_name: str, day: str) -> int:
        """Count captured frames for a profile and day."""
        d = self.root / "timelapse_frames" / camera_id / profile_name / day
        if not d.exists():
            return 0
        return len(list(d.glob("*.jpg")))

    def build_profile(self, camera_id: str, profile_name: str, day: str,
                      target_duration_s: int = 60, target_fps: int = 30,
                      force: bool = False) -> str | None:
        """Build timelapse for a specific profile (new per-profile path structure)."""
        frames_dir = self.root / "timelapse_frames" / camera_id / profile_name / day
        if not frames_dir.exists():
            return None
        images = sorted(frames_dir.glob("*.jpg"))
        if len(images) < 2:
            return None
        out_dir = self.out_root / camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{day}_{profile_name}.mp4"
        if out_path.exists() and not force:
            return str(out_path)
        return self._write_video(images, out_path, target_duration_s, target_fps)

    # ── Legacy (flat date directory) ─────────────────────────────────────────

    def build_period(self, camera_id: str, day: str,
                     target_duration_s: int = 60,
                     target_fps: int = 30,
                     period: str = "day",
                     force: bool = False,
                     images_override: list | None = None) -> str | None:
        """Build from legacy flat timelapse_frames/<cam>/<day>/ directory."""
        if images_override is not None:
            images = list(images_override)
        else:
            frames_dir = self._timelapse_frames_dir(camera_id) / day
            if not frames_dir.exists():
                return None
            images = sorted(frames_dir.glob("*.jpg"))

        if len(images) < 2:
            return None

        out_dir = self.out_root / camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{day}_{period}.mp4"
        if out_path.exists() and not force:
            return str(out_path)
        return self._write_video(images, out_path, target_duration_s, target_fps)

    def build_for_day(self, camera_id: str, day: str, fps: int = 25, force: bool = False) -> str | None:
        """Backward-compatible wrapper. Tries timelapse_frames first, falls back to event snapshots."""
        path = self.build_period(camera_id, day,
                                 target_duration_s=60,
                                 target_fps=fps,
                                 period="day",
                                 force=force)
        if path:
            return path

        # Fallback: build from legacy event snapshot files
        images = self._camera_images_for_day(camera_id, day)
        if len(images) < 2:
            return None
        out_dir = self.out_root / camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{day}.mp4"
        if out_path.exists() and not force:
            return str(out_path)
        return self._write_video(images, out_path, 60, fps)

    def build_yesterday_if_missing(self, camera_id: str, fps: int = 25):
        day = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        return self.build_for_day(camera_id, day, fps=fps, force=False)

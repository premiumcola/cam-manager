from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
import cv2
import logging
import numpy as np

log = logging.getLogger(__name__)


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
        return f"{target_s}s"
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

    def _open_video_writer(self, out_path: Path, fps: float, w: int, h: int) -> cv2.VideoWriter:
        """Use mp4v (MPEG-4 Part 2) — reliable and iOS-compatible in .mp4 container."""
        writer = cv2.VideoWriter(
            str(out_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps, (w, h)
        )
        if writer.isOpened():
            log.debug("timelapse: using codec mp4v for %s", out_path.name)
            return writer
        writer.release()
        log.warning("timelapse: mp4v failed for %s, trying DIVX fallback", out_path.name)
        return cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"DIVX"), fps, (w, h))

    @staticmethod
    def _is_valid_frame(img) -> tuple[bool, str]:
        """Validate a decoded frame before it enters a timelapse video.
        Returns (is_valid, reason_if_rejected).
        Conservative thresholds — night/dark frames pass as long as they have detail."""
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
        if brightness < 3.0:
            return False, f"too_dark(brightness={brightness:.1f})"
        # Completely white/oversaturated
        if brightness > 253.0:
            return False, f"too_bright(brightness={brightness:.1f})"
        # Pink/magenta H.265 artifact: heavy red dominance
        if r > 160 and r > g * 2.0 and r > b * 2.0:
            return False, f"pink_artifact(r={r:.0f},g={g:.0f},b={b:.0f})"
        # Uniform gray/color: > 80% of pixels have channels within ±8 of each other
        b_ch = img[:, :, 0].astype(np.int16)
        g_ch = img[:, :, 1].astype(np.int16)
        r_ch = img[:, :, 2].astype(np.int16)
        uniform_frac = float(np.mean(
            (np.abs(r_ch - g_ch) < 8) & (np.abs(r_ch - b_ch) < 8)
        ))
        if uniform_frac > 0.85:
            return False, f"uniform_gray(frac={uniform_frac:.0%})"
        # No detail at all (completely solid color, even if not gray)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        if float(gray.std()) < 1.5:
            return False, "no_detail(std<1.5)"
        return True, ""

    def _write_video(self, images: list, out_path: Path,
                     target_duration_s: int, target_fps: int) -> str | None:
        """Subsample images, validate each frame, skip corrupt ones, write to out_path.
        Returns path string or None on failure."""
        total_frames_needed = max(2, target_duration_s * target_fps)
        if len(images) > total_frames_needed:
            step = len(images) / total_frames_needed
            images = [images[int(i * step)] for i in range(total_frames_needed)]

        # Load and validate all frames first
        valid_frames: list = []
        skipped = 0
        ref_size: tuple[int, int] | None = None  # (w, h)

        for img_path in images:
            img = cv2.imread(str(img_path))
            ok, reason = self._is_valid_frame(img)
            if not ok:
                log.debug("timelapse: skip corrupt frame %s — %s", img_path.name, reason)
                skipped += 1
                continue
            # Normalise to reference size (use first valid frame as reference)
            if ref_size is None:
                ref_size = (img.shape[1], img.shape[0])
            elif (img.shape[1], img.shape[0]) != ref_size:
                img = cv2.resize(img, ref_size)
            valid_frames.append(img)

        if skipped > 0:
            log.info("timelapse: skipped %d/%d corrupt frames for %s",
                     skipped, skipped + len(valid_frames), out_path.name)

        if len(valid_frames) < 2:
            log.warning("timelapse: only %d valid frames (of %d) — skipping encode for %s",
                        len(valid_frames), skipped + len(valid_frames), out_path.name)
            return None

        w, h = ref_size
        fps = float(max(1, target_fps))
        writer = self._open_video_writer(out_path, fps, w, h)
        for img in valid_frames:
            writer.write(img)
        writer.release()

        if not out_path.exists():
            log.warning("timelapse: VideoWriter produced no file: %s", out_path)
            return None
        return str(out_path)

    # ── Naming helpers ────────────────────────────────────────────────────────

    def make_output_name(self, window_key: str, profile_name: str,
                         period_s: int, target_s: int) -> str:
        """Generate a human-readable filename stem.
        Example: '2026-04-14_020435_custom_2min-to-10s'"""
        p_label = _period_label(period_s)
        d_label = _duration_label(target_s)
        return f"{window_key}_{profile_name}_{p_label}-to-{d_label}"

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

    def build_for_day(self, camera_id: str, day: str, fps: int = 12, force: bool = False) -> str | None:
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

    def build_yesterday_if_missing(self, camera_id: str, fps: int = 12):
        day = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        return self.build_for_day(camera_id, day, fps=fps, force=False)

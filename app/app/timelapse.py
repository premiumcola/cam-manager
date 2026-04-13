from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
import cv2
import logging

log = logging.getLogger(__name__)


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
        """Try H.264 (avc1) first for better compression, fall back to MPEG-4 (mp4v)."""
        for fourcc_code in ("avc1", "mp4v"):
            try:
                writer = cv2.VideoWriter(
                    str(out_path),
                    cv2.VideoWriter_fourcc(*fourcc_code),
                    fps, (w, h)
                )
                if writer.isOpened():
                    log.debug("timelapse: using codec %s for %s", fourcc_code, out_path.name)
                    return writer
                writer.release()
            except Exception:
                pass
        # Last resort: plain mp4v without isOpened check
        return cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    def _write_video(self, images: list, out_path: Path,
                     target_duration_s: int, target_fps: int) -> str | None:
        """Subsample images and write to out_path. Returns path string or None."""
        total_frames_needed = max(2, target_duration_s * target_fps)
        if len(images) > total_frames_needed:
            step = len(images) / total_frames_needed
            images = [images[int(i * step)] for i in range(total_frames_needed)]

        first = cv2.imread(str(images[0]))
        if first is None:
            return None
        h, w = first.shape[:2]
        fps = float(max(1, target_fps))
        writer = self._open_video_writer(out_path, fps, w, h)
        for img_path in images:
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            if img.shape[:2] != (h, w):
                img = cv2.resize(img, (w, h))
            writer.write(img)
        writer.release()
        return str(out_path) if out_path.exists() else None

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

from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
import cv2


class TimelapseBuilder:
    def __init__(self, storage_root: str | Path):
        self.root = Path(storage_root)
        self.media_root = self.root / "media"
        self.out_root = self.root / "timelapse"
        self.out_root.mkdir(parents=True, exist_ok=True)

    def _camera_images_for_day(self, camera_id: str, day: str):
        cam_dir = self.media_root / camera_id
        if not cam_dir.exists():
            return []
        prefix = day.replace("-", "") + "-"
        return sorted(cam_dir.glob(f"{prefix}*.jpg"))

    def build_for_day(self, camera_id: str, day: str, fps: int = 12, force: bool = False) -> str | None:
        images = self._camera_images_for_day(camera_id, day)
        if len(images) < 2:
            return None
        out_dir = self.out_root / camera_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{day}.mp4"
        if out_path.exists() and not force:
            return str(out_path)
        first = cv2.imread(str(images[0]))
        if first is None:
            return None
        h, w = first.shape[:2]
        writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), float(max(1, fps)), (w, h))
        for img_path in images:
            img = cv2.imread(str(img_path))
            if img is None:
                continue
            if img.shape[:2] != (h, w):
                img = cv2.resize(img, (w, h))
            writer.write(img)
        writer.release()
        return str(out_path) if out_path.exists() else None

    def build_yesterday_if_missing(self, camera_id: str, fps: int = 12):
        day = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        return self.build_for_day(camera_id, day, fps=fps, force=False)

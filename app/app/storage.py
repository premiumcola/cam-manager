from __future__ import annotations
from pathlib import Path
from datetime import datetime, timedelta
import json


class EventStore:
    def __init__(self, root: str):
        self.root = Path(root)
        self.events_dir = self.root / "events"
        self.events_dir.mkdir(parents=True, exist_ok=True)

    def _cam_dir(self, camera_id: str) -> Path:
        p = self.events_dir / camera_id
        p.mkdir(parents=True, exist_ok=True)
        return p

    def add_event(self, camera_id: str, payload: dict):
        payload = dict(payload)
        event_id = payload.get("event_id") or datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        payload["event_id"] = event_id
        path = self._cam_dir(camera_id) / f"{event_id}.json"
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return path

    def get_event(self, camera_id: str, event_id: str) -> dict | None:
        path = self._cam_dir(camera_id) / f"{event_id}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def update_event(self, camera_id: str, event_id: str, payload: dict) -> bool:
        path = self._cam_dir(camera_id) / f"{event_id}.json"
        if not path.exists():
            return False
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return True

    def list_events(self, camera_id: str, label: str | None = None, start: str | None = None, end: str | None = None, limit: int = 24):
        items = []
        cam_dir = self._cam_dir(camera_id)
        for file in sorted(cam_dir.glob("*.json"), reverse=True):
            try:
                obj = json.loads(file.read_text(encoding="utf-8"))
            except Exception:
                continue
            t = obj.get("time", "")
            if start and t and t < start:
                continue
            if end and t and t > end:
                continue
            labels = obj.get("labels", [])
            if label and label not in labels and obj.get("cat_name") != label and obj.get("bird_species") != label:
                continue
            items.append(obj)
            if len(items) >= limit:
                break
        return items

    def stats_range(self, camera_id: str, label: str | None = None, start: str | None = None, end: str | None = None):
        from collections import Counter, defaultdict
        events = self.list_events(camera_id, label=label, start=start, end=end, limit=5000)
        by_day = defaultdict(Counter)
        by_hour = Counter()
        top = Counter()
        species_top = Counter()
        cat_names = Counter()
        photo_count = 0
        video_count = 0
        for e in events:
            t = e.get("time", "")
            day = t[:10] if len(t) >= 10 else "unbekannt"
            hour = t[11:13] if len(t) >= 13 else "??"
            labels = e.get("labels", []) or ["motion"]
            for lab in labels:
                by_day[day][lab] += 1
                top[lab] += 1
            if e.get("bird_species"):
                species_top[e["bird_species"]] += 1
            if e.get("cat_name"):
                cat_names[e["cat_name"]] += 1
            by_hour[hour] += 1
            if e.get("snapshot_url"):
                photo_count += 1
            if e.get("video_url"):
                video_count += 1
        colors = {
            "motion": "#36a2ff", "person": "#ff6b6b", "cat": "#9b8cff", "dog": "#ffb020", "bird": "#62d26f",
            "fox": "#ff7a1a", "hedgehog": "#a67c52", "marten": "#7c5cff", "car": "#00c2ff", "other": "#64748b"
        }
        day_items = []
        for day in sorted(by_day.keys()):
            segs = []
            total = 0
            for lab, count in by_day[day].most_common():
                segs.append({"label": lab, "label_de": lab, "count": count, "color": colors.get(lab, colors['other'])})
                total += count
            day_items.append({"day": day, "total": total, "segments": segs})
        return {
            "total_events": len(events),
            "photos": photo_count,
            "videos": video_count,
            "top_objects": [{"label": lab, "label_de": lab, "count": cnt, "color": colors.get(lab, colors['other'])} for lab, cnt in top.most_common(8)],
            "top_bird_species": [{"label": lab, "count": cnt} for lab, cnt in species_top.most_common(8)],
            "top_cat_names": [{"label": lab, "count": cnt} for lab, cnt in cat_names.most_common(8)],
            "by_day": day_items,
            "by_hour": [{"hour": h, "count": by_hour[h]} for h in sorted(by_hour.keys())],
        }

    def aggregate_summary(self, days: int = 1):
        from collections import Counter
        start = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
        per_camera = {}
        top = Counter()
        bird_species = Counter()
        cat_names = Counter()
        total = 0
        for cam_dir in self.events_dir.iterdir() if self.events_dir.exists() else []:
            if not cam_dir.is_dir():
                continue
            events = self.list_events(cam_dir.name, start=start, limit=5000)
            cam_count = len(events)
            total += cam_count
            per_camera[cam_dir.name] = cam_count
            for e in events:
                for lab in e.get("labels", []) or ["motion"]:
                    top[lab] += 1
                if e.get("bird_species"):
                    bird_species[e["bird_species"]] += 1
                if e.get("cat_name"):
                    cat_names[e["cat_name"]] += 1
        return {
            "days": days,
            "total_events": total,
            "per_camera": per_camera,
            "top_objects": top.most_common(8),
            "top_bird_species": bird_species.most_common(8),
            "top_cat_names": cat_names.most_common(8),
        }

    def delete_event(self, camera_id: str, event_id: str) -> dict:
        """Delete event JSON and its snapshot file. Returns info about what was deleted."""
        json_path = self._cam_dir(camera_id) / f"{event_id}.json"
        event = None
        if json_path.exists():
            try:
                event = json.loads(json_path.read_text(encoding="utf-8"))
            except Exception:
                pass
            json_path.unlink(missing_ok=True)
        snap_deleted = False
        if event and event.get("snapshot_relpath"):
            snap_path = self.root / event["snapshot_relpath"]
            if snap_path.exists():
                snap_path.unlink(missing_ok=True)
                snap_deleted = True
        return {"json_deleted": event is not None, "snap_deleted": snap_deleted}

    def scan_media_files(self, camera_ids: list[str], public_base_url: str = "") -> int:
        """Scan storage/events for orphaned media files (.jpg/.jpeg/.mp4) not yet registered as events.
        Returns count of newly registered events."""
        import logging as _log
        log = _log.getLogger(__name__)
        scanned = 0
        for cam_id in camera_ids:
            cam_dir = self.events_dir / cam_id
            if not cam_dir.exists():
                continue
            # Collect existing event IDs
            existing_ids: set[str] = set()
            for jf in cam_dir.glob("*.json"):
                existing_ids.add(jf.stem)
            # Walk date subdirectories
            for entry in sorted(cam_dir.iterdir()):
                if not entry.is_dir():
                    continue
                for media_file in sorted(entry.iterdir()):
                    if media_file.suffix.lower() not in (".jpg", ".jpeg", ".mp4"):
                        continue
                    event_id = media_file.stem
                    if event_id in existing_ids:
                        continue
                    # Parse timestamp from filename (YYYYMMDD-HHMMSS-*)
                    try:
                        ts = datetime.strptime(event_id[:15], "%Y%m%d-%H%M%S")
                    except ValueError:
                        ts = datetime.now()
                    rel = media_file.relative_to(self.root)
                    is_video = media_file.suffix.lower() == ".mp4"
                    base = (public_base_url or "").rstrip("/")
                    event: dict = {
                        "event_id": event_id,
                        "camera_id": cam_id,
                        "camera_name": cam_id,
                        "time": ts.isoformat(timespec="seconds"),
                        "labels": ["motion"],
                        "top_label": "motion",
                        "alarm_level": "info",
                        "armed": True,
                        "after_hours": False,
                        "scanned": True,
                    }
                    if is_video:
                        event["video_relpath"] = rel.as_posix()
                        event["video_url"] = f"{base}/media/{rel.as_posix()}" if base else f"/media/{rel.as_posix()}"
                        event["snapshot_relpath"] = None
                        event["snapshot_url"] = None
                    else:
                        event["snapshot_relpath"] = rel.as_posix()
                        event["snapshot_url"] = f"{base}/media/{rel.as_posix()}" if base else f"/media/{rel.as_posix()}"
                        event["video_url"] = None
                    self.add_event(cam_id, event)
                    existing_ids.add(event_id)
                    scanned += 1
        log.info("[MediaScan] %d neue Medien-Events registriert", scanned)
        return scanned

    def cleanup_old(self, retention_days: int):
        cutoff = datetime.now() - timedelta(days=retention_days)
        removed = 0
        for p in self.events_dir.rglob("*"):
            if p.is_file() and datetime.fromtimestamp(p.stat().st_mtime) < cutoff:
                p.unlink(missing_ok=True)
                removed += 1
        return removed

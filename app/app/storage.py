from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path

log = logging.getLogger(__name__)


def _atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` via temp file + os.replace so a crash
    mid-write never leaves a truncated or corrupt file. Mirrors
    settings_store.save()'s pattern."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(str(tmp), str(path))


def event_date_subdir(event_id: str) -> str | None:
    """Derive the ``YYYY-MM-DD`` date-folder name from an event_id whose
    first 8 chars are ``YYYYMMDD`` (the standard
    ``%Y%m%d-%H%M%S-%f`` id format).

    Returns ``None`` for custom / legacy ids that don't start with 8
    digits, so callers fall back to the camera-root location and nothing
    breaks. This is the same date folder the mp4/jpg already use, so the
    event JSON ends up co-located with its media instead of littering
    the camera root."""
    head = event_id[:8]
    if len(head) == 8 and head.isdigit():
        return f"{head[:4]}-{head[4:6]}-{head[6:8]}"
    return None


class EventStore:
    def __init__(self, root: str):
        self.root = Path(root)
        self.events_dir = self.root / "motion_detection"
        # One-time migration: rename legacy events/ → motion_detection/
        old_events = self.root / "events"
        if old_events.exists() and not self.events_dir.exists():
            try:
                old_events.rename(self.events_dir)
            except Exception:
                # Best-effort one-time migration. Falling through is
                # fine — the mkdir() below ensures the canonical dir
                # exists regardless. Breadcrumb for the DEBUG channel.
                log.debug(
                    "[storage] legacy events/ → motion_detection/ rename skipped", exc_info=True
                )
        self.events_dir.mkdir(parents=True, exist_ok=True)

    def _cam_dir(self, camera_id: str) -> Path:
        p = self.events_dir / camera_id
        p.mkdir(parents=True, exist_ok=True)
        return p

    def add_event(self, camera_id: str, payload: dict):
        payload = dict(payload)
        event_id = payload.get("event_id") or datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        payload["event_id"] = event_id
        # Co-locate the event JSON with its media in the date subfolder
        # (motion_detection/<cam>/<YYYY-MM-DD>/<event_id>.json) instead
        # of littering the camera root. Falls back to the camera root for
        # custom/legacy ids whose first 8 chars aren't YYYYMMDD. Reads all
        # use rglob(), so both locations resolve during the transition.
        cam_dir = self._cam_dir(camera_id)
        subdir = event_date_subdir(event_id)
        if subdir is not None:
            target_dir = cam_dir / subdir
            target_dir.mkdir(parents=True, exist_ok=True)
        else:
            target_dir = cam_dir
        path = target_dir / f"{event_id}.json"
        _atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2))
        return path

    def get_event(self, camera_id: str, event_id: str) -> dict | None:
        cam_dir = self._cam_dir(camera_id)
        matches = list(cam_dir.rglob(f"{event_id}.json"))
        if not matches:
            return None
        try:
            return json.loads(matches[0].read_text(encoding="utf-8"))
        except Exception as e:
            # Returning None silently was hiding malformed event JSON
            # from operators — surface it once so a corrupted file
            # gets a clear signal in `docker logs`.
            log.warning("[storage] malformed event JSON %s: %s", matches[0], e)
            return None

    def find_event_anywhere(self, event_id: str) -> dict | None:
        """Cross-camera lookup for deep-links from Telegram. Walks every
        camera folder under motion_detection/ until a matching JSON is
        found. Returns the parsed event dict (with camera_id injected
        when missing) or None."""
        if not event_id or not self.events_dir.exists():
            return None
        for cam_dir in self.events_dir.iterdir():
            if not cam_dir.is_dir():
                continue
            matches = list(cam_dir.rglob(f"{event_id}.json"))
            if not matches:
                continue
            try:
                payload = json.loads(matches[0].read_text(encoding="utf-8"))
                payload.setdefault("camera_id", cam_dir.name)
                return payload
            except Exception as e:
                log.warning("[storage] malformed event JSON %s: %s", matches[0], e)
                continue
        return None

    def update_event(self, camera_id: str, event_id: str, payload: dict) -> bool:
        cam_dir = self._cam_dir(camera_id)
        matches = list(cam_dir.rglob(f"{event_id}.json"))
        if not matches:
            return False
        _atomic_write_text(matches[0], json.dumps(payload, ensure_ascii=False, indent=2))
        return True

    def delete_event_by_id(self, camera_id: str, event_id: str) -> bool:
        """Remove every event-JSON matching `<event_id>.json` under the camera tree.
        Returns True if at least one file was unlinked."""
        cam_dir = self._cam_dir(camera_id)
        matches = list(cam_dir.rglob(f"{event_id}.json"))
        for m in matches:
            try:
                m.unlink()
            except Exception:
                log.debug("[storage] unlink %s failed (best-effort)", m, exc_info=True)
        return bool(matches)

    def _filter_events(
        self,
        camera_id: str,
        label: str | None = None,
        labels: list | None = None,
        start: str | None = None,
        end: str | None = None,
        media_only: bool = False,
        type: str | None = None,
        bird_species: str | None = None,
    ):
        """Filter events for a camera. `labels` (list) takes precedence over `label` (str).
        Multi-label filter uses OR logic: event matches if any of its labels is in the filter set.
        media_only=True: skip metadata-only events (no snapshot/video file) — used by the viewer.
        bird_species: case-insensitive exact match against event.bird_species (used by the
        Sichtungen drilldown to pull every photo of e.g. "Grünfink")."""
        filter_set: set | None = None
        if labels:
            filter_set = set(labels)
        elif label:
            filter_set = {label}
        species_key = (bird_species or "").lower().strip() or None

        items = []
        cam_dir = self._cam_dir(camera_id)
        for file in cam_dir.rglob("*.json"):
            try:
                obj = json.loads(file.read_text(encoding="utf-8"))
            except Exception as e:
                # A malformed event JSON used to vanish from list_events
                # without a peep. Surface it as a one-line warning so
                # the operator notices and can investigate / repair.
                log.warning("[storage] malformed event JSON %s: %s", file, e)
                continue
            if media_only:
                has_media = (
                    obj.get("snapshot_relpath")
                    or obj.get("snapshot_url")
                    or obj.get("video_relpath")
                    or obj.get("video_url")
                )
                if not has_media:
                    continue
            t = obj.get("time", "")
            if start and t and t < start:
                continue
            if end and t and t > end:
                continue
            if type is not None and obj.get("type") != type:
                continue
            if filter_set:
                evt_labels = set(obj.get("labels", []))
                extras = {obj.get("cat_name"), obj.get("bird_species")} - {None}
                if not (filter_set & (evt_labels | extras)):
                    continue
            if species_key is not None:
                if (obj.get("bird_species") or "").lower().strip() != species_key:
                    continue
            items.append(obj)
        items.sort(key=lambda x: x.get("time", ""), reverse=True)
        return items

    def list_events(
        self,
        camera_id: str,
        label: str | None = None,
        labels: list | None = None,
        start: str | None = None,
        end: str | None = None,
        limit: int = 24,
        offset: int = 0,
        media_only: bool = False,
        type: str | None = None,
        bird_species: str | None = None,
    ):
        items = self._filter_events(
            camera_id,
            label=label,
            labels=labels,
            start=start,
            end=end,
            media_only=media_only,
            type=type,
            bird_species=bird_species,
        )
        return items[offset : offset + limit]

    def count_events(
        self,
        camera_id: str,
        label: str | None = None,
        labels: list | None = None,
        start: str | None = None,
        end: str | None = None,
        media_only: bool = False,
        bird_species: str | None = None,
    ) -> int:
        return len(
            self._filter_events(
                camera_id,
                label=label,
                labels=labels,
                start=start,
                end=end,
                media_only=media_only,
                bird_species=bird_species,
            )
        )

    def stats_range(
        self,
        camera_id: str,
        label: str | None = None,
        start: str | None = None,
        end: str | None = None,
    ):
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
            "motion": "#36a2ff",
            "person": "#ff6b6b",
            "cat": "#9b8cff",
            "dog": "#7c2d12",
            "bird": "#62d26f",
            "squirrel": "#7c4a1f",
            "fox": "#ff7a1a",
            "hedgehog": "#a67c52",
            "marten": "#7c5cff",
            "car": "#00c2ff",
            "other": "#64748b",
        }
        day_items = []
        for day in sorted(by_day.keys()):
            segs = []
            total = 0
            for lab, count in by_day[day].most_common():
                segs.append(
                    {
                        "label": lab,
                        "label_de": lab,
                        "count": count,
                        "color": colors.get(lab, colors['other']),
                    }
                )
                total += count
            day_items.append({"day": day, "total": total, "segments": segs})
        return {
            "total_events": len(events),
            "photos": photo_count,
            "videos": video_count,
            "top_objects": [
                {
                    "label": lab,
                    "label_de": lab,
                    "count": cnt,
                    "color": colors.get(lab, colors['other']),
                }
                for lab, cnt in top.most_common(8)
            ],
            "top_bird_species": [
                {"label": lab, "count": cnt} for lab, cnt in species_top.most_common(8)
            ],
            "top_cat_names": [
                {"label": lab, "count": cnt} for lab, cnt in cat_names.most_common(8)
            ],
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
        """Delete event JSON and its snapshot/video file. Returns info about what was deleted."""
        cam_dir = self._cam_dir(camera_id)
        matches = list(cam_dir.rglob(f"{event_id}.json"))
        event = None
        if matches:
            json_path = matches[0]
            try:
                event = json.loads(json_path.read_text(encoding="utf-8"))
            except Exception as e:
                # Falling through with event=None still deletes the
                # JSON; sidecars (snapshot/video/tracks) just won't get
                # cleaned because we couldn't read their relpaths.
                log.warning("[storage] malformed event JSON during delete %s: %s", json_path, e)
            json_path.unlink(missing_ok=True)
        snap_deleted = False
        if event and event.get("snapshot_relpath"):
            snap_path = self.root / event["snapshot_relpath"]
            if snap_path.exists():
                snap_path.unlink(missing_ok=True)
                snap_deleted = True
        vid_deleted = False
        tracks_deleted = False
        if event and event.get("video_relpath"):
            vid_path = self.root / event["video_relpath"]
            if vid_path.exists():
                vid_path.unlink(missing_ok=True)
                vid_deleted = True
            # tracks.json sidecar lives next to the mp4 as
            # `<event_id>.tracks.json`. Drop it whenever the event is
            # deleted so the lightbox doesn't try to render boxes
            # against a missing video. The sidecar may also be stored
            # next to the camera root for legacy events without a
            # date-subdir; rglob picks both up.
            for tp in list(cam_dir.rglob(f"{event_id}.tracks.json")):
                try:
                    tp.unlink()
                    tracks_deleted = True
                except Exception:
                    log.debug("[storage] tracks sidecar unlink %s failed", tp, exc_info=True)
            # `<event_id>.best.jpg` is the Telegram-only "best frame"
            # cache (bbox burnt on) — recreated by the next push if
            # tracks.json is rebuilt, but pointless to keep around
            # once the source mp4 is gone.
            for bp in list(cam_dir.rglob(f"{event_id}.best.jpg")):
                try:
                    bp.unlink()
                except Exception:
                    log.debug("[storage] best.jpg unlink %s failed", bp, exc_info=True)
        return {
            "json_deleted": event is not None,
            "snap_deleted": snap_deleted,
            "vid_deleted": vid_deleted,
            "tracks_deleted": tracks_deleted,
        }

    def purge_orphans(self) -> int:
        """Delete event JSON files whose media file no longer exists. Returns count removed."""
        removed = 0
        if not self.events_dir.exists():
            return 0
        for cam_dir in (d for d in self.events_dir.iterdir() if d.is_dir()):
            for jf in list(cam_dir.rglob("*.json")):
                # Skip our own tracking sidecars — they're handled in
                # the second pass below so an orphaned tracks.json
                # (event already deleted) doesn't survive forever.
                if jf.name.endswith(".tracks.json"):
                    continue
                try:
                    obj = json.loads(jf.read_text(encoding="utf-8"))
                except Exception as e:
                    # purge_orphans intentionally treats unparseable
                    # JSON as an orphan (can't validate its media
                    # refs). Log so the deletion is visible.
                    log.warning("[storage] removing malformed event JSON %s: %s", jf, e)
                    jf.unlink(missing_ok=True)
                    removed += 1
                    continue
                snap_rel = obj.get("snapshot_relpath")
                vid_rel = obj.get("video_relpath")
                snap_missing = snap_rel and not (self.root / snap_rel).exists()
                vid_missing = vid_rel and not (self.root / vid_rel).exists()
                # Orphan: has a media reference that no longer exists on disk
                if snap_missing or vid_missing:
                    jf.unlink(missing_ok=True)
                    removed += 1
            # Second pass — tracks.json sidecars whose matching event
            # manifest is already gone (delete_event was bypassed at
            # some point, e.g. manual rm -rf). Stem of "<event_id>.
            # tracks.json" is "<event_id>.tracks"; the event JSON we
            # look for is "<event_id>.json".
            for tp in list(cam_dir.rglob("*.tracks.json")):
                event_id = tp.stem.removesuffix(".tracks")
                if not list(cam_dir.rglob(f"{event_id}.json")):
                    tp.unlink(missing_ok=True)
                    removed += 1
            # Same orphan check for the Telegram-only `.best.jpg`
            # cache. Pattern: `<event_id>.best.jpg` → stem is
            # `<event_id>.best`, the event JSON we look for is
            # `<event_id>.json`.
            for bp in list(cam_dir.rglob("*.best.jpg")):
                event_id = bp.stem.removesuffix(".best")
                if not list(cam_dir.rglob(f"{event_id}.json")):
                    bp.unlink(missing_ok=True)
                    removed += 1
        return removed

    def scan_media_files(self, camera_ids: list[str], public_base_url: str = "") -> int:
        """Scan storage/motion_detection for orphaned media files (.jpg/.jpeg/.mp4) not yet registered as events.
        Covers both flat files directly in cam_dir/ and files in any depth of subdirectories.
        Returns count of newly registered events."""
        import logging as _log

        log = _log.getLogger(__name__)
        scanned = 0
        for cam_id in camera_ids:
            cam_dir = self.events_dir / cam_id
            log.info("[MediaScan] checking cam_dir: %s exists=%s", cam_dir, cam_dir.exists())
            if not cam_dir.exists():
                continue
            # Collect existing event IDs from all JSON files in the entire tree
            existing_ids: set[str] = set()
            for jf in cam_dir.rglob("*.json"):
                existing_ids.add(jf.stem)
            # Collect all media files recursively (flat + subdirs)
            media_files: list[Path] = []
            for suffix in ("*.jpg", "*.jpeg", "*.mp4"):
                media_files.extend(cam_dir.rglob(suffix))
            for media_file in sorted(media_files):
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
                    event["video_url"] = (
                        f"{base}/media/{rel.as_posix()}" if base else f"/media/{rel.as_posix()}"
                    )
                    event["snapshot_relpath"] = None
                    event["snapshot_url"] = None
                    # Try to grab a thumbnail so the freshly-registered card has a preview
                    thumb = media_file.with_suffix(".jpg")
                    if not thumb.exists():
                        try:
                            import cv2 as _cv2

                            cap = _cv2.VideoCapture(str(media_file))
                            try:
                                total = int(cap.get(_cv2.CAP_PROP_FRAME_COUNT))
                                if total > 2:
                                    cap.set(_cv2.CAP_PROP_POS_FRAMES, total // 2)
                                ok_t, frame_t = cap.read()
                            finally:
                                cap.release()
                            if (
                                ok_t
                                and frame_t is not None
                                and _cv2.imwrite(
                                    str(thumb), frame_t, [int(_cv2.IMWRITE_JPEG_QUALITY), 85]
                                )
                            ):
                                thumb_rel = thumb.relative_to(self.root).as_posix()
                                event["snapshot_relpath"] = thumb_rel
                                event["snapshot_url"] = (
                                    f"{base}/media/{thumb_rel}" if base else f"/media/{thumb_rel}"
                                )
                        except Exception as _e:
                            log.debug(
                                "[MediaScan] thumb extract failed for %s: %s", media_file.name, _e
                            )
                    elif thumb.exists():
                        thumb_rel = thumb.relative_to(self.root).as_posix()
                        event["snapshot_relpath"] = thumb_rel
                        event["snapshot_url"] = (
                            f"{base}/media/{thumb_rel}" if base else f"/media/{thumb_rel}"
                        )
                else:
                    event["snapshot_relpath"] = rel.as_posix()
                    event["snapshot_url"] = (
                        f"{base}/media/{rel.as_posix()}" if base else f"/media/{rel.as_posix()}"
                    )
                    event["video_url"] = None
                self.add_event(cam_id, event)
                existing_ids.add(event_id)
                scanned += 1
        log.info("[MediaScan] %d neue Medien-Events registriert", scanned)
        orphans = self.purge_orphans()
        if orphans:
            log.info("[MediaScan] %d verwaiste Events bereinigt", orphans)
        return scanned

    def cleanup_old(self, retention_days: int) -> int:
        import logging as _log

        log = _log.getLogger(__name__)
        cutoff = datetime.now() - timedelta(days=retention_days)
        removed = 0
        if not self.events_dir.exists():
            log.info("[storage] motion_detection/ not found, nothing to clean")
            return 0
        log.info(
            "[storage] autoclean: retention=%dd cutoff=%s | "
            "eligible: motion snapshots + event JSON (motion_detection/) | "
            "protected: timelapse videos (timelapse/) — separate storage, never touched by autoclean",
            retention_days,
            cutoff.strftime("%Y-%m-%d"),
        )
        for p in self.events_dir.rglob("*"):
            if p.is_file() and datetime.fromtimestamp(p.stat().st_mtime) < cutoff:
                p.unlink(missing_ok=True)
                removed += 1
        if removed:
            log.info(
                "[storage] removed %d files (motion events + snapshots older than %dd)",
                removed,
                retention_days,
            )
        else:
            log.info(
                "[storage] nothing removed (all motion_detection/ files within %dd retention)",
                retention_days,
            )
        return removed

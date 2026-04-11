from __future__ import annotations
import cv2
import time
import threading
import logging
import json as _json_mod
from datetime import datetime
from pathlib import Path
import requests
import numpy as np
from .detectors import CoralObjectDetector, BirdSpeciesClassifier, draw_detections
from .event_logic import is_in_schedule, choose_alarm_level

# Species name → achievement ID mapping (German species names → normalised IDs)
_SPECIES_TO_ACH_ID = {
    "blaumeise": "blaumeise",
    "kohlmeise": "kohlmeise",
    "rotkehlchen": "rotkehlchen",
    "buchfink": "buchfink",
    "amsel": "amsel",
    "hausspatz": "hausspatz",
    "grünfink": "gruenfink",
    "gruenfink": "gruenfink",
    "stieglitz": "stieglitz",
    "kleiber": "kleiber",
    "buntspecht": "buntspecht",
    "eichelhäher": "eichelhaher",
    "eichelhaher": "eichelhaher",
    "elster": "elster",
    "rabenkrähe": "rabenkraehe",
    "rabenkraehe": "rabenkraehe",
    "mäusebussard": "maeusebussard",
    "maeusebussard": "maeusebussard",
    "turmfalke": "turmfalke",
    "eichhörnchen": "eichhoernchen",
    "eichhoernchen": "eichhoernchen",
    "igel": "igel",
    "feldhase": "feldhase",
    "reh": "reh",
    "fuchs": "fuchs",
}

log = logging.getLogger(__name__)


class CameraRuntime:
    def __init__(self, camera_id: str, config_getter, global_cfg: dict, store, notifier, mqtt=None, cat_registry=None, person_registry=None):
        self.camera_id = camera_id
        self.config_getter = config_getter
        self.global_cfg = global_cfg
        self.store = store
        self.notifier = notifier
        self.mqtt = mqtt
        self.cat_registry = cat_registry
        self.person_registry = person_registry
        self.frame = None
        self.preview = None
        self.running = False
        self.thread = None
        self.last_event_at = datetime.min
        self.last_error = None
        self.event_counter_today = 0
        self.capture = None
        self.connect_time = None
        self.prev_gray = None
        self._error_streak = 0
        self.lock = threading.Lock()
        # Video recording state
        self._motion_frames: list = []
        self._motion_start_time: datetime | None = None
        self._last_motion_time: datetime | None = None
        proc = self.global_cfg.get("processing", {})
        self.detector = CoralObjectDetector(proc.get("detection", {}))
        self.bird_classifier = BirdSpeciesClassifier(proc.get("bird_species", {}))
        self._ach_lock = threading.Lock()
        self._ach_path = Path(self.global_cfg["storage"]["root"]) / "achievements.json"

    @property
    def cfg(self):
        return self.config_getter(self.camera_id) or {"id": self.camera_id, "name": self.camera_id}

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.capture is not None:
            try:
                self.capture.release()
            except Exception:
                pass

    def _open_capture(self):
        src = self.cfg.get("rtsp_url") or self.cfg.get("snapshot_url")
        if not src:
            raise RuntimeError(f"Kamera {self.camera_id}: keine Quelle gesetzt")
        if self.cfg.get("rtsp_url"):
            import os
            # Force TCP + disable hardware acceleration to prevent H.265 tile-split
            # pink/magenta artifact (classic half-frame corruption bug in FFmpeg/OpenCV).
            # hwaccel;none forces pure software decode — tested working on 4K HEVC stream.
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|hwaccel;none"
            cap = cv2.VideoCapture(self.cfg["rtsp_url"], cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                raise RuntimeError(f"Kamera {self.camera_id}: RTSP konnte nicht geöffnet werden")
            self.capture = cap
            self.connect_time = time.time()
            self.prev_gray = None  # reset motion state on reconnect
        else:
            self.capture = None

    def _grab_frame(self):
        if self.cfg.get("rtsp_url"):
            if self.capture is None or not self.capture.isOpened():
                self._open_capture()
            ok, frame = self.capture.read()
            if not ok or frame is None:
                raise RuntimeError(f"Kamera {self.camera_id}: Frame lesen fehlgeschlagen")
            # Reject H.265 pink/magenta corruption frames (hardware decode artifact)
            mean_r = float(frame[:, :, 2].mean())
            mean_b = float(frame[:, :, 0].mean())
            if mean_r > mean_b * 2.5 and mean_r > 150:
                log.debug("[%s] Pink frame discarded (R=%.0f B=%.0f)", self.camera_id, mean_r, mean_b)
                ok2, frame2 = self.capture.read()
                if ok2 and frame2 is not None:
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
        """Reject corrupt, uniform-gray, white, pink-artifact, or near-black frames."""
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
        mean_b = float(b_ch.mean())
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
        return True

    def _motion_detect(self, frame):
        """Returns (labels: list[str], motion_bbox: tuple|None).
        motion_bbox is (x, y, w, h) bounding rect of all motion combined."""
        proc = self.global_cfg.get("processing", {}).get("motion", {})
        if not proc.get("enabled", True):
            return [], None
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur_size = int(proc.get("blur_size", 15))
        if blur_size % 2 == 0:
            blur_size += 1
        gray = cv2.GaussianBlur(gray, (blur_size, blur_size), 0)
        if self.prev_gray is None:
            self.prev_gray = gray
            return [], None
        diff = cv2.absdiff(self.prev_gray, gray)
        self.prev_gray = gray
        _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
        thresh = cv2.dilate(thresh, None, iterations=2)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_area = int(proc.get("min_area", 3000))
        big = [c for c in contours if cv2.contourArea(c) >= min_area]
        if not big:
            return [], None
        all_pts = np.concatenate(big)
        bbox = cv2.boundingRect(all_pts)
        return ["motion"], bbox

    def _crop(self, frame, bbox):
        x1, y1, x2, y2 = bbox
        return frame[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]

    def _group(self):
        groups = {g.get("id"): g for g in self.global_cfg.get("camera_groups", [])}
        return groups.get(self.cfg.get("group_id"), {})

    def _save_motion_video(self, start_time: datetime, frames: list) -> str | None:
        """Save buffered frames as MP4. Returns path or None."""
        if not frames:
            return None
        try:
            day_dir = Path(self.global_cfg["storage"]["root"]) / "events" / self.camera_id / start_time.strftime("%Y-%m-%d")
            day_dir.mkdir(parents=True, exist_ok=True)
            event_id = start_time.strftime("%Y%m%d-%H%M%S-vid")
            vid_path = day_dir / f"{event_id}.mp4"
            h, w = frames[0].shape[:2]
            interval = max(0.05, float(self.global_cfg.get("processing", {}).get("motion", {}).get("frame_interval_ms", 150)) / 1000.0)
            fps = max(5, min(25, int(1.0 / interval)))
            writer = cv2.VideoWriter(str(vid_path), cv2.VideoWriter_fourcc(*'mp4v'), fps, (w, h))
            for f in frames:
                writer.write(f)
            writer.release()
            log.info("[%s] Motion video saved: %s (%d frames, %.1fs)", self.camera_id, vid_path.name, len(frames), len(frames) / fps)
            return str(vid_path)
        except Exception as e:
            log.error("[%s] Video save error: %s", self.camera_id, e)
            return None

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
                self._ach_path.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            log.info("[%s] Achievement unlocked: %s (%s)", self.camera_id, ach_id, species_label)
            return True
        except Exception as e:
            log.warning("[%s] Achievement unlock failed: %s", self.camera_id, e)
            return False

    def _loop(self):
        interval = max(0.05, float(self.global_cfg.get("processing", {}).get("motion", {}).get("frame_interval_ms", 150)) / 1000.0)
        cooldown = int(self.global_cfg.get("processing", {}).get("event_cooldown_seconds", 25))
        while self.running:
            try:
                frame = self._grab_frame()
                # Always store raw frame so status → "active" and snapshots work
                with self.lock:
                    self.frame = frame
                self.last_error = None  # clear on every successful frame read
                self._error_streak = 0
                # Quality gate: skip corrupt/uniform/artifact frames for events only
                if not self._is_frame_valid(frame):
                    time.sleep(interval)
                    continue
                # Stream warmup: ignore first 3 s after connect to skip transition frames
                if self.connect_time and time.time() - self.connect_time < 3.0:
                    time.sleep(interval)
                    continue
                motion_labels, motion_bbox = self._motion_detect(frame)
                detections = self.detector.detect_frame(frame)
                allowed = set(self.cfg.get("object_filter") or [])
                if allowed:
                    detections = [d for d in detections if d.label in allowed]
                labels = motion_labels + [d.label for d in detections]
                if self.bird_classifier.available:
                    for d in detections:
                        if d.label == "bird":
                            crop = self._crop(frame, d.bbox)
                            species, _ = self.bird_classifier.classify_crop(crop)
                            if species:
                                d.species = species
                if self.cat_registry:
                    for d in detections:
                        if d.label == "cat":
                            crop = self._crop(frame, d.bbox)
                            m = self.cat_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                if self.person_registry:
                    for d in detections:
                        if d.label == "person":
                            crop = self._crop(frame, d.bbox)
                            m = self.person_registry.match_details(crop)
                            if m:
                                d.identity = m.get("name")
                drawn = draw_detections(frame, detections)
                with self.lock:
                    self.preview = drawn
                # ── Video recording: buffer frames during motion ──────────────
                has_motion_now = bool(labels)
                now_t = datetime.now()
                if has_motion_now:
                    if self._motion_start_time is None:
                        self._motion_start_time = now_t
                    self._last_motion_time = now_t
                    if self.cfg.get("rtsp_url"):
                        dur_so_far = (now_t - self._motion_start_time).total_seconds()
                        if dur_so_far <= 30:
                            self._motion_frames.append(frame.copy())
                        elif len(self._motion_frames) >= 5:
                            # > 30s segment – save and start fresh
                            self._save_motion_video(self._motion_start_time, self._motion_frames)
                            self._motion_frames = [frame.copy()]
                            self._motion_start_time = now_t
                elif self._last_motion_time is not None:
                    since_last = (now_t - self._last_motion_time).total_seconds()
                    if since_last >= 30:
                        motion_total = (self._last_motion_time - self._motion_start_time).total_seconds() if self._motion_start_time else 0
                        if motion_total >= 10 and len(self._motion_frames) >= 5:
                            self._save_motion_video(self._motion_start_time, self._motion_frames)
                        self._motion_frames = []
                        self._motion_start_time = None
                        self._last_motion_time = None

                # ── Event trigger: person bypasses cooldown ──────────────────
                has_person = "person" in labels
                elapsed = (datetime.now() - self.last_event_at).total_seconds()
                if labels and (has_person or elapsed >= cooldown):
                    self.last_event_at = datetime.now()
                    self.event_counter_today += 1
                    ts = datetime.now()
                    event_id = ts.strftime("%Y%m%d-%H%M%S-%f")
                    day_dir = Path(self.global_cfg["storage"]["root"]) / "events" / self.camera_id / ts.strftime("%Y-%m-%d")
                    day_dir.mkdir(parents=True, exist_ok=True)
                    snap_path = day_dir / f"{event_id}.jpg"
                    save_frame = drawn.copy()
                    # Draw green motion bounding box if motion was detected
                    if motion_bbox is not None:
                        mx, my, mw, mh = motion_bbox
                        cv2.rectangle(save_frame, (mx, my), (mx + mw, my + mh), (0, 220, 0), 2)
                    h_px, w_px = save_frame.shape[:2]
                    if w_px > 1280:
                        scale = 1280 / w_px
                        save_frame = cv2.resize(save_frame, (1280, int(h_px * scale)), interpolation=cv2.INTER_AREA)
                    cv2.imwrite(str(snap_path), save_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                    rel = snap_path.relative_to(Path(self.global_cfg["storage"]["root"]))
                    public_base = (self.global_cfg.get("server", {}).get("public_base_url") or "").rstrip("/")
                    snapshot_url = f"{public_base}/media/{rel.as_posix()}" if public_base else None
                    top_det = max(detections, key=lambda d: d.score, default=None)
                    cat_match = next((d.identity for d in detections if d.label == "cat" and d.identity), None)
                    person_match = next((d.identity for d in detections if d.label == "person" and d.identity), None)
                    bird_species = next((d.species for d in detections if d.label == "bird" and d.species), None)
                    group = self._group()
                    after_hours = is_in_schedule(self.cfg.get("schedule") or group.get("schedule") or {})
                    whitelisted = bool(person_match and (person_match in (self.cfg.get("whitelist_names") or [])))
                    if self.person_registry and person_match:
                        p = self.person_registry.get_profile(person_match) or {}
                        whitelisted = whitelisted or bool(p.get("whitelisted"))
                    level, notify = choose_alarm_level(group, list(sorted(set(labels))), after_hours, whitelisted)
                    event = {
                        "event_id": event_id,
                        "camera_id": self.camera_id,
                        "camera_name": self.cfg.get("name", self.camera_id),
                        "group_id": self.cfg.get("group_id"),
                        "camera_role": self.cfg.get("role"),
                        "armed": bool(self.cfg.get("armed", True)),
                        "after_hours": after_hours,
                        "alarm_level": level,
                        "time": ts.isoformat(timespec="seconds"),
                        "labels": sorted(set(labels)),
                        "top_label": top_det.label if top_det else labels[0],
                        "bird_species": bird_species,
                        "cat_name": cat_match,
                        "person_name": person_match,
                        "whitelisted": whitelisted,
                        "detections": [d.to_dict() for d in detections],
                        "snapshot_url": snapshot_url,
                        "snapshot_relpath": rel.as_posix(),
                        "video_url": None,
                    }
                    self.store.add_event(self.camera_id, event)
                    if self.mqtt and self.cfg.get("mqtt_enabled", True):
                        self.mqtt.publish(f"events/{self.camera_id}", event)
                    # Apply group-specific telegram rules
                    _send_tg = notify and self.cfg.get("telegram_enabled", True)
                    if _send_tg:
                        tg_cfg = self.global_cfg.get("telegram", {})
                        tg_groups = tg_cfg.get("groups", {})
                        g_id = self.cfg.get("group_id")
                        if g_id and g_id in tg_groups:
                            gr = tg_groups[g_id]
                            if not gr.get("enabled", True):
                                _send_tg = False
                            elif gr.get("objects") and not any(lbl in set(gr["objects"]) for lbl in labels):
                                _send_tg = False
                            elif gr.get("from") and gr.get("to"):
                                if not is_in_schedule({"enabled": True, "start": gr["from"], "end": gr["to"]}):
                                    _send_tg = False
                    # Achievement unlock for first-time species detection
                    if bird_species:
                        newly_unlocked = self._try_unlock_achievement(bird_species, bird_species)
                        if newly_unlocked and self.notifier:
                            try:
                                ach_msg = f"🏆 Neue Trophäe freigeschaltet: {bird_species}!\n📷 Kamera: {self.cfg.get('name', self.camera_id)}"
                                import threading as _thr
                                _thr.Thread(target=self.notifier.send_alert_sync, kwargs={"caption": ach_msg}, daemon=True).start()
                            except Exception:
                                pass
                    if _send_tg:
                        top_bird_score = next((d.score for d in detections if d.label == "bird" and d.species), None)
                        if bird_species:
                            # Spezielles Vogel-Format
                            score_pct = f"{top_bird_score * 100:.0f}" if top_bird_score else "?"
                            caption = (
                                f"🐦 Vogel erkannt: {bird_species}\n"
                                f"📷 Kamera: {self.cfg.get('name', self.camera_id)}\n"
                                f"⏰ {event['time']}\n"
                                f"📊 Sicherheit: {score_pct}%"
                            )
                        else:
                            details = []
                            if cat_match:
                                details.append(f"🐈 {cat_match}")
                            if person_match:
                                details.append(f"🧍 {person_match}{' (Whitelist)' if whitelisted else ''}")
                            caption = f"{'🚨' if level == 'alarm' else 'ℹ️'} {', '.join(sorted(set(labels)))}\n📷 {self.cfg.get('name', self.camera_id)}\n📍 {self.cfg.get('location', '')}\n🕒 {event['time']}"
                            if details:
                                caption += "\n" + " · ".join(details)
                        with open(snap_path, "rb") as fh:
                            self.notifier.send_alert_sync(caption=caption, jpeg_bytes=fh.read(), snapshot_url=snapshot_url, dashboard_url=public_base, camera_id=self.camera_id)
                self.last_error = None
            except Exception as e:
                self._error_streak += 1
                self.last_error = str(e)
                if self._error_streak % 3 == 1:
                    log.error("[%s] error_streak=%d: %s", self.camera_id, self._error_streak, e)
                try:
                    if self.capture is not None:
                        self.capture.release()
                except Exception:
                    pass
                self.capture = None
                time.sleep(5.0)
            time.sleep(interval)

    def snapshot_jpeg(self, quality=88):
        with self.lock:
            frame = self.preview if self.preview is not None else self.frame
            if frame is None:
                return None
            ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            return buf.tobytes() if ok else None

    def status(self):
        cfg = self.cfg
        return {
            "id": self.camera_id,
            "name": cfg.get("name", self.camera_id),
            "location": cfg.get("location", ""),
            "enabled": cfg.get("enabled", True),
            "group_id": cfg.get("group_id"),
            "role": cfg.get("role"),
            "armed": cfg.get("armed", True),
            "source": "rtsp" if cfg.get("rtsp_url") else "snapshot",
            "last_error": self.last_error,
            "status": "error" if self._error_streak >= 10 else ("active" if self.frame is not None else "starting"),
            "today_events": self.event_counter_today,
            "timelapse_enabled": bool((cfg.get("timelapse") or {}).get("enabled")),
            "detection_mode": getattr(self.detector, "mode", "motion_only"),
            "coral_available": getattr(self.detector, "available", False),
            "coral_reason": getattr(self.detector, "reason", "disabled"),
            "bird_species_available": getattr(self.bird_classifier, "available", False),
            "bird_species_mode": getattr(self.bird_classifier, "mode", "none"),
        }

from __future__ import annotations
import cv2
import time
import threading
import logging
from datetime import datetime
from pathlib import Path
import requests
import numpy as np
from .detectors import CoralObjectDetector, BirdSpeciesClassifier, draw_detections
from .event_logic import is_in_schedule, choose_alarm_level

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
        proc = self.global_cfg.get("processing", {})
        self.detector = CoralObjectDetector(proc.get("detection", {}))
        self.bird_classifier = BirdSpeciesClassifier(proc.get("bird_species", {}))

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
            cap = cv2.VideoCapture(self.cfg["rtsp_url"])
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
        """Reject corrupt, uniform-gray, white, or artifact frames."""
        if frame is None or frame.size == 0:
            return False
        h, w = frame.shape[:2]
        if w < 64 or h < 48:
            return False
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mean_val = float(np.mean(gray))
        if mean_val < 20 or mean_val > 240:
            return False
        std_val = float(np.std(gray))
        if std_val > 80:
            return False
        # Reject frames where >30% of pixels are R≈G≈B (uniform gray/white)
        b_ch, g_ch, r_ch = cv2.split(frame)
        uniform = np.sum(
            (np.abs(r_ch.astype(np.int16) - g_ch.astype(np.int16)) < 10) &
            (np.abs(r_ch.astype(np.int16) - b_ch.astype(np.int16)) < 10)
        )
        if uniform > 0.3 * h * w:
            return False
        return True

    def _motion_detect(self, frame):
        """Returns (labels: list[str], motion_bbox: tuple|None).
        motion_bbox is (x, y, w, h) bounding rect of all motion combined."""
        proc = self.global_cfg.get("processing", {}).get("motion", {})
        if not proc.get("enabled", True):
            return [], None
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur_size = int(proc.get("blur_size", 21))
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
        min_area = int(proc.get("min_area", 5000))
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

    def _loop(self):
        interval = max(0.1, float(self.global_cfg.get("processing", {}).get("motion", {}).get("frame_interval_ms", 350)) / 1000.0)
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
                if labels and (datetime.now() - self.last_event_at).total_seconds() >= cooldown:
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
                    if notify and self.cfg.get("telegram_enabled", True):
                        details = []
                        if bird_species:
                            details.append(f"🐦 {bird_species}")
                        if cat_match:
                            details.append(f"🐈 {cat_match}")
                        if person_match:
                            details.append(f"🧍 {person_match}{' (Whitelist)' if whitelisted else ''}")
                        caption = f"{ '🚨' if level == 'alarm' else 'ℹ️' } {', '.join(sorted(set(labels)))}\n📷 {self.cfg.get('name', self.camera_id)}\n📍 {self.cfg.get('location', '')}\n🕒 {event['time']}"
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
            "detection_mode": self.global_cfg.get("processing", {}).get("detection", {}).get("mode", "none"),
            "coral_available": getattr(self.detector, "available", False),
            "coral_reason": getattr(self.detector, "reason", "disabled"),
            "bird_species_available": getattr(self.bird_classifier, "available", False),
        }

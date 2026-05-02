from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — some symbols are unused in this
# mixin but kept identical across mixins so methods can move between them
# without import bookkeeping. See service.py for the canonical import list.
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import requests

from ._consts import (
    EVENT_ICON_HEX,
    EVENT_LABEL_DE,
    HISTORY_FIELDS,
    HISTORY_FIELD_TO_EVENT,
    HISTORY_LABELS_DE,
    HISTORY_MAXLEN,
    HISTORY_UNITS,
    _atomic_write_json,
    _is_quiet_now,
    _safe_dt,
    _safe_subset,
    log,
)


class ClipMixin:
    """Sighting clip pipeline: trigger → encode → push to Telegram.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _trigger_clip(self, cam_id: str, evt: str, severity: float,
                      api_data: dict, sun_data: dict):
        rt = self.runtimes.get(cam_id)
        if rt is None or rt.weather_prebuffer is None:
            log.warning("[weather] cam %s has no prebuffer — clip aborted", cam_id)
            return
        clip_cfg = self.cfg.get("clip") or {}
        post_s = int(clip_cfg.get("post_roll_s", 5) or 5)
        fps    = int(clip_cfg.get("fps", 15) or 15)
        # Snap the pre-roll right now and start the post-roll session.
        pre = rt.weather_prebuffer.snapshot()
        session = rt.weather_prebuffer.start_postroll(post_s)
        # Wait for post-roll to complete.
        time.sleep(post_s + 0.3)
        post = rt.weather_prebuffer.collect_postroll(session)
        frames = pre + post
        if len(frames) < max(2, fps):
            log.warning("[weather] clip %s/%s: only %d frames captured — discarding",
                        cam_id, evt, len(frames))
            return
        ts_dt = datetime.now()
        ts_label = ts_dt.strftime("%Y-%m-%d_%H%M%S")
        out_dir = self._sightings_dir() / cam_id / evt
        out_dir.mkdir(parents=True, exist_ok=True)
        mp4_path  = out_dir / f"{ts_label}.mp4"
        thumb_path = out_dir / f"{ts_label}.jpg"
        if not self._encode_clip(frames, mp4_path, fps):
            log.warning("[weather] clip encode failed for %s/%s", cam_id, evt)
            return
        # Thumbnail = middle JPEG frame, written verbatim (no re-encode).
        try:
            mid = frames[len(frames) // 2][1]
            thumb_path.write_bytes(mid)
        except Exception as e:
            log.debug("[weather] thumb write failed: %s", e)
        # Manifest.
        manifest = {
            "id":           f"{cam_id}__{evt}__{ts_label}",
            "cam_id":       cam_id,
            "cam_name":     self._cam_name(cam_id),
            "event_type":   evt,
            "started_at":   ts_dt.isoformat(timespec="seconds"),
            "severity":     round(float(severity), 3),
            "score":        round(float(severity), 3),
            "api_snapshot": _safe_subset(api_data, [
                "time", "precipitation", "snowfall", "lightning_potential",
                "visibility", "wind_gusts_10m", "cloud_cover", "weather_code",
            ]),
            "sun_snapshot": {"altitude": sun_data.get("altitude"),
                             "azimuth":  sun_data.get("azimuth")},
            "clip_path":    f"weather/{cam_id}/{evt}/{mp4_path.name}",
            "thumb_path":   f"weather/{cam_id}/{evt}/{thumb_path.name}",
            "duration_s":   round(len(frames) / max(1, fps), 2),
            "fps":          fps,
            "width":        int(clip_cfg.get("width", 1280) or 1280),
            "height":       0,  # filled below if probe succeeds
        }
        try:
            import cv2
            cap = cv2.VideoCapture(str(mp4_path))
            manifest["width"]  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))  or manifest["width"]
            manifest["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            cap.release()
        except Exception:
            pass
        manifest_path = out_dir / f"{ts_label}.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
        log.info("[weather] Clip written: %s · %s · %.1fs · sev=%.2f",
                 self._cam_name(cam_id), EVENT_LABEL_DE.get(evt, evt),
                 manifest["duration_s"], severity)
        # Phase 3: per-event Telegram push.
        self._maybe_push_telegram(manifest, mp4_path)

    @staticmethod
    def _encode_clip(frames: list[tuple[float, bytes]], out_path: Path, fps: int) -> bool:
        """Pipe the JPEG stream straight into ffmpeg's mjpeg demuxer.
        Stream-copy would be cleanest but mjpeg→h264 transcode is essentially
        free on these clip lengths and gives us a browser-friendly mp4."""
        if not shutil.which("ffmpeg"):
            log.warning("[weather] ffmpeg not available — cannot encode clip")
            return False
        cmd = [
            "ffmpeg", "-y",
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-framerate", str(int(fps)),
            "-i", "pipe:0",
            "-vcodec", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(out_path),
        ]
        try:
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            write_failed = False
            for _ts, jpg in frames:
                try:
                    proc.stdin.write(jpg)
                except Exception:
                    write_failed = True
                    break
            # Don't proc.stdin.close() here — communicate() does it for us, and
            # a manual close before communicate raises "flush of closed file"
            # on the next communicate() call.
            try:
                _out, err = proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                log.warning("[weather] ffmpeg timeout — killed")
                return False
            if proc.returncode != 0:
                log.warning("[weather] ffmpeg rc=%s stderr=%s",
                            proc.returncode, (err or b"").decode("utf-8", "replace")[-300:])
                return False
            if write_failed:
                log.debug("[weather] partial frame write — clip may be short")
            return out_path.exists() and out_path.stat().st_size > 1024
        except Exception as e:
            log.warning("[weather] ffmpeg pipe error: %s", e)
            return False

    # ── Read paths used by API endpoints ────────────────────────────────────

    def _maybe_push_telegram(self, manifest: dict, mp4_path: Path):
        """After a successful clip write, push the video to Telegram if the
        per-event toggle is on and severity meets the min-score gate."""
        try:
            tg = self.telegram_getter() if callable(self.telegram_getter) else None
            if tg is None or not getattr(tg, "enabled", False):
                return
            push_cfg = (getattr(tg, "push_cfg", {}) or {})
            wcfg = push_cfg.get("weather") or {}
            if not wcfg.get("enabled", True):
                return
            evt = manifest.get("event_type")
            if not (wcfg.get("events") or {}).get(evt, False):
                log.debug("[weather] tg push skip: %s disabled in push.weather.events", evt)
                return
            min_score = float(wcfg.get("min_score", 0.4) or 0.0)
            score = float(manifest.get("score") or manifest.get("severity") or 0.0)
            if score < min_score:
                log.info("[weather] tg push skip: %s score=%.2f < min=%.2f",
                         evt, score, min_score)
                return
            cam_name = manifest.get("cam_name") or manifest.get("cam_id", "?")
            cap = (f"<b>{EVENT_LABEL_DE.get(evt, evt)} · {cam_name}</b>\n"
                   f"{self._api_summary_line(manifest.get('api_snapshot') or {})}")
            buttons = [[
                ("🖼 In der Mediathek öffnen",
                 self._dashboard_url(f"#weather/{manifest.get('id', '')}")),
            ]]
            # Quiet hours respect — mirrors push.silent semantics from Phase 1.
            silent = bool(_is_quiet_now(push_cfg.get("quiet_hours") or {}))
            tg.send(cap, video=str(mp4_path), buttons=buttons, silent=silent)
            log.info("[weather] Push gesendet: %s (%s, sev=%.2f)",
                     evt, cam_name, score)
        except Exception as e:
            log.warning("[weather] tg push failed: %s", e)

    @staticmethod
    def _api_summary_line(snap: dict) -> str:
        parts = []
        for key, label, unit, fmt in [
            ("precipitation",       "Niederschlag",     "mm/h", "%g"),
            ("snowfall",            "Schnee",           "cm/h", "%g"),
            ("lightning_potential", "Blitz-Pot.",       "J/kg", "%g"),
            ("visibility",          "Sicht",            "m",    "%g"),
            ("wind_gusts_10m",      "Wind",             "km/h", "%g"),
            ("cloud_cover",         "Wolken",           "%",    "%g"),
        ]:
            v = snap.get(key)
            if v is None:
                continue
            try:
                parts.append(f"{fmt % float(v)} {unit} {label}")
            except Exception:
                pass
        return " · ".join(parts[:3]) if parts else "—"

    def _dashboard_url(self, suffix: str = "") -> str:
        base = (self.server_cfg.get("public_base_url") or "").rstrip("/")
        if not base:
            base = "https://example.invalid"
        return f"{base}/{suffix}"

    # ── Recaps (Phase 3) ────────────────────────────────────────────────────


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


class LifecycleMixin:
    """Service lifecycle (start/shutdown/reload) + 5-min poll loop + prebuffer attach.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def start(self):
        if not self.cfg.get("enabled", True):
            log.info("[weather] Service disabled via config")
            return
        loc = self.server_cfg.get("location") or {}
        if loc.get("lat") is None or loc.get("lon") is None:
            log.warning("[weather] No server.location set — service cannot poll. Refusing to start.")
            return
        try:
            from apscheduler.schedulers.background import BackgroundScheduler
            self._scheduler = BackgroundScheduler(daemon=True)
            self._scheduler.start()
        except Exception as e:
            log.error("[weather] Scheduler start failed: %s", e)
            return
        # Attach prebuffers to opted-in cameras so post-roll capture has
        # something to splice on.
        self._attach_prebuffers()
        # Register the recurring poll job.
        from apscheduler.triggers.interval import IntervalTrigger
        interval = int(self.cfg.get("poll_interval", 300) or 300)
        self._scheduler.add_job(
            self._safe_poll, IntervalTrigger(seconds=interval),
            id="weather_poll", replace_existing=True,
            max_instances=1, coalesce=True,
        )
        # Fire once a few seconds after start so the dashboard isn't blank
        # for `interval` seconds — and so camera runtimes (which are started
        # by rebuild_runtimes() AFTER rebuild_services()) have time to be
        # inserted into the shared runtimes dict before _sync_prebuffers runs.
        try:
            from apscheduler.triggers.date import DateTrigger
            self._scheduler.add_job(
                self._safe_poll,
                DateTrigger(run_date=datetime.now() + timedelta(seconds=8)),
                id="weather_poll_initial",
            )
        except Exception:
            pass
        # Recap jobs (quarterly + yearly) — calculated for current and next
        # year so the scheduler always knows the upcoming firings even when
        # the service was started after this year's Q1 has already happened.
        self._register_recap_jobs()
        # Sun-Timelapse: register today's sunrise/sunset jobs and a daily
        # cron at 00:05 that re-registers for the new day.
        self._register_sun_jobs()
        try:
            from apscheduler.triggers.cron import CronTrigger
            self._scheduler.add_job(
                self._register_sun_jobs, CronTrigger(hour=0, minute=5),
                id="sun_tl_recompute", replace_existing=True,
                max_instances=1, coalesce=True,
            )
        except Exception as e:
            log.warning("[weather] daily recompute job failed: %s", e)
        cams_in = [self._cam_name(cid) for cid in self._enabled_cam_ids()]
        log.info("[weather] Service started · interval=%ss · cameras=%s", interval, cams_in)

    def shutdown(self):
        if self._stopped:
            return
        self._stopped = True
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
                log.info("[weather] Service stopped")
        except Exception as e:
            log.warning("[weather] shutdown failed: %s", e)
        self._scheduler = None
        # Detach prebuffers so cameras stop spending CPU on JPEG encoding.
        self._detach_prebuffers()

    def reload(self, new_cfg: dict, server_cfg: dict | None = None):
        was_enabled = bool(self.cfg.get("enabled", True))
        self.cfg = new_cfg or {}
        if server_cfg is not None:
            self.server_cfg = server_cfg
        self._stopped = False
        # Tear down the scheduler and prebuffers, rebuild them under the new
        # config. Same in-place pattern TelegramService.reload uses.
        try:
            if self._scheduler:
                self._scheduler.shutdown(wait=False)
        except Exception:
            pass
        self._scheduler = None
        self._detach_prebuffers()
        if not self.cfg.get("enabled", True):
            log.info("[weather] reloaded — disabled")
            with self._lock:
                self._status["enabled"] = False
            return
        with self._lock:
            self._status["enabled"] = True
        self.start()
        if not was_enabled:
            log.info("[weather] reloaded — newly enabled")
        else:
            log.info("[weather] reload applied")

    # ── Camera prebuffer attach/detach ──────────────────────────────────────

    def _enabled_cam_ids(self) -> list[str]:
        ids = []
        for cam_id, rt in (self.runtimes or {}).items():
            if (rt.cfg.get("weather") or {}).get("enabled"):
                ids.append(cam_id)
        return ids

    def _cam_name(self, cam_id: str) -> str:
        rt = self.runtimes.get(cam_id)
        if not rt:
            return cam_id
        try:
            return rt.cfg.get("name") or cam_id
        except Exception:
            return cam_id

    def _attach_prebuffers(self):
        from ..camera_runtime import WeatherPrebuffer
        clip = self.cfg.get("clip") or {}
        pre_s = int(clip.get("pre_roll_s", 5) or 5)
        fps   = int(clip.get("fps",        15) or 15)
        for cam_id in self._enabled_cam_ids():
            rt = self.runtimes.get(cam_id)
            if rt is None:
                continue
            if rt.weather_prebuffer is None:
                rt.weather_prebuffer = WeatherPrebuffer(pre_roll_s=pre_s, fps=fps)
                log.info("[weather] Prebuffer attached to %s (pre=%ss fps=%s)",
                         self._cam_name(cam_id), pre_s, fps)

    def _detach_prebuffers(self):
        for rt in (self.runtimes or {}).values():
            try:
                rt.weather_prebuffer = None
            except Exception:
                pass

    # ── Polling ─────────────────────────────────────────────────────────────

    def _safe_poll(self):
        # Re-sync prebuffers every poll: rebuild_runtimes() runs the
        # service-init BEFORE the camera dict is populated, so the start()
        # call finds an empty runtimes map. Re-checking here is also how we
        # pick up cameras the user enables / disables at runtime.
        self._sync_prebuffers()
        try:
            self._poll_once()
            self._fail_streak = 0
        except Exception as e:
            self._fail_streak += 1
            log.warning("[weather] poll failed (#%d): %s", self._fail_streak, e)
            with self._lock:
                self._status["last_api_ok"] = False
                self._status["last_poll_at"] = datetime.now().isoformat(timespec="seconds")

    def _sync_prebuffers(self):
        from ..camera_runtime import WeatherPrebuffer
        clip = self.cfg.get("clip") or {}
        pre_s = int(clip.get("pre_roll_s", 5) or 5)
        fps   = int(clip.get("fps",        15) or 15)
        enabled_ids = set(self._enabled_cam_ids())
        for cam_id, rt in (self.runtimes or {}).items():
            if cam_id in enabled_ids:
                if rt.weather_prebuffer is None:
                    rt.weather_prebuffer = WeatherPrebuffer(pre_roll_s=pre_s, fps=fps)
                    log.info("[weather] Prebuffer attached to %s (pre=%ss fps=%s)",
                             self._cam_name(cam_id), pre_s, fps)
            else:
                if rt.weather_prebuffer is not None:
                    rt.weather_prebuffer = None
                    log.info("[weather] Prebuffer detached from %s (weather disabled)",
                             self._cam_name(cam_id))

    def _poll_once(self):
        loc = self.server_cfg.get("location") or {}
        lat, lon = loc.get("lat"), loc.get("lon")
        if lat is None or lon is None:
            log.warning("[weather] no location — skipping poll")
            return

        api = self.cfg.get("api") or {}
        url = api.get("base_url") or "https://api.open-meteo.com/v1/forecast"
        params = {
            "latitude":  lat,
            "longitude": lon,
            "minutely_15": ",".join([
                "precipitation", "snowfall", "weather_code",
                "lightning_potential", "visibility",
                "wind_gusts_10m", "cloud_cover",
            ]),
            "timezone": api.get("timezone") or "Europe/Berlin",
            "models":   api.get("model") or "icon_d2",
        }
        r = requests.get(url, params=params, timeout=10)
        if r.status_code >= 500:
            raise RuntimeError(f"upstream {r.status_code}")
        if r.status_code != 200:
            raise RuntimeError(f"http {r.status_code}: {r.text[:200]}")
        payload = r.json()
        latest = self._latest_slice(payload)
        sun = self._sun_position()

        # Build the "current state" dict that the status endpoint exposes
        # AND that Phase-2 UI panels will display in near-real-time.
        cur_state: dict[str, bool] = {}
        events_cfg = (self.cfg.get("events") or {})
        for evt_type in EVENT_LABEL_DE:
            cfg = events_cfg.get(evt_type) or {}
            if not cfg.get("enabled", False):
                cur_state[evt_type] = False
                continue
            active, severity = self._detect(evt_type, cfg, latest, sun)
            cur_state[evt_type] = bool(active)
            if not active:
                continue
            for cam_id in self._enabled_cam_ids():
                in_cd, mins = self._cooldown.check(cam_id, evt_type)
                if in_cd:
                    log.info("[weather] Skip %s on %s: in cooldown (%d min remaining)",
                             evt_type, self._cam_name(cam_id), mins)
                    continue
                cooldown_min = int(cfg.get("cooldown_min", 30) or 30)
                self._cooldown.arm(cam_id, evt_type, cooldown_min)
                # Spin the clip build off so the next poll isn't blocked.
                threading.Thread(
                    target=self._trigger_clip,
                    args=(cam_id, evt_type, severity, latest, sun),
                    daemon=True,
                    name=f"weather-clip-{cam_id}-{evt_type}",
                ).start()
                log.info("[weather] %s on %s · severity=%.2f · clip building",
                         EVENT_LABEL_DE.get(evt_type, evt_type), self._cam_name(cam_id), severity)

        # Wetter-Ereignis-Timelapse — separate trigger pipeline that walks
        # the full minutely_15 forecast (not just the latest slot) and uses
        # its own per-cam cross-trigger cooldown + daily cap.
        try:
            self._check_event_tl_triggers(payload)
        except Exception as e:
            log.warning("[weather] trigger eval failed: %s", e)

        with self._lock:
            self._status["last_poll_at"] = datetime.now().isoformat(timespec="seconds")
            self._status["last_api_ok"] = True
            self._status["current_state"] = cur_state
        # Persist this slot to the history ring buffer for the
        # Wetterstatistik chart. Best-effort — a write failure must never
        # interrupt the poll cadence.
        try:
            self._record_sample(latest, sun)
        except Exception as e:
            log.warning("[weather] history record failed: %s", e)
        # Mirror the last-poll timestamp into the runtime store so the
        # Telegram /status command can show "letzter Poll vor N min".
        try:
            if self.settings_store:
                self.settings_store.runtime_set("weather_last_poll_ts", time.time())
        except Exception:
            pass


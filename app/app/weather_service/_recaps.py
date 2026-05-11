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


class RecapsMixin:
    """Cross-day recap generation: definitions, builder, concat, push.

    Mixin for WeatherService. Methods access shared state via `self.*`
    (cfg, runtimes, settings_store, scheduler, etc.) which live on the
    concrete class.
    """

    def _recaps_dir(self) -> Path:
        return self._sightings_dir() / "recaps"

    @staticmethod
    def _last_sunday_of(year: int, month: int) -> date:
        """Last Sunday on or before the last day of <month>."""
        # Find the last day of the month by stepping into the next month
        # and back one day. No relativedelta dependency needed.
        if month == 12:
            d = date(year + 1, 1, 1) - timedelta(days=1)
        else:
            d = date(year, month + 1, 1) - timedelta(days=1)
        while d.weekday() != 6:  # 0=Mon, 6=Sun
            d -= timedelta(days=1)
        return d

    def _recap_definitions(self, year: int) -> list[dict]:
        """All recap firings for a given year. Each defines: period_id,
        period_label, run_at (datetime), period_start (date), period_end (date)."""
        out = []
        # Quarterly (Q1–Q3): last Sunday of Mar/Jun/Sep at 16:00.
        for q, end_month in [(1, 3), (2, 6), (3, 9)]:
            run_d = self._last_sunday_of(year, end_month)
            out.append({
                "period_id":    f"q{q}_{year}",
                "period_label": f"Q{q} {year}",
                "run_at":       datetime(run_d.year, run_d.month, run_d.day, 16, 0),
                "period_start": date(year, (q - 1) * 3 + 1, 1),
                "period_end":   date(year, end_month, 28) + timedelta(days=4),  # last day of month, sloppy
            })
        # Q4 + Jahres-Recap: 02. Januar des FOLGEJAHRES um 16:00.
        # Both fire on the same day; period_id distinguishes them so the
        # idempotent re-registration treats them as separate jobs.
        run_q4 = datetime(year + 1, 1, 2, 16, 0)
        out.append({
            "period_id":    f"q4_{year}",
            "period_label": f"Q4 {year}",
            "run_at":       run_q4,
            "period_start": date(year, 10, 1),
            "period_end":   date(year, 12, 31),
        })
        out.append({
            "period_id":    f"year_{year}",
            "period_label": f"Jahres-Rückblick {year}",
            "run_at":       run_q4 + timedelta(minutes=10),  # 16:10 same day
            "period_start": date(year, 1, 1),
            "period_end":   date(year, 12, 31),
        })
        # Trim period_end to actual last day of month for quarterly periods.
        for r in out:
            if r["period_id"].startswith("q") and not r["period_id"].startswith("q4"):
                # Re-derive precisely: last day of period_end month
                pe = r["period_end"]
                if pe.month == 12:
                    r["period_end"] = date(pe.year + 1, 1, 1) - timedelta(days=1)
                else:
                    r["period_end"] = date(pe.year, pe.month + 1, 1) - timedelta(days=1)
        return out

    def _register_recap_jobs(self):
        if not self._scheduler:
            return
        from apscheduler.triggers.date import DateTrigger
        now = datetime.now()
        registered = []
        for year in (now.year, now.year + 1):
            for r in self._recap_definitions(year):
                if r["run_at"] <= now:
                    continue  # past — don't re-fire
                # Idempotent skip if a recap manifest already exists for this period.
                if (self._recaps_dir() / f"{r['period_id']}.json").exists():
                    continue
                self._scheduler.add_job(
                    self._run_recap_safe,
                    DateTrigger(run_date=r["run_at"]),
                    id=f"weather_recap_{r['period_id']}",
                    replace_existing=True,
                    args=[r],
                )
                registered.append(f"{r['period_label']} → {r['run_at'].strftime('%Y-%m-%d %H:%M')}")
        if registered:
            log.info("[weather] Recap jobs scheduled: %s", "; ".join(registered))
        else:
            log.info("[weather] Recap jobs: keine zukünftigen Termine ausstehend")

    def _run_recap_safe(self, r: dict):
        """Wrapper that runs the build in a daemon thread so the scheduler
        thread isn't blocked by a long ffmpeg run."""
        threading.Thread(
            target=self._build_recap, args=[r],
            daemon=True, name=f"weather-recap-{r['period_id']}",
        ).start()

    def _build_recap(self, r: dict):
        try:
            cands = self._collect_recap_candidates(r["period_start"], r["period_end"])
            if len(cands) < 3:
                log.info("[weather] Recap %s skipped — only %d candidates (need 3)",
                         r["period_label"], len(cands))
                return
            picks = self._pick_recap_clips(cands)
            if len(picks) < 3:
                log.info("[weather] Recap %s: only %d picks survived", r["period_label"], len(picks))
                return
            self._recaps_dir().mkdir(parents=True, exist_ok=True)
            mp4_path = self._recaps_dir() / f"{r['period_id']}.mp4"
            duration = self._concat_clips([self._sightings_dir().parent / p["clip_path"] for p in picks], mp4_path)
            if not duration:
                log.warning("[weather] Recap %s: ffmpeg concat failed", r["period_label"])
                return
            manifest = {
                "id":            r["period_id"],
                "period_label":  r["period_label"],
                "period_start":  r["period_start"].isoformat(),
                "period_end":    r["period_end"].isoformat(),
                "built_at":      datetime.now().isoformat(timespec="seconds"),
                "clip_path":     f"weather/recaps/{mp4_path.name}",
                "n_clips":       len(picks),
                "duration_s":    int(duration),
                "included_sightings": [p.get("id") for p in picks],
            }
            _atomic_write_json(self._recaps_dir() / f"{r['period_id']}.json", manifest)
            log.info("[weather] Recap built: %s · %d Clips · %ds",
                     r["period_label"], len(picks), int(duration))
            self._maybe_push_recap(manifest, mp4_path)
        except Exception as e:
            log.warning("[weather] Recap %s build failed: %s", r.get("period_label"), e)

    def _collect_recap_candidates(self, start_d: date, end_d: date) -> list[dict]:
        root = self._sightings_dir()
        out = []
        if not root.exists():
            return out
        for cam_dir in root.iterdir():
            if not cam_dir.is_dir() or cam_dir.name == "recaps":
                continue
            for evt_dir in cam_dir.iterdir():
                if not evt_dir.is_dir():
                    continue
                for jf in evt_dir.glob("*.json"):
                    try:
                        m = json.loads(jf.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    started = _safe_dt(m.get("started_at", ""))
                    if not started:
                        continue
                    if started.date() < start_d or started.date() > end_d:
                        continue
                    if float(m.get("score") or 0.0) < 0.4:
                        continue
                    out.append(m)
        return out

    # Event-timelapse triggers — keep in sync with the WEATHER_TYPES keys
    # the frontend defines for these. Used to bump the per-type recap cap.
    _EVENT_TL_TRIGGERS: tuple[str, ...] = ("thunder_rising", "front_passing", "storm_front")

    @classmethod
    def _pick_recap_clips(cls, cands: list[dict], per_type_max: int = 3,
                          total_cap: int = 12) -> list[dict]:
        # Group by event_type, take top `per_type_max` by score per group.
        # Event-Timelapse triggers get a higher cap because they're longer,
        # rarer and more curated than the 10-s clips — a dramatic quarter
        # with several storm fronts deserves to be represented properly.
        EVT_TL_CAP = 5
        by_type: dict[str, list[dict]] = {}
        for m in cands:
            et = m.get("event_type", "?")
            # Manifest may carry the on-disk generic "event_timelapse" type
            # (when read straight from disk by the recap collector). Map
            # back to the trigger so per-type bucketing matches the UI.
            if et == "event_timelapse":
                et = (m.get("trigger") or et)
            by_type.setdefault(et, []).append(m)
        picked = []
        for evt, items in by_type.items():
            items.sort(key=lambda m: float(m.get("score") or 0.0), reverse=True)
            cap = EVT_TL_CAP if evt in cls._EVENT_TL_TRIGGERS else per_type_max
            picked.extend(items[:cap])
        picked.sort(key=lambda m: m.get("started_at", ""))
        return picked[:total_cap]

    @staticmethod
    def _concat_clips(input_paths: list[Path], out_path: Path) -> int:
        """Concat input mp4s into a single reel. Re-encodes to a uniform 1280×720
        H.264 so mixed source resolutions / fps don't trip up the demuxer.
        Returns the total duration in seconds (int) on success, 0 on failure."""
        if not shutil.which("ffmpeg"):
            log.warning("[weather] ffmpeg unavailable — cannot build recap")
            return 0
        valid = [p for p in input_paths if p.exists() and p.stat().st_size > 1024]
        if len(valid) < 2:
            return 0
        # Build a concat-demuxer file list.
        list_file = out_path.with_suffix(".txt")
        list_file.write_text(
            "\n".join(f"file '{str(p).replace(chr(39), chr(92) + chr(39))}'" for p in valid),
            encoding="utf-8",
        )
        cmd = [
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(list_file),
            "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=15,format=yuv420p",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-an", "-movflags", "+faststart",
            str(out_path),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=300)
            list_file.unlink(missing_ok=True)
            if proc.returncode != 0:
                log.warning("[weather] ffmpeg concat rc=%s stderr=%s",
                            proc.returncode, (proc.stderr or b"").decode("utf-8", "replace")[-300:])
                return 0
            # Probe duration via opencv as a cheap fallback (no ffprobe dep).
            try:
                import cv2
                cap = cv2.VideoCapture(str(out_path))
                try:
                    fc  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
                    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 15.0
                finally:
                    cap.release()
                return int(fc / fps) if fc > 0 and fps > 0 else 0
            except Exception:
                return 0
        except subprocess.TimeoutExpired:
            log.warning("[weather] ffmpeg concat timeout — killed")
            return 0
        except Exception as e:
            log.warning("[weather] ffmpeg concat error: %s", e)
            return 0

    def _maybe_push_recap(self, manifest: dict, mp4_path: Path):
        try:
            tg = self.telegram_getter() if callable(self.telegram_getter) else None
            if tg is None or not getattr(tg, "enabled", False):
                return
            push_cfg = (getattr(tg, "push_cfg", {}) or {})
            wcfg = push_cfg.get("weather") or {}
            if not wcfg.get("recap_push", True):
                return
            n = manifest.get("n_clips", 0)
            dur = int(manifest.get("duration_s", 0) or 0)
            mm, ss = divmod(dur, 60)
            cap = (f"<b>{manifest.get('period_label', '?')} · Wetter-Highlights</b>\n"
                   f"{n} Sichtungen · {mm}:{ss:02d} min")
            buttons = [[("🌐 Alle Sichtungen", self._dashboard_url("#weather"))]]
            tg.send(cap, video=str(mp4_path), buttons=buttons, silent=False)
            log.info("[weather] Recap-Push gesendet: %s", manifest.get("period_label"))
        except Exception as e:
            log.warning("[weather] recap push failed: %s", e)

    # ── Recap read helpers (used by API) ────────────────────────────────────


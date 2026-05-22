from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — kept identical across mixins so
# methods can move between them without import bookkeeping. See
# service.py for the canonical import list.
import asyncio
import logging
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from threading import Lock, Thread

from telegram import (
    Bot,
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
)
from telegram.error import Conflict, NetworkError, TimedOut
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from ..telegram_helpers import (
    DULL_BIRDS,
    LABEL_DE,
    LABEL_WEIGHT,
    OBJECT_LABELS,
    is_night,
    is_quiet_now,
    most_specific_label,
    truncate_caption,
)
from ._consts import (
    _MUTE_DEFAULT_S,
    _MUTE_EXTEND_S,
    _NOTIFY_COOLDOWN_DEFAULTS,
    _PHOTO_LIMIT_BYTES,
    _VIDEO_LIMIT_BYTES,
    ACTION_CAMS,
    ACTION_CLIP,
    ACTION_LIVE,
    ACTION_MENU,
    ACTION_MUTE,
    ACTION_STATUS,
    ANCHOR_KEY,
    BOT_COMMANDS,
    PERSISTENT_KB_KEY,
    PERSISTENT_KEYBOARD,
    _parse_hhmm,
    log,
)


class OutboundMixin:
    """Send pipeline: low-level send, alerts, scheduled-job bodies (daily/highlight/watchdog).

    Mixin for TelegramService. Methods access shared state via `self.*`
    (cfg, bot, store, runtimes, scheduler, etc.) which live on the
    concrete class.
    """

    def send(self, text: str, **kwargs):
        """Sync entry point — schedules send_alert on the dedicated loop.

        Returns the concurrent.futures.Future so callers can wait if they
        care; most fire-and-forget code ignores it."""
        if not self.enabled or not self._loop:
            log.debug("[tg] send skipped (enabled=%s, loop=%s)", self.enabled, bool(self._loop))
            return None
        try:
            return asyncio.run_coroutine_threadsafe(self.send_alert(text, **kwargs), self._loop)
        except Exception as e:
            log.error("[tg] send dispatch failed: %s", e)
            return None

    def _build_markup(self, buttons) -> InlineKeyboardMarkup | None:
        """Buttons spec: list[list[(label, data_or_url)]] → InlineKeyboardMarkup.

        URLs are detected by 'http://' / 'https://' prefix on the second
        tuple element; everything else becomes callback_data."""
        if not buttons:
            return None
        rows = []
        for row in buttons:
            built_row = []
            for entry in row:
                if not entry or len(entry) < 2:
                    continue
                label, payload = entry[0], entry[1]
                if isinstance(payload, str) and (
                    payload.startswith("http://") or payload.startswith("https://")
                ):
                    built_row.append(InlineKeyboardButton(label, url=payload))
                else:
                    # Telegram callback_data hard limit: 64 bytes.
                    cb = str(payload)[:64]
                    built_row.append(InlineKeyboardButton(label, callback_data=cb))
            if built_row:
                rows.append(built_row)
        return InlineKeyboardMarkup(rows) if rows else None

    @staticmethod
    def _prepare_input(src, default_name: str):
        """Accept bytes OR a filesystem path; return something send_photo
        / send_video / send_document can swallow."""
        if isinstance(src, (bytes, bytearray)):
            bio = BytesIO(bytes(src))
            bio.name = default_name
            return bio
        if isinstance(src, (str, Path)):
            return open(str(src), "rb")
        return src

    @staticmethod
    def _src_size_bytes(src) -> int:
        if isinstance(src, (bytes, bytearray)):
            return len(src)
        if isinstance(src, (str, Path)):
            try:
                return Path(str(src)).stat().st_size
            except Exception:
                return 0
        return 0

    async def send_alert(
        self,
        text: str = "",
        *,
        photo=None,
        video=None,
        buttons=None,
        parse_mode: str = "HTML",
        silent: bool = False,
        dark: bool = False,
        reply_to: int | None = None,
    ):
        """Unified send. `photo`/`video` accept bytes or a filesystem path.
        Auto-falls-back to sendDocument when limits are exceeded."""
        if not self.enabled or not self.bot:
            log.info(
                "[tg] send_alert skipped (enabled=%s, bot=%s)", self.enabled, self.bot is not None
            )
            return
        if dark:
            log.info("[tg] dark/night alert")
        # Inline buttons win — Telegram only allows one reply_markup per
        # message, so when an alert carries Gültig/Falsch/Stumm we send those
        # and the persistent reply keyboard stays visible from the previous
        # message. When no inline buttons are present, reattach the
        # persistent keyboard so it always appears under the input field.
        markup = self._build_markup(buttons)
        if markup is None:
            markup = PERSISTENT_KEYBOARD
        common = dict(chat_id=self.chat_id, reply_markup=markup, disable_notification=bool(silent))
        if parse_mode:
            common["parse_mode"] = parse_mode
        if reply_to:
            common["reply_to_message_id"] = reply_to
        caption = truncate_caption(text or "")
        try:
            if video is not None:
                size = self._src_size_bytes(video)
                src = self._prepare_input(video, "video.mp4")
                if size and size > _VIDEO_LIMIT_BYTES:
                    log.info("[tg] video > 50MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_video(video=src, caption=caption, **common)
            elif photo is not None:
                size = self._src_size_bytes(photo)
                src = self._prepare_input(photo, "photo.jpg")
                if size and size > _PHOTO_LIMIT_BYTES:
                    log.info("[tg] photo > 10MB, falling back to sendDocument")
                    msg = await self.bot.send_document(document=src, caption=caption, **common)
                else:
                    msg = await self.bot.send_photo(photo=src, caption=caption, **common)
            else:
                msg = await self.bot.send_message(text=text or "", **common)
            # Stash timestamp of the most recent successful push so the
            # /api/system/telegram health endpoint can surface "letzte
            # Push vor X Min" without scraping the polling state.
            self._last_push_ts = time.time()
            log.info("[tg] send_alert ok (chat=%s silent=%s)", self.chat_id, silent)
            return msg
        except Exception as e:
            log.error("[tg] send_alert failed: %s", e)
            return None

    # Legacy sync wrapper (kept for the achievement push and the test endpoint).
    # Footer buttons used to include "24 h Zeitraffer" and "Last detections"
    # but those are reachable via /menu and only added clutter to event
    # bubbles. Callback strings now match the cam:<id>:* dispatcher so the
    # buttons actually route — the old "snapshot:<id>" / "clip:<id>" prefixes
    # were never registered and silently no-op'd on click.
    def send_alert_sync(
        self,
        caption: str,
        jpeg_bytes: bytes | None = None,
        snapshot_url: str | None = None,
        dashboard_url: str | None = None,
        camera_id: str | None = None,
    ):
        if not self.enabled:
            return
        buttons = []
        if camera_id:
            buttons.append(
                [
                    ("📷 Livebild", f"cam:{camera_id}:livebild"[:64]),
                    ("🎬 5 s Clip", f"cam:{camera_id}:clip:5"[:64]),
                ]
            )
        if dashboard_url:
            buttons.append([("🖥 Dashboard", dashboard_url)])
        self.send(caption, photo=jpeg_bytes, buttons=buttons, parse_mode=None)

    # ── Push pipeline ─────────────────────────────────────────────────────
    def _is_suppressed(self, cam_id: str, label: str) -> bool:
        key = f"{cam_id}|{label}"
        suppress = self.settings_store.runtime_get("suppress") if self.settings_store else None
        if not isinstance(suppress, dict):
            return False
        until = suppress.get(key, 0) or 0
        return time.time() < float(until)

    def _is_rate_limited(self, cam_id: str) -> bool:
        rl = float(self.push_cfg.get("rate_limit_seconds", 30) or 0)
        if rl <= 0:
            return False
        with self._rate_lock:
            last = self._rate_cache.get(cam_id, 0.0)
            return (time.time() - last) < rl

    def _record_rate_limit(self, cam_id: str):
        with self._rate_lock:
            self._rate_cache[cam_id] = time.time()
            # LRU-bound the cache so a long list of camera ids can't grow forever.
            while len(self._rate_cache) > self._RATE_CACHE_MAX:
                self._rate_cache.pop(next(iter(self._rate_cache)))

    def _is_night_for_camera(self, cam_id: str | None) -> bool:
        return is_night(self.push_cfg.get("night_alert") or {})

    def _is_quiet_now(self) -> bool:
        return is_quiet_now(self.push_cfg.get("quiet_hours") or {})

    def _best_frame_jpeg(self, meta: dict, camera_id: str) -> bytes | None:
        """Resolve the "best frame" for an event from the tracking
        sidecar and return JPEG bytes with the bbox burnt on. The
        recording-side tracks.json (Phase 1 worker) carries the highest-
        scoring detection across the whole clip; pushing that frame
        gives the receiver the strongest single image instead of
        whichever frame happened to trigger.

        Returns None on any failure (worker not ready, ffmpeg missing,
        tracks.json absent or corrupt, video missing). Caller is
        expected to fall back to the trigger snapshot in that case.

        Side effect: caches the rendered JPEG as <event_id>.best.jpg
        next to the mp4. Re-sends (resilience retry, /resend command)
        skip the ffmpeg + draw_detections work."""
        try:
            event_id = meta.get("event_id")
            if not event_id or not self.store:
                return None
            ev = self.store.get_event(camera_id, event_id)
            if not ev:
                return None
            video_rel = ev.get("video_relpath")
            if not video_rel:
                return None
            video_path = self._storage_root() / video_rel
            if not video_path.exists():
                return None
            from ..tracking_worker import tracks_path_for

            tracks_path = tracks_path_for(video_path)
            # Up to 2 s wait — most clips finish tracking in well under
            # that on this hardware. The poll interval is 100 ms so the
            # happy path returns within a single tick.
            deadline = time.time() + 2.0
            while not tracks_path.exists() and time.time() < deadline:
                time.sleep(0.1)
            if not tracks_path.exists():
                log.info("[tg] best-frame: tracks.json not ready for %s, fallback", event_id)
                return None
            import json as _json

            try:
                tracks = _json.loads(tracks_path.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning("[tg] best-frame: tracks.json parse fail %s: %s", tracks_path.name, e)
                return None
            best = tracks.get("best_frame")
            if not best or not isinstance(best, dict):
                log.info("[tg] best-frame: no best_frame in tracks.json for %s, fallback", event_id)
                return None
            # Cache check — skip ffmpeg + draw_detections when the
            # rendered JPEG is newer than the tracks.json that drove it.
            cache_path = video_path.with_name(video_path.stem + ".best.jpg")
            if cache_path.exists():
                try:
                    if cache_path.stat().st_mtime >= tracks_path.stat().st_mtime:
                        return cache_path.read_bytes()
                except Exception:
                    pass  # corrupt cache → re-render below
            # Extract the frame with ffmpeg. -ss before -i seeks via
            # keyframes (fast, may snap to nearest keyframe ≤2 s away);
            # acceptable here because best_frame is normally well inside
            # a continuous run with a keyframe nearby. -frames:v 1 +
            # mjpeg gives a single-image stream piped to stdout.
            import shutil as _shutil

            ffmpeg_bin = _shutil.which("ffmpeg")
            if not ffmpeg_bin:
                log.info("[tg] best-frame: ffmpeg missing, fallback")
                return None
            t_seek = float(best.get("t") or 0.0)
            import subprocess as _sp

            try:
                proc = _sp.run(
                    [
                        ffmpeg_bin,
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-ss",
                        f"{t_seek:.3f}",
                        "-i",
                        str(video_path),
                        "-frames:v",
                        "1",
                        "-q:v",
                        "2",
                        "-f",
                        "mjpeg",
                        "-",
                    ],
                    capture_output=True,
                    timeout=1.0,
                )
            except _sp.TimeoutExpired:
                log.warning("[tg] best-frame: ffmpeg timeout for %s, fallback", event_id)
                return None
            if proc.returncode != 0 or not proc.stdout:
                log.warning(
                    "[tg] best-frame: ffmpeg rc=%s len=%d for %s, fallback",
                    proc.returncode,
                    len(proc.stdout or b""),
                    event_id,
                )
                return None
            jpeg_bytes = proc.stdout
            # Decode JPEG → numpy frame, build synthetic Detection list
            # from the tracks samples that fall on best_frame.f, draw
            # boxes, re-encode. The on-disk MP4 stays untouched — this
            # JPEG is Telegram-only, since receivers can't render the
            # JSON overlay client-side the way the lightbox does.
            try:
                import cv2 as _cv2
                import numpy as _np

                arr = _np.frombuffer(jpeg_bytes, dtype=_np.uint8)
                frame = _cv2.imdecode(arr, _cv2.IMREAD_COLOR)
                if frame is None:
                    log.warning("[tg] best-frame: imdecode failed for %s", event_id)
                    return None
                from ..detectors import Detection, draw_detections

                best_f = int(best.get("f") or 0)
                synth_dets = []
                for tr in tracks.get("tracks", []) or []:
                    label = tr.get("label", "?")
                    for s in tr.get("samples", []) or []:
                        if s.get("f") != best_f:
                            continue
                        bb = s.get("bbox") or {}
                        try:
                            box = (int(bb["x1"]), int(bb["y1"]), int(bb["x2"]), int(bb["y2"]))
                        except Exception:
                            continue
                        score = s.get("score")
                        if score is None:
                            score = tr.get("best_score") or 0.0
                        synth_dets.append(
                            Detection(
                                label=label,
                                score=float(score),
                                bbox=box,
                            )
                        )
                        break  # one sample per track at this frame
                if synth_dets:
                    frame = draw_detections(frame, synth_dets)
                ok, buf = _cv2.imencode(".jpg", frame, [int(_cv2.IMWRITE_JPEG_QUALITY), 85])
                if not ok:
                    return None
                out_bytes = buf.tobytes()
                try:
                    cache_path.write_bytes(out_bytes)
                except Exception:
                    pass  # non-fatal — return the rendered bytes anyway
                log.info(
                    "[tg] best-frame: event=%s f=%d t=%.2f score=%.2f " "boxes=%d size=%dKB",
                    event_id,
                    best_f,
                    t_seek,
                    float(best.get("score") or 0.0),
                    len(synth_dets),
                    len(out_bytes) // 1024,
                )
                return out_bytes
            except Exception as e:
                log.warning("[tg] best-frame: render failed for %s: %s", event_id, e)
                return None
        except Exception as e:
            log.debug("[tg] best-frame: %s", e)
            return None

    def send_event_alert(self, meta: dict, camera_id: str, snapshot_path: str | Path | None = None):
        """Push entry point used by the camera runtime after an event is finalized.

        Decides — based on push.labels[primary], suppress, rate-limit and
        quiet/night state — whether and how to alert. Caller is expected
        to have already written the event to disk."""
        if not self.enabled:
            return
        pcfg = self.push_cfg or {}
        if not pcfg.get("enabled", True):
            log.debug("[tg] push: disabled")
            return
        # Observability marker — lands BEFORE every gate so a missing
        # push can be diagnosed by checking whether this line fires:
        #   • absent → live pipeline never produced an event for this
        #     cam (capture/motion/confirm upstream); not a notify gate
        #   • present + a "[tg] skip:" line for the same cam → that
        #     gate is the cause
        #   • present + no skip and no "[tg] event alert:" → bot init
        #     or transport issue; check Polling/HTTP errors above
        _labels_preview = meta.get("labels") or []
        log.info(
            "[tg] notify-attempt cam=%s label=%s sev=%s",
            camera_id,
            most_specific_label(_labels_preview) if _labels_preview else "—",
            (meta.get("severity") or "—"),
        )
        # Global + per-camera mute. Both gates honour the same "_until"
        # epoch contract: 0 / past = no mute, future = active. Daily
        # reports / highlights / watchdog go through their own jobs and
        # stay silent-by-design — they bypass this gate entirely.
        if self.settings_store:
            try:
                global_mute = float(self.settings_store.runtime_get("global_mute_until") or 0)
            except Exception:
                global_mute = 0
            if global_mute and time.time() < global_mute:
                log.info("[tg] skip: global mute active until epoch=%d", int(global_mute))
                return
            try:
                cam_mute = float(
                    self.settings_store.runtime_get_subkey("cam_mute_until", camera_id, 0) or 0
                )
            except Exception:
                cam_mute = 0
            if cam_mute and time.time() < cam_mute:
                log.info("[tg] skip: cam %s muted until epoch=%d", camera_id, int(cam_mute))
                return
        labels = meta.get("labels") or []
        primary = most_specific_label(labels)
        label_cfg = (pcfg.get("labels") or {}).get(primary, {})
        if not label_cfg.get("push", False):
            log.warning("[tg] skip: %s push disabled (cam=%s)", primary, camera_id)
            return
        # Top score for the primary label specifically — fall back to the
        # event's overall top detection if the primary isn't a CV label.
        detections = meta.get("detections") or []
        top_score = max(
            (float(d.get("score", 0.0)) for d in detections if d.get("label") == primary),
            default=0.0,
        )
        if top_score == 0.0 and detections:
            top_score = max((float(d.get("score", 0.0)) for d in detections), default=0.0)
        threshold = float(label_cfg.get("threshold", 0.0) or 0.0)
        if top_score < threshold:
            log.warning(
                "[tg] skip: %s score=%.2f < threshold=%.2f (cam=%s)",
                primary,
                top_score,
                threshold,
                camera_id,
            )
            return
        if self._is_suppressed(camera_id, primary):
            log.warning("[tg] skip: suppressed %s/%s", camera_id, primary)
            return
        if self._is_rate_limited(camera_id):
            log.warning("[tg] skip: rate-limited %s", camera_id)
            return

        cam_cfg = self._camera_cfg(camera_id) or {}
        # Per-class cooldown — minimum elapsed seconds between two
        # successive pushes for the SAME class on the SAME camera. The
        # primary label (already resolved above) is the gate; multi-
        # class events update the primary's cooldown and only the
        # primary's cooldown is consulted next time. Recording /
        # archiving are unaffected — this is purely a notification gate.
        cd_cfg = cam_cfg.get("notification_cooldown") or {}
        cd_default = _NOTIFY_COOLDOWN_DEFAULTS.get(primary, 0)
        cd_seconds = int(cd_cfg.get(primary, cd_default))
        if cd_seconds > 0:
            now_mono = time.monotonic()
            key = (camera_id, primary)
            last = self._last_notify.get(key, 0.0)
            elapsed = now_mono - last
            if last and elapsed < cd_seconds:
                log.info(
                    "[tg] skip: cooldown active for %s on %s (%ds remaining)",
                    primary,
                    camera_id,
                    int(cd_seconds - elapsed),
                )
                return
            self._last_notify[key] = now_mono
        # Per-camera notification schedule gate. Outside the configured
        # schedule_notify window the push is suppressed. Daily reports /
        # highlights / watchdog are system-level and are not gated by
        # this — they go through their own jobs. Falls back to the
        # legacy schedule.actions.telegram check for cameras that
        # haven't been migrated yet (the boot-time
        # _migrate_alerting_schedules in settings_store catches them on
        # next start).
        from ..event_logic import is_schedule_window_active, schedule_action_active as _sched_act

        sch_notify = cam_cfg.get("schedule_notify")
        if isinstance(sch_notify, dict) and sch_notify:
            if not is_schedule_window_active(sch_notify):
                log.warning("[tg] skip: schedule_notify blocks telegram (cam=%s)", camera_id)
                return
        else:
            if not _sched_act(cam_cfg.get("schedule") or {}, "telegram"):
                log.warning("[tg] skip: legacy schedule blocks telegram (cam=%s)", camera_id)
                return
        cam_name = cam_cfg.get("name") or camera_id
        is_armed = bool(cam_cfg.get("armed", True))
        is_night_now = self._is_night_for_camera(camera_id)
        is_quiet = self._is_quiet_now()
        night_cfg = pcfg.get("night_alert") or {}
        night_wakeup = (
            bool(night_cfg.get("enabled", True))
            and is_night_now
            and (not night_cfg.get("armed_only", True) or is_armed)
        )
        # Quiet hours → silent push, unless the alert qualifies as a
        # "wakeup at night" — those must always ring through.
        silent = is_quiet and not night_wakeup
        # Severity-driven silent override — the per-class severity
        # matrix is the new source of truth. severity="info" → always
        # silent regardless of quiet hours (user explicitly asked for a
        # quiet ping). severity="alarm" keeps the existing quiet-hours
        # behaviour (a loud alarm in quiet hours still mutes unless
        # night_wakeup escalates it).
        severity = (meta.get("severity") or "").lower()
        if severity == "info":
            silent = True
        elif severity == "alarm":
            silent = is_quiet and not night_wakeup

        eid = meta.get("event_id") or datetime.now().strftime("%Y%m%d-%H%M%S")
        score_pct = int(round(top_score * 100))
        # F06 first-since: when this event is the first of its class
        # after a long gap, lead with a celebratory headline. The marker
        # may name a different label than `primary` (e.g. event has
        # "person" + "squirrel" but only squirrel crossed its 12 h
        # threshold) — we use the marker's label for the headline so
        # the user sees the actually-anomalous class. is_new_record
        # adds a sparkle so users notice the rarity.
        first_since = meta.get("first_since") if isinstance(meta.get("first_since"), dict) else None
        if first_since:
            fs_label = first_since.get("label") or primary
            fs_label_de = LABEL_DE.get(fs_label, fs_label)
            gap_h = float(first_since.get("gap_hours") or 0.0)
            gap_str = f"{int(round(gap_h))} h" if gap_h >= 1 else f"{int(round(gap_h * 60))} min"
            record_tag = " ✨ (neuer Rekord)" if first_since.get("is_new_record") else ""
            caption = (
                f"<b>Erstes {fs_label_de} seit {gap_str}{record_tag}</b>\n"
                f"{cam_name} · {score_pct}%"
            )
        else:
            caption = f"<b>{LABEL_DE.get(primary, primary)}</b> · {score_pct}% · {cam_name}"

        buttons = [
            [("✅ Gültig", f"ev:{eid}:ok"), ("❌ Falsch", f"ev:{eid}:no")],
            [("🔇 1 h still", f"ev:{eid}:m1h")],
        ]
        if night_wakeup and is_armed:
            buttons[1].append(("🚨 Sirene", f"ev:{eid}:siren"))
        # Live-action row: snapshot now / 5 s clip now. Re-uses the same
        # cam:<id>:livebild and cam:<id>:clip:5 callbacks the /menu picker
        # already routes — single source of truth, no parallel dispatcher.
        buttons.append(
            [
                ("📷 Livebild", f"cam:{camera_id}:livebild"[:64]),
                ("🎬 5 s Clip", f"cam:{camera_id}:clip:5"[:64]),
            ]
        )
        # Deep-link to the lightbox in the web UI — only when public_base_url
        # is configured AND the event has a stored event_id. Lets the user
        # jump straight to the persisted event without hunting through the
        # mediathek. URL buttons are detected by the http(s):// prefix in
        # _build_markup; no callback_data needed.
        deep_link = self._event_deep_link_url(eid)
        if deep_link:
            buttons.append([("🌐 In App öffnen", deep_link)])

        if self.settings_store:
            self.settings_store.runtime_alert_index_set(
                eid,
                {
                    "cam": camera_id,
                    "label": primary,
                    "ts": time.time(),
                },
            )

        # Push payload: prefer the highest-scoring frame from the
        # tracking sidecar (Phase 1 worker → tracks.json) with the
        # bbox burnt on. Receivers can't render the Canvas overlay
        # the lightbox uses, so the burned JPEG is Telegram-specific
        # — the on-disk mp4 stays untouched. Fallback chain when the
        # worker hasn't finished yet (or ffmpeg is missing): trigger
        # snapshot bytes from meta, then snapshot_path on disk.
        photo = self._best_frame_jpeg(meta, camera_id)
        if photo is None:
            photo = meta.get("thumb_bytes")
        if photo is None and snapshot_path:
            photo = str(snapshot_path)
        self.send(caption, photo=photo, buttons=buttons, silent=silent, dark=is_night_now)
        self._record_rate_limit(camera_id)
        log.info(
            "[tg] event alert: cam=%s label=%s score=%.2f severity=%s silent=%s dark=%s",
            camera_id,
            primary,
            top_score,
            severity or "—",
            silent,
            is_night_now,
        )

    def send_quest_completed(self, quest: dict):
        """Push a one-shot Glückwunsch when an F09 quest hits its target.

        Caller (quest evaluator) is responsible for the notified_at
        gate — this method only formats and sends. Silent push so it
        joins the daily-summary tier of "informational" pings rather
        than waking the user at 3 AM the moment a wildlife threshold
        flips.
        """
        if not self.enabled:
            return
        icon = quest.get("icon") or "🎉"
        title = quest.get("title") or quest.get("id") or "Quest"
        desc = quest.get("description") or ""
        text = f"<b>🎉 Quest abgeschlossen: {icon} {title}</b>\n{desc}"
        try:
            self.send(text, silent=True)
            log.info("[tg] quest completion sent: %s", quest.get("id"))
        except Exception as e:
            log.warning("[tg] quest push failed for %s: %s", quest.get("id"), e)

    def send_timelapse_alert(
        self, video_path: str | Path, cam_name: str, profile_de: str, duration_s: int, rel_path: str
    ):
        """Fired by camera_runtime after a successful timelapse encode."""
        if not self.enabled:
            return
        if not (self.push_cfg.get("timelapse") or {}).get("enabled", True):
            return
        caption = f"<b>Zeitraffer fertig</b>\n" f"{cam_name} · {profile_de} · {duration_s}s"
        buttons = [[("💾 Speichern", f"tl:save:{rel_path}"[:64])]]
        self.send(caption, video=str(video_path), buttons=buttons, silent=True)

    # ── Scheduled jobs ────────────────────────────────────────────────────
    def _job_daily_report(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("daily_report") or {}).get(
                "enabled", True
            ):
                return
            cfg = self._cfg()
            cameras = cfg.get("cameras", []) or []
            today_iso = datetime.now().strftime("%Y-%m-%d")
            date_de = datetime.now().strftime("%d.%m.%Y")
            per_cam: list[tuple[str, dict]] = []
            object_set = set(OBJECT_LABELS)
            for cam in cameras:
                cam_id = cam.get("id")
                if not cam_id or not self.store:
                    continue
                events = self.store.list_events(cam_id, start=today_iso, limit=5000)
                counts: dict[str, int] = {}
                for ev in events:
                    labels = ev.get("labels") or []
                    primary = next((l for l in labels if l in object_set), None)
                    if primary is None and "motion" in labels:
                        primary = "motion"
                    if primary:
                        counts[primary] = counts.get(primary, 0) + 1
                if counts:
                    per_cam.append((cam.get("name") or cam_id, counts))
            per_cam.sort(key=lambda kv: -sum(kv[1].values()))
            lines = [f"<b>Tagesreport · {date_de}</b>", ""]
            if per_cam:
                for name, counts in per_cam:
                    chips = " · ".join(
                        f"<code>{n}</code> {LABEL_DE.get(l, l)}"
                        for l, n in sorted(counts.items(), key=lambda x: -x[1])
                        if n > 0
                    )
                    lines.append(f"{name}: {chips}")
            else:
                lines.append("Keine Erkennungen heute.")
            try:
                delta_gb = self._storage_today_delta_gb()
                if delta_gb is not None:
                    lines.append("")
                    lines.append(f"Speicher heute: + {delta_gb:.1f} GB")
            except Exception:
                pass
            buttons = [
                [("📊 Detail-Statistik", "menu:stats:today")],
                [("🎞 Tageszeitraffer", "menu:zeitraffer:today")],
            ]
            self.send("\n".join(lines), buttons=buttons, silent=True)
            log.info("[tg] daily report sent")
        except Exception as e:
            log.error("[tg] daily report job failed: %s", e)

    def _job_highlight(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("highlight") or {}).get(
                "enabled", True
            ):
                return
            cfg = self._cfg()
            cameras = cfg.get("cameras", []) or []
            cands = []
            cutoff_ts = time.time() - 24 * 3600
            object_set = set(OBJECT_LABELS)
            for cam in cameras:
                cam_id = cam.get("id")
                if not cam_id or not self.store:
                    continue
                events = self.store.list_events(cam_id, limit=400)
                for ev in events:
                    try:
                        ev_dt = datetime.fromisoformat(ev.get("time", ""))
                    except Exception:
                        continue
                    if ev_dt.timestamp() < cutoff_ts:
                        continue
                    labels = ev.get("labels") or []
                    primary = next((l for l in labels if l in object_set), None)
                    if not primary:
                        continue
                    if primary == "bird":
                        species = (ev.get("bird_species") or "").lower()
                        if any(d in species for d in DULL_BIRDS):
                            continue
                    detections = ev.get("detections") or []
                    top = max(
                        (
                            float(d.get("score", 0.0))
                            for d in detections
                            if d.get("label") == primary
                        ),
                        default=0.0,
                    )
                    if top < 0.70:
                        continue
                    daylight = 0.5 if ev.get("after_hours") else 1.0
                    score = top * LABEL_WEIGHT.get(primary, 1.0) * daylight
                    cands.append(
                        {
                            "score": score,
                            "eid": ev.get("event_id"),
                            "cam_id": cam_id,
                            "cam_name": cam.get("name") or cam_id,
                            "label": primary,
                            "time_hm": ev_dt.strftime("%H:%M"),
                            "snap_rel": ev.get("snapshot_relpath"),
                        }
                    )
            if not cands:
                log.info("[tg] highlight: no candidates")
                return
            pick = max(cands, key=lambda c: c["score"])
            caption = (
                f"<b>✨ Highlight des Tages</b>\n"
                f"{LABEL_DE.get(pick['label'], pick['label'])} · {pick['cam_name']} · {pick['time_hm']}"
            )
            photo = None
            if pick["snap_rel"]:
                full = self._storage_root() / pick["snap_rel"]
                if full.exists():
                    photo = str(full)
            buttons = [
                [("🖼 Hochauflösend", f"hi:{pick['eid']}"[:64])],
                [("📤 Teilen", f"share:{pick['eid']}"[:64])],
            ]
            if self.settings_store and pick["eid"]:
                self.settings_store.runtime_alert_index_set(
                    pick["eid"],
                    {
                        "cam": pick["cam_id"],
                        "label": pick["label"],
                        "ts": time.time(),
                    },
                )
            self.send(caption, photo=photo, buttons=buttons, silent=True)
            log.info(
                "[tg] highlight sent: %s/%s score=%.2f", pick["cam_id"], pick["eid"], pick["score"]
            )
        except Exception as e:
            log.error("[tg] highlight job failed: %s", e)

    def _job_watchdog(self):
        try:
            pcfg = self.push_cfg or {}
            if not pcfg.get("enabled", True) or not (pcfg.get("system") or {}).get("enabled", True):
                return
            ss = self.settings_store
            if not ss:
                return
            now = time.time()
            state = ss.runtime_get("system_state") or {}
            for cam_id, rt in (self.runtimes or {}).items():
                try:
                    status = rt.status() if hasattr(rt, "status") else {}
                except Exception:
                    status = {}
                cam_name = status.get("name") or cam_id
                # Treat 'error' or stale frames as offline; 'active' / 'starting' as online.
                online = status.get("status") in ("active", "starting")
                cam_state = state.setdefault(
                    cam_id, {"online": True, "since": now, "alert_sent": False}
                )
                # Transition: online → offline
                if not online and cam_state.get("online", True):
                    cam_state["online"] = False
                    cam_state["since"] = now
                    cam_state["alert_sent"] = False
                # Still offline → push once after 5 min
                elif not online and not cam_state.get("alert_sent"):
                    offline_for = now - float(cam_state.get("since", now))
                    if offline_for >= 300:
                        self.send(
                            f"<b>{cam_name} offline</b> seit {int(offline_for/60)} Min · keine RTSP-Antwort",
                            buttons=[
                                [("🔄 Neu verbinden", f"cam:{cam_id}:reconnect"[:64])],
                                [("📋 Logs", "menu:logs")],
                            ],
                        )
                        cam_state["alert_sent"] = True
                # Recovery: offline → online
                elif online and not cam_state.get("online", True):
                    offline_for = now - float(cam_state.get("since", now))
                    if cam_state.get("alert_sent"):
                        self.send(
                            f"{cam_name} wieder online (Ausfall {int(offline_for/60)} Min)",
                            silent=True,
                        )
                    cam_state["online"] = True
                    cam_state["since"] = now
                    cam_state["alert_sent"] = False
            ss.runtime_set("system_state", state)
            # Storage check — once per 24 h while < 2 GB free.
            try:
                import shutil as _sh

                root = str(self._storage_root())
                free_gb = _sh.disk_usage(root).free / (1024**3)
                last_warn = float(ss.runtime_get("last_storage_warn_ts") or 0)
                if free_gb < 2.0 and (now - last_warn) > 86400:
                    self.send(f"<b>⚠ Speicher knapp</b>: nur noch {free_gb:.1f} GB frei")
                    ss.runtime_set("last_storage_warn_ts", now)
            except Exception as e:
                log.debug("[tg] storage check failed: %s", e)
        except Exception as e:
            log.error("[tg] watchdog failed: %s", e)

    def _storage_today_delta_gb(self) -> float | None:
        """Sum bytes of media files modified today (best-effort, never raises)."""
        root = self._storage_root()
        if not root.exists():
            return None
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        total = 0
        for sub in ("motion_detection", "timelapse"):
            base = root / sub
            if not base.exists():
                continue
            for p in base.rglob("*"):
                try:
                    st = p.stat()
                    if st.st_mtime >= today_start and p.is_file():
                        total += st.st_size
                except Exception:
                    continue
        return total / (1024**3)

    # ── Menu helpers — view builders ──────────────────────────────────────

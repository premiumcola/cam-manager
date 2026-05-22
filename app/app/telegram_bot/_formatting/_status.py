from __future__ import annotations

# ruff: noqa: F401
# Comprehensive per-mixin import block — kept identical across mixins so
# methods can move between them without import bookkeeping. See
# service.py for the canonical import list.
import asyncio
import contextlib
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

from ...telegram_helpers import (
    DULL_BIRDS,
    LABEL_DE,
    LABEL_WEIGHT,
    OBJECT_LABELS,
    is_night,
    is_quiet_now,
    most_specific_label,
    truncate_caption,
)
from .._consts import (
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


class _StatusMixin:
    """Per-camera live blocks, system overview, disk-usage formatting —
    "what's the system doing right now"."""

    def _cam_status_icon(self, st: dict) -> str:
        s = st.get("status", "")
        if s == "active":
            return "🟢"
        if s == "starting":
            return "🟡"
        return "🔴"

    def _status_view(self) -> tuple[str, InlineKeyboardMarkup]:
        lines = ["🛠 <b>Kamera-Status</b>", ""]
        rows = []
        cam_cfgs = {c["id"]: c for c in self._cfg().get("cameras", [])}
        today_iso = datetime.now().strftime("%Y-%m-%d")
        for cam_id, rt in self.runtimes.items():
            try:
                st = rt.status()
            except Exception:
                st = {}
            icon = self._cam_status_icon(st)
            name = st.get("name", cam_id)
            armed = bool((cam_cfgs.get(cam_id) or {}).get("armed", st.get("armed", True)))
            arm_label = "scharf" if armed else "stumm"
            extra = ""
            if st.get("status") not in ("active", "starting"):
                fa = st.get("frame_age_s")
                if isinstance(fa, (int, float)) and fa > 0:
                    extra = f" · offline {int(fa // 60)} min"
                else:
                    extra = " · offline"
            n_today = "?"
            if self.store:
                try:
                    n_today = len(self.store.list_events(cam_id, start=today_iso, limit=5000))
                except Exception:
                    n_today = "?"
            lines.append(f"{icon} <b>{name}</b> · {arm_label}{extra} · {n_today} Events heute")
            rows.append(
                [
                    InlineKeyboardButton(
                        ("🔇 Stumm" if armed else "🛡 Scharf") + f" {name[:10]}",
                        callback_data=f"cam:{cam_id}:arm",
                    ),
                    InlineKeyboardButton("🔄 Reconnect", callback_data=f"cam:{cam_id}:reconnect"),
                ]
            )
        rows.append([self._back_btn()])
        return "\n".join(lines), InlineKeyboardMarkup(rows)

    def _active_cams(self) -> list[dict]:
        """Single source of truth for "which cameras can the user act on".

        Returns a list of info dicts (one per cam):

            cam_id        camera id
            name          display name
            source        "runtime" — backed by a live CameraRuntime
                          "settings" — fallback, no runtime in self.runtimes
            runtime       the rt object (None for fallback)
            cfg           the cam dict from settings (None when source="runtime")
            status_kind   "active" | "starting" | "error" | "fallback"
            status        the rt.status() dict (empty for fallback)

        Fallback rule: when an enabled camera has no live runtime (recent
        boot crash, restart in progress, …), it still appears in this list
        so the Telegram bot can show it with a yellow icon instead of
        replying "Keine Kameras konfiguriert" — which historically led
        users to think the camera was lost when really the runtime just
        failed to construct."""
        out: list[dict] = []
        seen: set[str] = set()
        for cam_id, rt in (self.runtimes or {}).items():
            try:
                st = rt.status() if hasattr(rt, "status") else {}
            except Exception:
                st = {}
            kind = st.get("status") or "starting"
            out.append(
                {
                    "cam_id": cam_id,
                    "name": st.get("name") or cam_id,
                    "source": "runtime",
                    "runtime": rt,
                    "cfg": None,
                    "status_kind": kind,
                    "status": st,
                }
            )
            seen.add(cam_id)
        for cam_cfg in self._cfg().get("cameras", []) or []:
            cid = cam_cfg.get("id")
            if not cid or cid in seen:
                continue
            if not cam_cfg.get("enabled", True):
                continue
            out.append(
                {
                    "cam_id": cid,
                    "name": cam_cfg.get("name") or cid,
                    "source": "settings",
                    "runtime": None,
                    "cfg": cam_cfg,
                    "status_kind": "fallback",
                    "status": {},
                }
            )
        return out

    def _cam_status_icon_for(self, info: dict) -> str:
        """🟢 active · 🟡 starting/fallback · 🔴 error. Used by the picker
        and the per-cam status block."""
        kind = info.get("status_kind") or "starting"
        if kind == "active":
            return "🟢"
        if kind == "error":
            return "🔴"
        return "🟡"  # starting, fallback, or anything else unknown

    # Per-cam disk usage cache. Walking three sub-trees per call is too
    # expensive to do on every /status tap, so we cache for 60 s. Cleared
    # automatically because the dict is bound to the TelegramService
    # instance — restart_telegram_service() builds a fresh instance and
    # the cache starts empty again.
    _DISK_CACHE_TTL_S = 60.0

    def _cam_disk_usage_bytes(self, cam_id: str) -> int:
        cache = getattr(self, "_disk_cache", None)
        if cache is None:
            cache = {}
            self._disk_cache = cache
        ent = cache.get(cam_id)
        now = time.time()
        if ent and (now - ent[0]) < self._DISK_CACHE_TTL_S:
            return int(ent[1])
        root = self._storage_root()
        total = 0
        for sub in ("motion_detection", "timelapse", "timelapse_frames"):
            p = root / sub / cam_id
            if not p.exists():
                continue
            try:
                for f in p.rglob("*"):
                    if f.is_file():
                        with contextlib.suppress(OSError):
                            total += f.stat().st_size
            except Exception:
                pass
        cache[cam_id] = (now, total)
        return total

    @staticmethod
    def _fmt_bytes(n: int) -> str:
        if n is None:
            return "—"
        n = int(n)
        if n >= 1024**3:
            return f"{n / 1024 ** 3:.1f} GB"
        if n >= 1024**2:
            return f"{n / 1024 ** 2:.0f} MB"
        if n >= 1024:
            return f"{n / 1024:.0f} KB"
        return f"{n} B"

    def _render_camera_block(self, info: dict) -> list[str]:
        """Render the per-cam multi-line block used by both the global
        /status bubble and the per-cam drilldown. Returns a list of
        already-formatted lines so the caller controls separators."""
        from html import escape as _esc

        today_iso = datetime.now().strftime("%Y-%m-%d")
        cam_id = info["cam_id"]
        name = _esc(info["name"])
        icon = self._cam_status_icon_for(info)
        st = info.get("status") or {}
        cam_cfg = info.get("cfg") or self._camera_cfg(cam_id) or {}
        armed = bool(cam_cfg.get("armed", st.get("armed", True)))
        arm_label = "scharf" if armed else "stumm"
        out = [f"{icon} <b>{name}</b>  · {arm_label}"]
        if info["source"] == "runtime" and st:
            kind = info.get("status_kind") or "starting"
            fps = st.get("preview_fps")
            age = st.get("frame_age_s")
            if kind == "active":
                rtsp_label = "stabil"
            elif kind == "starting":
                rtsp_label = "verbindet"
            else:
                rtsp_label = "getrennt"
            fps_str = f"{fps:.0f} fps" if isinstance(fps, (int, float)) and fps > 0 else "—"
            age_str = (
                f"letzter Frame vor {int(age)} s"
                if isinstance(age, (int, float)) and age >= 0
                else "kein Frame"
            )
            out.append(f"   RTSP: {rtsp_label} · {fps_str} · {age_str}")
        else:
            out.append("   Runtime nicht aktiv — wird gestartet …")
        # Per-cam disk usage (cached) + today event count
        n_today = "?"
        if self.store:
            try:
                n_today = len(self.store.list_events(cam_id, start=today_iso, limit=5000))
            except Exception:
                n_today = "?"
        try:
            disk = self._fmt_bytes(self._cam_disk_usage_bytes(cam_id))
        except Exception:
            disk = "—"
        out.append(f"   Heute: {n_today} Events · {disk} belegt")
        # Per-cam mute hint
        cam_mute = 0.0
        if self.settings_store:
            try:
                cam_mute = float(
                    self.settings_store.runtime_get_subkey("cam_mute_until", cam_id, 0) or 0
                )
            except Exception:
                cam_mute = 0.0
        if cam_mute and time.time() < cam_mute:
            end_local = datetime.fromtimestamp(cam_mute).strftime("%H:%M")
            out.append(f"   🔇 stumm bis {end_local}")
        return out

    def _render_system_status_text(self) -> str:
        """Build the /status bubble. Defensive — any single source
        missing falls back to a question mark instead of crashing the
        whole render. Layout (from spec):

            📊 System-Status
            ━━━━━━━━━━━
            <per-cam block>     <— from _render_camera_block
            <per-cam block>
            ────
            Telegram   …
            Coral      …
            Wetter     …
            ────
            Speicher: free + sum of cam-belegt
            🔇 Pushes pausiert bis HH:MM   (only when muted)
        """
        import shutil as _sh

        cfg = self._cfg()
        lines = ["📊 <b>System-Status</b>", "━━━━━━━━━━━━━━", ""]
        cams_info = self._active_cams()
        cam_disk_total = 0
        for info in cams_info:
            try:
                lines.extend(self._render_camera_block(info))
                lines.append("")
            except Exception as e:
                log.warning("[tg] cam block render failed for %s: %s", info.get("cam_id"), e)
                continue
            with contextlib.suppress(Exception):
                cam_disk_total += self._cam_disk_usage_bytes(info["cam_id"])
        if not cams_info:
            lines.append("(keine Kameras konfiguriert)")
            lines.append("")
        lines.append("────")
        # Telegram polling
        try:
            ps = self.get_polling_status() if hasattr(self, "get_polling_status") else {}
        except Exception:
            ps = {}
        ps_state = ps.get("state", "?")
        ps_icon = {"active": "🟢", "conflict": "🟡", "starting": "🟡", "off": "⚪"}.get(
            ps_state, "⚪"
        )
        ps_dur_min = (ps.get("since_seconds", 0) or 0) // 60
        lines.append(f"Telegram   {ps_icon} Polling {ps_dur_min} min")
        # Coral state + rolling-average inference latency from any active cam
        det_mode = (cfg.get("processing", {}).get("detection") or {}).get("mode", "none")
        coral_icon = "🟢" if det_mode == "coral" else "⚪"
        avg_inferences = []
        for info in cams_info:
            v = (info.get("status") or {}).get("inference_avg_ms")
            if isinstance(v, (int, float)) and v > 0:
                avg_inferences.append(v)
        infer_str = (
            f" · {sum(avg_inferences)/len(avg_inferences):.0f} ms ø" if avg_inferences else ""
        )
        lines.append(f"Coral      {coral_icon} {det_mode}{infer_str}")
        # Weather — last poll age + summary of active event triggers
        weather_line = "Wetter     ⚪ kein Poll bekannt"
        try:
            from ... import server as _srv

            wsvc = getattr(_srv, "weather_service", None)
        except Exception:
            wsvc = None
        try:
            if wsvc and hasattr(wsvc, "status"):
                wstat = wsvc.status() or {}
                last_iso = wstat.get("last_poll_at")
                age_min = None
                if last_iso:
                    try:
                        age_min = int(
                            (datetime.now() - datetime.fromisoformat(last_iso)).total_seconds() / 60
                        )
                    except Exception:
                        age_min = None
                cur = wstat.get("current_state") or {}
                # Compact event chip list — only the events the user has
                # turned on (dot icon + label).
                from ...weather_service import EVENT_LABEL_DE

                ev_chips = []
                for evt, lbl in EVENT_LABEL_DE.items():
                    active = bool(cur.get(evt))
                    ev_chips.append(f"{lbl} {'🟡' if active else '⚪'}")
                age_str = (
                    f"letzter Poll vor {age_min} min"
                    if age_min is not None
                    else "kein Poll bekannt"
                )
                weather_line = f"Wetter     🟢 {age_str} · {' · '.join(ev_chips)}"
        except Exception as e:
            log.debug("[tg] weather row render failed: %s", e)
        lines.append(weather_line)
        lines.append("────")
        # Storage: free disk + sum of per-cam belegt
        try:
            root = str(self._storage_root())
            free_gb = _sh.disk_usage(root).free / (1024**3)
            cam_total_str = self._fmt_bytes(cam_disk_total) if cam_disk_total else "—"
            lines.append(
                f"Speicher:  <b>{free_gb:.1f} GB</b> frei · {cam_total_str} von Cams belegt"
            )
        except Exception:
            pass
        # Global mute hint
        if self.settings_store:
            try:
                mute_until = float(self.settings_store.runtime_get("global_mute_until") or 0)
            except Exception:
                mute_until = 0
            if mute_until and time.time() < mute_until:
                end_local = datetime.fromtimestamp(mute_until).strftime("%H:%M")
                lines.append(f"🔇 Pushes pausiert bis {end_local}")
        return "\n".join(lines)

    def _system_view(self) -> tuple[str, InlineKeyboardMarkup]:
        """🛠 System — per-cam disk breakdown + global health checks."""
        import shutil as _sh
        from html import escape as _esc

        lines = ["🛠 <b>System</b>", "─────────────"]
        # Per-cam storage breakdown
        cams_info = self._active_cams()
        cam_disk_total = 0
        if cams_info:
            lines.append("Speicher pro Kamera:")
            for info in cams_info:
                cam_id = info["cam_id"]
                name = _esc(info["name"])
                root = self._storage_root()
                parts = []
                row_total = 0
                for sub_label, sub in [
                    ("Events", "motion_detection"),
                    ("TL", "timelapse"),
                    ("Frames", "timelapse_frames"),
                ]:
                    p = root / sub / cam_id
                    bs = 0
                    if p.exists():
                        try:
                            for f in p.rglob("*"):
                                if f.is_file():
                                    with contextlib.suppress(OSError):
                                        bs += f.stat().st_size
                        except Exception:
                            pass
                    row_total += bs
                    parts.append(f"{sub_label} {self._fmt_bytes(bs)}")
                cam_disk_total += row_total
                lines.append(
                    f"  {name:<12s} {self._fmt_bytes(row_total):>8s}  ({' · '.join(parts)})"
                )
            lines.append("")
        # Free disk
        try:
            usage = _sh.disk_usage(str(self._storage_root()))
            free_gb = usage.free / (1024**3)
            total_gb = usage.total / (1024**3)
            lines.append(f"Gesamt frei: <b>{free_gb:.1f} GB</b> von {total_gb:.0f} GB")
        except Exception:
            free_gb = None
            lines.append("Speicher: nicht ermittelbar")
        lines.append("")
        # Health rows
        lines.append("Health:")
        # Cam state
        n_runtime = sum(1 for c in cams_info if c["source"] == "runtime")
        n_fallback = sum(1 for c in cams_info if c["source"] == "settings")
        if n_fallback == 0 and n_runtime > 0:
            lines.append("  ✅ Alle Kameras online")
        elif n_fallback > 0:
            lines.append(f"  ⚠️ {n_fallback} im Fallback (Runtime nicht aktiv)")
        elif n_runtime == 0:
            lines.append("  ⚠️ Keine Kamera-Runtime aktiv")
        # Reconnects 24h
        for info in cams_info:
            n24 = (info.get("status") or {}).get("reconnect_count_24h")
            if isinstance(n24, int) and n24 > 3:
                lines.append(f"  ⚠️ {_esc(info['name'])}: {n24} Reconnects letzte 24 h")
        # Coral
        cfg = self._cfg()
        det_mode = (cfg.get("processing", {}).get("detection") or {}).get("mode", "none")
        if det_mode == "coral":
            avg_inferences = []
            for info in cams_info:
                v = (info.get("status") or {}).get("inference_avg_ms")
                if isinstance(v, (int, float)) and v > 0:
                    avg_inferences.append(v)
            if avg_inferences:
                lines.append(f"  ✅ Coral · {sum(avg_inferences) / len(avg_inferences):.0f} ms ø")
            else:
                lines.append("  ✅ Coral aktiv")
        else:
            lines.append(f"  ⚠️ Coral inaktiv (Modus: {det_mode})")
        # Disk
        if free_gb is not None:
            if free_gb < 10:
                lines.append(f"  🔴 Speicher: nur {free_gb:.1f} GB frei")
            elif free_gb < 25:
                lines.append(f"  ⚠️ Speicher: {free_gb:.1f} GB frei")
            else:
                lines.append(f"  ✅ Speicher: {free_gb:.0f} GB frei")
        # Telegram polling
        try:
            ps = self.get_polling_status() if hasattr(self, "get_polling_status") else {}
        except Exception:
            ps = {}
        ps_state = ps.get("state", "?")
        if ps_state == "active":
            lines.append("  ✅ Telegram-Polling aktiv")
        elif ps_state in ("starting", "conflict"):
            lines.append(f"  ⚠️ Telegram-Polling {ps_state}")
        else:
            lines.append(f"  🔴 Telegram-Polling {ps_state}")

        rows = [
            [
                InlineKeyboardButton("🔄 Aktualisieren", callback_data="menu:system"),
                InlineKeyboardButton("🏠 Hauptmenü", callback_data="menu:root"),
            ],
        ]
        return "\n".join(lines), InlineKeyboardMarkup(rows)

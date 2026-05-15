"""Weather sightings, sun-times, recaps, status, history.

Migrated from server.py during R01.5. Every route reads
`app_state.weather_service` fresh — `rebuild_services` may replace
the instance after a settings save.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime
from pathlib import Path

import cv2
from flask import Blueprint, Response, jsonify, request, send_from_directory

from .. import app_state

bp = Blueprint("weather", __name__)

log = logging.getLogger(__name__)

# Canonical on-disk phase directory names. Walked in this order so
# orphan-mp4 synthesis prefers the per-phase folders introduced by
# the boot-time `migrate_sun_timelapse_layout` over the legacy shared
# "sun_timelapse/" dir. `event_timelapse/` is where _event_tl.py
# writes thunder/front/storm captures.
_WEATHER_PHASE_DIRS: tuple[str, ...] = (
    "sunrise_timelapse",
    "sunset_timelapse",
    "sun_timelapse",
    "event_timelapse",
)


# Serializes thumb-regen across parallel requests for the same sighting.
# A single global lock is overkill but the operation is rare (only fires
# when a thumb file is genuinely missing) and a per-path lock map would
# add bookkeeping for no measurable win.
_weather_thumb_regen_lock = threading.Lock()


def _regenerate_weather_thumb(clip_path: Path, thumb_path: Path) -> bool:
    """Extract a frame from roughly the middle of `clip_path` and write
    it as JPEG to `thumb_path` via temp-file + atomic rename. Returns
    True on success. cv2 is the same backend the original thumb writer
    uses so no new dependency."""
    try:
        cap = cv2.VideoCapture(str(clip_path))
        if not cap.isOpened():
            return False
        try:
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if n > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, n // 2))
            ok, frame = cap.read()
            if (not ok or frame is None) and n > 0:
                # Some codecs misreport frame count — first frame always
                # decodes if the file is otherwise valid.
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
            if not ok or frame is None:
                return False
            ok2, buf = cv2.imencode(".jpg", frame,
                                    [int(cv2.IMWRITE_JPEG_QUALITY), 88])
            if not ok2:
                return False
        finally:
            cap.release()
        thumb_path.parent.mkdir(parents=True, exist_ok=True)
        # Same-directory tempfile keeps the rename filesystem-local so
        # parallel readers never see a half-written JPEG.
        tmp = thumb_path.with_name(
            f".{thumb_path.name}.tmp.{os.getpid()}.{threading.get_ident()}"
        )
        tmp.write_bytes(buf.tobytes())
        os.replace(str(tmp), str(thumb_path))
        return True
    except Exception as e:
        log.warning("[weather] thumb regen exception: %s", e)
        return False


def _cam_name_lookup(cam_id: str) -> str:
    """Resolve the display name for a camera id via settings_store.
    Falls back to cam_id when the camera isn't found (e.g. removed but
    media still on disk)."""
    try:
        store = app_state.store
        if store is None:
            return cam_id
        cams = (store.export_effective_config() or {}).get("cameras") or []
        for c in cams:
            if (c.get("id") or "") == cam_id:
                return c.get("name") or cam_id
    except Exception:
        pass
    return cam_id


def _phase_from_dir_and_stem(phase_dir: str, stem: str) -> tuple[str, str]:
    """Return (sun_phase, phase_suffix) inferred from the on-disk
    directory name and the filename stem. `phase_suffix` is "rise" or
    "set" (used in the canonical sighting id); `sun_phase` is the
    legacy "sunrise"/"sunset" string carried inside the manifest body.
    For event_timelapse/ both return empty strings — the caller treats
    those manifests separately."""
    if phase_dir == "sunrise_timelapse":
        return ("sunrise", "rise")
    if phase_dir == "sunset_timelapse":
        return ("sunset", "set")
    if phase_dir == "sun_timelapse":
        s = stem.lower()
        if "sunrise" in s or s.endswith("_rise"):
            return ("sunrise", "rise")
        if "sunset" in s or s.endswith("_set"):
            return ("sunset", "set")
        return ("sunrise", "rise")
    return ("", "")


def _synth_sun_manifest(cam_id: str, phase_dir: str, mp4_path: Path) -> dict:
    """Build a minimal sun-timelapse manifest from a found mp4 file.
    Used by rescan to register orphans — fields the live capture path
    fills (api_snapshot, sun_snapshot, fps) get sensible defaults."""
    stem = mp4_path.stem
    sun_phase, phase_suffix = _phase_from_dir_and_stem(phase_dir, stem)
    started = datetime.fromtimestamp(
        mp4_path.stat().st_mtime).isoformat(timespec="seconds")
    width = height = 0
    duration_s = 0
    try:
        cap = cv2.VideoCapture(str(mp4_path))
        if cap.isOpened():
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if fps > 0 and n > 0:
                duration_s = max(1, int(round(n / fps)))
            cap.release()
    except Exception:
        pass
    rel = f"weather/{cam_id}/{phase_dir}/{mp4_path.name}"
    thumb_rel = rel[:-len(".mp4")] + ".jpg"
    return {
        "id":           f"{cam_id}__sun_timelapse_{phase_suffix}__{stem}",
        "cam_id":       cam_id,
        "cam_name":     _cam_name_lookup(cam_id),
        "event_type":   "sun_timelapse",
        "sun_phase":    sun_phase,
        "is_test":      False,
        "started_at":   started,
        "score":        0.6, "severity": 0.6,
        "window_min":   0, "window_seconds": 0,
        "interval_s":   0, "fps": 0,
        "api_snapshot": {},
        "clip_path":    rel,
        "thumb_path":   thumb_rel,
        "duration_s":   duration_s,
        "width":        width, "height": height,
        "rescanned":    True,
    }


def _synth_event_manifest(cam_id: str, mp4_path: Path) -> dict:
    """Minimal manifest for an orphan event_timelapse mp4."""
    stem = mp4_path.stem
    started = datetime.fromtimestamp(
        mp4_path.stat().st_mtime).isoformat(timespec="seconds")
    rel = f"weather/{cam_id}/event_timelapse/{mp4_path.name}"
    thumb_rel = rel[:-len(".mp4")] + ".jpg"
    return {
        "id":           f"{cam_id}__event_timelapse__{stem}",
        "cam_id":       cam_id,
        "cam_name":     _cam_name_lookup(cam_id),
        "event_type":   "event_timelapse",
        "is_test":      False,
        "started_at":   started,
        "score":        0.5, "severity": 0.5,
        "clip_path":    rel,
        "thumb_path":   thumb_rel,
        "rescanned":    True,
    }


def _atomic_write_json(path: Path, data: dict) -> None:
    """Same-directory tempfile + os.replace so a concurrent reader
    never sees a half-written manifest. Mirrors the helper in
    _consts.py without importing across packages."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(
        f".{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                   encoding="utf-8")
    os.replace(str(tmp), str(path))


def _weather_root() -> Path | None:
    """Return `<storage_root>/weather` (the same dir the WeatherService
    writes into). Returns None when storage isn't configured yet."""
    sr = app_state.storage_root
    if sr is None:
        return None
    return Path(sr) / "weather"


@bp.post('/api/weather/rescan')
def api_weather_rescan():
    """Walk every weather cam dir + phase dir, synthesize manifest
    JSONs for orphan mp4s, regenerate any thumb that's missing while
    its clip is present, and mark manifests whose clip vanished. Safe
    to run repeatedly — orphans are detected by "mp4 with no matching
    .json"; manifests already on disk are left untouched (only their
    thumbs may be regenerated)."""
    root = _weather_root()
    if root is None or not root.exists():
        return jsonify({"ok": True, "registered": 0, "missing": 0,
                        "thumbs_regen": 0, "scanned": 0, "errors": 0,
                        "note": "no weather storage root"})
    registered = missing = thumbs_regen = scanned = errors = 0
    for cam_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if cam_dir.name.startswith(".") or cam_dir.name == "recaps":
            continue
        cam_id = cam_dir.name
        for phase in _WEATHER_PHASE_DIRS:
            phase_dir = cam_dir / phase
            if not phase_dir.exists() or not phase_dir.is_dir():
                continue
            mp4_stems: set[str] = set()
            json_stems: set[str] = set()
            for f in phase_dir.iterdir():
                if f.name.startswith("."):
                    continue
                if f.suffix == ".mp4":
                    mp4_stems.add(f.stem)
                elif f.suffix == ".json":
                    json_stems.add(f.stem)
                scanned += 1
            # Orphan mp4 → synthesize manifest.
            for stem in sorted(mp4_stems - json_stems):
                mp4_path = phase_dir / f"{stem}.mp4"
                try:
                    if phase == "event_timelapse":
                        m = _synth_event_manifest(cam_id, mp4_path)
                    else:
                        m = _synth_sun_manifest(cam_id, phase, mp4_path)
                    _atomic_write_json(phase_dir / f"{stem}.json", m)
                    registered += 1
                    log.info(
                        "[weather] rescan: registered orphan mp4 %s/%s/%s",
                        cam_id, phase, mp4_path.name)
                except Exception as e:
                    errors += 1
                    log.warning(
                        "[weather] rescan: synth manifest failed for %s/%s/%s: %s",
                        cam_id, phase, mp4_path.name, e)
            # Manifest whose clip vanished → tag missing (don't delete —
            # the user may want to inspect or recover from backup).
            for stem in sorted(json_stems - mp4_stems):
                j_path = phase_dir / f"{stem}.json"
                try:
                    data = json.loads(j_path.read_text(encoding="utf-8"))
                    if not data.get("missing_clip"):
                        data["missing_clip"] = True
                        _atomic_write_json(j_path, data)
                        missing += 1
                        log.info(
                            "[weather] rescan: marked missing-clip %s/%s/%s",
                            cam_id, phase, j_path.name)
                except Exception as e:
                    errors += 1
                    log.warning(
                        "[weather] rescan: missing-clip mark failed %s: %s",
                        j_path, e)
            # Thumb regen for every clip whose thumb is gone — covers
            # both newly registered orphans and pre-existing manifests
            # that lost their thumb (e.g. user-deleted jpgs).
            for stem in sorted(mp4_stems):
                jpg = phase_dir / f"{stem}.jpg"
                if jpg.exists():
                    continue
                mp4 = phase_dir / f"{stem}.mp4"
                if not mp4.exists():
                    continue
                with _weather_thumb_regen_lock:
                    if jpg.exists():
                        continue
                    if _regenerate_weather_thumb(mp4, jpg):
                        thumbs_regen += 1
                    else:
                        errors += 1
    return jsonify({
        "ok": True,
        "registered":   registered,
        "missing":      missing,
        "thumbs_regen": thumbs_regen,
        "scanned":      scanned,
        "errors":       errors,
    })


@bp.post('/api/weather/thumbs/regen')
def api_weather_thumbs_regen():
    """Force-rebuild every weather thumb whose clip exists. Used when
    a codec change or model rebuild has left the existing thumbs
    looking stale and the user wants a fresh middle-frame extract
    for the whole collection. Idempotent — overwriting an existing
    JPEG with a fresh decode is harmless."""
    root = _weather_root()
    if root is None or not root.exists():
        return jsonify({"ok": True, "regenerated": 0, "skipped": 0,
                        "errors": 0, "note": "no weather storage root"})
    regenerated = skipped = errors = 0
    for cam_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if cam_dir.name.startswith(".") or cam_dir.name == "recaps":
            continue
        for phase in _WEATHER_PHASE_DIRS:
            phase_dir = cam_dir / phase
            if not phase_dir.exists() or not phase_dir.is_dir():
                continue
            for mp4 in sorted(phase_dir.glob("*.mp4")):
                if mp4.name.startswith("."):
                    continue
                jpg = phase_dir / (mp4.stem + ".jpg")
                with _weather_thumb_regen_lock:
                    if _regenerate_weather_thumb(mp4, jpg):
                        regenerated += 1
                    else:
                        errors += 1
            # Count orphan thumbs (no matching clip) — surfaced as
            # `skipped` in the response so the user knows there's
            # something to clean up, but we don't auto-delete because
            # the rescan endpoint is the right tool for re-pairing.
            for jpg in sorted(phase_dir.glob("*.jpg")):
                if jpg.name.startswith("."):
                    continue
                if not (phase_dir / (jpg.stem + ".mp4")).exists():
                    skipped += 1
    return jsonify({
        "ok": True,
        "regenerated": regenerated,
        "skipped":     skipped,
        "errors":      errors,
    })


@bp.get('/api/weather/sightings')
def api_weather_sightings():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"items": [], "counts": {}, "total": 0, "page": 0, "page_size": 50})
    # Flask's type=int parser swallows non-int values into None;
    # the explicit `or 0` matches the prior try/except default.
    page = request.args.get('page', type=int, default=0) or 0
    return jsonify(ws.list_sightings(
        cam_id=request.args.get('cam_id') or None,
        event_type=request.args.get('event_type') or None,
        since_iso=request.args.get('from') or None,
        until_iso=request.args.get('to') or None,
        page=page,
    ))


@bp.get('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_get(sighting_id: str):
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"error": "weather service not available"}), 503
    m = ws.get_sighting(sighting_id)
    if not m:
        return jsonify({"error": "not found"}), 404
    return jsonify(m)


def _tolerant_resolve(stored_full: Path, storage_root: Path,
                      ext: str) -> Path | None:
    """When the path stored in a manifest no longer matches what's on
    disk (cam-slug suffix migration renamed files post-write), look for
    any file in the same directory that shares the stem prefix up to
    the date. Returns a Path that exists and lives inside storage_root,
    or None when nothing matches. `ext` is the lowercase extension
    without leading dot (e.g. "mp4", "jpg")."""
    parent = stored_full.parent
    if not parent.exists():
        return None
    stem = stored_full.stem
    # The cam-slug migration appends an underscore + slug to the stem,
    # so the historical prefix is still a prefix of the new name.
    # Glob on `<stem>*.<ext>` covers both directions (stored name has
    # the slug but disk doesn't, or vice versa — fall back to any file
    # whose stem starts with the date portion before the first slug
    # underscore).
    candidates = list(parent.glob(f"{stem}*.{ext}"))
    if not candidates:
        # Try the date-prefix path: split on first "_sunrise"/"_sunset"
        # token because that's the stable part of every sun-tl name.
        for token in ("_sunrise", "_sunset"):
            if token in stem:
                prefix = stem.split(token, 1)[0] + token
                candidates = list(parent.glob(f"{prefix}*.{ext}"))
                if candidates:
                    break
    if not candidates:
        return None
    # Prefer an exact-stem match when present, otherwise pick the
    # shortest filename (most likely the original, un-suffixed one).
    candidates.sort(key=lambda p: (p.stem != stem, len(p.name)))
    picked = candidates[0]
    try:
        if not str(picked.resolve()).startswith(str(storage_root.resolve())):
            return None
    except (OSError, RuntimeError):
        return None
    return picked


@bp.get('/api/weather/sightings/<sighting_id>/clip')
def api_weather_sighting_clip(sighting_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("clip_path", "")
    full = storage_root / rel
    try:
        if not str(full.resolve()).startswith(str(storage_root.resolve())):
            return Response(status=404)
    except (OSError, RuntimeError):
        return Response(status=404)
    if not full.exists():
        # Stored path 404s — legacy manifests still point at the
        # pre-rename filename. Try a tolerant same-dir glob before
        # giving up so the user doesn't see a broken card.
        alt = _tolerant_resolve(full, storage_root, "mp4")
        if alt is None:
            log.warning("[weather] clip 404 — %s missing for %s",
                        rel, sighting_id)
            return Response(status=404)
        log.info("[weather] clip resolved via fallback glob: %s → %s",
                 rel, alt.name)
        full = alt
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@bp.get('/api/weather/sightings/<sighting_id>/thumb')
def api_weather_sighting_thumb(sighting_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_sighting(sighting_id)
    if not m:
        return Response(status=404)
    rel = m.get("thumb_path", "")
    full = storage_root / rel
    try:
        if not str(full.resolve()).startswith(str(storage_root.resolve())):
            return Response(status=404)
    except (OSError, RuntimeError):
        return Response(status=404)
    if not full.exists():
        # First try a tolerant same-dir glob — legacy manifests still
        # point at pre-rename filenames after the cam-slug migration.
        alt = _tolerant_resolve(full, storage_root, "jpg")
        if alt is not None:
            log.info("[weather] thumb resolved via fallback glob: %s → %s",
                     rel, alt.name)
            full = alt
    if not full.exists():
        # Thumb JPG still missing — try to regenerate from the clip
        # before giving up. Both-missing is the only true 404 case.
        clip_rel = m.get("clip_path", "")
        clip_full = (storage_root / clip_rel) if clip_rel else None
        if clip_full and not clip_full.exists():
            alt_clip = _tolerant_resolve(clip_full, storage_root, "mp4")
            if alt_clip is not None:
                clip_full = alt_clip
        if not clip_full or not clip_full.exists():
            log.warning(
                "[weather] thumb 404 — clip and thumb both missing for %s",
                sighting_id)
            return Response(status=404)
        with _weather_thumb_regen_lock:
            # Re-check inside the lock — another request may have won.
            if not full.exists():
                if not _regenerate_weather_thumb(clip_full, full):
                    log.warning("[weather] thumb regen failed for %s",
                                sighting_id)
                    return Response(status=404)
                log.info("[weather] thumb regenerated for %s", sighting_id)
    return send_from_directory(full.parent, full.name, mimetype='image/jpeg')


@bp.delete('/api/weather/sightings/<sighting_id>')
def api_weather_sighting_delete(sighting_id: str):
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"error": "weather service not available"}), 503
    if ws.delete_sighting(sighting_id):
        return jsonify({"ok": True})
    return jsonify({"error": "not found"}), 404


@bp.get('/api/weather/sun-times')
def api_weather_sun_times():
    """Today's sunrise/sunset for the configured location, plus per-camera
    sun-timelapse window previews. Powers the live preview row in
    Settings → Wetter."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"location_set": False, "sunrise": None, "sunset": None,
                        "cameras": []})
    return jsonify(ws.sun_times_today())


@bp.get('/api/weather/recaps')
def api_weather_recaps():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"items": []})
    return jsonify({"items": ws.list_recaps()})


@bp.get('/api/weather/recaps/<recap_id>/clip')
def api_weather_recap_clip(recap_id: str):
    ws = app_state.weather_service
    storage_root = app_state.storage_root
    if ws is None:
        return Response(status=503)
    m = ws.get_recap(recap_id)
    if not m:
        return Response(status=404)
    full = storage_root / m.get("clip_path", "")
    if not full.exists() or not str(full.resolve()).startswith(str(storage_root.resolve())):
        return Response(status=404)
    return send_from_directory(full.parent, full.name, mimetype='video/mp4')


@bp.get('/api/weather/status')
def api_weather_status():
    ws = app_state.weather_service
    if ws is None:
        return jsonify({
            "enabled": False, "last_poll_at": None, "last_api_ok": None,
            "current_state": {}, "current_values": {},
            "location": {"lat": None, "lon": None},
        })
    return jsonify(ws.status())


@bp.post('/api/weather/sun-tl/test')
def api_weather_sun_tl_test_start():
    """Start an ad-hoc sunrise/sunset capture for live diagnostic
    observation. Re-uses the production capture path so the
    bug we're chasing reproduces; surfaces frame counters and the
    daynight-override result via /api/weather/sun-tl/test/status.

    G5 · duration_s + target_duration_s parsing fails LOUD (HTTP 400)
    instead of silently defaulting to 120 / None. The full allowlists
    live in app/app/weather_service/_sun_tl.py and must stay aligned
    with web/static/js/weather/settings-suntltest.js · _DURATIONS /
    _TARGET_LENGTHS; mismatched values bubble up as the start_sun_tl_
    test() error reply, which we surface as 400."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"ok": False, "error": "weather service not available"}), 503
    body = request.get_json(silent=True) or {}
    cam_id = (body.get("cam_id") or "").strip()
    phase = (body.get("phase") or "").strip()
    # G5 · explicit 400 instead of the previous silent fallback to
    # 120 s. A type error here means the frontend sent something
    # malformed and the operator needs to see WHY, not get a quiet
    # 120 s coercion that misaligns the math readout.
    raw_duration = body.get("duration_s")
    if raw_duration is None:
        return jsonify({"ok": False,
                        "error": "duration_s required"}), 400
    try:
        duration_s = int(raw_duration)
    except (TypeError, ValueError):
        return jsonify({"ok": False,
                        "error": f"duration_s must be an integer "
                                 f"(got {raw_duration!r})"}), 400
    raw_target = body.get("target_duration_s")
    target_duration_s = None
    if raw_target is not None:
        try:
            target_duration_s = int(raw_target)
        except (TypeError, ValueError):
            return jsonify({"ok": False,
                            "error": f"target_duration_s must be an integer "
                                     f"or null (got {raw_target!r})"}), 400
    if not cam_id or not phase:
        return jsonify({"ok": False, "error": "cam_id and phase required"}), 400
    res = ws.start_sun_tl_test(cam_id, phase, duration_s,
                               target_duration_s=target_duration_s)
    if not res.get("ok"):
        # G5 · "not in allowlist" errors from start_sun_tl_test fall
        # under HTTP 400 (client supplied a value the server doesn't
        # accept). The legacy "test already running" stays at 409 so
        # the frontend's existing toast wording still applies.
        err = (res.get("error") or "")
        code = 400 if "allowlist" in err or "must be an integer" in err else 409
        return jsonify(res), code
    return jsonify(res)


@bp.get('/api/weather/sun-tl/test/status')
def api_weather_sun_tl_test_status():
    """Live snapshot of the active (or most recently completed)
    sun-tl test session. Polled by the UI every ~1.5 s while running.

    G2 · ``?since=<epoch_s>`` filters slot_events to entries strictly
    newer than that timestamp so the poller can ship just the delta.
    Default (no since) returns the full slot_events history."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"running": False, "session": None})
    try:
        since = float(request.args.get("since") or 0.0)
    except (TypeError, ValueError):
        since = 0.0
    return jsonify(ws.get_sun_tl_test_status(since=since))


@bp.post('/api/weather/sun-tl/test/cancel')
def api_weather_sun_tl_test_cancel():
    """Signal the active sun-tl test capture to stop at the next
    poll boundary (~0.5 s). The capture loop sets ``cancelled=True``
    and skips the encode path; the status endpoint surfaces the
    cancellation so the frontend can render the right end-state."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({"ok": False,
                        "error": "weather service not available"}), 503
    res = ws.cancel_sun_tl_test()
    if not res.get("ok"):
        return jsonify(res), 409
    return jsonify(res)


@bp.get('/api/weather/history')
def api_weather_history():
    """Backing endpoint for the Wetterstatistik chart. `hours` clamped
    to 1..720 by the service (30 d at default 5-min poll). Returns a
    sample list, per-field thresholds drawn from the configured event
    triggers, units, German labels, and the configured poll interval."""
    ws = app_state.weather_service
    if ws is None:
        return jsonify({
            "hours": 24, "samples": [], "thresholds": {}, "units": {},
            "labels_de": {}, "fields": [], "poll_interval_s": 300,
        })
    hours = request.args.get("hours", type=int, default=24) or 24
    return jsonify(ws.history(hours))

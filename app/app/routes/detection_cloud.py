"""Detection-scatter (Erkennungswolke) read endpoint.

Flattens existing `tracks.json` sidecars next to motion clips into a
flat list of per-sample detection points so the Statistik panel can
plot a confidence vs. time / class scatter. No new persistence — the
sidecars are the source of truth; events without one are simply
skipped (they fall into the coverage metric so the operator notices
when the tracking worker has fallen behind).
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from .. import app_state
from ..tracking_worker import tracks_path_for

bp = Blueprint("detection_cloud", __name__)
log = logging.getLogger(__name__)

# Mirrors #tlRangeSlider's max so the UI slider semantics stay 1:1.
_MAX_HOURS = 720
_DEFAULT_HOURS = 24
_DEFAULT_LIMIT = 5000
_MAX_LIMIT = 20000


def _parse_csv_param(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [s for s in (x.strip() for x in raw.split(",")) if s]


def _event_start_dt(time_str: str) -> datetime | None:
    """Parse event['time'] (ISO-ish string written by event_logic). Falls
    back to None when the string is missing or malformed — the caller
    drops the sample entirely so a broken event doesn't pollute the
    scatter."""
    if not time_str:
        return None
    try:
        # Strip trailing Z if any, fromisoformat handles HH:MM:SS+offset.
        return datetime.fromisoformat(time_str.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, TypeError):
        return None


def _bbox_frac_area(bbox: dict, frame_w: int, frame_h: int) -> float | None:
    """(width * height) / (frame_w * frame_h) for a sample's bbox.
    Returns None when the frame dims aren't recorded (older clips with
    fps==0 paths) so the frontend can fall back to a default radius."""
    if not bbox or frame_w <= 0 or frame_h <= 0:
        return None
    try:
        w = max(0, int(bbox.get("x2", 0)) - int(bbox.get("x1", 0)))
        h = max(0, int(bbox.get("y2", 0)) - int(bbox.get("y1", 0)))
    except (TypeError, ValueError):
        return None
    area = (w * h) / float(frame_w * frame_h)
    if area <= 0:
        return None
    return round(area, 5)


def _read_sidecar(tracks_path) -> dict | None:
    """Parse a tracks.json, swallowing errors so a single corrupt file
    can't kill the whole cloud response. Returns None on any failure."""
    try:
        return json.loads(tracks_path.read_text(encoding="utf-8"))
    except Exception as e:
        log.info("[stats] sidecar unreadable %s: %s", tracks_path.name, e)
        return None


@bp.get("/api/detection_cloud")
def api_detection_cloud():
    """Flatten per-sample detections from tracks.json sidecars.

    Query:
      hours      — 1..720 window (default 24)
      cameras    — CSV of cam_ids (optional → every enabled cam)
      min_score  — 0..1 floor (default 0.0)
      limit      — cap on returned points (default 5000, max 20000)

    Response:
      { points: [...], coverage: {events_total, events_with_sidecar,
                                  oldest_iso, newest_iso} }
    """
    settings = app_state.settings
    store = app_state.store
    storage_root = app_state.storage_root
    if settings is None or store is None or storage_root is None:
        return jsonify({"points": [], "coverage": _empty_coverage()})

    hours = request.args.get("hours", type=int) or _DEFAULT_HOURS
    hours = max(1, min(_MAX_HOURS, hours))
    cameras_filter = set(_parse_csv_param(request.args.get("cameras")))
    try:
        min_score = float(request.args.get("min_score") or 0.0)
    except (TypeError, ValueError):
        min_score = 0.0
    min_score = max(0.0, min(1.0, min_score))
    limit = request.args.get("limit", type=int) or _DEFAULT_LIMIT
    limit = max(1, min(_MAX_LIMIT, limit))

    start_iso = (datetime.now() - timedelta(hours=hours)).isoformat(timespec="seconds")

    cameras_cfg = settings.data.get("cameras", []) or []
    cam_ids = [c["id"] for c in cameras_cfg if c.get("id")]
    if cameras_filter:
        cam_ids = [cid for cid in cam_ids if cid in cameras_filter]

    points: list[dict] = []
    events_total = 0
    events_with_sidecar = 0
    oldest_dt: datetime | None = None
    newest_dt: datetime | None = None

    for cid in cam_ids:
        # media_only=True mirrors timeline / mediathek; events without a
        # clip can't have a sidecar, so they don't even count toward
        # coverage. limit=5000 matches the timeline route's ceiling.
        events = store.list_events(cid, start=start_iso, limit=5000, media_only=True)
        for ev in events:
            video_rel = ev.get("video_relpath")
            if not video_rel:
                continue
            events_total += 1
            vid_path = storage_root / video_rel
            if not vid_path.exists():
                continue
            tracks_path = tracks_path_for(vid_path)
            if not tracks_path.exists():
                # Worker pending or older clip — do NOT trigger reindex.
                continue
            payload = _read_sidecar(tracks_path)
            if not payload:
                continue
            events_with_sidecar += 1
            ev_id = ev.get("event_id")
            ev_start = _event_start_dt(ev.get("time") or "")
            if ev_start is None:
                continue
            snapshot_url = ev.get("snapshot_url")
            # frame_w/h aren't stored in the v2 sidecar yet — we recover
            # the dimensions implicitly through bbox math relative to the
            # max bbox seen, but the cleaner path is to expose the raw
            # bbox area in pixels and let the frontend pick a default
            # scale. We try to derive frame dims from the first bbox seen
            # vs. the schema; fall back to None.
            tracks_list = payload.get("tracks") or []
            # No frame dims in payload yet (v2 schema). Use the maximum
            # bbox extent across all samples as the assumed frame size —
            # bbox_frac_area becomes "relative size vs. the biggest box
            # in this clip", which is what the user actually wants to
            # see in the scatter (a small bird sample vs. a person
            # filling the frame).
            max_x2 = max_y2 = 0
            for tr in tracks_list:
                for s in tr.get("samples") or []:
                    bb = s.get("bbox") or {}
                    try:
                        x2 = int(bb.get("x2", 0))
                        y2 = int(bb.get("y2", 0))
                    except (TypeError, ValueError):
                        continue
                    if x2 > max_x2:
                        max_x2 = x2
                    if y2 > max_y2:
                        max_y2 = y2
            assumed_w = max_x2 or 1920
            assumed_h = max_y2 or 1080

            for tr in tracks_list:
                label = tr.get("label") or "unknown"
                for sample in tr.get("samples") or []:
                    if sample.get("source") != "detect":
                        continue
                    score = sample.get("score")
                    if score is None:
                        continue
                    try:
                        score_f = float(score)
                    except (TypeError, ValueError):
                        continue
                    if score_f < min_score:
                        continue
                    frame_idx = sample.get("f")
                    t_off = sample.get("t")
                    try:
                        t_off_f = float(t_off) if t_off is not None else 0.0
                    except (TypeError, ValueError):
                        t_off_f = 0.0
                    sample_dt = ev_start + timedelta(seconds=t_off_f)
                    frac_area = _bbox_frac_area(sample.get("bbox") or {}, assumed_w, assumed_h)
                    points.append(
                        {
                            "event_id": ev_id,
                            "camera_id": cid,
                            "sample_key": f"{ev_id}_{frame_idx}",
                            "time": sample_dt.isoformat(timespec="seconds"),
                            "label": label,
                            "score": round(score_f, 4),
                            "bbox_frac_area": frac_area,
                            "snapshot_url": snapshot_url,
                        }
                    )
                    if oldest_dt is None or sample_dt < oldest_dt:
                        oldest_dt = sample_dt
                    if newest_dt is None or sample_dt > newest_dt:
                        newest_dt = sample_dt

    points.sort(key=lambda p: p["time"], reverse=True)
    if len(points) > limit:
        # Truncate from the most-recent end so a low limit still shows
        # the user the latest activity (oldest points fall off).
        points = points[:limit]

    coverage = {
        "events_total": events_total,
        "events_with_sidecar": events_with_sidecar,
        "oldest_iso": oldest_dt.isoformat(timespec="seconds") if oldest_dt else None,
        "newest_iso": newest_dt.isoformat(timespec="seconds") if newest_dt else None,
    }
    return jsonify({"points": points, "coverage": coverage})


def _empty_coverage() -> dict:
    return {
        "events_total": 0,
        "events_with_sidecar": 0,
        "oldest_iso": None,
        "newest_iso": None,
    }

"""N14 · Per-camera test-detection endpoint extracted from coral.py.

The /api/cameras/<id>/test-detection endpoint isn't a Coral-pipeline
test like the rest of coral.py — it's the backend for the cam-edit
"Erkennung jetzt simulieren" button. Splitting it out drops coral.py
from 1135 → 631 lines and gives this functionality its own home so
follow-ups (helper extraction in api_test_detection itself) can
land without touching the Coral-test panel.

URL path unchanged. Blueprint is registered alongside coral.bp via
routes/__init__.py so the URL space is byte-identical to pre-split.
"""

from __future__ import annotations

import collections
import logging
import time as _time

import cv2
from flask import Blueprint, jsonify, request

from .. import app_state
from ..tracker_core import (
    LiveTracker,
    associate_detections,
    compute_miss_grace_samples,
    resolve_track_thresholds,
)

# SIMU-05h · cluster-evidence ring-buffer window. Events older than
# this are pruned on every test-detection call.
_EVIDENCE_WINDOW_S = 60.0

bp = Blueprint("coral_test_detection", __name__)
log = logging.getLogger(__name__)

# C41 · per-camera last "sub-stream unavailable, fell back to main"
# warn timestamp. Rate-limits to once per 60 s so a camera with the
# sub-stream permanently disabled (firmware option, RTSP URL typo)
# doesn't spam docker logs on every Simulieren tick.
_FALLBACK_WARN_TS: dict[str, float] = {}

# SIMU-02e · per-camera tracker state for the test-detection endpoint.
# Mirrors the runtime tracker config but keeps its OWN state so the
# alarm pipeline's tracker isn't perturbed by Simulieren ticks. The
# state carries a stable display-number map (track_id → #N) that
# survives across ticks until the user closes Simulieren on this cam.
_TEST_TRACKERS: dict[str, dict] = {}
# Idle threshold — drop tracker state after 5 min of no test-detection
# calls for this camera so a stale session doesn't keep stretching
# display numbers across a fresh user open.
_TEST_TRACKER_IDLE_S = 300.0


def _get_test_tracker(cam_id: str, cam_cfg: dict) -> dict:
    """Return the per-cam test-detection tracker state.

    Lazily creates a fresh LiveTracker on first call (or after the
    idle window expires) so the runtime tracker stays untouched.
    """
    now = _time.monotonic()
    entry = _TEST_TRACKERS.get(cam_id)
    if entry and (now - float(entry.get("last_call_ts", 0))) < _TEST_TRACKER_IDLE_S:
        return entry
    spawn, floor, grace, iou = resolve_track_thresholds(lambda _cid: cam_cfg, cam_id)
    tracker = LiveTracker(
        cam_id,
        spawn_default=spawn,
        floor=floor,
        grace_seconds=grace,
        iou_threshold=iou,
    )
    entry = {
        "tracker": tracker,
        "display_nums": {},
        "next_num": 0,
        "last_call_ts": now,
        # SIMU-05h · ring-buffer of (wall_ts, kind, track_num, label,
        # score, iou, extra). maxlen large enough for ~3 tick/s × 60 s
        # × 4 event-kinds = 720 entries with room to spare.
        "events": collections.deque(maxlen=1024),
        # Per-class detection counts within the 60-s window. Each
        # entry is (wall_ts, label, verdict) so prune-by-time is
        # straightforward.
        "class_log": collections.deque(maxlen=2048),
        # Tracker-state mirror for DEATH detection — track_id → last
        # wall-time we saw it in matches.
        "last_seen_ts": {},
        # Cumulative drops over the test-tracker's lifetime; surfaced
        # in cluster 4. Set on each tick from the live runtime when
        # available, otherwise stays 0.
        "drops_session": 0,
    }
    _TEST_TRACKERS[cam_id] = entry
    return entry


@bp.post('/api/cameras/<cam_id>/test-detection')
def api_test_detection(cam_id: str):
    """Run Coral inference on the camera's most-recent frame and return
    each raw detection alongside a verdict — pass / belowthresh /
    filtered — computed against the camera's current configuration
    (detection_min_score, label_thresholds, object_filter). The cam-
    edit "Erkennung jetzt simulieren" button hits this and renders the
    snapshot inline with coloured bounding boxes so the user can see
    exactly what Coral found and which filter dropped what.

    No fresh capture: we read the runtime's last cached frame
    (rt.frame). The main loop refills that buffer on every successful
    grab (~frame_interval_ms cadence). To guarantee the simulation
    actually reflects the CURRENT scene — the user-visible bug was
    snapshots 2+ minutes old when the stream had stalled — the
    handler does a fresh-frame check: if the cached frame is older
    than ~1.5 s OR 3× the camera's frame_interval_ms, it waits up to
    2 s for the main loop to advance ``frame_ts``. If the buffer
    never moves, returns 503 so the operator sees a clear "stream
    stuck" instead of inferring on a stale frame. Inference runs at a
    low 0.20 threshold so even almost-rejected hits surface in the
    visualisation; the user's actual thresholds are applied afterwards
    to compute the per-detection verdict.
    """
    settings = app_state.settings
    runtimes = app_state.runtimes
    cam = settings.get_camera(cam_id)
    if not cam:
        return jsonify({"error": "camera not found"}), 404
    rt = runtimes.get(cam_id)
    if rt is None:
        return jsonify({"error": "Kamera-Runtime nicht aktiv (deaktiviert?)"}), 503

    # ── Fresh + decoder-strip frame contract ──────────────────────────
    # Poll up to 2.5 s for a frame whose timestamp is NEWER than this
    # request AND passes the cheap ``has_corrupt_strip`` H.264 chroma-
    # buffer-flush check. The richer ``is_valid_frame`` validator
    # (bright_outlier_dark_scene, grey_toned, dead_area, …) is
    # deliberately NOT applied here: it was designed to gate the alarm
    # / notification pipeline against frames that look broken to the
    # human, but the live-preview / Simulieren use case is exactly the
    # opposite — show what Coral sees on the camera's CURRENT frame,
    # whatever it looks like. Letting the validator gate the live
    # preview produced ~60 % rejection on the Garten-Dachterrasse
    # twilight scene (one patio light + low-chroma terrace) and made
    # the UI show stale state. The human eye on the live video
    # decides whether a frame is "trustworthy" — Coral's verdict on
    # whatever frame is current is the data the user is asking for.
    # has_corrupt_strip stays in because pink/rainbow bottom-strip is
    # a narrow decoder-artefact signature that would just produce
    # spurious detections on garbage chroma; the alarm-pipeline path
    # in camera_runtime/_main_loop already filters those out
    # independently.
    from ..frame_helpers import (
        has_corrupt_strip,
        pick_profile_from_baseline,
    )

    request_started_at = _time.time()
    deadline = _time.monotonic() + 2.5
    frame = None
    frame_ts_accepted = 0.0
    last_candidate_ts = 0.0
    saw_frame = False
    saw_fresh_candidate = False
    retries = 0
    final_outcome = "no_frame"
    # H1 · track the most recent validator rejection reason across the
    # 2.5 s wait loop. When outcome ends up "corrupt" we surface this
    # in BOTH the log line and the JSON response so the user can see
    # WHICH gate (horizontal_anomaly_band / dead_area / pink_artifact
    # …) flagged every candidate frame, without flipping the log
    # level to DEBUG. This is the single-line answer that splits
    # Stage ① (RTSP/decoder corruption — pink_artifact dominates) from
    # a validator-too-strict regression (e.g. horizontal_anomaly_band
    # spam on a Reolink in IR-cut transition).
    last_validator_reason: str = ""
    active_profile = None
    # C41 · "frame_src" identifies which stream the served frame came
    # from. The sub-stream tier (640×360, H.264) is preferred because
    # Coral SSD-MobileNet resizes its input to 300×300 internally; the
    # extra resolution of the main stream costs cycles without any
    # detection-quality gain for the subjects we care about. We fall
    # back to the main stream only when the sub path is unavailable
    # for the entire 2.5 s wait deadline. frame_src is also surfaced
    # in diag so the operator can confirm the path live in the UI.
    frame_src_used = ""
    while _time.monotonic() < deadline:
        # Tier 1 · sub-stream (preferred). _preview_loop writes a clean
        # H.264 frame here; the corrupt-strip check is skipped because
        # that artefact is a main-stream-only failure mode.
        with rt.lock:
            sub_candidate = rt._preview_frame.copy() if rt._preview_frame is not None else None
            sub_candidate_ts = float(getattr(rt, "_preview_frame_ts", 0.0) or 0.0)
        if sub_candidate is not None:
            if sub_candidate_ts >= request_started_at - 1.0:
                frame = sub_candidate
                frame_ts_accepted = sub_candidate_ts
                last_candidate_ts = max(last_candidate_ts, sub_candidate_ts)
                saw_frame = True
                saw_fresh_candidate = True
                active_profile = pick_profile_from_baseline([sub_candidate])
                frame_src_used = "sub"
                final_outcome = "ok"
                break
        # Tier 2 · main-stream fallback. Same shape as the original
        # wait loop: poll rt.frame, gate on freshness + has_corrupt_strip,
        # accept on first survivor.
        with rt.lock:
            candidate = rt.frame.copy() if rt.frame is not None else None
            candidate_ts = float(getattr(rt, "frame_ts", 0.0) or 0.0)
        retries += 1
        if candidate is None:
            _time.sleep(0.05)
            continue
        saw_frame = True
        last_candidate_ts = max(last_candidate_ts, candidate_ts)
        if candidate_ts < request_started_at:
            final_outcome = "stale"
            _time.sleep(0.05)
            continue
        saw_fresh_candidate = True
        active_profile = pick_profile_from_baseline([candidate])
        if has_corrupt_strip(candidate):
            final_outcome = "corrupt"
            last_validator_reason = "has_corrupt_strip"
            log.info(
                "[test-detection] %s rejected candidate · strip=True",
                cam_id,
            )
            _time.sleep(0.05)
            continue
        frame = candidate
        frame_ts_accepted = candidate_ts
        frame_src_used = "main_fallback"
        final_outcome = "ok"
        break

    waited_s = _time.time() - request_started_at
    if frame is None:
        # Pick the most precise outcome the loop observed.
        if not saw_frame:
            code, msg = "no_frame", "Kamera liefert noch keine Frames"
        elif not saw_fresh_candidate:
            code, msg = "stale", "Stream-Puffer hinkt zurück — kein frischer Frame innerhalb 2.5 s"
        else:
            code, msg = "corrupt", "Stream liefert nur korrupte Frames"
        # Best-effort age of the most recent rt.frame_ts we saw so the
        # frontend can colour the banner against the existing
        # frame_age_ms semantic. 0 means we never saw a frame at all.
        if last_candidate_ts > 0:
            frame_age_ms_attempt = int((_time.time() - last_candidate_ts) * 1000)
        else:
            frame_age_ms_attempt = 0
        # WARNING: no usable frame is a stream-side regression worth
        # the higher log level. Same key set as the success log line
        # below so an operator's grep matches both shapes.
        # H1 · last_validator_reason carries the gate that flagged the
        # most-recent rejected frame — single source for the stage-1
        # diagnostic. Empty string on "no_frame" / "stale" branches
        # because no frame ever reached the validator in those cases.
        log.warning(
            "[test-detection] cam=%s outcome=%s waited=%.2fs retries=%d "
            "frame_age_ms=%d frame_src=- raw=0 pass=0 belowthresh=0 "
            "filtered=0 inference_ms=0 top_raw=[] "
            "validator_reason=%r profile=%s",
            cam_id,
            code,
            waited_s,
            retries,
            frame_age_ms_attempt,
            last_validator_reason or "-",
            (active_profile.name if active_profile else "-"),
        )
        return jsonify(
            {
                "ok": False,
                "error": msg,
                "code": code,
                "frame_age_ms": frame_age_ms_attempt,
                # H1 · expose the validator reason so the in-modal Diagnose
                # panel can render "frames rejected by horizontal_anomaly
                # _band" instead of just "corrupt frames".
                "validator_reason": last_validator_reason or None,
                "validator_profile": (active_profile.name if active_profile else None),
            }
        ), 503
    frame_age_ms = int((_time.time() - frame_ts_accepted) * 1000)
    # C41 · frame_src is now either "sub" (preferred path, written by
    # _preview_loop into rt._preview_frame) or "main_fallback" (the
    # rt.frame path, only when sub was unavailable for the entire
    # 2.5 s wait). Both branches set frame_src_used above; we derive
    # the human label here for the existing log line. A WARNING fires
    # ONCE per 60 s per camera on fallback so a sub-stream-less cam
    # doesn't spam the log.
    src_h_raw, src_w_raw = frame.shape[:2]
    if frame_src_used == "sub":
        frame_src_label = f"sub {src_w_raw}×{src_h_raw}"
    else:
        frame_src_label = f"main_fallback {src_w_raw}×{src_h_raw}"
        now_ts = _time.time()
        last_warn = _FALLBACK_WARN_TS.get(cam_id, 0.0)
        if now_ts - last_warn > 60.0:
            _FALLBACK_WARN_TS[cam_id] = now_ts
            log.warning(
                "[test-detection] cam=%s sub-stream unavailable, falling back to main-stream",
                cam_id,
            )
    detector = getattr(rt, "detector", None)
    if not detector or not getattr(detector, "available", False):
        # WARNING level: a Coral-disabled test request is almost always
        # a config bug worth surfacing in docker logs even when the
        # frontend already shows a "Coral nicht verfügbar" banner.
        log.warning(
            "[test-detection] cam=%s outcome=coral_unavailable waited=%.2fs "
            "retries=%d frame_age_ms=%d frame_src=%s raw=0 pass=0 "
            "belowthresh=0 filtered=0 top_raw=[]",
            cam_id,
            waited_s,
            retries,
            frame_age_ms,
            frame_src_label,
        )
        return jsonify({"error": "Coral nicht verfügbar (motion-only?)"}), 503
    inference_t0 = _time.monotonic()
    try:
        raw = detector.detect_frame_raw(frame, threshold=0.20)
    except Exception as e:
        log.warning("[test-detection] %s inference failed: %s", cam_id, e)
        return jsonify({"error": f"Inference fehlgeschlagen: {e}"}), 500
    inference_ms = int(round((_time.monotonic() - inference_t0) * 1000))
    # Resolve the global confidence floor — empty/zero on the camera
    # means "use the global processing.detection.min_score". This must
    # match what camera_runtime actually applies at runtime so the
    # simulation result reflects what would happen in production.
    global_floor = float(cam.get("detection_min_score") or 0.0)
    if global_floor <= 0:
        proc = app_state.get_effective_config().get("processing") or {}
        global_floor = float((proc.get("detection") or {}).get("min_score") or 0.55)
    per_class = cam.get("label_thresholds") or {}
    obj_filter = set(cam.get("object_filter") or [])
    # SIMU-02e · run the per-camera test-tracker to assign stable
    # track_num values that the frontend renders as badges on each
    # bbox. State persists across consecutive test-detection calls
    # so a person walking through holds the same #N across ticks.
    tt = _get_test_tracker(cam_id, cam)
    tt["last_call_ts"] = _time.monotonic()
    tracker = tt["tracker"]
    display_nums = tt["display_nums"]
    fps_approx = max(1.0, 1000.0 / float(cam.get("frame_interval_ms") or 350))
    tracker._frame_idx += 1
    grace_samples = compute_miss_grace_samples(tracker.grace_seconds, fps_approx)
    try:
        matches = associate_detections(
            tracker.state,
            list(raw),
            frame_idx=tracker._frame_idx,
            t_s=_time.monotonic(),
            spawn_score=tracker.spawn_default,
            spawn_for=lambda lbl: float(per_class.get(lbl, tracker.spawn_default)),
            miss_grace_samples=grace_samples,
            iou_threshold=tracker.iou_threshold,
        )
    except Exception as exc:
        log.warning("[test-detection] %s tracker step failed: %s", cam_id, exc)
        matches = []
    di_to_num: dict[int, int] = {}
    wall_now = _time.time()
    prev_seen = tt.get("last_seen_ts") or {}
    new_seen: dict[str, float] = {}
    events_buf = tt.get("events") or collections.deque(maxlen=1024)
    for di, tr in matches:
        tid = tr.track_id
        num = display_nums.get(tid)
        is_new = num is None
        if is_new:
            tt["next_num"] = int(tt.get("next_num") or 0) + 1
            num = tt["next_num"]
            display_nums[tid] = num
        di_to_num[di] = num
        new_seen[tid] = wall_now
        # SIMU-05h · emit SPAWN on first match, CONT on subsequent.
        ev_kind = "spawn" if is_new else "cont"
        try:
            score_v = float(raw[di].score)
        except Exception:
            score_v = 0.0
        events_buf.append(
            (
                wall_now,
                ev_kind,
                num,
                getattr(raw[di], "label", ""),
                round(score_v, 4),
                None,
                "",
            )
        )
    # DEATH detection: any previously-seen track that didn't match
    # this tick AND has been silent past the grace window emits a
    # DEATH event. Mirror the runtime tracker's logic: grace is in
    # seconds, derived from compute_miss_grace_samples * cycle_time.
    grace_ms = float(tracker.grace_seconds) * 1000.0
    for tid_prev, prev_ts in prev_seen.items():
        if tid_prev in new_seen:
            continue
        if (wall_now - prev_ts) * 1000.0 < grace_ms:
            # still within grace — carry forward so a brief gap
            # doesn't fire false DEATHs.
            new_seen[tid_prev] = prev_ts
            continue
        # already past grace — emit DEATH once and drop from the seen
        # map so we don't re-fire on every subsequent tick.
        num_prev = display_nums.get(tid_prev)
        if num_prev is not None:
            label_prev = ""
            # Look up the closed track in tracker.state for its label
            # (best-effort — the closed list may have been pruned).
            for closed in getattr(tracker.state, "closed", []) or []:
                if getattr(closed, "track_id", None) == tid_prev:
                    label_prev = getattr(closed, "label", "") or ""
                    break
            events_buf.append(
                (wall_now, "death", num_prev, label_prev, None, None, "grace expired"),
            )
    tt["last_seen_ts"] = new_seen
    tt["events"] = events_buf
    # SIMU-05h · log per-class verdict counts. The loop building `out`
    # below writes the verdict per detection; record raw + verdict here
    # so the 60-s window can aggregate without re-walking `out`.
    class_log = tt.get("class_log") or collections.deque(maxlen=2048)
    out = []
    for di, d in enumerate(raw):
        cls_thresh = float(per_class.get(d.label, global_floor))
        if obj_filter and d.label not in obj_filter:
            verdict = "filtered"
            reason = f"Klasse '{d.label}' nicht im Filter"
        elif d.score < cls_thresh:
            verdict = "belowthresh"
            reason = f"unter Schwelle {int(round(cls_thresh * 100))} %"
        else:
            verdict = "pass"
            reason = ""
        x1, y1, x2, y2 = d.bbox
        out.append(
            {
                "label": d.label,
                "score": round(float(d.score), 4),
                "bbox": [int(x1), int(y1), int(max(0, x2 - x1)), int(max(0, y2 - y1))],
                "verdict": verdict,
                "reason": reason,
                "track_num": di_to_num.get(di),
            }
        )
        class_log.append((wall_now, d.label, verdict))
    tt["class_log"] = class_log
    out.sort(key=lambda r: r["score"], reverse=True)
    # ``?no_snapshot=1`` — Simulieren v2 (kr493): frontend drives the
    # video via the continuous MJPEG stream and only needs the bbox
    # payload + frame dimensions here. Skipping the resize + base64
    # encode cuts the response from ~106 kB to ~1 kB AND eliminates
    # the cv2.imencode + base64 cost (which on a 1080p frame is the
    # dominant time budget after Coral inference itself). Bbox coords
    # stay in SOURCE pixel space so the SVG viewBox math still lines
    # up against the live MJPEG.
    src_h, src_w = frame.shape[:2]
    skip_snapshot = (request.args.get("no_snapshot") or "").strip() in ("1", "true", "yes")
    snap_scale = 1.0
    snap_w, snap_h = src_w, src_h
    snapshot = None
    if not skip_snapshot:
        # ── Downscale the snapshot to ≤960 px wide ────────────────────
        # Inference already ran on the full-resolution frame (above).
        # What the frontend renders inside the panel is only the JPEG
        # that lives in the base64 data URL — a 1920×1080 snapshot at
        # 1 Hz turns iOS Safari into molasses without any actual stream
        # problem. Bbox coordinates land in the same coordinate space
        # as the encoded JPEG (frame_size), so the SVG viewBox lines
        # up regardless of the source resolution. Quality 65 +
        # JPEG-OPTIMIZE gives a progressive render that iOS paints
        # incrementally.
        target_w = 960
        if src_w > target_w:
            snap_scale = target_w / float(src_w)
            snap_w = target_w
            snap_h = max(2, int(round(src_h * snap_scale)) // 2 * 2)
            snap_frame = cv2.resize(frame, (snap_w, snap_h), interpolation=cv2.INTER_AREA)
        else:
            snap_frame = frame
        # Rewrite bbox coords into the downscaled space when we
        # actually resized. Skip the multiplication entirely on the
        # no-op path so rounding never nudges an integer bbox off the
        # source frame.
        if snap_scale != 1.0:
            for d in out:
                x, y, w_box, h_box = d["bbox"]
                d["bbox"] = [
                    int(round(x * snap_scale)),
                    int(round(y * snap_scale)),
                    int(round(w_box * snap_scale)),
                    int(round(h_box * snap_scale)),
                ]
        try:
            import base64

            ok, jpg = cv2.imencode(
                ".jpg",
                snap_frame,
                [
                    int(cv2.IMWRITE_JPEG_QUALITY),
                    65,
                    int(cv2.IMWRITE_JPEG_OPTIMIZE),
                    1,
                ],
            )
            snapshot = (
                f"data:image/jpeg;base64,{base64.b64encode(jpg.tobytes()).decode()}" if ok else None
            )
        except Exception as e:
            log.warning("[test-detection] %s encode failed: %s", cam_id, e)
            snapshot = None
    # Frontend uses these dims to size the SVG viewBox; must match the
    # bbox + snapshot coordinate space, not the source resolution.
    w, h = snap_w, snap_h
    # ── Decision trace ──────────────────────────────────────────
    # Walk every gate from capture → telegram and record a one-line
    # human-readable verdict for each. The frontend renders this list
    # verbatim in a green-on-black terminal block so the user can iterate
    # on settings without grepping container logs. We evaluate the
    # downstream gates (matrix / armed / schedule_notify / cooldown)
    # even when nothing passed — "what WOULD have happened if a hit
    # passed" is often the actual debugging question.
    from ..event_logic import compute_severity_from_matrix, is_schedule_window_active

    trace: list[str] = []
    trace.append(
        f"[capture] frame {w}×{h} · age {frame_age_ms} ms · "
        f"interval ≤{cam.get('frame_interval_ms', 350)} ms"
    )
    trace.append(
        f"[coral] threshold floor {global_floor:.2f} · per-class: "
        f"{dict(per_class) if per_class else '(none)'}"
    )
    trace.append(
        f"[coral] object_filter: {sorted(obj_filter) if obj_filter else '(none — all classes accepted)'}"
    )
    trace.append(f"[coral] raw detections: {len(raw)}")
    for d in out:
        pct = int(round(d["score"] * 100))
        if d["verdict"] == "pass":
            trace.append(f"[det] {d['label']} {pct}% → PASS (above class threshold)")
        elif d["verdict"] == "belowthresh":
            trace.append(f"[det] {d['label']} {pct}% → REJECTED ({d['reason']})")
        elif d["verdict"] == "filtered":
            trace.append(f"[det] {d['label']} {pct}% → FILTERED ({d['reason']})")
    pass_dets = [d for d in out if d["verdict"] == "pass"]
    if not pass_dets:
        trace.append(
            "[verdict] no detection survived the threshold/filter gates · alarm pipeline NOT triggered"
        )
    class_sev_cfg = cam.get("class_severity") or {}
    trace.append(
        f"[matrix] class_severity: "
        f"{class_sev_cfg if class_sev_cfg else '(empty — falling back to legacy alarm_profile)'}"
    )
    severity = "—"
    if pass_dets:
        labels_pass = sorted({d["label"] for d in pass_dets})
        if class_sev_cfg:
            severity = compute_severity_from_matrix(class_sev_cfg, labels_pass)
        else:
            severity = "alarm"
        trace.append(f"[matrix] resolved severity for {labels_pass}: {severity}")
    trace.append(f"[armed] camera armed={bool(cam.get('armed', True))}")
    trace.append(
        f"[telegram_enabled] cam.telegram_enabled={bool(cam.get('telegram_enabled', True))}"
    )
    sch_notify = cam.get("schedule_notify") or {}
    if sch_notify:
        try:
            active_now = is_schedule_window_active(sch_notify)
        except Exception as e:
            active_now = f"(eval failed: {e})"
        trace.append(
            f"[schedule_notify] enabled={bool(sch_notify.get('enabled', False))} "
            f"window={sch_notify.get('from','?')}→{sch_notify.get('to','?')} · active_now={active_now}"
        )
    else:
        trace.append("[schedule_notify] (none — falling back to legacy schedule)")
    # Cooldown peek — best-effort. Mirrors the keying + lookup in
    # telegram_bot/_outbound.py so the trace matches what would actually
    # happen at notify-time. Swallows any structural drift between the
    # notifier internals and this read-only inspection.
    notifier = getattr(app_state, "telegram_service", None)
    try:
        if notifier is not None and pass_dets:
            top_label = pass_dets[0]["label"]
            key = (cam_id, top_label)
            last_mono = getattr(notifier, "_last_notify", {}).get(key, 0.0)
            cd_cfg = cam.get("notification_cooldown") or {}
            cd_seconds = int(cd_cfg.get(top_label, 60))
            if last_mono:
                import time as _t

                elapsed = _t.monotonic() - last_mono
                if elapsed < cd_seconds:
                    trace.append(
                        f"[cooldown] {top_label}@{cam_id}: last push {int(elapsed)}s ago · "
                        f"{int(cd_seconds - elapsed)}s remaining → would SKIP"
                    )
                else:
                    trace.append(
                        f"[cooldown] {top_label}@{cam_id}: idle (last {int(elapsed)}s ago, "
                        f"threshold {cd_seconds}s) → would PASS"
                    )
            else:
                trace.append(f"[cooldown] {top_label}@{cam_id}: never pushed → would PASS")
    except Exception as e:
        trace.append(f"[cooldown] lookup failed: {e}")
    if not pass_dets:
        trace.append("[final] no push (no detection passed)")
    else:
        trace.append(
            f"[final] {len(pass_dets)} detection(s) would route through the push pipeline "
            f"(subject to gates above)"
        )
    # C2 · freshness + gate-count log line. The operator can grep
    # `[test-detection]` to confirm rt.frame is advancing AND see at a
    # glance which gate dropped detections on this tick.
    #   raw          — count of detections Coral returned at threshold 0.20
    #   pass         — count that survived per-class threshold + object_filter
    #   belowthresh  — count rejected by per-class / global threshold
    #   filtered     — count dropped by object_filter
    #   top_raw      — up to 3 highest-scoring raw hits (label, pct),
    #                  including the ones that ended up filtered. With
    #                  raw=0 the field collapses to [] — that single
    #                  data point answers the "Coral returned nothing
    #                  for this frame" question without DevTools.
    # WARNING level when raw=0 OR outcome != ok so a regression
    # surfaces in docker logs without --tail digging.
    belowthresh_n = sum(1 for d in out if d["verdict"] == "belowthresh")
    filtered_n = sum(1 for d in out if d["verdict"] == "filtered")
    top_raw_pairs = [(d["label"], int(round(d["score"] * 100))) for d in out[:3]]
    top_raw_str = "[" + ", ".join(f"({lab},{pct}%)" for lab, pct in top_raw_pairs) + "]"
    log_fn = log.info if (final_outcome == "ok" and len(raw) > 0) else log.warning
    # H1 · object_filter + global_floor surfaced in the log so the
    # Stage 3 case (raw>0 but filter eats everything → pass=0
    # filtered=raw) is identifiable from the same line. The filter
    # is a set; format as a sorted list for grep stability. An empty
    # filter prints as "[]" and means "all classes accepted".
    _obj_filter_str = "[" + ",".join(sorted(obj_filter)) + "]"
    log_fn(
        "[test-detection] cam=%s outcome=%s waited=%.2fs retries=%d "
        "frame_age_ms=%d frame_src=%s raw=%d pass=%d belowthresh=%d "
        "filtered=%d inference_ms=%d top_raw=%s "
        "obj_filter=%s min_score=%.2f profile=%s",
        cam_id,
        final_outcome,
        waited_s,
        retries,
        frame_age_ms,
        frame_src_label,
        len(raw),
        len(pass_dets),
        belowthresh_n,
        filtered_n,
        inference_ms,
        top_raw_str,
        _obj_filter_str,
        float(global_floor),
        (active_profile.name if active_profile else "-"),
    )
    # ── Decoder-backlog heuristic ────────────────────────────────────
    # The runtime tracks an EMA of the wall-clock interval between
    # successive frame_ts writes. If that average is well below the
    # camera's CONFIGURED frame_interval_ms (≤ 0.4×) the decoder is
    # almost certainly draining a buffered burst at us faster than the
    # camera actually emits frames — i.e. "vor 0.2 s" would be true
    # for "when we decoded it" but lying about "when the camera shot
    # it". 0.4 chosen so a normally-cadenced stream (e.g. 350 ms config
    # with a slightly fast 280 ms EMA) doesn't false-positive but a
    # genuine 5–10× burst does. interval_ms taken from the saved cam
    # config so the threshold tracks user intent, not autodetected
    # fps that may be skewed by the same backlog.
    interval_ms = int(cam.get("frame_interval_ms", 350) or 350)
    ema_ms = float(getattr(rt, "_frame_interval_ema_ms", 0.0) or 0.0)
    backlog = ema_ms > 0 and interval_ms > 0 and ema_ms < 0.4 * interval_ms
    # C3 · diagnostic payload for the in-modal panel. Structured so
    # the frontend doesn't have to re-derive counts from `detections`
    # (and so future regression hunts have one canonical shape to
    # read against). All values either appear in the WARNING log
    # line above or extend it (per_class thresholds, inference_ms).
    # C41 · sub_stream_available is independent of frame_src — the
    # sub stream may exist but be too stale, in which case this tick
    # served from main_fallback yet sub is still "available" for the
    # next try. Frontend reads this to know whether enabling/fixing
    # the sub stream is even a path forward.
    sub_stream_available = bool(getattr(rt, "_preview_frame", None) is not None)
    diag = {
        "frame_src": frame_src_used or "main_fallback",
        "sub_stream_available": sub_stream_available,
        "frame_size": {"w": int(src_w_raw), "h": int(src_h_raw)},
        "frame_age_ms": int(frame_age_ms),
        "coral_available": bool(getattr(detector, "available", False)),
        "inference_ms": int(inference_ms),
        "gates": {
            "raw": int(len(raw)),
            "pass": int(len(pass_dets)),
            "belowthresh": int(belowthresh_n),
            "filtered": int(filtered_n),
        },
        "top_raw": [{"label": d["label"], "score": d["score"]} for d in out[:3]],
        "thresholds": {
            "global": round(float(global_floor), 3),
            "per_class": dict(per_class) if per_class else {},
        },
        # H1 · Stage 3 visibility — surface the object_filter the
        # endpoint actually applies so the in-modal Diagnose panel can
        # render "Filter aktiv: [person, cat]" or "(keine Klassen-
        # filter — alle passieren)" and the user spots a stale empty-
        # filter regression without DevTools.
        "object_filter": sorted(obj_filter) if obj_filter else [],
        # H1 · validator profile + (when validation rejected during
        # the wait loop) the last rejection reason. On the success
        # path this is empty; on a corrupt-outcome 503 it carries
        # the single most-informative diagnostic.
        "validator_profile": (active_profile.name if active_profile else None),
        "validator_reason": last_validator_reason or None,
        # A2 · explicit coord-space disclosure for the bbox payload.
        # The top-level response carries `frame_size` = the bbox-space
        # size (snap_w/snap_h, contract-stable). These additive diag
        # fields let the frontend assert that the SVG viewBox space
        # matches the bbox space without inferring scale from the JPEG:
        #   - source_frame_size : raw frame Coral ran inference on
        #   - snapshot_frame_size: encoded JPEG dims (= source when
        #                          no_snapshot=1)
        #   - bbox_space        : "source" when snap_scale == 1.0 (no
        #                          rewrite happened), "snapshot" when
        #                          the bbox coords were scaled to the
        #                          downscaled JPEG before serialising.
        "source_frame_size": {"w": int(src_w_raw), "h": int(src_h_raw)},
        "snapshot_frame_size": {"w": int(snap_w), "h": int(snap_h)},
        "bbox_space": "source" if snap_scale == 1.0 else "snapshot",
    }
    # SIMU-05h · build the cluster-evidence object from the
    # ring-buffer state. Prunes events outside the 60-s window and
    # computes per-cluster aggregates inline.
    cluster_evidence = _build_cluster_evidence(tt, cam, obj_filter, ema_ms)
    return jsonify(
        {
            "ok": True,
            "snapshot": snapshot,
            "frame_size": {"w": int(w), "h": int(h)},
            "frame_age_ms": frame_age_ms,
            "detections": out,
            "decision_trace": trace,
            "diag": diag,
            "frame_interval_avg_ms": int(round(ema_ms)) if ema_ms > 0 else 0,
            "decoder_backlog_suspected": bool(backlog),
            "cluster_evidence": cluster_evidence,
        }
    )


def _build_cluster_evidence(tt: dict, cam: dict, obj_filter: set, ema_ms: float) -> dict:
    """Aggregate the per-cam ring buffer into the cluster_evidence
    structure the Debug-tab frontend consumes.

    Prunes events older than ``_EVIDENCE_WINDOW_S`` on every call
    so memory stays bounded. Each cluster gets its own dict; the
    frontend can choose to render the corresponding section or
    skip it if data is empty.
    """
    now = _time.time()
    cutoff = now - _EVIDENCE_WINDOW_S
    # ── Prune ────────────────────────────────────────────────
    events = tt.get("events")
    if events is not None:
        while events and events[0][0] < cutoff:
            events.popleft()
    class_log = tt.get("class_log")
    if class_log is not None:
        while class_log and class_log[0][0] < cutoff:
            class_log.popleft()
    # ── Cluster 1 · track continuity ─────────────────────────
    deaths_60s = 0
    spawns_60s = 0
    reid_successes_60s = 0
    reid_attempts: list[dict] = []
    for ev in events or []:
        _ts, kind, *_ = ev
        if kind == "spawn":
            spawns_60s += 1
        elif kind == "death":
            deaths_60s += 1
        elif kind == "reid":
            reid_successes_60s += 1
    cluster1 = {
        "deaths_60s": deaths_60s,
        "spawns_60s": spawns_60s,
        "reid_attempts_60s": reid_attempts,
        "reid_successes_60s": reid_successes_60s,
    }
    # ── Cluster 2 · per-class counts ─────────────────────────
    per_class: dict[str, dict] = {}
    for _ts, lbl, verdict in class_log or []:
        bucket = per_class.setdefault(lbl, {"raw": 0, "pass": 0, "below": 0})
        bucket["raw"] += 1
        if verdict == "pass":
            bucket["pass"] += 1
        elif verdict == "belowthresh":
            bucket["below"] += 1
    missing = []
    if obj_filter:
        for lbl in obj_filter:
            if lbl not in per_class:
                missing.append(lbl)
    cluster2 = {
        "per_class_60s_counts": per_class,
        "missing_classes_60s": sorted(missing),
    }
    # ── Cluster 3 · off-filter counts ────────────────────────
    off_filter: dict[str, int] = {}
    for _ts, lbl, verdict in class_log or []:
        if verdict == "filtered":
            off_filter[lbl] = off_filter.get(lbl, 0) + 1
    cluster3 = {"off_filter_60s_counts": off_filter}
    # ── Cluster 4 · performance EMAs ─────────────────────────
    runtime = app_state.runtimes.get(cam.get("id", ""))
    sub_fps = 0.0
    main_fps = 0.0
    if runtime is not None:
        sub_fps = float(getattr(runtime, "_sub_fps", 0.0) or 0.0)
        main_fps = float(getattr(runtime, "_main_fps", 0.0) or 0.0)
    cluster4 = {
        "tick_cycle_ema_ms": int(round(ema_ms)) if ema_ms > 0 else 0,
        "dropped_ticks_session": int(tt.get("drops_session") or 0),
        "sub_fps": round(sub_fps, 1),
        "main_fps": round(main_fps, 1),
    }
    # ── Cluster 5 · raw event log ────────────────────────────
    events_list = []
    for ev in events or []:
        ts, kind, tn, lbl, sc, iou, extra = ev
        events_list.append(
            {
                "kind": kind,
                "track_num": tn,
                "label": lbl,
                "score": sc,
                "iou": iou,
                "t_ago_seconds": round(now - ts, 1),
                "extra": extra,
            }
        )
    # Newest first so the frontend log renders top-to-bottom.
    events_list.reverse()
    cluster5 = {"events_60s": events_list}
    return {
        "cluster1": cluster1,
        "cluster2": cluster2,
        "cluster3": cluster3,
        "cluster4": cluster4,
        "cluster5": cluster5,
    }

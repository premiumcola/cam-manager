"""Quality-analysis sidecar for built timelapse mp4s.

Every successful timelapse encode writes a paired ``<mp4>.qa.json``
alongside the video. The sidecar carries playback-side measurements
(decoded from the finished mp4) and an embedded copy of the capture-
side rejection tally from ``_stats.json``, so the GUI pill + the
diag CLI + a copy-paste-back-to-chat report all read from one
machine-readable source of truth.

Public surface — kept narrow so the timelapse build path stays a
straight line:

* ``write_qa_sidecar(out_path, *, declared_fps, frames_dir,
  camera_id, profile_name, validator_profile_used, settings_store)``
  decodes the mp4, computes pHash + duplicate run + freeze clusters,
  reads matching ``_stats.json`` (if any), grades the build, writes
  ``<mp4>.qa.json`` atomically, logs ``[timelapse]`` INFO with the
  grade + top-3 reject reasons, and — when ``settings_store`` is
  provided AND ``timelapse.fps_auto_adjust`` is true AND the rolling
  mean of ``unique_fps / declared_fps`` over the last three
  sidecars for the same ``(camera_id, profile_name)`` drops below
  ``_AUTO_ADJUST_TRIGGER`` — ratchets ``target_fps`` down to the
  nearest sensible bucket and persists additively via ``setdefault``.

* ``read_qa_sidecar(mp4_path)`` returns the parsed dict, or ``None``
  when no sidecar exists (older builds).

The decode pass is single-thread cv2 frame-by-frame; iOS-grade
hardware finishes a 30 s sunrise mp4 in well under a second so a
synchronous run inside ``_write_video`` is fine.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import cv2

from .frame_helpers import hamming_distance, perceptual_hash

log = logging.getLogger(__name__)

# pHash hamming distances — same thresholds the build-side dedup uses
# (frame_helpers/_dedup.py) so the playback-side analysis carries the
# same idea of "what's a duplicate".
_DUP_HAMMING_MAX = 3
_UNIQUE_HAMMING_MIN = 4
# A "freeze cluster" is at least this many consecutive duplicates.
_FREEZE_MIN_RUN = 5

# fps auto-adjust — kicks down to the nearest sensible bucket when the
# rolling unique-fps / declared-fps ratio drops below the trigger.
_AUTO_ADJUST_TRIGGER = 0.60
_AUTO_ADJUST_BUCKETS = (5, 10, 15, 20)
_AUTO_ADJUST_HISTORY = 3  # look back N sidecars per (cam, profile)


# ── Sidecar schema + grade ─────────────────────────────────────────────────
_SCHEMA_VERSION = 1


def _grade(duplicate_ratio: float, unique_fps: float, declared_fps: float) -> str:
    """Three-tier quality grade matching the spec:
       green   if duplicate_ratio < 0.10 AND unique_fps >= 0.8 * declared_fps
       yellow  if duplicate_ratio < 0.25
       red     otherwise
    Declared 0 → forces red, since the build couldn't honour any target.
    """
    if declared_fps <= 0:
        return "red"
    if duplicate_ratio < 0.10 and unique_fps >= 0.8 * declared_fps:
        return "green"
    if duplicate_ratio < 0.25:
        return "yellow"
    return "red"


# ── Decode pass ────────────────────────────────────────────────────────────
def _analyse_playback(mp4_path: Path) -> dict:
    """Decode the mp4 frame-by-frame, compute pHash per frame, count
    unique-vs-previous-unique with hamming > 3, detect freeze clusters
    (≥ 5 consecutive duplicates).

    Returns a partial playback dict — caller folds in declared_fps +
    expected_frames before writing. Empty/unreadable mp4 returns a
    safe-defaults shape so the writer can still emit a sidecar marked
    as red instead of silently skipping."""
    cap = cv2.VideoCapture(str(mp4_path))
    declared = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total <= 0 or declared <= 0:
        cap.release()
        return {
            "duration_s": 0.0,
            "frames_in_file": total,
            "container_fps": round(declared, 3),
            "effective_fps": 0.0,
            "unique_fps": 0.0,
            "duplicate_count": 0,
            "duplicate_ratio": 0.0,
        }
    duration_s = total / declared
    prev_phash = None
    duplicate_count = 0
    unique_count = 0
    # Freeze-cluster bookkeeping — a run of consecutive hamming-≤-3
    # frames starting AFTER the first "anchor" of the run. We record
    # the cluster start index as the LAST unique frame before the run
    # so the playback timeline shows where the freeze visually begins.
    freezes: list[dict] = []
    run_start_anchor: int | None = None
    run_len = 0
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        try:
            ph = perceptual_hash(frame)
        except Exception:
            frame_idx += 1
            prev_phash = None
            continue
        if prev_phash is None:
            unique_count += 1
            prev_phash = ph
            run_start_anchor = frame_idx
            run_len = 0
            frame_idx += 1
            continue
        dist = hamming_distance(prev_phash, ph)
        if dist <= _DUP_HAMMING_MAX:
            duplicate_count += 1
            run_len += 1
            # prev_phash stays — duplicates don't update the reference
            # so a long freeze on the same content keeps registering.
        else:
            # Close the previous run if it crossed the threshold.
            if run_len >= _FREEZE_MIN_RUN and run_start_anchor is not None:
                end_idx = frame_idx - 1
                freezes.append(
                    {
                        "frames": [int(run_start_anchor), int(end_idx)],
                        "playback_s": [
                            round(run_start_anchor / declared, 2),
                            round(end_idx / declared, 2),
                        ],
                        "duration_s": round((end_idx - run_start_anchor) / declared, 2),
                    }
                )
            unique_count += 1
            prev_phash = ph
            run_start_anchor = frame_idx
            run_len = 0
        frame_idx += 1
    # Final run flush — if the clip ends mid-freeze, record it.
    if run_len >= _FREEZE_MIN_RUN and run_start_anchor is not None:
        end_idx = frame_idx - 1
        freezes.append(
            {
                "frames": [int(run_start_anchor), int(end_idx)],
                "playback_s": [round(run_start_anchor / declared, 2), round(end_idx / declared, 2)],
                "duration_s": round((end_idx - run_start_anchor) / declared, 2),
            }
        )
    cap.release()
    if total == 0:
        dup_ratio = 0.0
    else:
        dup_ratio = duplicate_count / total
    effective_fps = total / duration_s if duration_s > 0 else 0.0
    unique_fps = unique_count / duration_s if duration_s > 0 else 0.0
    return {
        "duration_s": round(duration_s, 2),
        "frames_in_file": total,
        "container_fps": round(declared, 3),
        "effective_fps": round(effective_fps, 2),
        "unique_fps": round(unique_fps, 2),
        "duplicate_count": duplicate_count,
        "duplicate_ratio": round(dup_ratio, 3),
        "freezes": freezes,
    }


# ── Capture-side stats embed ───────────────────────────────────────────────
def _load_capture_stats(frames_dir: Path | None) -> dict | None:
    """Read the validator's per-build ``_stats.json`` from the
    capture scratch dir. Returns the parsed dict or None when the
    file is absent — never raises.

    Logs the miss reason at INFO when the file is unreadable so the
    "capture-block leer" forensic from the 2026-05-14 Garten sunset
    can be diagnosed from one log line instead of digging through
    docker output for a missing-flush trail."""
    if frames_dir is None:
        log.info("[timelapse] capture stats missing: frames_dir=None")
        return None
    stats_path = Path(frames_dir) / "_stats.json"
    if not stats_path.exists():
        # Differentiate "scratch dir is gone" from "scratch dir exists
        # but no _stats.json was ever flushed" — both signal a bug but
        # different ones (cleanup race vs capture-loop crash before
        # first flush).
        if Path(frames_dir).exists():
            log.info(
                "[timelapse] capture stats missing: scratch=%s exists "
                "but _stats.json absent — capture loop probably "
                "crashed before any flush() ran",
                frames_dir,
            )
        else:
            log.info(
                "[timelapse] capture stats missing: scratch dir %s "
                "no longer exists — cleanup ran before QA",
                frames_dir,
            )
        return None
    try:
        return json.loads(stats_path.read_text(encoding="utf-8"))
    except Exception as e:
        log.warning("[timelapse] capture stats read failed: %s · %s", stats_path, e)
        return None


# ── Atomic write ───────────────────────────────────────────────────────────
def _atomic_write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# ── Public entry ───────────────────────────────────────────────────────────
def qa_sidecar_path(mp4_path: Path | str) -> Path:
    """Convention: the QA sidecar lives at ``<mp4>.qa.json`` (note the
    full extension chain — NOT replacing .mp4). Keeps it adjacent
    while staying obviously distinct from the existing ``.json``
    metadata sidecar that camera_runtime writes."""
    return Path(str(mp4_path) + ".qa.json")


def read_qa_sidecar(mp4_path: Path | str) -> dict | None:
    p = qa_sidecar_path(mp4_path)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def write_qa_sidecar(
    out_path: Path | str,
    *,
    declared_fps: float,
    target_duration_s: float,
    frames_dir: Path | str | None = None,
    camera_id: str | None = None,
    profile_name: str | None = None,
    validator_profile_used: str | None = None,
    settings_store=None,
) -> dict | None:
    """Decode the just-written mp4, build the QA sidecar payload,
    write atomically, log a single ``[timelapse]`` INFO with the
    grade + top-3 reject reasons, and run the fps auto-adjust pass.
    Returns the written payload or None on failure."""
    out_path = Path(out_path)
    if not out_path.exists():
        log.warning("[timelapse] QA sidecar skipped — mp4 missing: %s", out_path)
        return None
    t0 = time.monotonic()
    playback = _analyse_playback(out_path)
    cap_stats = _load_capture_stats(Path(frames_dir) if frames_dir else None)
    # Capture-side counters + reject reasons. Empty when no _stats.json.
    capture_block: dict = {}
    if cap_stats:
        capture_block = {
            "expected_frames": cap_stats.get("expected_frames"),
            "captured_frames": cap_stats.get("captured_frames"),
            "rejected_frames": cap_stats.get("invalid_frames"),
            "reject_reasons": dict(cap_stats.get("rejected_by_reason") or {}),
            "scene_skips_by_reason": dict(cap_stats.get("scene_skips_by_reason") or {}),
            "validator_profile": cap_stats.get("validator_profile"),
        }
    dup_ratio = float(playback.get("duplicate_ratio") or 0.0)
    unique_fps = float(playback.get("unique_fps") or 0.0)
    grade = _grade(dup_ratio, unique_fps, declared_fps)
    payload = {
        "schema_version": _SCHEMA_VERSION,
        "video": out_path.name,
        "camera_id": camera_id,
        "profile_name": profile_name,
        "build_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "playback": {
            "duration_s": playback.get("duration_s", 0.0),
            "frames_in_file": playback.get("frames_in_file", 0),
            "declared_fps": float(declared_fps),
            "container_fps": playback.get("container_fps", 0.0),
            "effective_fps": playback.get("effective_fps", 0.0),
            "unique_fps": unique_fps,
            "duplicate_count": playback.get("duplicate_count", 0),
            "duplicate_ratio": dup_ratio,
        },
        "capture": capture_block,
        "freezes": playback.get("freezes", []),
        "validator_profile_used": validator_profile_used or capture_block.get("validator_profile"),
        "quality_grade": grade,
        "target_duration_s": float(target_duration_s),
    }
    try:
        _atomic_write_json(qa_sidecar_path(out_path), payload)
    except Exception as e:
        log.warning("[timelapse] QA sidecar write failed: %s · %s", out_path.name, e)
        return None
    # Top-3 reject reasons for the one-line summary.
    reasons = capture_block.get("reject_reasons") or {}
    top3 = sorted(reasons.items(), key=lambda kv: -kv[1])[:3]
    top3_str = ", ".join(f"{k}={v}" for k, v in top3) or "(no _stats.json)"
    log.info(
        "[timelapse] QA %s grade=%s declared=%.0f unique=%.2f dup=%.0f%% "
        "freezes=%d top=[%s] · %s (%.2fs)",
        out_path.name,
        grade,
        declared_fps,
        unique_fps,
        dup_ratio * 100,
        len(payload["freezes"]),
        top3_str,
        camera_id or "?",
        time.monotonic() - t0,
    )
    # fps auto-adjust — only when we have both a settings_store AND
    # a (camera_id, profile_name) pair to scope the rolling history.
    if settings_store is not None and camera_id and profile_name:
        try:
            _maybe_auto_adjust_fps(
                settings_store, out_path, camera_id, profile_name, declared_fps, unique_fps
            )
        except Exception as e:
            log.warning("[timelapse] fps auto-adjust failed: %s", e)
    return payload


# ── fps auto-adjust ────────────────────────────────────────────────────────
def _is_auto_adjust_enabled(settings_store) -> bool:
    """Read ``timelapse.fps_auto_adjust`` (default True) with the
    additive-setdefault pattern so a fresh install lands the default
    once without overwriting a user-set value on subsequent boots."""
    try:
        tl = settings_store.data.setdefault("timelapse", {})
        tl.setdefault("fps_auto_adjust", True)
        return bool(tl.get("fps_auto_adjust", True))
    except Exception:
        return False


def _recent_sidecars_for(profile_dir: Path, profile_name: str, limit: int) -> list[dict]:
    """Scan a camera's timelapse output directory and return the last
    ``limit`` QA sidecars matching ``profile_name``, newest first.

    Skipped silently when ``profile_dir`` doesn't exist (fresh camera)
    or when a sidecar fails to parse."""
    if not profile_dir.exists():
        return []
    out: list[tuple[float, dict]] = []
    for qa_path in profile_dir.glob("*.qa.json"):
        try:
            data = json.loads(qa_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("profile_name") != profile_name:
            continue
        # Sort by file mtime — build_at strings work too but mtime
        # is robust to a clock skew or a manual file copy.
        out.append((qa_path.stat().st_mtime, data))
    out.sort(key=lambda t: -t[0])
    return [d for _, d in out[:limit]]


def _nearest_bucket_at_or_above(measured: float) -> int:
    """Pick the smallest member of ``_AUTO_ADJUST_BUCKETS`` that is
    ≥ ``measured``. Caps at the top bucket — we never auto-adjust
    UP, so the caller will keep its existing target_fps when the
    current value already sits at or below the chosen bucket."""
    for b in _AUTO_ADJUST_BUCKETS:
        if b >= measured:
            return b
    return _AUTO_ADJUST_BUCKETS[-1]


def _maybe_auto_adjust_fps(
    settings_store,
    out_path: Path,
    camera_id: str,
    profile_name: str,
    declared_fps: float,
    unique_fps: float,
) -> None:
    """When the last ``_AUTO_ADJUST_HISTORY`` sidecars for this
    (camera, profile) show a rolling mean unique/declared ratio
    below ``_AUTO_ADJUST_TRIGGER``, ratchet ``target_fps`` down to
    the nearest sensible bucket ≥ the measured rolling unique_fps.
    Only ratchets DOWN; persists additively via setdefault.
    """
    if not _is_auto_adjust_enabled(settings_store):
        return
    profile_dir = out_path.parent
    history = _recent_sidecars_for(profile_dir, profile_name, _AUTO_ADJUST_HISTORY)
    if len(history) < _AUTO_ADJUST_HISTORY:
        # Not enough samples yet — keep the configured fps. The
        # caller's <3-sidecars-no-adjust contract.
        return
    ratios = []
    rolling_unique = []
    for h in history:
        pb = h.get("playback") or {}
        d = float(pb.get("declared_fps") or 0.0)
        u = float(pb.get("unique_fps") or 0.0)
        if d > 0:
            ratios.append(u / d)
            rolling_unique.append(u)
    if not ratios:
        return
    mean_ratio = sum(ratios) / len(ratios)
    if mean_ratio >= _AUTO_ADJUST_TRIGGER:
        return
    target_unique = sum(rolling_unique) / len(rolling_unique)
    new_target = _nearest_bucket_at_or_above(target_unique)
    # Locate the per-camera per-profile slot in settings. Schema
    # convention: ``cameras[N].timelapse_fps_overrides[<profile>]``.
    # Additive — never overwrite an existing override unless it's
    # higher than the new target (ratchet-down only).
    try:
        cams = settings_store.data.get("cameras") or []
        cam_dict = next((c for c in cams if c.get("id") == camera_id), None)
        if cam_dict is None:
            return
        overrides = cam_dict.setdefault("timelapse_fps_overrides", {})
        existing = overrides.get(profile_name)
        if existing is not None and int(existing) <= int(new_target):
            # User already running at or below the suggested bucket —
            # leave alone. Auto-adjust never reverses a manual tighter
            # setting.
            return
        overrides[profile_name] = int(new_target)
        # Persist. The settings store keeps the canonical JSON file
        # in sync via its own atomic-write path; we just need to call
        # save when the API allows it.
        save = getattr(settings_store, "save", None)
        if callable(save):
            save()
        log.warning(
            "[timelapse] auto-adjust cam=%s profile=%s "
            "rolling_ratio=%.2f → target_fps=%d "
            "(measured unique=%.2f, declared=%.0f, history=%d)",
            camera_id,
            profile_name,
            mean_ratio,
            new_target,
            target_unique,
            declared_fps,
            len(history),
        )
    except Exception as e:
        log.warning("[timelapse] auto-adjust persist failed: %s", e)

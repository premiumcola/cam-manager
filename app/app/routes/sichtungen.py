"""Sichtungen — cat / person identity registration + species achievements.

Migrated from server.py during R01.2. The route bodies are byte-for-
byte the originals; references to module-level state in server.py
have been rewritten to flow through `app_state`. Achievement
persistence (`_load_achievements`, `_save_achievements`) lives here
because nothing else in the codebase reads or writes
`achievements.json`.
"""
from __future__ import annotations

import json as _json_mod
import logging
import threading as _threading_mod
from datetime import datetime

import cv2
from flask import Blueprint, jsonify, request

from .. import app_state
from ..cat_identity import IdentityRegistry
from ..storage import _atomic_write_text

bp = Blueprint("sichtungen", __name__)


# ── Cat / person identity ────────────────────────────────────────────────


@bp.get('/api/cats')
def api_cats():
    return jsonify({"profiles": app_state.cat_registry.list_profiles()})


@bp.get('/api/persons')
def api_persons():
    return jsonify({"profiles": app_state.person_registry.list_profiles()})


def _register_identity(registry: IdentityRegistry, cam_id: str, identity_type: str):
    store = app_state.store
    storage_root = app_state.storage_root
    payload = request.get_json(force=True, silent=True) or {}
    event_id = payload.get("event_id")
    name = (payload.get("name") or "").strip()
    whitelisted = bool(payload.get("whitelisted", False))
    notes = payload.get("notes", "")
    if not event_id or not name:
        return jsonify({"ok": False, "error": "event_id und name erforderlich"}), 400
    event = store.get_event(cam_id, event_id)
    if not event:
        return jsonify({"ok": False, "error": "Event nicht gefunden"}), 404
    snap_rel = event.get("snapshot_relpath")
    snap_path = storage_root / snap_rel if snap_rel else None
    if not snap_path or not snap_path.exists():
        return jsonify({"ok": False, "error": "Snapshot-Datei fehlt"}), 404
    img = cv2.imread(str(snap_path))
    if img is None:
        return jsonify({"ok": False, "error": "Snapshot nicht lesbar"}), 400
    det = next((d for d in event.get("detections", []) if d.get("label") == identity_type), None)
    if not det:
        return jsonify({"ok": False, "error": f"Kein {identity_type} in diesem Event"}), 400
    b = det.get("bbox") or {}
    crop = img[max(0, int(b.get("y1", 0))):max(0, int(b.get("y2", 0))), max(0, int(b.get("x1", 0))):max(0, int(b.get("x2", 0)))]
    if crop.size == 0:
        return jsonify({"ok": False, "error": "Crop leer"}), 400
    ok = registry.register_crop(name, crop, whitelisted=whitelisted, notes=notes)
    if ok:
        if identity_type == "cat":
            event["cat_name"] = name
        else:
            event["person_name"] = name
            event["whitelisted"] = whitelisted
        store.update_event(cam_id, event_id, event)
    return jsonify({"ok": bool(ok), "profiles": registry.list_profiles()})


@bp.post('/api/camera/<cam_id>/cats/register')
def api_cat_register(cam_id):
    return _register_identity(app_state.cat_registry, cam_id, "cat")


@bp.post('/api/camera/<cam_id>/persons/register')
def api_person_register(cam_id):
    return _register_identity(app_state.person_registry, cam_id, "person")


@bp.post('/api/persons/<name>/flags')
def api_person_flags(name):
    payload = request.get_json(force=True, silent=True) or {}
    ok = app_state.person_registry.set_profile_flags(
        name,
        whitelisted=payload.get("whitelisted"),
        notes=payload.get("notes"),
    )
    return jsonify({"ok": ok, "profiles": app_state.person_registry.list_profiles()})


# ── Achievements ────────────────────────────────────────────────────────────

_ach_lock = _threading_mod.Lock()


def _ach_path():
    return app_state.storage_root / "achievements.json"


def _load_achievements() -> dict:
    try:
        p = _ach_path()
        if p.exists():
            return _json_mod.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_achievements(data: dict):
    try:
        _atomic_write_text(_ach_path(), _json_mod.dumps(data, ensure_ascii=False, indent=2))
    except Exception as e:
        logging.getLogger(__name__).warning("achievements save: %s", e)


@bp.get('/api/achievements')
def api_achievements_get():
    with _ach_lock:
        data = _load_achievements()
    # Surface the quests block alongside the species map. Existing
    # clients ignore unknown keys, so this is additive — pinned at
    # top-level so the JS doesn't need a second roundtrip.
    return jsonify({"achievements": data, "quests": data.get("quests") or {}})


@bp.post('/api/achievements/quests/reevaluate')
def api_achievements_quests_reevaluate():
    """Manual full re-eval — wired up to the "Re-Eval"-Button in the
    Sichtungen pinboard. Same evaluator that runs hourly in the
    background and after every motion event."""
    from ..quests import reevaluate_and_save
    result = reevaluate_and_save()
    return jsonify(result)


@bp.post('/api/achievements/unlock')
def api_achievements_unlock():
    payload = request.get_json(force=True, silent=True) or {}
    species_id = (payload.get("id") or "").strip().lower()
    if not species_id:
        return jsonify({"ok": False, "error": "id fehlt"}), 400
    with _ach_lock:
        data = _load_achievements()
        already = species_id in data
        if not already:
            data[species_id] = {
                "date": datetime.now().isoformat(timespec="seconds"),
                "camera_id": payload.get("camera_id", ""),
                "species": payload.get("species", species_id),
                "count": 1,
            }
        else:
            data[species_id]["count"] = data[species_id].get("count", 1) + 1
        _save_achievements(data)
    return jsonify({"ok": True, "already_had": already, "achievements": data})


# ── Bird dossiers (F08) ────────────────────────────────────────────────────


@bp.get('/api/bird-dossiers')
def api_bird_dossiers_list():
    svc = app_state.bird_dossiers
    if svc is None:
        return jsonify({"dossiers": []})
    return jsonify({"dossiers": svc.list_dossiers()})


@bp.get('/api/bird-dossiers/<path:latin>')
def api_bird_dossier_detail(latin: str):
    """Single dossier plus the last 10 motion events that featured this
    species. The events are gathered from every camera (a species
    visits multiple cams over time) and sorted by time DESC."""
    svc = app_state.bird_dossiers
    if svc is None:
        return jsonify({"ok": False, "error": "service unavailable"}), 404
    d = svc.get_dossier(latin)
    if not d:
        return jsonify({"ok": False, "error": "not found"}), 404
    store = app_state.store
    settings = app_state.settings
    cams = settings.export_effective_config(app_state.base_cfg).get("cameras", []) or [] if settings else []
    events: list = []
    for cam in cams:
        cam_id = cam.get("id")
        if not cam_id:
            continue
        for ev in store.list_events(cam_id, limit=200, media_only=True):
            for det in ev.get("detections") or []:
                if (det.get("species_latin") or "").strip() == latin:
                    events.append(ev)
                    break
    events.sort(key=lambda e: e.get("time", ""), reverse=True)
    return jsonify({"ok": True, "dossier": d, "events": events[:10]})


@bp.post('/api/bird-dossiers/<path:latin>/refetch')
def api_bird_dossier_refetch(latin: str):
    svc = app_state.bird_dossiers
    if svc is None:
        return jsonify({"ok": False, "error": "service unavailable"}), 404
    started = svc.refetch_dossier(latin)
    if not started:
        return jsonify({"ok": False, "error": "not found"}), 404
    return jsonify({"ok": True, "queued": True})


@bp.get('/api/achievements/<species_id>/media')
def api_achievements_media(species_id: str):
    """All media events for a species, across every camera. The species
    is identified by its achievement ID (e.g. "gruenfink"); we walk the
    camera_runtime._SPECIES_TO_ACH_ID reverse-map to find every German
    variant that collapses into that ID ("Grünfink" / "Gruenfink") and
    union the results."""
    from ..camera_runtime import _SPECIES_TO_ACH_ID
    settings = app_state.settings
    store = app_state.store
    sid = (species_id or "").strip().lower()
    # Collect every species-name key that maps to this achievement ID
    name_variants = {name for name, ach in _SPECIES_TO_ACH_ID.items() if ach == sid}
    if not name_variants:
        return jsonify({"items": [], "total_count": 0})
    # Flask's type=int returns None on parse failure → fall through
    # to the legacy default. No more try/except wrappers needed.
    limit = max(1, request.args.get('limit', type=int) or 24)
    offset = max(0, request.args.get('offset', type=int) or 0)
    cams = app_state.get_effective_config().get("cameras", []) or []
    seen_ids: set[str] = set()
    pool: list = []
    for cam in cams:
        cam_id = cam.get("id")
        if not cam_id:
            continue
        for variant in name_variants:
            # list_events sorts desc by time internally. media_only skips
            # metadata-only entries — the drilldown only wants visible cards.
            for ev in store.list_events(cam_id, bird_species=variant, media_only=True, limit=5000):
                eid = ev.get("event_id")
                if not eid or eid in seen_ids:
                    continue
                seen_ids.add(eid)
                # Attach any stored review so the drilldown matches what the
                # main Mediathek shows for the same event.
                review = settings.get_review(f"{cam_id}:{eid}")
                if review:
                    ev["review"] = review
                pool.append(ev)
    pool.sort(key=lambda x: x.get("time", ""), reverse=True)
    total = len(pool)
    page = pool[offset:offset + limit]
    return jsonify({"items": page, "total_count": total})

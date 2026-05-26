"""Auto-built bird "dossiers" — a personal field guide that grows as
the bird species classifier identifies new species in your garden.

How it grows:
    Every time the bird classifier returns a latin name, the camera
    runtime calls `on_new_species(latin, common_de, event_id, camera_id)`.
    First-ever sighting → a fresh dossier entry plus a background fetch
    of (a) Wikipedia summary + thumbnail, (b) a Xeno-canto audio sample
    with attribution. Subsequent sightings → just a counter bump.

External APIs are deliberately best-effort:
    Network failures and rate-limits never poison the camera pipeline.
    A missed Wikipedia fetch leaves `wikipedia_fetched_at = null` in the
    dossier; the next sighting (or a manual /refetch) tries again. No
    retry loops, no cascading timeouts back into detection.

License compliance:
    Xeno-canto audio is Creative Commons but each recording carries its
    own license (CC-BY, CC-BY-SA, CC-BY-NC, CC0). The dossier MUST store
    `audio_attribution` + `audio_license` and the frontend MUST display
    them next to the player — anything less is a license violation.
    Wikipedia text is CC-BY-SA; the API extract is 2-3 sentences which
    is a fair-use snippet.
"""

from __future__ import annotations

import json as _json_mod
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

log = logging.getLogger("app.bird_dossiers")

# Xeno-canto API v3 requires a per-account `key` parameter (v2 is gone
# as of early 2026). When `XENO_CANTO_API_KEY` is unset, the audio
# fetch is silently skipped — `audio_url` stays None and the frontend
# hides the player. q:A means "Quality A"; len:5-15 picks recordings
# short enough to play inline as MP3 in the modal.
_XC_API_KEY = os.environ.get("XENO_CANTO_API_KEY", "").strip()
_XC_QUERY_TEMPLATE = (
    "https://xeno-canto.org/api/3/recordings" "?query={latin}+q:A+len:5-15&key={key}"
)

# The MediaWiki REST summary endpoint. Returns title, extract, thumbnail,
# content_urls, and a couple of cross-language hints. Works on every
# language wiki — we try DE first, EN as fallback.
_WIKI_SUMMARY_URL_DE = "https://de.wikipedia.org/api/rest_v1/page/summary/{latin}"
_WIKI_SUMMARY_URL_EN = "https://en.wikipedia.org/api/rest_v1/page/summary/{latin}"

_HTTP_TIMEOUT = 5.0
_USER_AGENT = "squirreling-sightings bird-dossier-builder (https://github.com/premiumcola/cam-manager)"

# ── Rate-limit lock ────────────────────────────────────────────────────────
# The spec mandates ≤1 outgoing request/sec to Wikipedia + Xeno-canto.
# A single global lock + a "next allowed slot" timestamp is the simplest
# bound: every fetch grabs the lock, sleeps until the slot opens, fires
# its request, then sets the next slot to now+1 s. Multiple species
# detected in the same minute serialise behind this; nothing is dropped.
_rate_lock = threading.Lock()
_next_request_slot = [0.0]


# Re-export from the shared helper so the single internal callers
# (this module and any future ones) all land on one implementation.
from .io_utils import atomic_write_json as _atomic_write_json  # noqa: F401


def _rate_limited_get(url: str) -> dict | None:
    """GET `url`, return parsed JSON or None on any failure (404, timeout,
    network error, malformed JSON). Never raises. Caller is expected to
    treat None as "fetch failed, try again later"."""
    import urllib.request as _ur

    with _rate_lock:
        sleep_for = max(0.0, _next_request_slot[0] - time.time())
        if sleep_for > 0:
            time.sleep(sleep_for)
        _next_request_slot[0] = time.time() + 1.0
    try:
        req = _ur.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
        with _ur.urlopen(req, timeout=_HTTP_TIMEOUT) as r:
            if r.status >= 400:
                return None
            return _json_mod.loads(r.read().decode("utf-8", errors="replace"))
    except Exception as e:
        log.debug("[dossiers] GET %s failed: %s", url, e)
        return None


def _strip_subspecies(latin: str) -> str:
    """Drop the third name in a trinomial — "Erithacus rubecula rubecula"
    → "Erithacus rubecula". Wikipedia normally indexes species at the
    binomial, so the trinomial 404s but the binomial fallback hits.
    Returns the input unchanged when it isn't a trinomial."""
    parts = latin.split()
    return f"{parts[0]} {parts[1]}" if len(parts) >= 3 else latin


def _fetch_wikipedia(latin: str) -> dict | None:
    """Try DE summary first, EN fallback, subspecies-stripped fallback.

    Returns None when all three lookups fail. The caller stores None
    fields rather than the literal None — see _apply_wikipedia."""
    candidates = [latin]
    stripped = _strip_subspecies(latin)
    if stripped != latin:
        candidates.append(stripped)
    for cand in candidates:
        for url_tmpl in (_WIKI_SUMMARY_URL_DE, _WIKI_SUMMARY_URL_EN):
            url = url_tmpl.format(latin=quote(cand))
            data = _rate_limited_get(url)
            if not data:
                continue
            if data.get("type") == "disambiguation":
                continue
            extract = data.get("extract") or ""
            if not extract.strip():
                continue
            return data
    return None


# Map xeno-canto English call-type strings to a short German caption.
# Keys are matched case-insensitively via substring search; the order
# matters because longer keys must be tested before shorter ones
# they could collide with — "flight call" must win over "call",
# "alarm call" over "call". Unrecognised types fall back to the raw
# string capitalised — better than nothing.
_XC_TYPE_DE: dict[str, str] = {
    "flight call": "Flugruf",
    "alarm call": "Warnruf",
    "begging call": "Bettelruf",
    "alarm": "Warnruf",
    "begging": "Bettelruf",
    "subsong": "Subgesang",
    "song": "Gesang",
    "drumming": "Trommeln",
    "duet": "Duett",
    "wing": "Flügelschlag",
    "call": "Ruf",
}


def _de_type(raw: str | None) -> str:
    """Translate an xeno-canto call-type string to a short German caption."""
    if not raw:
        return "Aufnahme"
    s = raw.lower().strip()
    for k, v in _XC_TYPE_DE.items():
        if k in s:
            return v
    return raw.strip().capitalize() or "Aufnahme"


def _fetch_xeno_canto(latin: str, max_recordings: int = 3) -> list[dict]:
    """Pull up to `max_recordings` quality-A 5-15 s clips for the species.

    Returns a list of recording dicts (`id`, `file_url`, `type_en`,
    `type_de`, `recordist`, `license_url`, `length`). Empty list when
    no recordings are available — typical for rare or recently-named
    species — OR when no API key is configured. Both cases let the
    frontend hide the audio block.

    Subspecies fallback mirrors the Wikipedia path. The picker prefers
    a diverse set of call types when available (one Gesang + one Ruf
    + one Warnruf reads better than three Gesänge), then fills the
    remaining slots in API order.
    """
    if not _XC_API_KEY:
        return []
    candidates = [latin]
    stripped = _strip_subspecies(latin)
    if stripped != latin:
        candidates.append(stripped)
    for cand in candidates:
        url = _XC_QUERY_TEMPLATE.format(latin=quote(cand), key=_XC_API_KEY)
        data = _rate_limited_get(url)
        if not data:
            continue
        recordings = data.get("recordings") or []
        if not recordings:
            continue
        # Diversity-first picker: walk the list and prefer a new type
        # each round; when we run out of new types, fall back to API
        # order to fill remaining slots.
        seen_types: set[str] = set()
        first_pass: list[dict] = []
        leftover: list[dict] = []
        for rec in recordings:
            type_de = _de_type(rec.get("type"))
            if type_de in seen_types:
                leftover.append(rec)
                continue
            seen_types.add(type_de)
            first_pass.append(rec)
            if len(first_pass) >= max_recordings:
                break
        picked = first_pass
        for rec in leftover:
            if len(picked) >= max_recordings:
                break
            picked.append(rec)
        out: list[dict] = []
        for rec in picked:
            file_url = rec.get("file") or ""
            if file_url.startswith("//"):
                file_url = "https:" + file_url
            if not file_url:
                continue
            out.append(
                {
                    "id": str(rec.get("id") or "").strip() or None,
                    "file_url": file_url,
                    "type_en": rec.get("type") or "",
                    "type_de": _de_type(rec.get("type")),
                    "recordist": rec.get("rec") or None,
                    "license_url": rec.get("lic") or None,
                    "length": rec.get("length") or None,
                }
            )
        if out:
            return out
    return []


# ── Service ────────────────────────────────────────────────────────────────
class BirdDossierService:
    """Owns `bird_dossiers.json` plus the background fetcher pool.

    Constructed once at boot in server.py. Camera runtimes call
    `on_new_species` from the motion-finalize hook; the route layer
    reads via `list_dossiers` / `get_dossier` and triggers manual
    refetches via `refetch_dossier`.
    """

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.data = self._load()
        # Background fetches share a single daemon-thread pool. We never
        # join it; pending fetches die with the process. Each fetch is
        # short (≤2× _HTTP_TIMEOUT = 10 s upper bound), so shutdown
        # always sees a small in-flight set.
        self._inflight: set[str] = set()
        self._inflight_lock = threading.Lock()

    def _load(self) -> dict:
        if not self.path.exists():
            return {"schema": 1, "dossiers": {}}
        try:
            d = _json_mod.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(d, dict):
                return {"schema": 1, "dossiers": {}}
            d.setdefault("schema", 1)
            d.setdefault("dossiers", {})
            return d
        except Exception as e:
            log.warning("[dossiers] load failed (%s) — starting empty", e)
            return {"schema": 1, "dossiers": {}}

    def _save_locked(self) -> None:
        """Persist self.data. Caller holds self._lock."""
        try:
            _atomic_write_json(self.path, self.data)
        except Exception as e:
            log.warning("[dossiers] save failed: %s", e)

    # ── Public API ─────────────────────────────────────────────────────
    def on_new_species(
        self, latin: str, common_de: str | None, event_id: str, camera_id: str
    ) -> bool:
        """Hook called by the bird classifier on every successful ID.

        Returns True if a new dossier was created (first sighting),
        False if it just bumped the counter. Never raises.
        """
        if not latin:
            return False
        latin = latin.strip()
        with self._lock:
            existing = self.data["dossiers"].get(latin)
            if existing is not None:
                existing["sighting_count"] = int(existing.get("sighting_count", 0)) + 1
                self._save_locked()
                return False
            now_iso = datetime.now().isoformat(timespec="seconds")
            self.data["dossiers"][latin] = {
                "common_name_de": common_de,
                "common_name_en": None,
                "latin": latin,
                "first_seen_at": now_iso,
                "first_seen_event_id": event_id,
                "first_seen_camera_id": camera_id,
                "sighting_count": 1,
                "wikipedia_summary": None,
                "wikipedia_url": None,
                "wikipedia_thumb_url": None,
                "wikipedia_fetched_at": None,
                # Multi-clip xeno-canto store. Each entry carries id /
                # file_url / type_en / type_de / recordist / license_url /
                # length so the frontend can render a labelled <audio>
                # row per clip and the cache check can skip refetch on
                # subsequent views. The legacy single-clip fields below
                # mirror recordings[0] for backward-compat with older
                # dossier consumers; the frontend prefers `recordings`.
                "recordings": [],
                "audio_url": None,
                "audio_attribution": None,
                "audio_license": None,
                "audio_fetched_at": None,
                "wiki_distribution_thumb": None,
            }
            self._save_locked()
        log.info("[dossiers] new species: %s (%s) — fetching", latin, common_de or "?")
        self._spawn_fetch(latin)
        return True

    def increment_sighting(self, latin: str) -> None:
        """Bump the counter without going through the new-species path.
        Use when you already know the dossier exists."""
        if not latin:
            return
        with self._lock:
            d = self.data["dossiers"].get(latin)
            if d is None:
                return
            d["sighting_count"] = int(d.get("sighting_count", 0)) + 1
            self._save_locked()

    def get_dossier(self, latin: str) -> dict | None:
        with self._lock:
            d = self.data["dossiers"].get(latin)
            return dict(d) if d else None

    def list_dossiers(self) -> list[dict]:
        """Newest-first list. Keys with no first_seen_at sink to the end."""
        with self._lock:
            items = list(self.data["dossiers"].values())
        items.sort(key=lambda d: d.get("first_seen_at") or "", reverse=True)
        return [dict(d) for d in items]

    def refetch_dossier(self, latin: str) -> bool:
        """Manual re-fetch trigger from the API. Returns True if a fetch
        was started, False if the dossier doesn't exist."""
        with self._lock:
            if latin not in self.data["dossiers"]:
                return False
        self._spawn_fetch(latin)
        return True

    # ── Background fetcher ─────────────────────────────────────────────
    def _spawn_fetch(self, latin: str) -> None:
        """Start a daemon thread for the Wiki + xeno-canto fetch unless
        one is already in flight for this latin name."""
        with self._inflight_lock:
            if latin in self._inflight:
                return
            self._inflight.add(latin)
        threading.Thread(target=self._fetch_worker, args=(latin,), daemon=True).start()

    def _fetch_worker(self, latin: str) -> None:
        try:
            self._fetch_and_apply(latin)
        finally:
            with self._inflight_lock:
                self._inflight.discard(latin)

    def _fetch_and_apply(self, latin: str) -> None:
        wiki = _fetch_wikipedia(latin)
        # Cache check: if recordings are already populated, skip the
        # xeno-canto round-trip. The frontend's "open dossier" path
        # ends up here whenever a fresh species is detected; for known
        # species we keep the cached clips instead of re-pulling.
        with self._lock:
            d_existing = self.data["dossiers"].get(latin)
            already_have_audio = bool(d_existing and d_existing.get("recordings"))
        recordings = [] if already_have_audio else _fetch_xeno_canto(latin)
        now_iso = datetime.now().isoformat(timespec="seconds")
        with self._lock:
            d = self.data["dossiers"].get(latin)
            if d is None:
                return
            self._apply_wikipedia(d, wiki, now_iso)
            if not already_have_audio:
                self._apply_xeno_canto(d, recordings, now_iso)
            self._save_locked()
        log.info(
            "[dossiers] fetched %s — wiki=%s xc=%s",
            latin,
            "ok" if wiki else "miss",
            f"{len(recordings)} clips"
            if recordings
            else ("cached" if already_have_audio else "miss"),
        )

    @staticmethod
    def _apply_wikipedia(dossier: dict, wiki: dict | None, now_iso: str) -> None:
        """Merge a successful Wikipedia summary into the dossier dict.

        On miss: leave wikipedia_fetched_at NULL so a future trigger
        retries (the spec's "Indikator dass der Fetch noch aussteht").
        """
        if not wiki:
            return
        thumb = (wiki.get("thumbnail") or {}).get("source")
        page_url = ((wiki.get("content_urls") or {}).get("desktop") or {}).get("page")
        dossier["wikipedia_summary"] = wiki.get("extract") or None
        dossier["wikipedia_url"] = page_url or None
        dossier["wikipedia_thumb_url"] = thumb or None
        dossier["wikipedia_fetched_at"] = now_iso
        # Title is normally the German common name when the DE wiki hit;
        # use it to backfill common_name_de if the classifier didn't
        # provide one (rare path, but happens for genus-only matches).
        if not dossier.get("common_name_de") and wiki.get("title"):
            dossier["common_name_de"] = wiki.get("title")

    @staticmethod
    def _apply_xeno_canto(dossier: dict, recordings: list, now_iso: str) -> None:
        """Merge xeno-canto recordings into the dossier.

        `recordings` is a list of dicts (see _fetch_xeno_canto). Stored
        on `dossier["recordings"]` directly; the legacy single-clip
        fields (`audio_url` / `audio_attribution` / `audio_license`)
        mirror the first entry for backward-compat with older
        consumers but the frontend prefers iterating `recordings[]`.
        """
        if not recordings:
            return
        dossier["recordings"] = recordings
        dossier["audio_fetched_at"] = now_iso
        # Legacy mirror — keeps any older code path that still reads
        # the single-clip fields working without a coordinated change.
        head = recordings[0]
        dossier["audio_url"] = head.get("file_url")
        dossier["audio_attribution"] = head.get("recordist")
        dossier["audio_license"] = head.get("license_url")

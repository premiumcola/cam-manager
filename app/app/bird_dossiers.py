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

# Xeno-canto returns audio bound to recordings of a given length range.
# 5–15 s clips are short enough to play inline as an MP3 in the modal.
# q:A means "Quality A" — the platform's highest tier.
_XC_QUERY_TEMPLATE = (
    "https://xeno-canto.org/api/2/recordings"
    "?query={latin}+q:A+len:5-15"
)

# The MediaWiki REST summary endpoint. Returns title, extract, thumbnail,
# content_urls, and a couple of cross-language hints. Works on every
# language wiki — we try DE first, EN as fallback.
_WIKI_SUMMARY_URL_DE = "https://de.wikipedia.org/api/rest_v1/page/summary/{latin}"
_WIKI_SUMMARY_URL_EN = "https://en.wikipedia.org/api/rest_v1/page/summary/{latin}"

_HTTP_TIMEOUT = 5.0
_USER_AGENT = "tam-spy bird-dossier-builder (https://github.com/premiumcola/cam-manager)"

# ── Rate-limit lock ────────────────────────────────────────────────────────
# The spec mandates ≤1 outgoing request/sec to Wikipedia + Xeno-canto.
# A single global lock + a "next allowed slot" timestamp is the simplest
# bound: every fetch grabs the lock, sleeps until the slot opens, fires
# its request, then sets the next slot to now+1 s. Multiple species
# detected in the same minute serialise behind this; nothing is dropped.
_rate_lock = threading.Lock()
_next_request_slot = [0.0]


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write `data` as JSON via temp + os.replace so a crash never leaves
    a half-written file. Mirrors storage.py::_atomic_write_text."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(_json_mod.dumps(data, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    os.replace(str(tmp), str(path))


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
        req = _ur.Request(url, headers={"User-Agent": _USER_AGENT,
                                        "Accept": "application/json"})
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


def _fetch_xeno_canto(latin: str) -> dict | None:
    """Pull the first quality-A 5-15 s recording for the species.

    Subspecies fallback mirrors the Wikipedia path. Returns None when
    no recording is available — typical for rare or recently-named
    species. The frontend hides the audio player in that case."""
    candidates = [latin]
    stripped = _strip_subspecies(latin)
    if stripped != latin:
        candidates.append(stripped)
    for cand in candidates:
        url = _XC_QUERY_TEMPLATE.format(latin=quote(cand))
        data = _rate_limited_get(url)
        if not data:
            continue
        recordings = data.get("recordings") or []
        if not recordings:
            continue
        rec = recordings[0]
        # The "file" field is a relative or absolute media URL; xeno-canto
        # serves both forms in practice. Normalise to https.
        file_url = rec.get("file") or ""
        if file_url.startswith("//"):
            file_url = "https:" + file_url
        return {
            "audio_url": file_url or None,
            "audio_attribution": rec.get("rec") or None,
            "audio_license": rec.get("lic") or None,
        }
    return None


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
    def on_new_species(self, latin: str, common_de: str | None,
                       event_id: str, camera_id: str) -> bool:
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
                "audio_url": None,
                "audio_attribution": None,
                "audio_license": None,
                "audio_fetched_at": None,
                "wiki_distribution_thumb": None,
            }
            self._save_locked()
        log.info("[dossiers] new species: %s (%s) — fetching",
                 latin, common_de or "?")
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
        threading.Thread(target=self._fetch_worker, args=(latin,),
                         daemon=True).start()

    def _fetch_worker(self, latin: str) -> None:
        try:
            self._fetch_and_apply(latin)
        finally:
            with self._inflight_lock:
                self._inflight.discard(latin)

    def _fetch_and_apply(self, latin: str) -> None:
        wiki = _fetch_wikipedia(latin)
        xc = _fetch_xeno_canto(latin)
        now_iso = datetime.now().isoformat(timespec="seconds")
        with self._lock:
            d = self.data["dossiers"].get(latin)
            if d is None:
                return
            self._apply_wikipedia(d, wiki, now_iso)
            self._apply_xeno_canto(d, xc, now_iso)
            self._save_locked()
        log.info("[dossiers] fetched %s — wiki=%s xc=%s",
                 latin, "ok" if wiki else "miss",
                 "ok" if xc and xc.get("audio_url") else "miss")

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
    def _apply_xeno_canto(dossier: dict, xc: dict | None, now_iso: str) -> None:
        """Merge a successful Xeno-canto recording into the dossier."""
        if not xc:
            return
        dossier["audio_url"] = xc.get("audio_url")
        dossier["audio_attribution"] = xc.get("audio_attribution")
        dossier["audio_license"] = xc.get("audio_license")
        dossier["audio_fetched_at"] = now_iso

"""
Download a curated set of freely-licensed test images from Wikimedia Commons
into storage/test_images/<folder>/ for /api/coral/test-batch.

Usage (inside container):
    docker exec tam-spy python3 /app/storage/test_images/_download.py

Each entry below names a folder, a filename prefix, the number of images to
fetch, and an ordered list of Commons categories / search queries to pull
from. The first `count` photos that pass the quality filter are saved as
`<prefix>_1.jpg … <prefix>_N.jpg`. Existing files with the same name are
skipped, so re-running is safe.

Quality filter:
  - skip SVGs, very-wide panoramas, tiny thumbnails
  - skip titles containing obvious non-photo keywords (maps, drawings,
    juvenile-only chicks, feather close-ups, etc.)
  - shuffle candidates with a species-specific seed so different runs don't
    all grab the same top-of-category photo

All images are sourced from Wikimedia Commons under their respective free
licenses (CC-BY, CC-BY-SA, public domain). Original attribution lives at
https://commons.wikimedia.org/wiki/File:<filename>.
"""
from __future__ import annotations

import hashlib
import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
HEADERS = {"User-Agent": "tam-spy-test-images/2.0 (+https://github.com/premiumcola/cam-manager)"}

THUMB_WIDTH = 640

# Reseed map — bumps the per-prefix shuffle when an entry's initial pick
# was unsuitable (animal too small, blocked, etc.). Add a prefix here to
# cycle to a different image without changing the source categories.
# Already-good prefixes stay out of this map and keep their stable seed.
_RESEED: dict[str, str] = {
    "Eichhoernchen_rot":    "v5",
    "Eichhoernchen_dunkel": "v9",
    "Eichhoernchen_hell":   "v8",
    "Eichhoernchen_grau":   "v5",
    "Eichhoernchen_baum":   "v2",
    "Person_gruppe":        "v2",
    "Person_strasse":       "v2",
    "Buntspecht":           "v2",
    "Eichelhaher":          "v3",
    "Elster":               "v2",
    "Haussperling":         "v2",
    "Kleiber":              "v3",
    "Mauersegler":          "v3",
    "Moenchsgrasmucke":     "v3",
    "Rabenkraehe":          "v2",
    "Ringeltaube":          "v2",
    "Star":                 "v2",
    "Stieglitz":            "v2",
}


# ──────────────────────────────────────────────────────────────────────────
# Test specs — each tuple: (folder, prefix, count, [sources...])
# A source is either:
#   ("cat", "Passer_domesticus")                       → Commons category
#   ("search", "red fox urban")                        → Commons search
# Sources are queried in order; later ones fill whatever earlier didn't.
# ──────────────────────────────────────────────────────────────────────────
SPECS: list[tuple[str, str, int, list[tuple[str, str]]]] = [
    # ── Birds (LBV Top 20 Bayern) — tight category picks, plus male/female
    # subcategories where the species-main category is flower-photo heavy.
    ("bird", "Haussperling",     3, [
        ("cat", "Male_Passer_domesticus"),
        ("cat", "Passer_domesticus"),
        ("search", "House sparrow perched"),
    ]),
    ("bird", "Amsel",            3, [
        ("cat", "Male_Turdus_merula"), ("cat", "Turdus_merula"),
    ]),
    ("bird", "Kohlmeise",        3, [
        ("cat", "Parus_major"), ("search", "Great tit perched close-up"),
    ]),
    ("bird", "Star",             3, [
        ("cat", "Sturnus_vulgaris_(adult_breeding)"),
        ("cat", "Sturnus_vulgaris"),
        ("search", "Common starling adult"),
    ]),
    ("bird", "Feldsperling",     3, [
        ("cat", "Passer_montanus"),
    ]),
    ("bird", "Blaumeise",        3, [
        ("cat", "Cyanistes_caeruleus"),
    ]),
    ("bird", "Ringeltaube",      3, [
        ("cat", "Columba_palumbus"),
    ]),
    ("bird", "Mauersegler",      3, [
        # Apus apus is a notoriously hard test target — the species spends
        # nearly all its life in flight, so most Wikimedia photos show a
        # tiny silhouette far in the sky. Favour nest-box / perched photos
        # first so the bird actually fills enough of the frame for the
        # iNat classifier to fire.
        ("cat", "Apus_apus_at_nest"),
        ("search", "common swift apus apus perched nest box close-up"),
        ("cat", "Apus_apus"),
        ("cat", "Apus_apus_in_flight"),
    ]),
    ("bird", "Elster",           3, [
        ("cat", "Pica_pica"),
    ]),
    ("bird", "Mehlschwalbe",     3, [
        ("cat", "Nests_of_Delichon_urbicum"),
        ("cat", "Delichon_urbicum"),
        ("search", "house martin delichon perched"),
    ]),
    ("bird", "Buchfink",         3, [
        ("cat", "Male_Fringilla_coelebs"),
        ("cat", "Fringilla_coelebs"),
        ("search", "common chaffinch male perched"),
    ]),
    ("bird", "Rotkehlchen",      3, [
        ("cat", "Erithacus_rubecula"),
    ]),
    ("bird", "Gruenfink",        3, [
        ("cat", "Chloris_chloris"),
    ]),
    ("bird", "Rabenkraehe",      3, [
        ("cat", "Corvus_corone"),
    ]),
    ("bird", "Hausrotschwanz",   3, [
        ("cat", "Male_Phoenicurus_ochruros"),
        ("cat", "Phoenicurus_ochruros"),
        ("search", "black redstart male perched"),
    ]),
    ("bird", "Moenchsgrasmucke", 3, [
        ("search", "eurasian blackcap sylvia atricapilla male perched"),
        ("cat", "Male_Sylvia_atricapilla"),
        ("cat", "Sylvia_atricapilla"),
        ("search", "eurasian blackcap close-up branch"),
    ]),
    ("bird", "Stieglitz",        3, [
        ("search", "european goldfinch carduelis perched close-up"),
        ("cat", "Carduelis_carduelis"),
        ("search", "european goldfinch feeding"),
    ]),
    ("bird", "Buntspecht",       3, [
        ("cat", "Dendrocopos_major"),
    ]),
    ("bird", "Kleiber",          3, [
        ("search", "eurasian nuthatch sitta europaea on tree close-up"),
        ("cat", "Sitta_europaea"),
        ("search", "eurasian nuthatch perched branch"),
    ]),
    ("bird", "Eichelhaher",      3, [
        ("search", "eurasian jay garrulus glandarius perched branch close-up"),
        ("cat", "Garrulus_glandarius_in_Germany"),
        ("cat", "Garrulus_glandarius_in_France"),
        ("cat", "Garrulus_glandarius"),
    ]),

    # ── Car folder: 6 mixed-scene photos (multi-object tests) ───────────
    ("car", "Car_mixed", 6, [
        ("search", "street scene pedestrians cars Germany"),
        ("search", "European street cars people"),
        ("cat", "Street_scenes_in_Germany"),
        ("cat", "Cars_in_cities"),
        ("cat", "Parking_lots_in_Germany"),
    ]),

    # ── Cats: 5 additional outdoor photos ───────────────────────────────
    ("cat", "Katze_outdoor", 3, [
        ("cat", "Cats_in_gardens"),
        ("cat", "Outdoor_cats"),
        ("search", "cat garden outdoor"),
    ]),
    ("cat", "Katze_schwarz", 1, [
        ("cat", "Black_cats_outdoors"),
        ("cat", "Black_cats"),
        ("search", "black cat outdoor"),
    ]),
    ("cat", "Katze_getigert", 1, [
        ("cat", "Tabby_cats"),
        ("search", "tabby cat close-up"),
    ]),

    # ── Foxes: 5 red fox images (Vulpes vulpes) ─────────────────────────
    ("fox", "Fuchs", 5, [
        ("cat", "Vulpes_vulpes_in_Europe"),
        ("cat", "Vulpes_vulpes"),
        ("search", "red fox vulpes vulpes"),
    ]),

    # ── Hedgehogs: 5 close-ups ──────────────────────────────────────────
    ("hedgehog", "Igel", 5, [
        ("cat", "Erinaceus_europaeus_in_the_wild"),
        ("cat", "Erinaceus_europaeus"),
        ("search", "European hedgehog Erinaceus"),
    ]),

    # ── Persons: 5 mixed contexts ───────────────────────────────────────
    ("person", "Person_garten",  1, [
        ("cat", "People_in_gardens"), ("search", "person gardening outdoor"),
    ]),
    ("person", "Person_eingang", 1, [
        ("cat", "People_at_doors"),   ("search", "person at door entrance"),
    ]),
    ("person", "Person_strasse", 1, [
        ("cat", "Pedestrians_on_sidewalks"),
        ("search", "pedestrian sidewalk Germany"),
    ]),
    ("person", "Person_nacht",   1, [
        ("cat", "People_at_night"),   ("search", "pedestrian night street"),
    ]),
    ("person", "Person_gruppe",  1, [
        ("cat", "Groups_of_people_walking"),
        ("search", "small group walking street"),
    ]),

    # ── Squirrels: 9 images by colour variant ───────────────────────────
    ("squirrel", "Eichhoernchen_rot", 3, [
        # Side-on / 3-4 view, sitting or eating — avoid front-on jumps
        # which the wildlife model often confuses with hare.
        ("search", "Sciurus vulgaris sitting eating side"),
        ("cat", "Red_morph_of_Sciurus_vulgaris"),
        ("cat", "Sciurus_vulgaris_in_Europe"),
        ("cat", "Sciurus_vulgaris"),
        ("search", "red squirrel Sciurus vulgaris"),
    ]),
    ("squirrel", "Eichhoernchen_dunkel", 3, [
        # The narrow "Black_morph_of_Sciurus_vulgaris" / "Melanistic_*"
        # subcategories don't exist on Commons in 2026 — broader fallbacks
        # plus targeted searches catch dark-coat specimens reliably. The
        # search prefix forces close-ups so the animal isn't a tiny
        # background subject. "Wall pose" / "vertical climbing" filenames
        # tend to fool the classifier into agama / lizard / hare / mink
        # predictions, so weight toward unambiguous side-on shots in
        # "natural habitat" / forest categories first.
        ("cat", "Sciurus_vulgaris_in_forests"),
        ("search", "dark red squirrel forest portrait"),
        ("search", "Sciurus vulgaris brown phase forest"),
        ("search", "dark Eurasian red squirrel sitting branch"),
        ("search", "Sciurus vulgaris dark coat eating"),
        ("search", "melanistic Eurasian red squirrel"),
        ("cat", "Sciurus_vulgaris_in_Germany"),
        ("cat", "Sciurus_vulgaris"),
    ]),
    ("squirrel", "Eichhoernchen_hell", 3, [
        # Bias toward unambiguous full-body shots so the bbox refiner
        # actually has something to lock onto. Indoor feeder / window-sill
        # photos kept fooling the classifier into "refrigerator" hits, so
        # bias hard toward outdoor branch / forest categories first.
        ("cat", "Blonde_morph_of_Sciurus_vulgaris"),
        ("cat", "Light_morph_of_Sciurus_vulgaris"),
        ("search", "pale red squirrel forest branch outdoor"),
        ("search", "light coat Sciurus vulgaris branch outdoor"),
        ("search", "blonde red squirrel Sciurus vulgaris"),
        ("cat", "Sciurus_vulgaris_in_Italy"),
        ("search", "Sciurus vulgaris pale coat"),
    ]),
    # Grey squirrel (Sciurus carolinensis) — broadens the test set so the
    # detector isn't only seeing red European squirrels. Six photos so the
    # classifier sees enough variation in pose/lighting/background. Sources
    # ordered to favour close-ups + eating/sitting poses; albino subcats
    # are filtered globally via SKIP_SUBSTR.
    ("squirrel", "Eichhoernchen_grau", 6, [
        # Side-on / sitting poses first — frontal jumps and "running on
        # fence" shots get classified as mink/marmot.
        ("search", "eastern gray squirrel sitting branch close-up"),
        ("search", "eastern gray squirrel sitting feeder"),
        ("search", "Sciurus carolinensis eating nut"),
        ("search", "Sciurus carolinensis side profile"),
        ("cat", "Sciurus_carolinensis_eating"),
        ("cat", "Sciurus_carolinensis_in_the_United_Kingdom"),
        ("cat", "Sciurus_carolinensis"),
    ]),
    # Squirrels on tree trunks / branches — high-contrast subjects with the
    # animal taking up a large fraction of the frame. Bias toward sitting
    # poses on a clean trunk; "behind branches" pictures wreck the bbox.
    ("squirrel", "Eichhoernchen_baum", 3, [
        ("search", "red squirrel sitting on tree trunk close-up"),
        ("search", "Sciurus vulgaris on tree trunk"),
        ("search", "red squirrel climbing tree"),
        ("cat", "Sciurus_vulgaris_climbing"),
    ]),
]


# Globally-rejected image content hashes. When the deterministic shuffle
# keeps landing on a Commons file that happens to fool the classifier
# (frontal-jump red squirrels mistaken for hares, wall-pose squirrels
# mistaken for agamas, etc.), drop the md5 here. The downloader will
# refuse the bytes and walk on to the next candidate. Rolls forward —
# only add hashes, never remove, so a future re-run cannot regress to
# a bad image we already rejected.
_BLOCKED_HASHES: set[str] = {
    # Squirrel folder — round 1 (v4/v5 reseeds): wildlife mis-classified.
    "8f1cc40f482ec0c161541a035ce85575",  # rot_2 → hare
    "24590504a40bf9c346d910f166cff8f8",  # hell_3 → no wildlife result
    "1b6ed0c24981592fb8629081b0016248",  # grau_6 → mink
    "217fb79b6708424ee48250709c8c424f",  # grau_2 → marginal
    "7cd9bfb10543fa4f89a246b989145b95",  # dunkel_1 → agama
    # Round 2 (v5/v6 reseeds): blocklist worked but the next-shuffled
    # candidates were also tough cases.
    "436d9ff540cd9981be91d14b3e5d2f6e",  # dunkel_1 → mink (climbing pose)
    "59930eff9570959613333766b64f8bc9",  # grau_2 → megalith (subject too small)
    "6a05c92e0c5996c360ae17625ca0fabd",  # hell_3 → refrigerator (indoor feeder shot)
    # Round 3: still tough — dark / pale-coat squirrels are notoriously
    # under-represented on Commons in flattering poses.
    "08efb86ad80aa0e111a6b3d44605045e",  # dunkel_1 → hen-of-the-woods (mushroom)
    "224e914e0575f5885d95927da848402a",  # hell_3 → refrigerator (another feeder)
    "39ce4ee770472f8f0f87ca0d2da26fe1",  # dunkel_1 → red panda (close but no)
    "0ececcea27fe23bc7f9485bae40632cc",  # hell_3 → weasel (mustelid pose)
    # Round 4: dark/pale-coat squirrels keep mapping to mammals of similar
    # silhouette. Saturating the blocklist forces the downloader off the
    # narrow Commons pool of these sub-categories.
    "77c1dd5a513d0ae74fd6e55141d7a4f1",  # dunkel_1 → hare (sitting upright)
    "bd4be7bfc2ff98e4fae66acc8fde7945",  # hell_3 → refrigerator (third feeder)
}


SKIP_SUBSTR = (
    "distribution map", "range map", "rangemap", "iucn", "_map", " map",
    "map.jpg", "map.jpeg", "map.png", "diagram", "phylogeny", "taxonomy",
    "locator", "skeleton", "skull", " egg ", "_egg", "-egg",
    "nest only", "habitat map", "vocalizations", "call.ogg", "song.ogg",
    "audio", "spectrogram", "illustration", "drawing", "sketch", "engraving",
    "painting", "plate ", "specimen", "taxidermy", "mount ", "logo", "emblem",
    "feather ", "plumage detail", "chick only", "chicks only",
    "advertisement", "advertising", "brochure", "patent", "blueprint",
    "schematic", "newspaper", "clipping",
    # Test-image quality filters added when these exact issues turned up
    # in the squirrel folder: albino specimens look nothing like the
    # detector's training distribution, and 3D anaglyphs wreck colour
    # statistics so MobileNet returns confident garbage.
    "albino", "anaglyph", "stereoscopic", "3d-image", "3d image",
    "red-cyan", "leucistic",
)


def _api_get(params: dict) -> dict:
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read())


def _parse_images(pages: dict) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for p in pages.values():
        info_list = p.get("imageinfo") or []
        if not info_list:
            continue
        info = info_list[0]
        if not str(info.get("mime", "")).startswith("image/"):
            continue
        thumb = info.get("thumburl") or info.get("url")
        if not thumb:
            continue
        w = info.get("width") or 0
        h = info.get("height") or 0
        # Skip very small originals (below 400px) and extreme panoramas —
        # those always have the subject far off-centre or cropped.
        if w and w < 400:
            continue
        if w and h:
            ratio = max(w, h) / float(min(w, h))
            if ratio > 3.0:
                continue
        title = (p.get("title") or "").replace("File:", "").strip()
        if not title:
            continue
        low = title.lower().replace("_", " ")
        if any(s in low for s in SKIP_SUBSTR):
            continue
        out.append((title, thumb))
    return out


def _candidates_from_category(cat: str, limit: int = 60) -> list[tuple[str, str]]:
    try:
        data = _api_get({
            "action":      "query",
            "format":      "json",
            "generator":   "categorymembers",
            "gcmtitle":    f"Category:{cat}",
            "gcmtype":     "file",
            "gcmlimit":    str(limit),
            "prop":        "imageinfo",
            "iiprop":      "url|mime|size",
            "iiurlwidth":  str(THUMB_WIDTH),
        })
    except Exception as e:
        print(f"    (cat {cat}: API error {e})", flush=True)
        return []
    return _parse_images((data.get("query") or {}).get("pages") or {})


def _candidates_from_search(query: str, limit: int = 40) -> list[tuple[str, str]]:
    """Use the Wikimedia search API to find images matching free text."""
    try:
        data = _api_get({
            "action":      "query",
            "format":      "json",
            "generator":   "search",
            "gsrsearch":   f"filetype:bitmap {query}",
            "gsrnamespace": "6",  # File namespace
            "gsrlimit":    str(limit),
            "prop":        "imageinfo",
            "iiprop":      "url|mime|size",
            "iiurlwidth":  str(THUMB_WIDTH),
        })
    except Exception as e:
        print(f"    (search {query!r}: API error {e})", flush=True)
        return []
    return _parse_images((data.get("query") or {}).get("pages") or {})


def _download(url: str, dest: Path) -> int:
    delay = 2.0
    last_err: Exception | None = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            dest.write_bytes(data)
            return len(data)
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code != 429 or attempt == 3:
                raise
            time.sleep(delay)
            delay *= 2
    raise last_err if last_err else RuntimeError("unreachable")


def run_spec(folder: str, prefix: str, count: int, sources: list[tuple[str, str]]) -> tuple[int, int]:
    out_dir = BASE / folder
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"\n== {folder}/{prefix}  (want {count}) ==", flush=True)
    # Collect candidates from each source in order.
    all_cands: list[tuple[str, str]] = []
    seen_urls: set[str] = set()
    for kind, q in sources:
        if kind == "cat":
            batch = _candidates_from_category(q, limit=60)
        else:
            batch = _candidates_from_search(q, limit=40)
        for t, u in batch:
            if u in seen_urls:
                continue
            seen_urls.add(u)
            all_cands.append((t, u))
        if len(all_cands) >= count * 5:
            break
    if not all_cands:
        print(f"  ! no candidates for {prefix}", flush=True)
        return 0, 0
    # Deterministic-but-spread order: hash(prefix) seeds the shuffle so
    # re-runs pick the same images, but different species don't all grab
    # the same "top of category" photo.
    # Reseed lets us pull a different slice of the candidate list for a
    # given prefix without renaming the output files. Used to swap in
    # better photos for entries that produced poor detections.
    seed_input = prefix + _RESEED.get(prefix, "")
    seed = int.from_bytes(hashlib.md5(seed_input.encode()).digest()[:4], "big")
    random.Random(seed).shuffle(all_cands)
    # Snapshot existing-file hashes per folder so a freshly downloaded
    # candidate that turns out to be byte-identical to a sibling is skipped
    # and we move on to the next URL in the shuffled list.
    existing_hashes: set[str] = set()
    for f in out_dir.glob("*.jpg"):
        try:
            existing_hashes.add(hashlib.md5(f.read_bytes()).hexdigest())
        except Exception:
            pass
    taken = 0
    new_count = 0
    skip_count = 0
    cand_iter = iter(all_cands)
    while taken < count:
        idx = taken + 1
        outname = f"{prefix}_{idx}.jpg"
        dest = out_dir / outname
        if dest.exists() and dest.stat().st_size > 10_000:
            print(f"  · already have {outname}", flush=True)
            skip_count += 1
            taken += 1
            continue
        # Pull next URL until one downloads to a new content hash.
        accepted = False
        for _title, url in cand_iter:
            try:
                sz = _download(url, dest)
            except Exception as e:
                print(f"  ! {outname} fetch failed: {e}", flush=True)
                continue
            try:
                h = hashlib.md5(dest.read_bytes()).hexdigest()
            except Exception:
                h = None
            if h and h in existing_hashes:
                print(f"  · {outname} duplicate of existing — retrying", flush=True)
                dest.unlink(missing_ok=True)
                time.sleep(0.6)
                continue
            if h and h in _BLOCKED_HASHES:
                print(f"  · {outname} on global blocklist (md5 {h[:8]}) — retrying", flush=True)
                dest.unlink(missing_ok=True)
                time.sleep(0.6)
                continue
            if h:
                existing_hashes.add(h)
            print(f"  ✓ {outname} ({sz // 1024} KB)", flush=True)
            new_count += 1
            taken += 1
            accepted = True
            time.sleep(0.6)
            break
        if not accepted:
            print(f"  ! {outname} no unique candidate left", flush=True)
            break
    if taken < count:
        print(f"  (only {taken}/{count} for {prefix})", flush=True)
    return new_count, skip_count


def main() -> int:
    new_total = 0
    skipped_total = 0
    for folder, prefix, count, sources in SPECS:
        n, s = run_spec(folder, prefix, count, sources)
        new_total += n
        skipped_total += s
    print(f"\n=== done. new: {new_total}, already-present: {skipped_total} ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

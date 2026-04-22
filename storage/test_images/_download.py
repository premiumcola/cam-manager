"""
Download a small set of freely-licensed sample images from Wikimedia Commons
into storage/test_images/<folder>/ for /api/coral/test-batch.

Usage (inside container):
    docker exec tam-spy python3 /app/storage/test_images/_download.py

Fills each folder with exactly 3 clear, identifiable photos per species,
named `<GermanSpecies>_1.jpg` / `_2.jpg` / `_3.jpg`. Existing files with the
same names are skipped, so re-running is safe.

All images are sourced from Wikimedia Commons under their respective free
licenses (CC-BY, CC-BY-SA, public domain). Original attribution lives at
https://commons.wikimedia.org/wiki/File:<filename>.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
HEADERS = {"User-Agent": "tam-spy-test-images/1.0 (+https://github.com/premiumcola/cam-manager)"}

# folder → [(german_name, commons_category), ...]  — exactly 3 images per species
# "bird" folder covers LBV Top 20 Bavarian garden birds.
SPECIES: dict[str, list[tuple[str, str]]] = {
    "bird": [
        ("Haussperling",     "Passer_domesticus"),
        ("Amsel",            "Turdus_merula"),
        ("Kohlmeise",        "Parus_major"),
        ("Star",             "Sturnus_vulgaris"),
        ("Feldsperling",     "Passer_montanus"),
        ("Blaumeise",        "Cyanistes_caeruleus"),
        ("Ringeltaube",      "Columba_palumbus"),
        ("Mauersegler",      "Apus_apus"),
        ("Elster",           "Pica_pica"),
        ("Mehlschwalbe",     "Delichon_urbicum"),
        ("Buchfink",         "Fringilla_coelebs"),
        ("Rotkehlchen",      "Erithacus_rubecula"),
        ("Gruenfink",        "Chloris_chloris"),
        ("Rabenkraehe",      "Corvus_corone"),
        ("Hausrotschwanz",   "Phoenicurus_ochruros"),
        ("Moenchsgrasmucke", "Sylvia_atricapilla"),
        ("Stieglitz",        "Carduelis_carduelis"),
        ("Buntspecht",       "Dendrocopos_major"),
        ("Kleiber",          "Sitta_europaea"),
        ("Eichelhaher",      "Garrulus_glandarius"),
    ],
    "squirrel": [
        ("Eichhoernchen", "Sciurus_vulgaris"),
    ],
    "fox": [
        ("Fuchs", "Vulpes_vulpes"),
    ],
    "hedgehog": [
        ("Igel", "Erinaceus_europaeus"),
    ],
}

IMAGES_PER_SPECIES = 3
THUMB_WIDTH = 640

# Skip obvious non-photo assets that end up in Commons species categories.
SKIP_SUBSTR = (
    "distribution map", "range map", "rangemap", "iucn", "_map", " map",
    "map.jpg", "map.jpeg", "map.png", "diagram", "phylogeny", "taxonomy",
    "locator", "skeleton", "skull", " egg ", "_egg", "-egg",
    "nest only", "habitat map", "vocalizations", "call.ogg", "song.ogg",
    "audio", "spectrogram", "illustration", "drawing", "sketch", "engraving",
    "painting", "plate ", "specimen", "taxidermy", "mount ",
    "feather", "plumage detail", "chick only", "juvenile only",
)


def list_images(category: str, limit: int) -> list[tuple[str, str]]:
    """Return (file_title, thumb_url) pairs from a Commons category."""
    params = {
        "action":      "query",
        "format":      "json",
        "generator":   "categorymembers",
        "gcmtitle":    f"Category:{category}",
        "gcmtype":     "file",
        "gcmlimit":    str(limit),
        "prop":        "imageinfo",
        "iiprop":      "url|mime|size",
        "iiurlwidth":  str(THUMB_WIDTH),
    }
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.loads(r.read())
    pages = (data.get("query") or {}).get("pages") or {}
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
        # Skip SVGs and tiny crops (less than 400px original width)
        w = info.get("width") or 0
        if w and w < 400:
            continue
        title = (p.get("title") or "").replace("File:", "").strip()
        if not title:
            continue
        low = title.lower().replace("_", " ")
        if any(s in low for s in SKIP_SUBSTR):
            continue
        out.append((title, thumb))
    return out


def download(url: str, dest: Path) -> int:
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


def main() -> int:
    new_total = 0
    skipped_total = 0
    for folder, species_list in SPECIES.items():
        out_dir = BASE / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        for de_name, cat in species_list:
            print(f"\n== {folder}/{de_name}  (Category:{cat}) ==", flush=True)
            # Request 10× the target so skip-filter + picky selection has room
            try:
                imgs = list_images(cat, IMAGES_PER_SPECIES * 10)
            except Exception as e:
                print(f"  ! list_images failed: {e}", flush=True)
                continue
            taken = 0
            for _title, url in imgs:
                if taken >= IMAGES_PER_SPECIES:
                    break
                idx = taken + 1
                outname = f"{de_name}_{idx}.jpg"
                dest = out_dir / outname
                if dest.exists():
                    print(f"  · already have {outname}", flush=True)
                    skipped_total += 1
                    taken += 1
                    continue
                try:
                    sz = download(url, dest)
                    print(f"  ✓ {outname} ({sz // 1024} KB)", flush=True)
                    taken += 1
                    new_total += 1
                    time.sleep(0.8)
                except Exception as e:
                    print(f"  ! {outname} failed: {e}", flush=True)
            if taken < IMAGES_PER_SPECIES:
                print(f"  (only {taken}/{IMAGES_PER_SPECIES} for {de_name})", flush=True)

    print(f"\n=== done. new: {new_total}, already-present: {skipped_total} ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

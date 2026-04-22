"""
Download a small set of freely-licensed sample images from Wikimedia Commons
into storage/test_images/<category>/ for /api/coral/test-batch.

Usage (inside container):
    docker exec tam-spy python3 /app/storage/test_images/_download.py

The script uses the MediaWiki API (commons.wikimedia.org/w/api.php) and asks
for the 640px-wide thumbnail of each file via iiurlwidth=640 — no local resize
required. Existing files are skipped, so re-running is safe.

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

# (folder, [(commons_category, count_to_keep)])
CATEGORIES: dict[str, list[tuple[str, int]]] = {
    "person": [
        ("People_walking_outdoors", 5),
    ],
    "car": [
        ("Sedans", 3),
        ("Hatchbacks", 2),
    ],
    "cat": [
        ("Felis_silvestris_catus", 5),  # all domestic cats
    ],
    "squirrel": [
        ("Sciurus_vulgaris", 4),
    ],
    "bird": [
        ("Turdus_merula",       2),  # Amsel
        ("Cyanistes_caeruleus", 2),  # Blaumeise
        ("Parus_major",         2),  # Kohlmeise
        ("Erithacus_rubecula",  1),  # Rotkehlchen
        ("Fringilla_coelebs",   1),  # Buchfink
        ("Chloris_chloris",     1),  # Grünfink
        ("Dendrocopos_major",   1),  # Buntspecht
        ("Garrulus_glandarius", 1),  # Eichelhäher
    ],
}

VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}
# Skip obvious non-photo assets that end up in Commons species categories
SKIP_SUBSTR = ("distribution map", "range map", "diagram", "phylogeny", "taxonomy")


def list_images(category: str, want: int) -> list[tuple[str, str]]:
    """Return up to ~want*3 (file_title, thumb_url) pairs from a Commons category."""
    params = {
        "action":      "query",
        "format":      "json",
        "generator":   "categorymembers",
        "gcmtitle":    f"Category:{category}",
        "gcmtype":     "file",
        "gcmlimit":    str(max(want * 3, 10)),
        "prop":        "imageinfo",
        "iiprop":      "url|mime",
        "iiurlwidth":  "640",
    }
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as r:
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
        title = (p.get("title") or "").replace("File:", "").strip()
        if title:
            out.append((title, thumb))
    return out


def safe_filename(s: str) -> str:
    keep = "-_."
    cleaned = "".join(c if c.isalnum() or c in keep else "_" for c in s)
    return cleaned[:80]


def download(url: str, dest: Path) -> int:
    # Retry with exponential backoff on 429 rate-limits (Wikimedia returns them
    # when our request cadence spikes). Up to 4 tries, then give up.
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
    for folder, cats in CATEGORIES.items():
        out_dir = BASE / folder
        out_dir.mkdir(parents=True, exist_ok=True)
        for cat, want in cats:
            print(f"\n== {folder} / Category:{cat}  (want {want}) ==", flush=True)
            try:
                imgs = list_images(cat, want)
            except Exception as e:
                print(f"  ! list_images failed: {e}", flush=True)
                continue
            taken = 0
            for fname, url in imgs:
                if taken >= want:
                    break
                # Normalize underscores and spaces so SKIP_SUBSTR matches whichever Commons returns
                low = fname.lower().replace("_", " ")
                if any(s in low for s in SKIP_SUBSTR):
                    continue
                # iiurlwidth=640 always serves a JPG-encoded thumbnail
                outname = safe_filename(Path(fname).stem) + ".jpg"
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
                    time.sleep(1.0)  # be nice to Wikimedia
                except Exception as e:
                    print(f"  ! {fname} failed: {e}", flush=True)
            if taken < want:
                print(f"  (only {taken}/{want} for {cat})", flush=True)

    print(f"\n=== done. new: {new_total}, already-present: {skipped_total} ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

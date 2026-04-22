# Test images for /api/coral/test-batch

Sample images grouped by expected COCO label, used by the Coral test-batch
endpoint to verify object-detection quality without needing live camera feeds.

```
person/    5 — humans outdoors
car/       5 — cars (sedans, hatchbacks)
cat/       5 — domestic cats
bird/     11 — Bavarian garden species:
              Amsel · Blaumeise · Kohlmeise · Rotkehlchen · Buchfink ·
              Grünfink · Buntspecht · Eichelhäher
squirrel/  4 — Sciurus vulgaris
```

All images are downloaded from Wikimedia Commons under their respective free
licenses (CC-BY, CC-BY-SA, public domain). Original attribution lives at
<https://commons.wikimedia.org/wiki/File:NAME>.

## Re-downloading

Run the bundled downloader inside the container:

```bash
docker exec tam-spy python3 /app/storage/test_images/_download.py
```

The script uses the MediaWiki API with `iiurlwidth=640` to fetch already-resized
640px-wide JPEG thumbnails — no local resize needed. Existing files are skipped,
so re-runs only fill in missing entries. Edit `_download.py`'s `CATEGORIES` dict
to change the list.

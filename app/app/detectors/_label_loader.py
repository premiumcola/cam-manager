"""TFLite label-file loader + bird-name pretty-printers.

Carved out of the original detectors.py during R02.1.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)


def load_label_map(path: str | None) -> dict[int, str]:
    """Load a TFLite label file.

    Supports two formats:
      A) numeric-prefixed (e.g. Coral COCO)   "16 bird"     / "16: bird"
      B) plain lines      (e.g. Coral iNat)   "Turdus merula (Common Blackbird)"

    In format B the line index (0-based) becomes the label id, which is what
    the classifier output layer uses for iNaturalist-style models.
    """
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    text = p.read_text(encoding="utf-8", errors="ignore").splitlines()
    out: dict[int, str] = {}
    lines_nonblank: list[str] = []
    for line in text:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        lines_nonblank.append(line)
        if ":" in line:
            k, v = line.split(":", 1)
        elif " " in line:
            k, v = line.split(" ", 1)
        else:
            continue
        try:
            out[int(k.strip())] = v.strip()
        except Exception:
            continue
    if not out and lines_nonblank:
        # Format B — plain labels, one per line, indexed by position.
        out = {i: s for i, s in enumerate(lines_nonblank)}
    return out


# Default Latin→German bird-name map. Cached across instances; the cache
# invalidates only when the configured path changes — dropping a fresh
# JSON over the same path won't get picked up until the process restarts,
# which is acceptable for a static reference table.
_BIRD_LATIN_TO_DE_PATH_DEFAULT = "/app/config/inat_to_german.json"
_bird_latin_to_de_cache: dict[str, str] | None = None
_bird_latin_to_de_cache_path: str | None = None


def _load_bird_latin_to_de(path: str | None) -> dict[str, str]:
    """Cached load of the Latin→German map. `path` may be overridden per
    classifier instance; reloads only when the path changes or the file has
    not been read yet."""
    global _bird_latin_to_de_cache, _bird_latin_to_de_cache_path
    use_path = path or _BIRD_LATIN_TO_DE_PATH_DEFAULT
    if _bird_latin_to_de_cache is not None and _bird_latin_to_de_cache_path == use_path:
        return _bird_latin_to_de_cache
    data: dict[str, str] = {}
    try:
        with open(use_path, encoding="utf-8") as f:
            raw = json.load(f)
        data = {
            k: v
            for k, v in raw.items()
            if isinstance(k, str) and isinstance(v, str) and not k.startswith("_")
        }
    except FileNotFoundError:
        log.info("Bird latin→de map: %s not found — species will show Latin names only.", use_path)
    except Exception as e:
        log.warning("Bird latin→de map: failed to parse %s: %s", use_path, e)
    _bird_latin_to_de_cache = data
    _bird_latin_to_de_cache_path = use_path
    if data:
        log.info("Bird latin→de map loaded from %s (%d entries)", use_path, len(data))
    return data


def _extract_latin(raw: str | None) -> str | None:
    """Pull a clean "Genus species" string out of any iNat label shape.

    Examples:
      "Turdus merula (Common Blackbird)"  → "Turdus merula"
      "PARUS MAJOR"                        → "Parus major"
      "Passer_domesticus"                  → "Passer domesticus"
    """
    if not raw:
        return None
    base = str(raw).strip()
    if not base:
        return None
    latin = base.split("(", 1)[0].strip().replace("_", " ")
    parts = latin.split()
    if len(parts) < 2:
        return latin or None
    return parts[0].capitalize() + " " + parts[1].lower()


def _pretty_bird_label(
    raw: str | None, mapping: dict[str, str] | None = None
) -> tuple[str | None, str | None]:
    """Return (display_name, latin_binomial) for an iNaturalist label.

    Display name is the German common name when the Latin binomial is in
    the mapping. If no mapping exists we return (None, latin) so the UI
    keeps the generic COCO "bird" label and does not invent a fake species
    line. The caller can use a None display name as a signal to fall back
    to the next top-k candidate.
    """
    if not raw:
        return raw, None
    latin = _extract_latin(raw)
    m = mapping if mapping is not None else _load_bird_latin_to_de(None)
    de = m.get(latin) if latin else None
    if de:
        return de, latin
    # No German mapping → suppress fake species line, keep latin for logs.
    return None, latin

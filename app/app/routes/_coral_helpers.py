"""Coral-test helper constants and filename-classification functions.

Lives next to coral.py because every helper here is referenced from
multiple routes inside that blueprint (test, test-batch, models,
models/select). Single-route consumers stay inline."""
from __future__ import annotations

from pathlib import Path

_MODELS_DIR = Path("/app/models")

_TEST_FOLDER_LABELS = {
    "bird":     {"label": "Vogel",        "icon": "🐦"},
    "cat":      {"label": "Katze",        "icon": "🐱"},
    "person":   {"label": "Person",       "icon": "🚶"},
    "car":      {"label": "Auto",         "icon": "🚗"},
    "squirrel": {"label": "Eichhörnchen", "icon": "🐿️"},
    "fox":      {"label": "Fuchs",        "icon": "🦊"},
    "hedgehog": {"label": "Igel",         "icon": "🦔"},
}
_TEST_VALID_EXT = {".jpg", ".jpeg", ".png", ".webp"}


def _nickname_tflite(filename: str) -> str:
    """Short pill-friendly badge name for a model file (≤ 16 chars).
    Used by the Coral test UI to tag each detection with the model that
    produced it. Filename heuristics — no model introspection."""
    low = (filename or "").lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low:
        return "COCO SSD"
    if 'efficientdet' in low:
        return "EfficientDet"
    if 'bavarian' in low and 'bird' in low:
        return "Vögel BY"
    if ('inat' in low and 'bird' in low) or 'inat_bird' in low:
        return "Vögel iNat"
    if 'imagenet' in low:
        return "Wildtiere"
    if 'bird' in low:
        return "Vögel"
    # Fallback: filename stem, no underscores, capped at 16 chars.
    stem = Path(filename or "").stem.replace("_", " ").strip()
    return (stem[:16] if stem else "Modell")


def _describe_tflite(filename: str) -> str:
    """Return a human-readable description based on common filename patterns.
    Pure heuristics — we never crack the model file itself."""
    low = filename.lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low:
        return "Objekt-Erkennung · Person, Auto, Vogel, Katze, Hund + 75 COCO-Klassen"
    if 'efficientdet' in low:
        return "Objekt-Erkennung · EfficientDet (höhere Genauigkeit, langsamer)"
    if 'bavarian' in low and 'bird' in low:
        return "Vogelarten · Bayerische Gartenvögel (30 Arten)"
    if ('inat' in low and 'bird' in low) or 'inat_bird' in low:
        return "Vogelarten · ~960 Arten weltweit (iNaturalist)"
    if 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        return "Wildtiere · Eichhörnchen, Fuchs, Igel + 997 ImageNet-Klassen"
    if 'bird' in low or 'bavarian' in low:
        return "Vogelarten-Klassifikation"
    if 'classifier' in low or 'classification' in low:
        return "Image classifier"
    if 'posenet' in low or 'pose' in low:
        return "Human pose estimation"
    if 'deeplab' in low or 'segment' in low:
        return "Semantic segmentation"
    return "Custom model"


def _categorize_tflite(filename: str) -> str:
    """Map a model filename to a purpose category. Used by the UI to group
    models into Objekt-Erkennung / Vogelarten / Wildtiere / Sonstige."""
    low = filename.lower()
    if ('ssd' in low and 'mobilenet' in low) or 'mobilenet_ssd' in low or 'efficientdet' in low:
        return "detection"
    if 'inat' in low or ('bird' in low) or 'bavarian' in low:
        return "bird_species"
    if 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        return "wildlife"
    return "other"


def _labels_for_model(filename: str) -> dict:
    """Best-effort guess of which labels file belongs to a given model.
    Returns {"path": str|None, "filename": str|None, "exists": bool, "count": int|None}."""
    low = filename.lower()
    candidates: list[Path] = []
    if ('ssd' in low and 'mobilenet' in low) or 'efficientdet' in low:
        candidates = [Path("/app/config/coco_labels.example.txt"),
                      Path("/app/config/coco_labels.txt")]
    elif 'inat' in low and 'bird' in low:
        candidates = [Path("/app/models/inat_bird_labels.txt")]
    elif 'bavarian' in low and 'bird' in low:
        candidates = [Path("/app/config/bavarian_birds_common.txt")]
    elif 'imagenet' in low or ('mobilenet' in low and 'ssd' not in low and 'bird' not in low):
        candidates = [Path("/app/models/imagenet_labels.txt")]
    for c in candidates:
        if c.exists():
            try:
                count = sum(1 for ln in c.read_text(encoding="utf-8", errors="ignore").splitlines() if ln.strip())
            except Exception:
                count = None
            return {"path": str(c), "filename": c.name, "exists": True, "count": count}
    # Return the first expected path so the UI can show "fehlt" meaningfully
    if candidates:
        c = candidates[0]
        return {"path": str(c), "filename": c.name, "exists": False, "count": None}
    return {"path": None, "filename": None, "exists": False, "count": None}

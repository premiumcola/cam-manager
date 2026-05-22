"""Wildlife-category mapping rules (ImageNet + iNaturalist label space).

Carved out of the original detectors.py during R02.1. WildlifeClassifier
imports these rules; the test panel and live runtime both pass through
the same predicates so a "fox-likely" label is treated the same way
everywhere.
"""

from __future__ import annotations

# Substring→category rules. Case-insensitive match against the ImageNet
# human-readable label. Ordering matters — first hit wins, so put the more
# specific rule first (e.g. "red fox" before bare "fox" to avoid flying-fox
# or corsac-fox false positives).
_WILDLIFE_LABEL_RULES: tuple[tuple[str, str], ...] = (
    ("red fox", "fox"),
    ("grey fox", "fox"),
    ("gray fox", "fox"),
    ("kit fox", "fox"),
    ("arctic fox", "fox"),
    ("fox squirrel", "squirrel"),
    ("squirrel", "squirrel"),
    ("hedgehog", "hedgehog"),
)


def _wildlife_category(raw_label: str | None) -> str | None:
    """Map an ImageNet top-1 label to one of our wildlife categories, or None."""
    if not raw_label:
        return None
    low = str(raw_label).lower()
    for needle, cat in _WILDLIFE_LABEL_RULES:
        if needle in low:
            return cat
    return None


# Latin-genus → wildlife category. Substring match (case-insensitive)
# against the full iNaturalist label string, e.g.
# "Sciurus vulgaris (Eurasian Red Squirrel)" → "squirrel".
# Used by WildlifeClassifier when an iNat second-stage model is configured
# and its labels file contains mammal binomials. The bird-only iNat model
# shipped by default does NOT contain any of these genera — these rules
# only fire once a mammal-capable iNat model is dropped into models/ and
# pointed at via processing.wildlife.inat_*.
_INAT_WILDLIFE_RULES: tuple[tuple[str, str], ...] = (
    ("sciurus", "squirrel"),  # Sciurus vulgaris, S. carolinensis, etc.
    ("tamias", "squirrel"),  # chipmunk genus — close enough for our purposes
    ("vulpes", "fox"),  # Vulpes vulpes, V. lagopus, V. corsac
    ("erinaceus", "hedgehog"),  # Erinaceus europaeus
    ("meles", "hedgehog"),  # badger genus — optional fallback per spec
)


def _inat_wildlife_category(raw_label: str | None) -> str | None:
    """Map a full iNaturalist label string to a wildlife category, or None."""
    if not raw_label:
        return None
    low = str(raw_label).lower()
    for needle, cat in _INAT_WILDLIFE_RULES:
        if needle in low:
            return cat
    return None


# ImageNet labels MobileNetV2 commonly emits on European squirrel crops.
# These are NOT direct squirrel matches — using them alone would generate
# false positives on real hares/mongooses. They count as squirrel ONLY
# when an independent iNat-secondary check returns a Sciuridae genus
# (see classify_crop cross-validation).
_SQUIRREL_LIKELY_LABELS: tuple[str, ...] = (
    "hare",
    "mongoose",
    "mink",
    "weasel",
    "polecat",
    "ferret",
    "marmot",
    # Bias-from-American-training-set cases — already in
    # _WILDLIFE_LABEL_RULES as direct hits, but listed here too so the
    # cross-check can boost a soft 0.45-ish "fox squirrel" with a strong
    # iNat "Sciurus vulgaris".
    "fox squirrel",
    "gray squirrel",
)


def _is_squirrel_likely(label: str | None) -> bool:
    if not label:
        return False
    low = str(label).lower()
    return any(needle in low for needle in _SQUIRREL_LIKELY_LABELS)


# Sciuridae-family Latin genera the iNat secondary may emit on a squirrel
# crop. Used as the cross-check half of the "squirrel-likely" rule above.
_SCIURIDAE_GENERA: tuple[str, ...] = (
    "sciurus",
    "tamias",
    "marmota",
    "tamiasciurus",
    "callosciurus",
    "spermophilus",
    "glaucomys",
)


def _is_sciuridae_inat(label: str | None) -> bool:
    if not label:
        return False
    low = str(label).lower()
    return any(g in low for g in _SCIURIDAE_GENERA)

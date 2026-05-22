"""Detectors package — re-exports the public API the rest of the
codebase consumes.

Step R02.1 of the detectors split. The 1168-line monolith now lives in
`_legacy_classes.py`; primitives have been carved out into `_types.py`,
`_label_loader.py`, `_wildlife_rules.py`, and `draw.py`. R02.2 / R02.3
move the remaining classes (Coral, Bird, Wildlife) one at a time.

Every consumer outside this package keeps working unchanged thanks to
the wildcard re-exports below. New code should import from the
specific submodule when it cares about provenance.
"""

from __future__ import annotations

from ._label_loader import (
    _extract_latin,
    _load_bird_latin_to_de,
    _pretty_bird_label,
    load_label_map,
)
from ._types import IMPOSSIBLE_LABELS, Detection, _apply_region_filter
from ._wildlife_rules import (
    _inat_wildlife_category,
    _is_sciuridae_inat,
    _is_squirrel_likely,
    _wildlife_category,
)

# R02.3 finished the carve-out — every detector class now lives in
# its own module and `_legacy_classes.py` is gone.
from .bird_species import BirdSpeciesClassifier
from .coral_object import CoralObjectDetector
from .discovery import discover_wildlife_paths
from .draw import draw_detections
from .wildlife import WildlifeClassifier

__all__ = [
    "BirdSpeciesClassifier",
    "CoralObjectDetector",
    "Detection",
    "IMPOSSIBLE_LABELS",
    "WildlifeClassifier",
    "_apply_region_filter",
    "_extract_latin",
    "_inat_wildlife_category",
    "_is_sciuridae_inat",
    "_is_squirrel_likely",
    "_load_bird_latin_to_de",
    "_pretty_bird_label",
    "_wildlife_category",
    "discover_wildlife_paths",
    "draw_detections",
    "load_label_map",
]

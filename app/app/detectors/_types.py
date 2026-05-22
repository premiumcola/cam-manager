"""Detector primitives — Detection dataclass, region-filter helper,
and the IMPOSSIBLE_LABELS frozenset.

Carved out of the original detectors.py during R02.1. Every detector
class still in `_legacy_classes.py` imports from here; later steps
move the classes into their own modules without touching this file.
"""

from __future__ import annotations

from dataclasses import dataclass

# COCO classes that are physically implausible for a residential / garden /
# workshop camera in central Europe. When the object detector emits one of
# these (typically a low-quality hallucination on a dark blob: e.g. a crow
# coming back as "elephant"), we drop it instead of polluting the event log.
# Disable via config: processing.detection.region_filter_enabled = false
IMPOSSIBLE_LABELS: frozenset[str] = frozenset(
    {
        "elephant",
        "bear",
        "zebra",
        "giraffe",
        "cow",
        "sheep",
        "horse",
        "airplane",
        "train",
        "bus",
        "truck",
        "boat",
        "surfboard",
        "snowboard",
        "skis",
        "baseball bat",
        "baseball_bat",
        "baseball glove",
        "baseball_glove",
        "frisbee",
        "skateboard",
        "kite",
        "fire hydrant",
        "fire_hydrant",
        "parking meter",
        "parking_meter",
        "stop sign",
        "stop_sign",
        "traffic light",
        "traffic_light",
    }
)


def _apply_region_filter(dets: list[Detection], enabled: bool) -> list[Detection]:
    if not enabled:
        return dets
    return [d for d in dets if d.label not in IMPOSSIBLE_LABELS]


@dataclass
class Detection:
    label: str
    score: float
    bbox: tuple[int, int, int, int]
    species: str | None = None  # display name (German when mapped, else raw iNat)
    species_latin: str | None = None  # "Genus species" binomial from the iNat label
    species_score: float | None = None
    identity: str | None = None
    raw_cls_id: int = -1  # unmapped class id as emitted by the model
    # Trigger flags inherited from the zone this detection passed through.
    # None when the detection didn't go through any zone (legacy or
    # zone-less camera) — caller treats that as "all flags True". A dict
    # like {"save_photo": True, "save_video": False, "send_telegram": True}
    # means the matching zone explicitly opted in/out for the listed actions.
    zone_flags: dict | None = None

    def to_dict(self):
        x1, y1, x2, y2 = self.bbox
        return {
            "label": self.label,
            "score": round(float(self.score), 4),
            "bbox": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
            "species": self.species,
            "species_latin": self.species_latin,
            "species_score": round(float(self.species_score), 4)
            if self.species_score is not None
            else None,
            "identity": self.identity,
            "raw_cls_id": int(self.raw_cls_id),
        }

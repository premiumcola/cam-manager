from __future__ import annotations
from pathlib import Path
import json
import cv2
import numpy as np


def dhash_bgr(img: np.ndarray) -> str | None:
    if img is None or img.size == 0:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (9, 8))
    diff = small[:, 1:] > small[:, :-1]
    bits = ''.join('1' if v else '0' for v in diff.flatten())
    return f"{int(bits, 2):016x}"


def hamming_hex(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()


class IdentityRegistry:
    def __init__(self, path: str | Path, threshold: int = 10):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.threshold = threshold
        self.data = {"profiles": []}
        self._load()

    def _load(self):
        if self.path.exists():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                self.data = {"profiles": []}

    def _save(self):
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    def list_profiles(self):
        return self.data.get("profiles", [])

    def get_profile(self, name: str):
        return next((p for p in self.data.get("profiles", []) if p.get("name") == name), None)

    def set_profile_flags(self, name: str, *, whitelisted: bool | None = None, notes: str | None = None):
        p = self.get_profile(name)
        if not p:
            return False
        if whitelisted is not None:
            p["whitelisted"] = bool(whitelisted)
        if notes is not None:
            p["notes"] = notes
        self._save()
        return True

    def match_details(self, crop: np.ndarray) -> dict | None:
        h = dhash_bgr(crop)
        if not h:
            return None
        best = None
        best_dist = 999
        for p in self.data.get("profiles", []):
            for sample in p.get("hashes", []):
                try:
                    d = hamming_hex(h, sample)
                except Exception:
                    continue
                if d < best_dist:
                    best_dist = d
                    best = p
        if best is not None and best_dist <= self.threshold:
            return {
                "name": best.get("name"),
                "distance": best_dist,
                "whitelisted": bool(best.get("whitelisted", False)),
                "notes": best.get("notes", ""),
            }
        return None

    def match(self, crop: np.ndarray) -> str | None:
        m = self.match_details(crop)
        return m.get("name") if m else None

    def register_crop(self, name: str, crop: np.ndarray, *, whitelisted: bool = False, notes: str = ""):
        h = dhash_bgr(crop)
        if not h:
            return False
        profiles = self.data.setdefault("profiles", [])
        profile = next((p for p in profiles if p.get("name") == name), None)
        if profile is None:
            profile = {"name": name, "hashes": [], "whitelisted": bool(whitelisted), "notes": notes}
            profiles.append(profile)
        profile.setdefault("hashes", [])
        profile.setdefault("whitelisted", bool(whitelisted))
        if notes:
            profile["notes"] = notes
        if h not in profile["hashes"]:
            profile["hashes"].append(h)
        self._save()
        return True


class CatRegistry(IdentityRegistry):
    pass

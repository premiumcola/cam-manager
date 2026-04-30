"""N-of-M sliding-window confirmation gate for object detections.

Sits between the per-frame Coral output and the camera-runtime's
event-trigger logic. A detection is held back from the trigger pipeline
until at least ``window_n`` hits land within the last ``window_s``
seconds — short single-frame artefacts (a wood-knot briefly classified
as a person) never make it to Telegram.

State is per ``(cam_id, label)``. A continuous sighting only fires the
confirmation log line ONCE; the ``confirmed`` flag stays raised until
the deque has been silent for ``2 × window_s`` seconds, after which the
next hit can confirm a fresh sighting again.

Usage from camera_runtime:

    confirmer = DetectionConfirmer()
    if confirmer.check(cam_id, "person", n=3, seconds=5.0):
        # first frame that crosses the threshold for this sighting
        ...
    elif confirmer.is_confirmed(cam_id, "person"):
        # already in a confirmed sighting, pass through silently
        ...
    else:
        # still accumulating — frontend may show the bbox, but the
        # event/Telegram pipeline must skip this label
        ...
"""
from __future__ import annotations
from collections import deque
import time


class DetectionConfirmer:
    def __init__(self):
        # key = (cam_id, label) → deque of monotonic timestamps
        self._hits: dict[tuple[str, str], deque] = {}
        # key = (cam_id, label) → bool
        self._confirmed: dict[tuple[str, str], bool] = {}

    def check(self, cam_id: str, label: str,
              window_n: int = 3, window_s: float = 5.0) -> bool:
        """Record a detection. Return True iff this hit is the FIRST one
        of a fresh confirmed sighting (first time we cross window_n hits
        in window_s seconds since the last decay)."""
        now = time.monotonic()
        key = (cam_id, label)
        dq = self._hits.setdefault(key, deque(maxlen=64))

        # Decay BEFORE inserting the new hit: if a previously confirmed
        # sighting has been quiet for 2× window, reset state so the next
        # burst can confirm again. The skeleton in the original brief
        # appended first and then checked, which made `now - dq[-1]`
        # always 0 and the decay branch unreachable; doing the check at
        # the top fixes that.
        if dq and self._confirmed.get(key) and (now - dq[-1]) > 2 * window_s:
            self._confirmed[key] = False
            dq.clear()

        dq.append(now)
        cutoff = now - window_s
        while dq and dq[0] < cutoff:
            dq.popleft()

        if len(dq) >= window_n:
            if not self._confirmed.get(key):
                self._confirmed[key] = True
                return True
            # already confirmed — suppress duplicate confirmations within
            # this continuous sighting
            return False
        return False

    def is_confirmed(self, cam_id: str, label: str) -> bool:
        return bool(self._confirmed.get((cam_id, label)))

    def current_count(self, cam_id: str, label: str) -> int:
        dq = self._hits.get((cam_id, label))
        return len(dq) if dq else 0

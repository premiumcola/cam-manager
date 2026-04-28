"""One-shot generator for apple-touch-icon.png (180×180).

Run inside the container so cv2 + numpy are available:

    docker exec tam-spy python /app/web/static/_gen_apple_touch_icon.py

Produces app/web/static/apple-touch-icon.png with a flat, dark-bg
camera-with-magnifier glyph in brand-blue (#14314c). Idempotent — same
inputs always produce the same bytes."""
from __future__ import annotations
import cv2
import numpy as np
from pathlib import Path


def _hex(s: str) -> tuple[int, int, int]:
    s = s.lstrip("#")
    r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    return (b, g, r)  # OpenCV is BGR


SIZE = 180
BG = _hex("#0a0a0a")
PRIMARY = _hex("#14314c")
ACCENT = _hex("#3b82f6")  # brand-accent-blue, same family


def main():
    img = np.full((SIZE, SIZE, 3), BG, dtype=np.uint8)

    # Rounded square plate — flat tile with rounded corners, brand-blue.
    plate = np.full((SIZE, SIZE, 3), BG, dtype=np.uint8)
    cv2.rectangle(plate, (16, 16), (SIZE - 16, SIZE - 16), PRIMARY, thickness=cv2.FILLED)
    # Mask out corner pixels for a visual rounded-corner effect.
    radius = 28
    mask = np.zeros((SIZE, SIZE), dtype=np.uint8)
    cv2.rectangle(mask, (16 + radius, 16), (SIZE - 16 - radius, SIZE - 16), 255, cv2.FILLED)
    cv2.rectangle(mask, (16, 16 + radius), (SIZE - 16, SIZE - 16 - radius), 255, cv2.FILLED)
    for cx, cy in ((16 + radius, 16 + radius), (SIZE - 16 - radius, 16 + radius),
                   (16 + radius, SIZE - 16 - radius), (SIZE - 16 - radius, SIZE - 16 - radius)):
        cv2.circle(mask, (cx, cy), radius, 255, cv2.FILLED)
    img[mask > 0] = plate[mask > 0]

    # Camera body — rounded rect, lighter accent fill.
    cv2.rectangle(img, (44, 70), (136, 132), ACCENT, thickness=cv2.FILLED)
    # Lens.
    cv2.circle(img, (90, 101), 22, BG, thickness=cv2.FILLED)
    cv2.circle(img, (90, 101), 14, ACCENT, thickness=cv2.FILLED)
    cv2.circle(img, (90, 101), 7, BG, thickness=cv2.FILLED)
    # Top hump (viewfinder).
    cv2.rectangle(img, (74, 60), (106, 72), ACCENT, thickness=cv2.FILLED)

    # Magnifier handle — diagonal stroke from lens lower-right to corner.
    cv2.line(img, (104, 115), (130, 141), (255, 255, 255), thickness=4, lineType=cv2.LINE_AA)
    cv2.circle(img, (104, 115), 4, (255, 255, 255), thickness=cv2.FILLED, lineType=cv2.LINE_AA)

    out = Path(__file__).resolve().parent / "apple-touch-icon.png"
    cv2.imwrite(str(out), img)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

"""PWA icon + iOS-splash builder for Squirreling · Sightings.

Source: ``app/web/static/img/logos/logo-squirrel-dark.svg`` — the
standalone squirrel mark. The previous master was the acorn-cam
combo (``logo-acorn-cam-dark.svg``); that file is kept in the repo
as a backup variant and is no longer referenced by the build, the
manifest, or the splash links. Switch ``MASTER_SVG`` below to swap
back if needed.

We rasterise the master onto a warm-cream square plate so the brown
squirrel separates cleanly from typical iOS dark wallpapers, and
emit the iOS-relevant icon sizes plus all the
apple-touch-startup-image splash variants.

Usage inside the container::

    docker exec squirreling-sightings pip install cairosvg     # transient one-shot
    docker exec squirreling-sightings python /app/web/static/icons/_build_icons.py

The PNG outputs are committed to git, so future rebuilds don't need
cairosvg unless the master SVG changes. The corresponding splash
backgrounds use the same cream `#F0E5D0` so iOS shows one seamless
surface from native splash → web app first paint.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import cairosvg


# ── Paths ─────────────────────────────────────────────────────────────
THIS = Path(__file__).resolve()
LOGO_DIR = THIS.parent.parent / "img" / "logos"
# Squirrel-only mark; backup variant ``logo-acorn-cam-dark.svg``
# stays in the repo for future swaps.
MASTER_SVG = LOGO_DIR / "logo-squirrel-dark.svg"
OUT_DIR = THIS.parent
SPLASH_DIR = OUT_DIR / "splash"
SPLASH_PARTIAL = (
    THIS.parent.parent.parent
    / "templates"
    / "partials"
    / "splash_links.html"
)


# ── Plate / palette ───────────────────────────────────────────────────
def _bgr(hex_str: str) -> tuple[int, int, int]:
    s = hex_str.lstrip("#")
    return (int(s[4:6], 16), int(s[2:4], 16), int(s[0:2], 16))


PLATE_BG_HEX = "#F0E5D0"        # warm cream — manifest background_color
PLATE_BG = _bgr(PLATE_BG_HEX)


# ── SVG rasterisation ─────────────────────────────────────────────────
def _rasterise_logo(target_height_px: int) -> np.ndarray:
    """Render the master Acorn Cam SVG to a numpy BGRA array of the
    requested height. Width follows the SVG's intrinsic aspect ratio.
    """
    png_bytes = cairosvg.svg2png(
        url=str(MASTER_SVG),
        output_height=target_height_px,
    )
    arr = np.frombuffer(png_bytes, dtype=np.uint8)
    rgba = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if rgba is None:
        raise RuntimeError(f"cairosvg → imdecode failed for {MASTER_SVG}")
    if rgba.shape[2] == 3:
        # cairosvg always outputs RGBA but be safe.
        alpha = np.full(rgba.shape[:2] + (1,), 255, dtype=np.uint8)
        rgba = np.concatenate([rgba, alpha], axis=2)
    return rgba


def _rounded_rect_mask(size: int, radius: int) -> np.ndarray:
    """Full-size rounded-square alpha mask (255 inside, 0 outside)."""
    mask = np.zeros((size, size), dtype=np.uint8)
    cv2.rectangle(mask, (radius, 0), (size - radius, size), 255, cv2.FILLED)
    cv2.rectangle(mask, (0, radius), (size, size - radius), 255, cv2.FILLED)
    for cx, cy in (
        (radius, radius),
        (size - radius, radius),
        (radius, size - radius),
        (size - radius, size - radius),
    ):
        cv2.circle(mask, (cx, cy), radius, 255, cv2.FILLED)
    return mask


def _compose_icon(size: int, *, padding_pct: float = 0.16,
                  rounded: bool = True) -> np.ndarray:
    """Compose a cream-plated icon at `size` px. The logo occupies
    ~(1 − 2·padding_pct) of the plate height so it doesn't touch the
    rounded corners. iOS renders its own corner mask on apple-touch-
    icons, so the rounded plate here is purely a fallback for devices
    that don't apply an OS-level mask (older Android launchers,
    favicon contexts).
    """
    canvas = np.full((size, size, 3), PLATE_BG, dtype=np.uint8)
    # Logo target height → rasterise SVG to that height, then centre.
    logo_h = max(8, int(size * (1 - 2 * padding_pct)))
    rgba = _rasterise_logo(logo_h)
    lh, lw = rgba.shape[:2]
    if lw > size - 2:
        # Pathological: SVG aspect very wide. Re-rasterise constrained.
        rgba = _rasterise_logo(int(logo_h * (size - 2) / lw))
        lh, lw = rgba.shape[:2]
    x0 = (size - lw) // 2
    y0 = (size - lh) // 2
    # Composite RGBA over the cream canvas.
    rgb = rgba[..., :3]
    a = rgba[..., 3:].astype(np.float32) / 255.0
    canvas_slice = canvas[y0:y0 + lh, x0:x0 + lw].astype(np.float32)
    blended = rgb.astype(np.float32) * a + canvas_slice * (1 - a)
    canvas[y0:y0 + lh, x0:x0 + lw] = blended.astype(np.uint8)
    if rounded:
        # Rounded-square plate via alpha channel. Saved as RGBA so the
        # transparent corners don't show the cream plate at any
        # rotation iOS might apply on the lock screen.
        radius = max(8, int(size * 0.22))
        mask = _rounded_rect_mask(size, radius)
        rgba_out = np.concatenate(
            [canvas, mask[..., None]], axis=2,
        )
        return rgba_out
    return canvas


# ── Output catalogue ──────────────────────────────────────────────────
ICON_SIZES: list[tuple[str, int, float, bool]] = [
    # (filename, pixel size, padding %, rounded plate?)
    ("icon-1024.png", 1024, 0.16, True),
    ("icon-512.png", 512, 0.16, True),
    # Maskable: 10% safe-zone inset so Android launcher masks crop only
    # the plate, never the logo.
    ("icon-512-maskable.png", 512, 0.20, False),
    ("icon-192.png", 192, 0.16, True),
    ("icon-180.png", 180, 0.16, True),
    ("icon-167.png", 167, 0.16, True),
    ("icon-152.png", 152, 0.16, True),
    ("icon-120.png", 120, 0.16, True),
    ("favicon-32.png", 32, 0.10, True),
    ("favicon-16.png", 16, 0.06, True),
]


SPLASH_SIZES: list[tuple[int, int]] = [
    (1290, 2796), (2796, 1290),
    (1179, 2556), (2556, 1179),
    (1284, 2778), (2778, 1284),
    (1170, 2532), (2532, 1170),
    (1242, 2688), (2688, 1242),
    (1125, 2436), (2436, 1125),
    (1242, 2208), (2208, 1242),
    (750, 1334),  (1334, 750),
    (2048, 2732), (2732, 2048),
    (1668, 2388), (2388, 1668),
    (1668, 2224), (2224, 1668),
    (1536, 2048), (2048, 1536),
    (1080, 2340), (2340, 1080),
    (828, 1792),  (1792, 828),
]


SPLASH_MEDIA: dict[tuple[int, int], tuple[int, int, int, str]] = {
    (1290, 2796): (430, 932, 3, "portrait"),
    (2796, 1290): (430, 932, 3, "landscape"),
    (1179, 2556): (393, 852, 3, "portrait"),
    (2556, 1179): (393, 852, 3, "landscape"),
    (1284, 2778): (428, 926, 3, "portrait"),
    (2778, 1284): (428, 926, 3, "landscape"),
    (1170, 2532): (390, 844, 3, "portrait"),
    (2532, 1170): (390, 844, 3, "landscape"),
    (1242, 2688): (414, 896, 3, "portrait"),
    (2688, 1242): (414, 896, 3, "landscape"),
    (1125, 2436): (375, 812, 3, "portrait"),
    (2436, 1125): (375, 812, 3, "landscape"),
    (1242, 2208): (414, 736, 3, "portrait"),
    (2208, 1242): (414, 736, 3, "landscape"),
    (750, 1334):  (375, 667, 2, "portrait"),
    (1334, 750):  (375, 667, 2, "landscape"),
    (1080, 2340): (360, 780, 3, "portrait"),
    (2340, 1080): (360, 780, 3, "landscape"),
    (828, 1792):  (414, 896, 2, "portrait"),
    (1792, 828):  (414, 896, 2, "landscape"),
    (2048, 2732): (1024, 1366, 2, "portrait"),
    (2732, 2048): (1024, 1366, 2, "landscape"),
    (1668, 2388): (834, 1194, 2, "portrait"),
    (2388, 1668): (834, 1194, 2, "landscape"),
    (1668, 2224): (834, 1112, 2, "portrait"),
    (2224, 1668): (834, 1112, 2, "landscape"),
    (1536, 2048): (768, 1024, 2, "portrait"),
    (2048, 1536): (768, 1024, 2, "landscape"),
}


def _render_splash(w: int, h: int) -> np.ndarray:
    """Splash background is the same cream plate as the icon (manifest
    background_color). Logo centred at ~25 % of the smaller dimension.
    """
    canvas = np.full((h, w, 3), PLATE_BG, dtype=np.uint8)
    icon_size = max(96, int(min(w, h) * 0.25))
    rgba = _rasterise_logo(int(icon_size * 0.7))
    lh, lw = rgba.shape[:2]
    x0 = (w - lw) // 2
    y0 = (h - lh) // 2
    rgb = rgba[..., :3]
    a = rgba[..., 3:].astype(np.float32) / 255.0
    slice_ = canvas[y0:y0 + lh, x0:x0 + lw].astype(np.float32)
    blended = rgb.astype(np.float32) * a + slice_ * (1 - a)
    canvas[y0:y0 + lh, x0:x0 + lw] = blended.astype(np.uint8)
    return canvas


def _splash_link(w: int, h: int) -> str:
    media = SPLASH_MEDIA.get((w, h))
    if not media:
        return f"  <!-- splash {w}x{h}: no media-query mapping -->\n"
    dw, dh, dpr, orient = media
    return (
        '  <link rel="apple-touch-startup-image"\n'
        f'        href="/static/icons/splash/splash-{w}x{h}.png"\n'
        f'        media="(device-width: {dw}px) and (device-height: {dh}px) '
        f'and (-webkit-device-pixel-ratio: {dpr}) and (orientation: {orient})" />\n'
    )


def _write_splash_partial() -> None:
    SPLASH_PARTIAL.parent.mkdir(parents=True, exist_ok=True)
    rows = "".join(_splash_link(w, h) for (w, h) in SPLASH_SIZES)
    SPLASH_PARTIAL.write_text(rows, encoding="utf-8")
    print(f"wrote {SPLASH_PARTIAL}")


# ── Main entrypoint ───────────────────────────────────────────────────
def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SPLASH_DIR.mkdir(parents=True, exist_ok=True)

    print(f"master SVG: {MASTER_SVG}")
    print(f"plate color: {PLATE_BG_HEX}")

    # Icons
    for fname, size, pad, rounded in ICON_SIZES:
        out = _compose_icon(size, padding_pct=pad, rounded=rounded)
        path = OUT_DIR / fname
        # If RGBA, write as PNG keeping alpha.
        if out.shape[2] == 4:
            cv2.imwrite(str(path), out)
        else:
            cv2.imwrite(str(path), out)
        print(f"  ↳ {fname} ({size}x{size})")

    # Splash images
    for w, h in SPLASH_SIZES:
        out = _render_splash(w, h)
        path = SPLASH_DIR / f"splash-{w}x{h}.png"
        cv2.imwrite(str(path), out)
        print(f"  ↳ splash-{w}x{h}.png")

    _write_splash_partial()
    print("done.")


if __name__ == "__main__":
    main()

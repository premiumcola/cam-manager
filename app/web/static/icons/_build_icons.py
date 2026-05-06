"""Parametric icon + iOS-splash builder for TAM-spy.

Renders a squirrel-with-camera motif at 1024×1024 master resolution
using only cv2 + numpy (no Pillow / cairosvg needed in the container),
then downsamples to every iOS-relevant icon size and composes splash
backgrounds for the common iPhone/iPad fleet.

Outputs land beside this script under app/web/static/icons/. The HTML
fragment for splash <link> tags is written to
app/web/templates/partials/splash_links.html so index.html can pull
it via {% include %} without hand-editing 30+ media queries.

Run inside the container:

    docker exec tam-spy python /app/web/static/icons/_build_icons.py

Idempotent — the parametric design has no random component, so the
same script always produces byte-identical PNGs.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def _bgr(hex_str: str) -> tuple[int, int, int]:
    """Hex string → cv2 BGR triple."""
    s = hex_str.lstrip("#")
    r, g, b = int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)
    return (b, g, r)


# Warm sand plate so the dark squirrel pops against typical iOS dark
# wallpapers — the previous near-black plate (#0a0a0a) with a navy
# centre glow disappeared into anything dark behind it. The new plate
# stays in the same warm-earth family as the squirrel itself
# (complementary, not competing) and the radial centre glow lifts
# even brighter so the silhouette has a soft halo to read against.
PLATE_BG = _bgr("#d4a76a")     # warm sand
PLATE_GLOW = _bgr("#f1d7a3")   # bright cream centre
SQUIRREL = _bgr("#8B5A2B")
SQUIRREL_DK = _bgr("#5a3a18")
SQUIRREL_LT = _bgr("#a06d35")
EYE = _bgr("#0a0a0a")
EYE_LIGHT = _bgr("#ffffff")
CAMERA_BODY = _bgr("#1f2937")
CAMERA_ACC = _bgr("#3b82f6")
LENS_RIM = _bgr("#0a0a0a")
LENS_GLINT = _bgr("#ffffff")


def _rounded_rect_mask(size: int, inset: int, radius: int) -> np.ndarray:
    mask = np.zeros((size, size), dtype=np.uint8)
    a, b = inset, size - inset
    cv2.rectangle(mask, (a + radius, a), (b - radius, b), 255, cv2.FILLED)
    cv2.rectangle(mask, (a, a + radius), (b, b - radius), 255, cv2.FILLED)
    for cx, cy in (
        (a + radius, a + radius),
        (b - radius, a + radius),
        (a + radius, b - radius),
        (b - radius, b - radius),
    ):
        cv2.circle(mask, (cx, cy), radius, 255, cv2.FILLED)
    return mask


def _radial_gradient(size: int, inner: tuple, outer: tuple) -> np.ndarray:
    """Subtle radial fill — plate-glow at center fading to plate-bg
    at the corners. Pure numpy; ~10 ms at 1024 px."""
    cx = cy = size / 2
    yy, xx = np.indices((size, size))
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    max_d = (size / 2) * np.sqrt(2)
    t = np.clip(dist / max_d, 0, 1)[..., None]
    inner_arr = np.array(inner, dtype=np.float32)
    outer_arr = np.array(outer, dtype=np.float32)
    img = (1 - t) * inner_arr + t * outer_arr
    return img.astype(np.uint8)


def _draw_squirrel(img: np.ndarray, cx: int, cy: int, h: int) -> None:
    """Sitting squirrel with bushy tail sweeping up-left. h sets the
    overall body-height; everything else is derived so proportions stay
    stable across sizes. (cx, cy) is roughly the body center."""
    tail_outer = np.array(
        [
            (cx - int(0.06 * h), cy + int(0.10 * h)),
            (cx - int(0.46 * h), cy + int(0.04 * h)),
            (cx - int(0.62 * h), cy - int(0.22 * h)),
            (cx - int(0.55 * h), cy - int(0.50 * h)),
            (cx - int(0.30 * h), cy - int(0.60 * h)),
            (cx - int(0.08 * h), cy - int(0.48 * h)),
            (cx - int(0.02 * h), cy - int(0.20 * h)),
            (cx + int(0.05 * h), cy - int(0.05 * h)),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(img, [tail_outer], SQUIRREL, lineType=cv2.LINE_AA)
    tail_inner = np.array(
        [
            (cx - int(0.20 * h), cy - int(0.20 * h)),
            (cx - int(0.40 * h), cy - int(0.27 * h)),
            (cx - int(0.46 * h), cy - int(0.42 * h)),
            (cx - int(0.30 * h), cy - int(0.52 * h)),
            (cx - int(0.16 * h), cy - int(0.40 * h)),
            (cx - int(0.10 * h), cy - int(0.25 * h)),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(img, [tail_inner], SQUIRREL_LT, lineType=cv2.LINE_AA)

    # Body — vertical ellipse, sits below the head.
    body_cy = cy + int(0.10 * h)
    cv2.ellipse(
        img,
        (cx, body_cy),
        (int(0.22 * h), int(0.30 * h)),
        0,
        0,
        360,
        SQUIRREL,
        cv2.FILLED,
        cv2.LINE_AA,
    )
    # Belly highlight — lighter ellipse on the front.
    cv2.ellipse(
        img,
        (cx, body_cy + int(0.08 * h)),
        (int(0.13 * h), int(0.20 * h)),
        0,
        0,
        360,
        SQUIRREL_LT,
        cv2.FILLED,
        cv2.LINE_AA,
    )

    # Head — round, slightly smaller than body.
    head_cy = cy - int(0.20 * h)
    head_r = int(0.20 * h)
    cv2.circle(img, (cx, head_cy), head_r, SQUIRREL, cv2.FILLED, cv2.LINE_AA)

    # Ears — two filled triangles capped with a darker inner triangle.
    ear_w = max(4, int(0.08 * h))
    ear_h = max(4, int(0.11 * h))
    for sign in (-1, 1):
        ex = cx + sign * int(0.13 * h)
        ey = head_cy - int(0.13 * h)
        outer = np.array(
            [
                (ex - ear_w // 2, ey + ear_h // 2),
                (ex + ear_w // 2, ey + ear_h // 2),
                (ex, ey - ear_h // 2),
            ],
            dtype=np.int32,
        )
        cv2.fillPoly(img, [outer], SQUIRREL, lineType=cv2.LINE_AA)
        # Inner triangle — shrunk toward (ex,ey) to give a darker pinna.
        inner = (outer * 0.6 + np.array([ex, ey]) * 0.4).astype(np.int32)
        cv2.fillPoly(img, [inner], SQUIRREL_DK, lineType=cv2.LINE_AA)

    # Snout — small lighter ellipse below the head center.
    snout_y = head_cy + int(0.07 * h)
    cv2.ellipse(
        img,
        (cx, snout_y),
        (max(3, int(0.075 * h)), max(2, int(0.05 * h))),
        0,
        0,
        360,
        SQUIRREL_LT,
        cv2.FILLED,
        cv2.LINE_AA,
    )
    # Nose dot.
    cv2.circle(
        img, (cx, snout_y + max(2, int(0.025 * h))),
        max(2, int(0.014 * h)), EYE, cv2.FILLED, cv2.LINE_AA,
    )

    # Eye — single eye visible (head turned slightly).
    eye_x = cx + int(0.085 * h)
    eye_y = head_cy - int(0.02 * h)
    eye_r = max(3, int(0.04 * h))
    cv2.circle(img, (eye_x, eye_y), eye_r, EYE, cv2.FILLED, cv2.LINE_AA)
    glint = max(1, int(0.013 * h))
    cv2.circle(
        img, (eye_x - glint, eye_y - glint), glint, EYE_LIGHT, cv2.FILLED, cv2.LINE_AA,
    )

    # Front paws — small lobes at the lower body, cradling the camera.
    paw_y = body_cy + int(0.12 * h)
    for sign in (-1, 1):
        cv2.circle(
            img,
            (cx + sign * int(0.13 * h), paw_y),
            max(3, int(0.05 * h)),
            SQUIRREL_DK,
            cv2.FILLED,
            cv2.LINE_AA,
        )


def _draw_camera(img: np.ndarray, cx: int, cy: int, w: int) -> None:
    """A tiny camera centered at (cx, cy) with body-width w. The
    motif sits on the squirrel's chest so the lens and a glint are
    the dominant feature at small sizes."""
    bw = w
    bh = int(w * 0.65)
    x0, y0 = cx - bw // 2, cy - bh // 2
    x1, y1 = cx + bw // 2, cy + bh // 2
    radius = max(3, bh // 6)
    cv2.rectangle(img, (x0 + radius, y0), (x1 - radius, y1), CAMERA_BODY, cv2.FILLED)
    cv2.rectangle(img, (x0, y0 + radius), (x1, y1 - radius), CAMERA_BODY, cv2.FILLED)
    for ccx, ccy in (
        (x0 + radius, y0 + radius),
        (x1 - radius, y0 + radius),
        (x0 + radius, y1 - radius),
        (x1 - radius, y1 - radius),
    ):
        cv2.circle(img, (ccx, ccy), radius, CAMERA_BODY, cv2.FILLED, cv2.LINE_AA)
    # Top hump (viewfinder).
    hump_w = max(6, bw // 3)
    hump_h = max(4, bh // 5)
    cv2.rectangle(
        img,
        (cx - hump_w // 2, y0 - hump_h),
        (cx + hump_w // 2, y0 + 2),
        CAMERA_BODY,
        cv2.FILLED,
    )
    # Lens — concentric circles ending in a bright catchlight.
    lens_r = max(4, int(bh * 0.40))
    cv2.circle(img, (cx, cy), lens_r, LENS_RIM, cv2.FILLED, cv2.LINE_AA)
    cv2.circle(img, (cx, cy), int(lens_r * 0.75), CAMERA_ACC, cv2.FILLED, cv2.LINE_AA)
    cv2.circle(img, (cx, cy), int(lens_r * 0.45), LENS_RIM, cv2.FILLED, cv2.LINE_AA)
    glint_r = max(2, lens_r // 4)
    cv2.circle(
        img,
        (cx - lens_r // 3, cy - lens_r // 3),
        glint_r,
        LENS_GLINT,
        cv2.FILLED,
        cv2.LINE_AA,
    )


def render_master(size: int = 1024, pad_pct: float = 0.0) -> np.ndarray:
    """Full icon at `size` px square. pad_pct shrinks the motif so
    the maskable variant survives Android launcher cropping (~10%)."""
    bg = _radial_gradient(size, PLATE_GLOW, PLATE_BG)
    plate_inset = max(2, int(size * 0.04))
    plate_radius = int(size * 0.22)
    mask = _rounded_rect_mask(size, plate_inset, plate_radius)

    canvas = np.full((size, size, 3), PLATE_BG, dtype=np.uint8)
    canvas[mask > 0] = bg[mask > 0]

    motif_h = int(size * (0.72 - pad_pct))
    cx = size // 2
    cy = int(size * 0.50)
    _draw_squirrel(canvas, cx, cy, motif_h)

    cam_w = int(size * (0.24 - pad_pct * 0.5))
    cam_cy = cy + int(motif_h * 0.32)
    _draw_camera(canvas, cx, cam_cy, cam_w)
    return canvas


# ── output sizes ───────────────────────────────────────────────────────
ICON_SIZES: list[tuple[str, int, float]] = [
    ("icon-1024.png", 1024, 0.0),
    ("icon-512.png", 512, 0.0),
    # Maskable variant (10% safe-zone inset) — used by I02 PWA manifest.
    ("icon-512-maskable.png", 512, 0.10),
    ("icon-192.png", 192, 0.0),
    ("icon-180.png", 180, 0.0),
    ("icon-167.png", 167, 0.0),
    ("icon-152.png", 152, 0.0),
    ("icon-120.png", 120, 0.0),
    ("favicon-32.png", 32, 0.0),
    ("favicon-16.png", 16, 0.0),
]


# Splash sizes covering the iPhone + iPad fleet through 2026. Each
# entry has an exact device-points + dpr + orientation triple so the
# media-query mapping below stays unambiguous.
SPLASH_SIZES: list[tuple[int, int]] = [
    (1290, 2796), (2796, 1290),     # 15 Pro Max / 14 Pro Max
    (1179, 2556), (2556, 1179),     # 15 Pro / 14 Pro / 15 / 14
    (1284, 2778), (2778, 1284),     # 14 Plus / 13 Pro Max / 12 Pro Max
    (1170, 2532), (2532, 1170),     # 14 / 13 / 13 Pro / 12 / 12 Pro
    (1080, 2340), (2340, 1080),     # 13 mini / 12 mini
    (828, 1792),  (1792, 828),      # 11 / XR
    (1242, 2688), (2688, 1242),     # 11 Pro Max / XS Max
    (1125, 2436), (2436, 1125),     # 11 Pro / XS / X
    (1242, 2208), (2208, 1242),     # 8 Plus / 7 Plus / 6s Plus / 6 Plus
    (750, 1334),  (1334, 750),      # SE3 / SE2 / 8 / 7 / 6s / 6
    (2048, 2732), (2732, 2048),     # iPad Pro 12.9
    (1668, 2388), (2388, 1668),     # iPad Pro 11
    (1668, 2224), (2224, 1668),     # iPad Air / 10.5
    (1536, 2048), (2048, 1536),     # iPad Mini / 9.7
]


# (target_w, target_h) → (device_w_pts, device_h_pts, dpr, orientation)
SPLASH_MEDIA: dict[tuple[int, int], tuple[int, int, int, str]] = {
    (1290, 2796): (430, 932, 3, "portrait"),
    (2796, 1290): (430, 932, 3, "landscape"),
    (1179, 2556): (393, 852, 3, "portrait"),
    (2556, 1179): (393, 852, 3, "landscape"),
    (1284, 2778): (428, 926, 3, "portrait"),
    (2778, 1284): (428, 926, 3, "landscape"),
    (1170, 2532): (390, 844, 3, "portrait"),
    (2532, 1170): (390, 844, 3, "landscape"),
    (1080, 2340): (360, 780, 3, "portrait"),
    (2340, 1080): (360, 780, 3, "landscape"),
    (828, 1792):  (414, 896, 2, "portrait"),
    (1792, 828):  (414, 896, 2, "landscape"),
    (1242, 2688): (414, 896, 3, "portrait"),
    (2688, 1242): (414, 896, 3, "landscape"),
    (1125, 2436): (375, 812, 3, "portrait"),
    (2436, 1125): (375, 812, 3, "landscape"),
    (1242, 2208): (414, 736, 3, "portrait"),
    (2208, 1242): (414, 736, 3, "landscape"),
    (750, 1334):  (375, 667, 2, "portrait"),
    (1334, 750):  (375, 667, 2, "landscape"),
    (2048, 2732): (1024, 1366, 2, "portrait"),
    (2732, 2048): (1024, 1366, 2, "landscape"),
    (1668, 2388): (834, 1194, 2, "portrait"),
    (2388, 1668): (834, 1194, 2, "landscape"),
    (1668, 2224): (834, 1112, 2, "portrait"),
    (2224, 1668): (834, 1112, 2, "landscape"),
    (1536, 2048): (768, 1024, 2, "portrait"),
    (2048, 1536): (768, 1024, 2, "landscape"),
}


def render_splash(w: int, h: int, master_icon_512: np.ndarray) -> np.ndarray:
    """Compose a splash background sized w×h with the icon centered
    at ~25% of the smaller dimension. background colour matches the
    web app's first-paint #111 so iOS shows a single seamless
    surface from native splash → web app — no flash, no colour
    seam. The icon itself carries its own warm-sand plate so it
    still pops against the dark splash background. */"""
    SPLASH_BG_BGR = _bgr("#111111")
    canvas = np.full((h, w, 3), SPLASH_BG_BGR, dtype=np.uint8)
    icon_size = max(64, int(min(w, h) * 0.25))
    icon = cv2.resize(master_icon_512, (icon_size, icon_size), interpolation=cv2.INTER_AREA)
    x0 = (w - icon_size) // 2
    y0 = (h - icon_size) // 2
    canvas[y0:y0 + icon_size, x0:x0 + icon_size] = icon
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


def write_splash_partial(out_path: Path, sizes: list[tuple[int, int]]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "{# Generated by app/web/static/icons/_build_icons.py — do not edit. #}\n",
    ]
    for w, h in sizes:
        lines.append(_splash_link(w, h))
    out_path.write_text("".join(lines), encoding="utf-8")


def main() -> None:
    here = Path(__file__).resolve().parent
    splash_out = here / "splash"
    here.mkdir(parents=True, exist_ok=True)
    splash_out.mkdir(parents=True, exist_ok=True)

    print("rendering master 1024 (standard + maskable)…")
    master = render_master(1024, pad_pct=0.0)
    master_maskable = render_master(1024, pad_pct=0.10)

    png_opts = [cv2.IMWRITE_PNG_COMPRESSION, 9]
    for name, size, pad in ICON_SIZES:
        src = master_maskable if pad > 0 else master
        if size != 1024:
            img = cv2.resize(src, (size, size), interpolation=cv2.INTER_AREA)
        else:
            img = src
        cv2.imwrite(str(here / name), img, png_opts)
        print(f"  ↳ {name} ({size}×{size})")

    # Pre-resize a 512-px master once for splash composition — every
    # splash uses the same intermediate, no need to re-downsample
    # 1024→25%×min(w,h) per call.
    master_512 = cv2.resize(master, (512, 512), interpolation=cv2.INTER_AREA)
    for w, h in SPLASH_SIZES:
        img = render_splash(w, h, master_512)
        cv2.imwrite(str(splash_out / f"splash-{w}x{h}.png"), img, png_opts)
        print(f"  ↳ splash-{w}x{h}.png")

    partials = here.parent.parent / "templates" / "partials" / "splash_links.html"
    write_splash_partial(partials, SPLASH_SIZES)
    print(f"wrote {partials}")


if __name__ == "__main__":
    main()

"""CSS build step — concatenates per-domain partials into one /static/app.css.

Source of truth is ``app/web/static/css/*.css``. The compiled file
``app/web/static/app.css`` is a build artifact and gitignored once the partials
exist. Build runs at server boot so a fresh clone + docker-compose up just
works without an explicit pre-step.

Load order is fixed and documented in ``app/web/static/css/README.md``:
    tokens → base → utilities → chrome → (domain partials, any order) → mobile

If the partials directory is empty (or missing), build is a no-op and the
existing ``app.css`` is left untouched. That guard keeps the build harmless
during the bootstrap phase before partials have been written.
"""
from __future__ import annotations

import logging
from pathlib import Path

# Authoritative load order. ``mobile.css`` MUST come last so its @media blocks
# override anything they need to. Domain partials in the middle can be in any
# order — CSS specificity, not source order, decides the cascade for them.
LOAD_ORDER = [
    # Zone + mask design tokens — load FIRST so every later partial
    # can reference the --zone-stroke / --mask-stroke custom properties.
    "00-zone-tokens.css",
    "01-base.css",
    "02-hero.css",
    "03-dashboard.css",
    "04-coral-1.css",
    "05-chrome-dock.css",
    # 06-cam-edit-1.css was split into 7 topical partials in the
    # modular refactor. Order is alphabetical within the 06 family,
    # matching the original byte-by-byte concatenation.
    "06a-cam-edit-zones-masks.css",
    "06b-cam-edit-credentials.css",
    "06c-cam-edit-erkennung.css",
    "06d-cam-edit-alerting.css",
    "06e-cam-edit-filters.css",
    "06f-cam-edit-erkennung-aufnahme.css",
    "06g-cam-edit-simulator.css",
    "07-timelapse-1.css",
    "08-settings.css",
    "09-telegram-1.css",
    "10-timeline.css",
    "11-chrome-overlays.css",
    "12-sichtungen.css",
    "13-statistics.css",
    "14-mediathek-1.css",
    "15-coral-2.css",
    "16-cam-edit-2.css",
    "17-timelapse-2.css",
    "18-telegram-2.css",
    "19-weather-1.css",
    "20-mediathek-2.css",
    "21-weather-2.css",
    "22-cam-edit-3.css",
    "23-weather-3.css",
    "24-cam-edit-4.css",
    "25-mobile.css",
    "26-erk-sim-sheet.css",
    "27-coral-test-modes.css",
    "28-quests.css",
    "29-birds.css",
    "30-lightbox-video.css",
]

_BANNER = (
    "/* GENERATED FILE — do not edit. Source of truth: app/web/static/css/*.css\n"
    " * Run scripts/build_css.py (or restart the server) to regenerate.\n"
    " */\n"
)


def _repo_static_dir() -> Path:
    """Locate ``app/web/static`` relative to this module.

    Layout: ``<repo>/app/app/css_builder.py`` → static is two parents up at
    ``<repo>/app/web/static``."""
    return Path(__file__).resolve().parent.parent / "web" / "static"


def build_css(*, log: logging.Logger | None = None) -> bool:
    """Concatenate partials → app.css. Returns True if a write happened."""
    static_dir = _repo_static_dir()
    partials_dir = static_dir / "css"
    out_path = static_dir / "app.css"

    if not partials_dir.is_dir():
        if log:
            log.debug("[css] partials dir missing — skipping build")
        return False

    chunks: list[str] = [_BANNER]
    found = 0
    missing: list[str] = []
    for name in LOAD_ORDER:
        p = partials_dir / name
        if not p.exists():
            missing.append(name)
            continue
        body = p.read_text(encoding="utf-8")
        if not body.endswith("\n"):
            body += "\n"
        chunks.append(f"/* ═══ {name} ═══ */\n{body}")
        found += 1

    if found == 0:
        if log:
            log.debug("[css] no partials present — skipping build (app.css untouched)")
        return False

    new_content = "\n".join(chunks)
    if out_path.exists() and out_path.read_text(encoding="utf-8") == new_content:
        if log:
            log.debug("[css] app.css already current (%d partials)", found)
        return False

    out_path.write_text(new_content, encoding="utf-8")
    if log:
        msg = "[css] rebuilt app.css from %d partials"
        if missing:
            msg += " (missing: %s)" % ", ".join(missing)
        log.info(msg, found)
    return True


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    build_css(log=logging.getLogger("css"))

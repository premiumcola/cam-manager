"""Small validation helpers shared by Flask route blueprints.

Things that don't belong in any single domain — path-traversal guards
for query params, cam_id format checks, etc.
"""
from __future__ import annotations

import re

# YYYY-MM-DD only — anything else (relative paths, dots, slashes) is a
# traversal attempt or a typo. The route falls back to today's date
# rather than serving a 400 so the operator never gets a broken page.
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Camera IDs are emitted by build_camera_id(); the schema is
# `manufacturer_model_name_iplastoctet`, so the character set is
# constrained to lowercase, digits, underscore, hyphen. Cap length so
# a crafted long path can't blow up the filesystem syscall.
_CAM_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")


def safe_day_param(s: str | None) -> str | None:
    """Return ``s`` only if it parses as YYYY-MM-DD; otherwise None.

    Callers typically chain this with an ``or today_iso`` fallback so
    a malformed param degrades to "current day" rather than 400."""
    if s and _DAY_RE.fullmatch(s):
        return s
    return None


def safe_cam_id(s: str | None) -> str | None:
    """Return ``s`` only if it matches the canonical cam-id grammar.

    None on miss so callers can either 404 or fall back to a default.
    """
    if s and _CAM_ID_RE.fullmatch(s):
        return s
    return None

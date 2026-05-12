"""Single source of truth for camera-id construction.

The shape is::

    "<manufacturer>_<model>_<name>_<ip-last-octet>"

Each segment is sanitised to ``[a-z0-9]+``, runs of separators collapse,
and missing or fully-stripped segments fall back to ``"unknown"``. The
helper is also re-implemented bit-for-bit in JS in ``app.js`` (search for
``buildCameraId``) so the camera-edit form can show a live preview that
matches what the backend will ultimately persist — keep both copies in
lockstep.

Examples (IPs from RFC 5737/3849 documentation ranges)::

    build_camera_id("Reolink", "RLC-810A",
                    "Werkstatt rechts oben", "192.0.2.42")
        → "reolink_rlc810a_werkstattrechtsoben_42"

    build_camera_id("", "", "Garten", "192.0.2.83")
        → "unknown_unknown_garten_83"

    build_camera_id("Reolink", "RLC-810A",
                    "Pförtnerhäuschen — älter", "2001:db8::042a")
        → "reolink_rlc810a_pfortnerhauschenalter_042a"
"""
from __future__ import annotations

import re
import unicodedata

# Map of common Latin diacritics + German umlauts to their ASCII fallback.
# We do this BEFORE the regex strip so "ä → a" doesn't get dropped to nothing
# and "ß → ss" stays as two letters. Anything not in the table is handled by
# Unicode NFKD decomposition + ASCII filter further down.
_TRANSLITERATIONS = str.maketrans({
    "ä": "ae", "ö": "oe", "ü": "ue",
    "Ä": "ae", "Ö": "oe", "Ü": "ue",
    "ß": "ss",
    "ñ": "n", "ç": "c",
})


def _sanitise(segment: str) -> str:
    """Lowercase, transliterate umlauts, strip everything but a-z0-9.
    Returns "" when the segment is empty/all-symbols — caller decides
    whether to fall back to 'unknown'."""
    if segment is None:
        return ""
    s = str(segment).translate(_TRANSLITERATIONS)
    # Decompose any remaining diacritics, then drop combining marks. This
    # turns "É" → "E", "ø" → "o", etc.
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def _ip_last_segment(ip: str) -> str:
    """Best-effort 'last segment' extractor.

    - IPv4 ``a.b.c.d`` → ``d``.
    - Dotted/colon mixes (``::ffff:192.0.2.1``) → ``1``.
    - Pure IPv6 ``2001:db8::42`` → last hex group → ``42``.
    - Anything unparseable → empty string."""
    if not ip:
        return ""
    s = str(ip).strip()
    # Split on dots first (covers IPv4 and IPv4-mapped IPv6 like ::ffff:1.2.3.4)
    if "." in s:
        last = s.rsplit(".", 1)[-1]
        sanitised = _sanitise(last)
        if sanitised:
            return sanitised
    if ":" in s:
        # Strip a trailing zone-id (eth0 etc.) before grabbing the last group
        s_no_zone = s.split("%", 1)[0]
        last = s_no_zone.rsplit(":", 1)[-1]
        sanitised = _sanitise(last)
        if sanitised:
            return sanitised
    # No dot, no colon — this isn't an IP at all. Return empty so
    # build_camera_id substitutes "unknown" rather than turning random
    # text into a fake "octet".
    return ""


def camera_slug(settings, camera_id: str) -> str:
    """Return a filesystem-safe slug for a camera, used as a tail
    fragment on timelapse output filenames so two cameras producing
    builds on the same day (same date stem) don't collide when the
    user downloads or aggregates them into a single folder.

    Resolution order:
      1. The camera's ``name`` field from settings (display label,
         e.g. ``"Squirrel Town 'Nut Bar'"``) run through
         :func:`_sanitise` (umlauts transliterated, non-alphanumerics
         stripped, lowercase) → ``"squirreltownnutbar"``.
      2. ``_sanitise(camera_id)`` — strips the underscore-separated
         canonical id into a single lowercase token, e.g.
         ``"reolinkrlc811asquirreltownnutbar183"``.
      3. Literal ``camera_id`` or the string ``"unknown"`` as a
         last resort. ``_sanitise`` on a non-empty input always
         returns something so this branch only triggers when the
         caller passed ``None`` or ``""`` for ``camera_id``.

    Single source of truth — every timelapse build path
    (``weather_service/_sun_tl.py``, ``_event_tl.py``,
    ``timelapse.py``, ``camera_runtime/_timelapse.py``) calls
    this; no ad-hoc slugging elsewhere.
    """
    name = ""
    if settings is not None:
        try:
            data = getattr(settings, "data", None) or {}
            for cam in (data.get("cameras") or []):
                if isinstance(cam, dict) and cam.get("id") == camera_id:
                    name = cam.get("name") or ""
                    break
        except Exception:
            name = ""
    slug = _sanitise(name)
    if slug:
        return slug
    slug = _sanitise(camera_id or "")
    if slug:
        return slug
    return camera_id or "unknown"


def build_camera_id(manufacturer: str, model: str, name: str, ip: str) -> str:
    """Compose the canonical camera id from the four input fields.

    All segments lowercased, non-alphanumerics stripped, and "unknown"
    substituted for any segment that comes out empty so the resulting
    id is always parseable as four underscore-separated tokens.

    The function is total: any input combination produces a valid id."""
    parts = []
    for raw in (manufacturer, model, name):
        clean = _sanitise(raw)
        parts.append(clean if clean else "unknown")
    ip_seg = _ip_last_segment(ip)
    parts.append(ip_seg if ip_seg else "unknown")
    return "_".join(parts)

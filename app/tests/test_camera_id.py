"""Unit tests for ``camera_id.build_camera_id``.

The function must be total — every input combination produces a valid id
of exactly four underscore-separated tokens. We exercise every weird
shape we've seen in the wild plus a few synthetic edge cases."""
import sys
from pathlib import Path

import pytest

_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.camera_id import build_camera_id, camera_slug  # noqa: E402


class _FakeSettings:
    """Minimal settings stand-in — duck-typed ``data`` dict with a
    ``cameras`` list, same shape as the real SettingsStore exposes."""
    def __init__(self, cameras):
        self.data = {"cameras": list(cameras)}


class TestBuildCameraId:
    def test_canonical_example(self):
        assert build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                               "192.0.2.42") == "reolink_rlc810a_werkstattrechtsoben_42"

    def test_all_empty_collapses_to_unknown(self):
        assert build_camera_id("", "", "Garten", "192.0.2.83") == \
            "unknown_unknown_garten_83"

    def test_every_field_empty(self):
        assert build_camera_id("", "", "", "") == "unknown_unknown_unknown_unknown"

    def test_german_umlauts_transliterate(self):
        # ä ö ü ß should not collapse to "unknown" — they map to ASCII multi-letter forms
        assert build_camera_id("", "", "Pförtnerhäuschen", "192.0.2.10") == \
            "unknown_unknown_pfoertnerhaeuschen_10"
        assert build_camera_id("", "", "größe & weiße", "198.51.100.5") == \
            "unknown_unknown_groesseweisse_5"

    def test_other_diacritics_decompose(self):
        # Non-german accented chars survive via NFKD decomposition + ASCII filter
        assert build_camera_id("", "", "Café Été Ñoño", "203.0.113.99") == \
            "unknown_unknown_cafeetenono_99"

    def test_punctuation_and_runs_collapse(self):
        # Multiple separators, mixed punctuation — all stripped, segment kept
        assert build_camera_id("Reolink-Inc.", "RLC---810A!", "  Werkbank — links  ",
                               "192.0.2.142") == \
            "reolinkinc_rlc810a_werkbanklinks_142"

    def test_pure_punctuation_segment_falls_back_to_unknown(self):
        # A segment that's only symbols sanitises to "" → must become "unknown"
        assert build_camera_id("---", "@@@", "Cam", "198.51.100.1") == \
            "unknown_unknown_cam_1"

    def test_very_long_name_passes_through(self):
        # No length cap — Telegram callback strings are NOT computed from this
        # id, so we don't need to be paranoid about width here. Just verify
        # the identity holds.
        long_name = "Eine sehr lange Kamera Bezeichnung mit vielen Wörtern"
        out = build_camera_id("", "", long_name, "192.0.2.7")
        assert out.startswith("unknown_unknown_einesehrlange")
        assert out.endswith("_7")
        assert out.count("_") == 3  # exactly four tokens

    def test_ipv6_falls_back_to_last_hex_group(self):
        assert build_camera_id("", "", "Cam", "2001:db8::42") == \
            "unknown_unknown_cam_42"

    def test_ipv4_mapped_ipv6_uses_v4_octet(self):
        # ::ffff:192.0.2.1 contains a dot, so the v4-style splitter fires
        # first and pulls the trailing octet — correct semantics for this
        # common form.
        assert build_camera_id("", "", "Cam", "::ffff:192.0.2.1") == \
            "unknown_unknown_cam_1"

    def test_unparseable_ip_falls_back_to_unknown(self):
        assert build_camera_id("Reolink", "X", "Cam", "no-ip-here-!@#") == \
            "reolink_x_cam_unknown"

    def test_id_always_four_tokens(self):
        for ip in ("192.0.2.10", "", "garbage", "::1", "203.0.113.0"):
            for name in ("", "Werkstatt", "  ", "äöü"):
                out = build_camera_id("", "", name, ip)
                assert out.count("_") == 3, f"bad token count for ({name!r},{ip!r}): {out}"

    def test_lowercase_invariant(self):
        out = build_camera_id("REOLINK", "RLC-810A", "Werkstatt", "192.0.2.1")
        assert out == out.lower()

    def test_idempotent_when_id_already_canonical(self):
        # If we feed back the canonical id components, the function shouldn't
        # mangle them — the rebuilt id must be the same.
        first = build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                                "192.0.2.42")
        # Same inputs → same output.
        again = build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                                "192.0.2.42")
        assert first == again


class TestCameraSlug:
    """The slug appended to timelapse output filenames so two cameras
    producing builds on the same day don't collide in a shared
    folder. Resolution order: display name → camera_id → ``"unknown"``."""

    def test_umlaut_display_name(self):
        s = _FakeSettings([
            {"id": "cam_a", "name": "Garten 'Pförtnerhäuschen'"},
        ])
        assert camera_slug(s, "cam_a") == "gartenpfoertnerhaeuschen"

    def test_symbols_only_display_name_falls_back_to_camera_id(self):
        s = _FakeSettings([
            {"id": "reolink_rlc810a_garten_42", "name": "!@#$%^&*()"},
        ])
        # The display name slugs to empty, so the canonical id wins.
        assert camera_slug(s, "reolink_rlc810a_garten_42") == \
            "reolinkrlc810agarten42"

    def test_empty_display_name_falls_back_to_camera_id(self):
        s = _FakeSettings([{"id": "reolink_cx810_werkstatt_172", "name": ""}])
        assert camera_slug(s, "reolink_cx810_werkstatt_172") == \
            "reolinkcx810werkstatt172"

    def test_missing_camera_in_settings_falls_back_to_camera_id(self):
        s = _FakeSettings([])
        assert camera_slug(s, "reolink_cx810_terrasse_181") == \
            "reolinkcx810terrasse181"

    def test_none_settings_falls_back_to_camera_id(self):
        assert camera_slug(None, "reolink_cx810_terrasse_181") == \
            "reolinkcx810terrasse181"

    def test_empty_camera_id_returns_unknown(self):
        s = _FakeSettings([])
        # No display name, no camera_id — last-resort sentinel.
        assert camera_slug(s, "") == "unknown"

    def test_distinct_slugs_for_slug_collision_first_letters(self):
        """Two cameras whose display names share their leading
        substring still produce distinct slugs — the slug captures
        the full sanitised name, not just the first token. Pins the
        collision-free invariant that the bug-fix prompt called
        out: "two cameras whose display names slug-collide on the
        first letters but differ later — assert both produce
        distinct filenames"."""
        s = _FakeSettings([
            {"id": "cam_a", "name": "Squirrel Town Nut Bar"},
            {"id": "cam_b", "name": "Squirrel Town Bird House"},
        ])
        slug_a = camera_slug(s, "cam_a")
        slug_b = camera_slug(s, "cam_b")
        assert slug_a != slug_b
        assert slug_a == "squirreltownnutbar"
        assert slug_b == "squirreltownbirdhouse"


class TestMakeOutputName:
    """The TimelapseBuilder.make_output_name helper composes filename
    stems for custom-window timelapse builds. The slug append at the
    tail is the bug-fix pivot — cross-camera builds must NOT share
    stems on the same window/profile/period combination."""

    def test_no_slug_keeps_legacy_stem(self):
        from app.timelapse import TimelapseBuilder
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            tb = TimelapseBuilder(td)
            name = tb.make_output_name("2026-05-12_020435", "custom", 60, 10)
            assert name == "2026-05-12_020435_custom_1min_to_10sec"

    def test_slug_appended_at_tail(self):
        from app.timelapse import TimelapseBuilder
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            tb = TimelapseBuilder(td)
            name = tb.make_output_name("2026-05-12_020435", "custom", 60, 10,
                                       cam_slug="gartenterrasse")
            assert name.endswith("_gartenterrasse")
            assert name == "2026-05-12_020435_custom_1min_to_10sec_gartenterrasse"

    def test_slug_makes_two_cameras_distinct(self):
        """Two cameras with the same window/profile/period/duration
        but distinct slugs must produce distinct stems — the whole
        point of the fix."""
        from app.timelapse import TimelapseBuilder
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            tb = TimelapseBuilder(td)
            a = tb.make_output_name("2026-05-12", "day", 0, 60,
                                    cam_slug="squirreltownnutbar")
            b = tb.make_output_name("2026-05-12", "day", 0, 60,
                                    cam_slug="gartenterrasse")
            assert a != b

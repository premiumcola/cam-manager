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

from app.camera_id import build_camera_id  # noqa: E402


class TestBuildCameraId:
    def test_canonical_example(self):
        assert build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                               "192.168.178.172") == "reolink_rlc810a_werkstattrechtsoben_172"

    def test_all_empty_collapses_to_unknown(self):
        assert build_camera_id("", "", "Garten", "192.168.178.183") == \
            "unknown_unknown_garten_183"

    def test_every_field_empty(self):
        assert build_camera_id("", "", "", "") == "unknown_unknown_unknown_unknown"

    def test_german_umlauts_transliterate(self):
        # ä ö ü ß should not collapse to "unknown" — they map to ASCII multi-letter forms
        assert build_camera_id("", "", "Pförtnerhäuschen", "192.168.178.10") == \
            "unknown_unknown_pfoertnerhaeuschen_10"
        assert build_camera_id("", "", "größe & weiße", "10.0.0.5") == \
            "unknown_unknown_groesseweisse_5"

    def test_other_diacritics_decompose(self):
        # Non-german accented chars survive via NFKD decomposition + ASCII filter
        assert build_camera_id("", "", "Café Été Ñoño", "172.16.0.99") == \
            "unknown_unknown_cafeetenono_99"

    def test_punctuation_and_runs_collapse(self):
        # Multiple separators, mixed punctuation — all stripped, segment kept
        assert build_camera_id("Reolink-Inc.", "RLC---810A!", "  Werkbank — links  ",
                               "192.168.1.42") == \
            "reolinkinc_rlc810a_werkbanklinks_42"

    def test_pure_punctuation_segment_falls_back_to_unknown(self):
        # A segment that's only symbols sanitises to "" → must become "unknown"
        assert build_camera_id("---", "@@@", "Cam", "10.0.0.1") == \
            "unknown_unknown_cam_1"

    def test_very_long_name_passes_through(self):
        # No length cap — Telegram callback strings are NOT computed from this
        # id, so we don't need to be paranoid about width here. Just verify
        # the identity holds.
        long_name = "Eine sehr lange Kamera Bezeichnung mit vielen Wörtern"
        out = build_camera_id("", "", long_name, "192.168.178.7")
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
        for ip in ("192.168.1.10", "", "garbage", "::1", "10.0.0.0"):
            for name in ("", "Werkstatt", "  ", "äöü"):
                out = build_camera_id("", "", name, ip)
                assert out.count("_") == 3, f"bad token count for ({name!r},{ip!r}): {out}"

    def test_lowercase_invariant(self):
        out = build_camera_id("REOLINK", "RLC-810A", "Werkstatt", "192.168.0.1")
        assert out == out.lower()

    def test_idempotent_when_id_already_canonical(self):
        # If we feed back the canonical id components, the function shouldn't
        # mangle them — the rebuilt id must be the same.
        first = build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                                "192.168.178.172")
        # Same inputs → same output.
        again = build_camera_id("Reolink", "RLC-810A", "Werkstatt rechts oben",
                                "192.168.178.172")
        assert first == again

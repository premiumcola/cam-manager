"""Unit tests for the pure-function helpers in hls_streamer + the
filename allowlist guard in routes/streams.

The full ffmpeg lifecycle isn't exercised here — that needs a real
RTSP source, which lives outside CI. The pieces we CAN test in
isolation are the playlist rewriter (string-in, string-out) and
the segment-name validator (string-in, bool-out)."""
from __future__ import annotations

import sys
from pathlib import Path

# Make ``app`` package importable (mirrors other test files).
_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

from app.hls_streamer import rewrite_playlist  # noqa: E402
from app.routes.streams import _safe_segment_name  # noqa: E402


class TestRewritePlaylist:
    """``rewrite_playlist`` prefixes every relative segment URI with
    ``hls/`` so the routes layout
    ``/api/camera/<cam_id>/hls/<seg.ts>`` matches the playlist's
    references. Comment lines (``#EXTM3U``, ``#EXTINF:1.0,`` etc.)
    pass through unchanged."""

    def test_prefixes_relative_ts_segments(self):
        playlist = (
            b"#EXTM3U\n"
            b"#EXT-X-VERSION:3\n"
            b"#EXT-X-TARGETDURATION:1\n"
            b"#EXTINF:1.000000,\n"
            b"live0.ts\n"
            b"#EXTINF:1.000000,\n"
            b"live1.ts\n"
        )
        out = rewrite_playlist(playlist).decode()
        assert "hls/live0.ts" in out
        assert "hls/live1.ts" in out
        # Comments + headers unchanged.
        assert "#EXTM3U" in out
        assert "#EXT-X-VERSION:3" in out
        assert "#EXTINF:1.000000," in out

    def test_does_not_double_prefix(self):
        # Idempotent — rewriting an already-rewritten playlist should
        # leave the URIs alone (no hls/hls/live0.ts).
        playlist = b"#EXTM3U\nhls/live0.ts\n"
        out = rewrite_playlist(playlist)
        assert b"hls/hls/" not in out
        assert b"hls/live0.ts" in out

    def test_absolute_urls_pass_through(self):
        playlist = (
            b"#EXTM3U\n"
            b"https://cdn.example/live0.ts\n"
            b"/abs/path/live1.ts\n"
        )
        out = rewrite_playlist(playlist)
        assert b"hls/https://" not in out
        assert b"hls//abs/" not in out

    def test_empty_lines_preserved(self):
        playlist = b"#EXTM3U\n\nlive0.ts\n\n"
        out = rewrite_playlist(playlist)
        # Empty lines stay empty (no prefix added).
        assert out.count(b'\n\n') == playlist.count(b'\n\n')


class TestSafeSegmentName:
    """Filename allowlist guard for ``/api/camera/<id>/hls/<file>``.
    ffmpeg only ever emits ``liveN.ts`` so the allowlist is tight;
    explicit ``..`` reject covers any edge case where user-supplied
    paths sneak in."""

    def test_accepts_typical_ffmpeg_names(self):
        assert _safe_segment_name("live0.ts")
        assert _safe_segment_name("live123.ts")
        assert _safe_segment_name("seg_0.ts")
        assert _safe_segment_name("a-b.ts")

    def test_rejects_path_traversal(self):
        assert not _safe_segment_name("../etc/passwd")
        assert not _safe_segment_name("..")
        assert not _safe_segment_name("a/b.ts")
        assert not _safe_segment_name("a\\b.ts")

    def test_rejects_non_ts_extension(self):
        assert not _safe_segment_name("live0.mp4")
        assert not _safe_segment_name("live0")
        assert not _safe_segment_name(".m3u8")

    def test_rejects_special_chars(self):
        assert not _safe_segment_name("live;0.ts")
        assert not _safe_segment_name("live$0.ts")
        assert not _safe_segment_name("live 0.ts")

    def test_rejects_empty(self):
        assert not _safe_segment_name("")

"""Per-camera live preview endpoints — snapshot JPEG, two MJPEG streams,
and the runtime-status echo.

Migrated from server.py during R01.3. The MJPEG generators stay inline
inside their route bodies; lifting the inner generator into a helper
would force its closure over the runtime/settings reference and break
the streaming semantics.
"""

from __future__ import annotations

import logging
import shutil as _shutil_check
import time as _time

import cv2
from flask import Blueprint, Response, jsonify

from .. import app_state, hls_streamer

bp = Blueprint("streams", __name__)


_FFMPEG_AVAILABLE = _shutil_check.which('ffmpeg') is not None


_log = logging.getLogger(__name__)


_SAFE_HLS_SEGMENT_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


def _safe_segment_name(name: str) -> bool:
    """Whitelist filename validation for the HLS segment route. ffmpeg
    only ever emits names like ``live0.ts`` so a tight allowlist is
    enough; an explicit ``..`` reject protects against any edge case
    where a user-supplied path string sneaks in."""
    if not name or '..' in name or '/' in name or '\\' in name:
        return False
    if not name.endswith('.ts'):
        return False
    return all(c in _SAFE_HLS_SEGMENT_CHARS for c in name)


@bp.get('/api/camera/<cam_id>/status')
def api_camera_status(cam_id):
    rt = app_state.runtimes.get(cam_id)
    if not rt:
        return jsonify({"ok": False, "error": "camera not running"}), 404
    s = rt.status()
    s["snap_url"] = f"/api/camera/{cam_id}/snapshot.jpg"
    s["stream_url"] = f"/api/camera/{cam_id}/stream.mjpg"
    s["stream_url_hd"] = f"/api/camera/{cam_id}/stream_hd.mjpg"
    return jsonify(s)


@bp.get('/api/camera/<cam_id>/snapshot.jpg')
def api_camera_snapshot(cam_id):
    rt = app_state.runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    # Brief wait — capture loop normally refills within a frame interval, so
    # transient gaps (post-reconnect, watchdog restart, runtime swap) don't
    # surface as 503 noise in the dashboard's 5 fps refresh loop.
    deadline = _time.monotonic() + 1.5
    data = rt.snapshot_jpeg()
    while not data and _time.monotonic() < deadline:
        _time.sleep(0.05)
        data = rt.snapshot_jpeg()
    if not data:
        return ("no frame", 503)
    return Response(data, mimetype='image/jpeg', headers={'Cache-Control': 'no-store'})


@bp.get('/api/camera/<cam_id>/stream.mjpg')
def api_camera_stream(cam_id):
    """Baseline preview stream — sub-stream quality, ~25fps cap.
    Increments live_viewers while connected so stream_mode reflects active users."""
    rt = app_state.runtimes.get(cam_id)
    if not rt:
        return ("not running", 404)
    rt.add_viewer()

    def gen():
        _interval = 1.0 / 25  # 25 fps cap — avoids busy-spin against shared frame buffer
        try:
            while True:
                t0 = _time.monotonic()
                data = rt.snapshot_jpeg(quality=82)
                if data:
                    yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + data + b'\r\n')
                gap = _interval - (_time.monotonic() - t0)
                if gap > 0:
                    _time.sleep(gap)
        finally:
            rt.remove_viewer()

    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')


@bp.get('/api/camera/<cam_id>/stream_hd.mjpg')
def api_camera_stream_hd(cam_id):
    """Interactive HD stream.

    Preferred path: ffmpeg transcodes the camera's RTSP main stream (H.264 or
    H.265) directly to MJPEG and we pipe that into the HTTP response. This
    avoids OpenCV's flaky H.265 decoder and re-uses the camera's native
    timebase, so playback is smooth and artifact-free.

    Fallback (no ffmpeg binary): read annotated frames from the camera runtime
    preview buffer and re-encode in Python. Slower and may show decode
    artifacts, but keeps the UI functional."""
    cam_cfg = app_state.settings.get_camera(cam_id)
    rt = app_state.runtimes.get(cam_id)
    rtsp_url = (cam_cfg or {}).get("rtsp_url") if cam_cfg else None

    if _FFMPEG_AVAILABLE and rtsp_url:
        import subprocess

        if rt:
            rt.add_viewer()

        def gen_ffmpeg():
            cmd = [
                'ffmpeg',
                '-rtsp_transport',
                'tcp',
                '-i',
                rtsp_url,
                '-vf',
                'fps=15',
                '-q:v',
                '4',
                '-f',
                'mjpeg',
                '-an',
                'pipe:1',
            ]
            proc = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    bufsize=1024 * 1024,
                )
                buf = b''
                while True:
                    chunk = proc.stdout.read(8192)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        start = buf.find(b'\xff\xd8')
                        if start < 0:
                            buf = b''
                            break
                        end = buf.find(b'\xff\xd9', start + 2)
                        if end < 0:
                            # Keep the partial JPEG; wait for more bytes
                            if start > 0:
                                buf = buf[start:]
                            break
                        jpeg = buf[start : end + 2]
                        buf = buf[end + 2 :]
                        yield (b'--frame\r\n' b'Content-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n')
            except GeneratorExit:
                pass
            except Exception as e:
                logging.getLogger(__name__).warning("[%s] HD ffmpeg stream error: %s", cam_id, e)
            finally:
                if proc is not None:
                    try:
                        proc.kill()
                        proc.wait(timeout=2)
                    except Exception:
                        pass
                if rt:
                    rt.remove_viewer()

        return Response(gen_ffmpeg(), mimetype='multipart/x-mixed-replace; boundary=frame')

    # ── Fallback: OpenCV-based re-encode from the runtime preview buffer ────
    if not rt:
        return ("not running", 404)
    rt.add_viewer()

    def gen_opencv():
        _interval = 1.0 / 15
        try:
            while True:
                t0 = _time.monotonic()
                with rt.lock:
                    frame = (
                        rt.preview.copy()
                        if rt.preview is not None
                        else (rt.frame.copy() if rt.frame is not None else None)
                    )
                if frame is not None:
                    ok, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
                    if ok:
                        yield (
                            b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n'
                        )
                gap = _interval - (_time.monotonic() - t0)
                if gap > 0:
                    _time.sleep(gap)
        finally:
            rt.remove_viewer()

    return Response(gen_opencv(), mimetype='multipart/x-mixed-replace; boundary=frame')


@bp.get('/api/camera/<cam_id>/live.m3u8')
def api_camera_hls_playlist(cam_id):
    """HLS playlist — drives the native ``<video>`` element on the
    frontend. Spawns the per-camera ffmpeg subprocess on first hit
    (idempotent) and waits up to 2.5 s for the first playlist to
    appear so the browser doesn't see a 503 on the very first load.
    Per-camera ``streaming.hls_enabled`` setting (default true)
    gates the route so a Pi-grade host can opt a noisy camera out."""
    cam_cfg = app_state.settings.get_camera(cam_id)
    if not cam_cfg:
        return ("camera not found", 404)
    streaming_cfg = cam_cfg.get("streaming") or {}
    if streaming_cfg.get("hls_enabled", True) is False:
        return ("hls disabled for this camera", 503)
    rtsp_url = cam_cfg.get("rtsp_url")
    if not rtsp_url:
        return ("no rtsp_url configured", 404)
    if not _FFMPEG_AVAILABLE:
        return ("ffmpeg not available", 503)
    streamer = hls_streamer.get_or_start(cam_id, rtsp_url)
    streamer.note_fetch()
    pl = streamer.playlist_path
    # ffmpeg takes a few hundred ms to write the first playlist.
    # Wait up to 2.5 s so the first browser load doesn't 503.
    deadline = _time.monotonic() + 2.5
    while not pl.exists() and _time.monotonic() < deadline:
        if not streamer.alive():
            _log.warning("[hls] %s ffmpeg died before first playlist", cam_id)
            return ("hls subprocess died", 503)
        _time.sleep(0.05)
    if not pl.exists():
        return ("hls not ready", 503)
    try:
        body = hls_streamer.rewrite_playlist(pl.read_bytes())
    except Exception as e:
        _log.warning("[hls] %s playlist read failed: %s", cam_id, e)
        return ("hls read failed", 503)
    return Response(
        body,
        mimetype='application/vnd.apple.mpegurl',
        headers={'Cache-Control': 'no-store'},
    )


@bp.get('/api/camera/<cam_id>/hls/<filename>')
def api_camera_hls_segment(cam_id, filename):
    """HLS segment — served from the per-camera tmp dir that the
    streamer's ffmpeg writes into. Strict filename allowlist so the
    route can't be coaxed into reading arbitrary files."""
    if not _safe_segment_name(filename):
        return ("bad filename", 400)
    streamer = hls_streamer.get(cam_id)
    if streamer is None:
        return ("streamer not running", 404)
    streamer.note_fetch()
    seg = streamer.segment_path(filename)
    if not seg.exists():
        return ("segment not found", 404)
    try:
        body = seg.read_bytes()
    except Exception as e:
        _log.warning("[hls] %s segment read failed: %s", cam_id, e)
        return ("segment read failed", 503)
    return Response(
        body,
        mimetype='video/mp2t',
        headers={'Cache-Control': 'no-store'},
    )

"""Per-camera HLS streamer — one ffmpeg subprocess per active camera,
viewers share the same playlist + segments, auto-teardown after 30 s
without a fetch.

Sits alongside the existing MJPEG endpoints in ``routes/streams.py``.
The MJPEG path keeps working for clients that can't (or won't) do
HLS; the new ``/api/camera/<cam_id>/live.m3u8`` + ``…/hls/<seg.ts>``
routes drive the native ``<video>`` element on the frontend so the
browser's built-in Play / Pause / Picture-in-Picture / native
fullscreen controls Just Work.

ffmpeg invocation (per prompt spec):
    ffmpeg -nostdin -fflags +genpts -rtsp_transport tcp
           -i <rtsp_url>
           -c:v copy -an
           -hls_time 1 -hls_list_size 4
           -hls_flags delete_segments+omit_endlist+independent_segments
           -hls_segment_type mpegts
           -f hls /tmp/hls/<cam_id>/live.m3u8

``-c:v copy`` avoids re-encoding (Reolink already streams H.264 via
RTSP). If a camera ever turns out to need transcoding, callers can
swap the codec args by writing a custom ``ffmpeg_args`` setting on
the camera record — out of scope for this commit.

Threading model:
- One subprocess per camera, indexed by cam_id in ``_streamers``.
- ``_registry_lock`` guards the dict + each streamer's start/stop.
- A daemon ``_sweeper_loop`` polls every 5 s and tears down any
  streamer whose last_fetch is older than ``_IDLE_SECONDS``.
- Request threads call ``note_fetch()`` on every playlist / segment
  hit to keep the streamer alive.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
from pathlib import Path

log = logging.getLogger("hls_streamer")

# Idle-teardown grace period — when last_fetch is older than this,
# the sweeper kills ffmpeg and removes the tmp dir. Per prompt: 30 s.
_IDLE_SECONDS = 30.0
# Sweeper poll interval — how often the daemon thread checks idle.
_SWEEP_INTERVAL = 5.0
# Where each camera's playlist + segments live. ffmpeg writes there
# directly; the routes read from the same path.
_TMP_ROOT = Path("/tmp/hls")


class HLSStreamer:
    """Owns one ffmpeg subprocess for a single camera. Idempotent
    ``start()`` so a route handler can call it on every request
    without spawning duplicate processes."""

    def __init__(self, cam_id: str, rtsp_url: str):
        self.cam_id = cam_id
        self.rtsp_url = rtsp_url
        self.dir = _TMP_ROOT / cam_id
        self.proc: subprocess.Popen | None = None
        self.last_fetch = time.monotonic()
        self._proc_lock = threading.Lock()

    @property
    def playlist_path(self) -> Path:
        return self.dir / "live.m3u8"

    def segment_path(self, filename: str) -> Path:
        return self.dir / filename

    def start(self) -> None:
        """Spawn ffmpeg if it isn't already running. Cheap on the
        hot path — checks proc.poll() under a tight lock before
        spending any work."""
        with self._proc_lock:
            if self.proc is not None and self.proc.poll() is None:
                return
            self.dir.mkdir(parents=True, exist_ok=True)
            cmd = [
                "ffmpeg", "-nostdin", "-fflags", "+genpts",
                "-rtsp_transport", "tcp",
                "-i", self.rtsp_url,
                "-c:v", "copy", "-an",
                "-hls_time", "1", "-hls_list_size", "4",
                "-hls_flags",
                "delete_segments+omit_endlist+independent_segments",
                "-hls_segment_type", "mpegts",
                "-f", "hls", str(self.playlist_path),
            ]
            log.info("[hls_streamer] %s spawning ffmpeg → %s",
                     self.cam_id, self.playlist_path)
            try:
                self.proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception as e:
                log.warning("[hls_streamer] %s spawn failed: %s",
                            self.cam_id, e)
                self.proc = None

    def note_fetch(self) -> None:
        self.last_fetch = time.monotonic()

    def is_idle(self) -> bool:
        return (time.monotonic() - self.last_fetch) > _IDLE_SECONDS

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def stop(self) -> None:
        """Terminate the subprocess and remove the tmp dir. Safe to
        call multiple times; idempotent."""
        with self._proc_lock:
            if self.proc is not None:
                try:
                    self.proc.terminate()
                    try:
                        self.proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                        try:
                            self.proc.wait(timeout=2)
                        except Exception:
                            pass
                except Exception as e:
                    log.warning("[hls_streamer] %s stop failed: %s",
                                self.cam_id, e)
                self.proc = None
            try:
                if self.dir.exists():
                    shutil.rmtree(self.dir, ignore_errors=True)
            except Exception as e:
                log.debug("[hls_streamer] %s cleanup failed: %s",
                          self.cam_id, e)


# Registry — module-level dict of HLSStreamer keyed by cam_id.
_streamers: dict[str, HLSStreamer] = {}
_registry_lock = threading.Lock()
_sweeper_started = False


def get_or_start(cam_id: str, rtsp_url: str) -> HLSStreamer:
    """Idempotent — returns the live streamer for ``cam_id``,
    spawning a fresh one on first call (or when ``rtsp_url`` has
    changed, e.g. after a settings edit that swapped the camera's
    address)."""
    with _registry_lock:
        s = _streamers.get(cam_id)
        if s is None or s.rtsp_url != rtsp_url:
            if s is not None:
                s.stop()
            s = HLSStreamer(cam_id, rtsp_url)
            _streamers[cam_id] = s
        s.start()
        _ensure_sweeper()
        return s


def get(cam_id: str) -> HLSStreamer | None:
    """Lookup without start — used by the segment route, where the
    playlist route is responsible for spawning the subprocess."""
    with _registry_lock:
        return _streamers.get(cam_id)


def stop_all() -> None:
    """Tear down every active streamer — used by tests + shutdown
    hooks."""
    with _registry_lock:
        for s in list(_streamers.values()):
            s.stop()
        _streamers.clear()


def _ensure_sweeper() -> None:
    """First-call wiring for the sweeper thread. Subsequent calls
    no-op. Lazy so unit tests can import the module without the
    daemon thread firing."""
    global _sweeper_started
    if _sweeper_started:
        return
    _sweeper_started = True
    t = threading.Thread(target=_sweeper_loop, name="hls-sweeper",
                         daemon=True)
    t.start()


def _sweeper_loop() -> None:
    while True:
        time.sleep(_SWEEP_INTERVAL)
        try:
            with _registry_lock:
                idle = [cid for cid, s in _streamers.items() if s.is_idle()]
            for cid in idle:
                with _registry_lock:
                    s = _streamers.pop(cid, None)
                if s is not None:
                    log.info(
                        "[hls_streamer] %s idle %.0fs — tearing down",
                        cid, time.monotonic() - s.last_fetch,
                    )
                    s.stop()
        except Exception as e:
            log.warning("[hls_streamer] sweeper iteration failed: %s", e)


def rewrite_playlist(content: bytes) -> bytes:
    """ffmpeg emits relative segment URIs (``live0.ts``, …). The
    route layout exposes segments at ``/hls/<filename>``, so prefix
    every non-comment, non-absolute line so the browser resolves the
    URIs correctly. Pure function — unit-testable without spawning
    ffmpeg."""
    out: list[bytes] = []
    for line in content.split(b'\n'):
        stripped = line.strip()
        if (stripped
                and not stripped.startswith(b'#')
                and not stripped.startswith(b'http')
                and not stripped.startswith(b'/')
                and not stripped.startswith(b'hls/')):
            line = b'hls/' + stripped
        out.append(line)
    return b'\n'.join(out)

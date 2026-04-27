"""Centralised logging setup for tam-spy.

server.py imports ``setup_logging`` and ``log_buffer`` from this module —
nothing else does any direct logging configuration. Console output goes to
stderr with a compact `HH:MM:SS.mmm LEVEL logger msg` format that's still
parseable by `docker logs` and the Logs tab; the in-memory buffer used by
the web UI keeps its existing shape so the API doesn't change.

Tag conventions (placed in the message body, not the logger name):

    [boot]      server bootstrap, migration, runtime build
    [cam:<id>]  per-camera runtime (capture, motion, recording)
    [det]       object / bird / wildlife detection
    [tg]        Telegram bot
    [weather]   WeatherService
    [storage]   EventStore + media scan + cleanup
    [migration] storage_migration
    [timelapse] timelapse capture + builder
    [mqtt]      MQTTService
    [heartbeat] periodic summaries
"""
from __future__ import annotations
import logging
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime


# ── In-memory ring buffer for the web-UI Logs tab ──────────────────────────
class _LogBuffer(logging.Handler):
    """Last-N records, returned by /api/logs. Format is intentionally
    minimal so the JS side can render its own coloured rows. Kept in a
    deque so emit() is O(1) regardless of buffer size."""

    def __init__(self, maxlen: int = 400):
        super().__init__()
        self.setFormatter(logging.Formatter("%(message)s"))
        self._records: deque = deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord):
        try:
            self._records.append({
                "ts": datetime.fromtimestamp(record.created).strftime("%H:%M:%S"),
                "level": record.levelname,
                "logger": record.name,
                "msg": self.format(record),
            })
        except Exception:
            pass

    def get(self, min_level: int = logging.DEBUG) -> list:
        return [r for r in self._records
                if logging.getLevelName(r["level"]) >= min_level]


log_buffer = _LogBuffer()


# ── Rate-limit filter (WARNING+ only) ──────────────────────────────────────
class RateLimitFilter(logging.Filter):
    """Suppresses repeated identical messages from the same logger within
    a sliding window. After the window closes, emits a single coalesced
    "[…repeated N×]" line so the operator knows the underlying condition
    didn't disappear silently.

    Applies only to records at WARNING level or higher — INFO/DEBUG flow
    through unconditionally because their volume is what makes the timeline
    readable."""

    def __init__(self, window_s: float = 30.0):
        super().__init__()
        self._window = window_s
        self._lock = threading.Lock()
        # key = (logger_name, message-template) → [last_emit_ts, suppressed_n]
        self._state: dict[tuple[str, str], list] = {}

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.WARNING:
            return True
        # Use the raw msg template (before % args formatting) as the key
        # so "Garten offline" with different timestamps still collapses.
        key = (record.name, str(record.msg))
        now = time.time()
        with self._lock:
            ent = self._state.get(key)
            if ent is None or (now - ent[0]) >= self._window:
                # First in window OR window expired. If a previous window
                # had suppressed records, surface the count once.
                if ent is not None and ent[1] > 0:
                    coal = ent[1]
                    self._state[key] = [now, 0]
                    # Augment the message in place (logging passes by ref).
                    try:
                        record.msg = f"{record.msg} […repeated {coal}×]"
                    except Exception:
                        pass
                else:
                    self._state[key] = [now, 0]
                return True
            # Inside the suppression window — bump counter, drop record.
            ent[1] += 1
            return False


# ── Setup ──────────────────────────────────────────────────────────────────
def _resolve_level() -> int:
    raw = (os.environ.get("LOG_LEVEL") or "INFO").upper().strip()
    return getattr(logging, raw, logging.INFO)


_DONE = False


def setup_logging():
    """Idempotent. Installs a single console handler + the in-memory buffer
    on the root logger and silences known-noisy library loggers. Subsequent
    calls return without duplicating handlers."""
    global _DONE
    if _DONE:
        return
    _DONE = True
    root = logging.getLogger()
    # Wipe any handlers a parent process or a prior import set up. We own
    # the root logger from this point on.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(logging.DEBUG)  # buffer wants everything; console gates on its own level
    fmt = logging.Formatter(
        "%(asctime)s.%(msecs)03d %(levelname)-5s %(name)-22s %(message)s",
        datefmt="%H:%M:%S",
    )
    console = logging.StreamHandler(stream=sys.stderr)
    console.setFormatter(fmt)
    console.setLevel(_resolve_level())
    root.addHandler(console)
    # Buffer keeps its existing message-only format so the UI doesn't
    # have to reparse to render its own coloured rows.
    root.addHandler(log_buffer)
    # Throttle WARNING+ duplicates so a flapping camera or weather
    # outage can't drown the live tail.
    root.addFilter(RateLimitFilter(window_s=30.0))
    # Silence libraries that flood at INFO/DEBUG. apscheduler is added
    # because its job-fired/job-completed pair every 60 s is far below
    # the noise floor we care about.
    for noisy, lvl in [
        ("urllib3",      logging.WARNING),
        ("werkzeug",     logging.WARNING),
        ("httpx",        logging.WARNING),
        ("httpcore",     logging.WARNING),
        ("telegram",     logging.WARNING),
        ("apscheduler",  logging.WARNING),
        ("PIL",          logging.WARNING),
        ("matplotlib",   logging.WARNING),
        ("asyncio",      logging.WARNING),
    ]:
        logging.getLogger(noisy).setLevel(lvl)


def console_level() -> int:
    """Helper for boot-time inventory — surfaces the actually-applied level
    so the [boot] line tells the operator what got picked up."""
    return _resolve_level()

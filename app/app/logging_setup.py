"""Centralised logging setup for tam-spy.

server.py imports ``setup_logging`` and ``log_buffer`` from this module —
nothing else does any direct logging configuration. Console output goes to
stderr with a compact `HH:MM:SS.mmm LEVEL logger msg` format that's still
parseable by `docker logs` and the Logs tab; the in-memory buffer used by
the web UI keeps its existing shape so the API doesn't change.

Tag conventions (placed in the message body, not the logger name):

    [boot]         server bootstrap, migration, runtime build
    [cam:<id>]     per-camera runtime (capture, motion, recording)
    [det]          object / bird / wildlife detection
    [tg]           Telegram bot
    [weather]      WeatherService
    [sun-tl-test]  ad-hoc sunrise/sunset timelapse test runner
    [storage]      EventStore + media scan + cleanup
    [migration]    storage_migration
    [timelapse]    timelapse capture + builder
    [mqtt]         MQTTService
    [heartbeat]    periodic summaries
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


# ── Burst rate-limit filter (WARNING+ only) ────────────────────────────────
class BurstRateLimitFilter(logging.Filter):
    """Lets the first N records of an identical message through within a
    sliding window, then suppresses further duplicates and emits a single
    "[…repeated K×]" summary at window close.

    Attached to the HANDLERS, not the root logger — Logger.addFilter()
    only filters records emitted directly on that logger, but every
    record in this codebase goes through ``logging.getLogger(__name__)``
    children, so a root-attached filter never sees them. The handlers
    on the other hand see every propagated record.

    Both handlers share the same filter instance so the suppression
    state is unified — otherwise a console-suppressed record could
    still flood the in-memory buffer (and the web UI's log panel)."""

    def __init__(self, burst_n: int = 3, window_s: float = 30.0):
        super().__init__()
        self._burst_n = max(1, int(burst_n))
        self._window = float(window_s)
        self._lock = threading.Lock()
        # key = (logger_name, msg_template)
        # value = [window_start_ts, emitted_count, suppressed_count, levelno]
        self._state: dict[tuple[str, str], list] = {}
        # Handlers we should send "[…repeated K×]" summaries to. Set via
        # attach_handlers() once the handler chain is built.
        self._summary_targets: list[logging.Handler] = []
        self._sweeper_started = False

    def attach_handlers(self, handlers):
        """Register the handlers that should receive coalesced summary
        records emitted by the background sweeper. Idempotent."""
        self._summary_targets = list(handlers)
        if not self._sweeper_started:
            self._sweeper_started = True
            threading.Thread(
                target=self._sweep_loop, daemon=True,
                name="logfilter-sweep",
            ).start()

    def filter(self, record: logging.LogRecord) -> bool:
        # INFO/DEBUG flow through unconditionally — their volume is
        # what makes the timeline readable.
        if record.levelno < logging.WARNING:
            return True
        # Use the raw msg template (before % args formatting) as the key
        # so different timestamps on the same warning still collapse.
        key = (record.name, str(record.msg))
        now = time.time()
        with self._lock:
            ent = self._state.get(key)
            if ent is None:
                self._state[key] = [now, 1, 0, record.levelno]
                return True
            window_start, emitted, suppressed, _level = ent
            if (now - window_start) >= self._window:
                # Window expired. The sweeper may have already emitted
                # the summary; if not, do it inline now so the
                # transition is visible.
                if suppressed > 0:
                    self._emit_summary_locked(key, ent)
                # Start a fresh window with this record as #1 of the burst.
                self._state[key] = [now, 1, 0, record.levelno]
                return True
            if emitted < self._burst_n:
                ent[1] = emitted + 1
                return True
            # Inside window AND already past the burst quota → suppress.
            ent[2] = suppressed + 1
            return False

    def _emit_summary_locked(self, key, ent):
        """Emit a "[…repeated K×]" summary record directly to every
        registered handler, then reset the entry's suppressed counter.
        Caller MUST hold self._lock. Bypasses Handler.handle() so this
        filter doesn't see the synthetic record again."""
        suppressed = ent[2]
        if suppressed <= 0:
            return
        logger_name, original_msg = key
        msg = f"[…repeated {suppressed}× in last {int(self._window)}s] {original_msg}"
        rec = logging.LogRecord(
            name=logger_name, level=ent[3], pathname="", lineno=0,
            msg=msg, args=None, exc_info=None,
        )
        for h in self._summary_targets:
            try:
                if rec.levelno >= h.level:
                    h.emit(rec)
            except Exception:
                pass
        ent[2] = 0

    def _sweep_loop(self):
        """Wakes once per second and flushes summary lines for any key
        whose window has closed with suppressions outstanding. Without
        this, a key that goes quiet for good never reports its tail."""
        while True:
            time.sleep(1.0)
            now = time.time()
            with self._lock:
                for key, ent in list(self._state.items()):
                    if (now - ent[0]) >= self._window and ent[2] > 0:
                        self._emit_summary_locked(key, ent)
                        # Reset the window so the next burst starts fresh.
                        ent[0] = now
                        ent[1] = 0


# Backwards-compat alias — older import sites (if any) referenced the
# previous class name. The new behaviour subsumes the old.
RateLimitFilter = BurstRateLimitFilter


# ── Setup ──────────────────────────────────────────────────────────────────
def _resolve_level() -> int:
    raw = (os.environ.get("LOG_LEVEL") or "INFO").upper().strip()
    return getattr(logging, raw, logging.INFO)


def _resolve_burst_n() -> int:
    try:
        return max(1, int(os.environ.get("LOG_BURST_N", "3")))
    except (TypeError, ValueError):
        return 3


def _resolve_window_s() -> float:
    try:
        return max(1.0, float(os.environ.get("LOG_WINDOW_S", "30")))
    except (TypeError, ValueError):
        return 30.0


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
    # Burst rate-limit (3 lines then quiet, summary at window close).
    # Attached to the handlers themselves — a root-logger filter never
    # fires on records that reach root via getLogger(__name__) → propagation.
    # Both handlers share the SAME filter instance so suppression is unified.
    rate_filter = BurstRateLimitFilter(
        burst_n=_resolve_burst_n(),
        window_s=_resolve_window_s(),
    )
    console.addFilter(rate_filter)
    log_buffer.addFilter(rate_filter)
    rate_filter.attach_handlers([console, log_buffer])
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

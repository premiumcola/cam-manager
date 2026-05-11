"""Filesystem helpers shared across services.

Hosts ``atomic_write_json`` — the single consolidation point for
crash-safe JSON writes. Two near-identical helpers had been
co-existing (``bird_dossiers._atomic_write_json`` and
``weather_service._consts._atomic_write_json``); future call sites
land here so we don't grow a third.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


def atomic_write_json(path: Path, payload: Any, *, indent: int = 2) -> None:
    """Write ``payload`` as JSON to ``path`` atomically.

    Pattern: write to a temp file in the same directory, then
    ``os.replace`` over the target. This guarantees a concurrent
    reader sees either the previous version or the new one — never
    a truncated mid-write file, even if the process is killed
    between ``open`` and ``close``.

    The temp file name carries the writer's pid + tid so two
    threads racing to update the same file don't trample each
    other's temp blob (the underlying issue that motivated the
    weather_service variant of this helper).
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=indent),
        encoding="utf-8",
    )
    os.replace(str(tmp), str(path))

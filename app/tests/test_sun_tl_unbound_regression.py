"""Regression test for the UnboundLocalError on ``stats``.

A previous validator-stabilisation pass added baseline-sample +
profile-mirror code BEFORE the ``stats = CaptureStats(...)`` line,
so any sun-tl test run hit:

    cannot access local variable 'stats' where it is not
    associated with a value

This test walks _run_sun_capture_inner end-to-end with stub
runtime + filesystem so the ordering invariant is checked
mechanically. If a future refactor moves the assignment back below
a stats reference, this test fails fast.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

# Make `app` package importable (same trick as the other tests).
_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)


def test_run_sun_capture_inner_does_not_raise(tmp_path, monkeypatch):
    """A cancelled-at-start test session walks through profile pick →
    stats init → cancellation branch without raising. Pre-fix this
    blew up with UnboundLocalError between profile-log and the
    stats assignment."""
    import cv2
    import numpy as np

    from app.weather_service._sun_tl import (  # noqa: E402
        SunTimelapseMixin,
        _SunTLTestSession,
    )

    # Stubs ----------------------------------------------------------
    class StubRT:
        """Returns a mid-grey JPEG for every snapshot call. Mid-grey
        is enough to drive the picker into TWILIGHT (the same path
        the live crash exercised) without needing a real camera."""
        def snapshot_jpeg_hires(self, quality: int = 85):
            grey = np.full((480, 640, 3), 80, dtype=np.uint8)
            ok, buf = cv2.imencode(".jpg", grey, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
            return buf.tobytes() if ok else None

    class FakeWS(SunTimelapseMixin):
        def __init__(self):
            self.runtimes = {"cam1": StubRT()}
            self.cfg = {"cameras": [{"id": "cam1", "name": "Cam One"}]}
            self.server_cfg = {"location": {"lat": 50, "lon": 8}}
            self.settings_store = None

        # Methods normally provided by the other WeatherService mixins.
        def _cam_name(self, cam_id):
            return "Cam One"

        def _cfg_cameras(self):
            return self.cfg["cameras"]

        def _sightings_dir(self):
            p = tmp_path / "weather"
            p.mkdir(parents=True, exist_ok=True)
            return p

        def _sun_position(self):
            return {"altitude": 0.0, "azimuth": 0.0}

        def _latest_api_snapshot_safe(self):
            return {}

        def _maybe_push_telegram(self, *_a, **_kw):
            pass

    # Drop the 0.5 s baseline-sample sleeps so the test runs in well
    # under a second.
    import app.weather_service._sun_tl as sun_tl_mod  # noqa: E402
    monkeypatch.setattr(sun_tl_mod.time, "sleep", lambda *_a, **_kw: None)

    ws = FakeWS()
    session = _SunTLTestSession(
        cam_id="cam1",
        phase="sunset",
        duration_s=15,
        started_at=datetime.now(),
        expected_frames=5,
    )
    # Pre-set cancellation so the slot loop exits immediately on the
    # very first iteration — we only care that the path THROUGH the
    # stats assignment doesn't UnboundLocalError. With a real loop
    # the test would burn 15 s waiting for the window to elapse.
    session.cancel_requested = True

    # Sun event = "now" so the drift guard is happy.
    sun_dt = datetime.now()

    # Must not raise.
    ws._run_sun_capture_inner(
        "cam1", "sunset", sun_dt,
        {"interval_s": 3, "fps": 25},
        test_session=session,
    )

    # Sanity: the cancelled branch ran (sets error="abgebrochen") and
    # final_stats was populated before the rename happened.
    assert session.cancelled is True
    assert session.error == "abgebrochen"
    assert session.final_stats is not None
    assert session.final_stats.get("validator_profile") in {"day", "twilight", "night"}

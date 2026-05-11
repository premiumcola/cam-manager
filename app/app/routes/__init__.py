"""Per-domain Flask blueprints carved out of server.py.

The split runs in stages (R01.2 → R01.5). At each stage, server.py
calls `register_blueprints(app)` once after the Flask app is built and
after `app_state` is wired up. Blueprints reach shared state via
`from .. import app_state` — never via `from ..server import ...`,
since that would close a circular-import loop.

The one-way exception: a handful of routes need the boot helpers
`rebuild_runtimes` / `restart_single_camera`, which still live in
server.py. Those imports are lazy (inside the route function body) to
avoid the import-time cycle. R01.6 cleans this up by relocating the
boot helpers out of server.py.
"""
from __future__ import annotations


def register_blueprints(app) -> None:
    """Register every route blueprint shipped under app/app/routes/.

    Imported from `server.py` exactly once during boot. New blueprints
    appended here follow the same rule: each one carries its own
    `/api/...` paths internally (no `url_prefix=` on the registration
    side) so the URL space remains identical to the pre-split layout.
    """
    from . import (
        admin,
        bootstrap,
        cameras,
        coral,
        detection_cloud,
        events,
        media,
        sichtungen,
        streams,
        telegram,
        timelapse,
        timeline_stats,
        tracking,
        weather,
    )
    app.register_blueprint(tracking.bp)
    app.register_blueprint(sichtungen.bp)
    app.register_blueprint(admin.bp)
    app.register_blueprint(bootstrap.bp)
    app.register_blueprint(cameras.bp)
    app.register_blueprint(streams.bp)
    app.register_blueprint(media.bp)
    app.register_blueprint(events.bp)
    app.register_blueprint(timeline_stats.bp)
    app.register_blueprint(timelapse.bp)
    app.register_blueprint(coral.bp)
    app.register_blueprint(weather.bp)
    app.register_blueprint(telegram.bp)
    app.register_blueprint(detection_cloud.bp)

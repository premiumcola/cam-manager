"""
Unit tests for rebuild_runtimes() diff-based camera reload.

All three diff cases are covered:
  - remove: runtime exists but camera gone/disabled in new config
  - add:    camera enabled in new config but no runtime yet
  - restart: runtime exists and camera still enabled, but config changed
  - no-op:  runtime exists, config unchanged → must NOT be touched
"""
import sys
import copy
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock, patch, call

# ─────────────────────────────────────────────────────────────────────────────
# Pre-stub all heavy deps BEFORE importing server.py
# (server.py runs module-level code on import; mocks prevent real I/O)
# ─────────────────────────────────────────────────────────────────────────────

_tmpdir = tempfile.mkdtemp(prefix="tam-test-")

_BASE_CFG = {
    "storage": {"root": _tmpdir, "retention_days": 14},
    "server": {"host": "0.0.0.0", "port": 8099},
    "cameras": [],
    "processing": {"detection": {"mode": "none"}, "bird_species": {"enabled": False},
                   "cat_identity": {"match_threshold": 10},
                   "person_identity": {"match_threshold": 10}},
    "telegram": {},
    "mqtt": {},
    "app": {},
    "ui": {},
}


def _make_stub(name: str) -> MagicMock:
    m = MagicMock()
    m.__name__ = name
    m.__file__ = f"<stub:{name}>"
    m.__spec__ = types.SimpleNamespace(name=name)
    sys.modules[name] = m
    return m


for _pkg in ("cv2", "requests", "numpy"):
    sys.modules.setdefault(_pkg, _make_stub(_pkg))

# Flask: app.jinja_env must support attribute assignment
if "flask" not in sys.modules:
    _flask = _make_stub("flask")
    _flask_app_inst = MagicMock()
    _flask_app_inst.jinja_env = MagicMock()
    _flask.Flask.return_value = _flask_app_inst

# app.config_loader
_cl_mod = _make_stub("app.config_loader")
_cl_mod.load_config = MagicMock(return_value=copy.deepcopy(_BASE_CFG))

# app.settings_store
_ss_inst = MagicMock()
_ss_inst.export_effective_config.return_value = copy.deepcopy(_BASE_CFG)
_ss_inst.data = {"cameras": [], "telegram_actions": []}
_ss_inst.bootstrap_state.return_value = {"needs_wizard": False}
_ss_inst.get_camera.return_value = None
_ss_mod = _make_stub("app.settings_store")
_ss_mod.SettingsStore.return_value = _ss_inst

# app.storage
_ev_store_inst = MagicMock()
_ev_store_inst.events_dir = Path(_tmpdir) / "events"
_st_mod = _make_stub("app.storage")
_st_mod.EventStore.return_value = _ev_store_inst

# app.camera_runtime
_cr_mod = _make_stub("app.camera_runtime")
_cr_mod._PROFILES = ("daily", "weekly", "monthly", "custom")
_cr_mod._PROFILE_PERIOD_DEFAULTS = {"daily": 86400, "weekly": 604800, "monthly": 2592000, "custom": 600}

# app.telegram_bot
_tg_inst = MagicMock()
_tg_inst.enabled = False
_tb_mod = _make_stub("app.telegram_bot")
_tb_mod.TelegramService.return_value = _tg_inst

# app.cat_identity
_ci_mod = _make_stub("app.cat_identity")
_ci_mod.IdentityRegistry.return_value = MagicMock()

# app.timelapse
_tl_mod = _make_stub("app.timelapse")
_tl_mod.TimelapseBuilder.return_value = MagicMock()

# remaining app sub-modules
for _m in ("app.discovery", "app.mqtt_service", "app.detectors", "app.event_logic"):
    _make_stub(_m)

_mq_inst = MagicMock()
sys.modules["app.mqtt_service"].MQTTService.return_value = _mq_inst

# Ensure D:\…\tam-spy\app is on sys.path so `import app.server` resolves
_pkg_root = str(Path(__file__).parent.parent)
if _pkg_root not in sys.path:
    sys.path.insert(0, _pkg_root)

# Import server — module-level rebuild_runtimes() runs with empty cameras (no-op)
import app.server as server  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _fake_runtime(cam_id: str) -> MagicMock:
    rt = MagicMock()
    rt.camera_id = cam_id
    return rt


def _setup(monkeypatch, existing: dict[str, dict], new_cameras: list[dict]):
    """
    existing: {cam_id: cfg_dict} → populate runtimes + _runtime_cfgs
    new_cameras: list of camera dicts returned by get_effective_config
    """
    # Clear and repopulate server state
    server.runtimes.clear()
    server._runtime_cfgs.clear()

    fake_rts = {}
    for cam_id, cfg_dict in existing.items():
        rt = _fake_runtime(cam_id)
        server.runtimes[cam_id] = rt
        server._runtime_cfgs[cam_id] = copy.deepcopy(cfg_dict)
        fake_rts[cam_id] = rt

    # Effective config returns the new camera list
    new_cfg = {**_BASE_CFG, "cameras": new_cameras}
    monkeypatch.setattr(server, "get_effective_config", lambda: copy.deepcopy(new_cfg))
    monkeypatch.setattr(server, "rebuild_services", MagicMock())
    monkeypatch.setattr(server, "cfg", copy.deepcopy(new_cfg))

    # get_camera_cfg returns the matching dict from new_cameras
    new_by_id = {c["id"]: c for c in new_cameras}
    monkeypatch.setattr(server, "get_camera_cfg", lambda cam_id: new_by_id.get(cam_id))

    # CameraRuntime constructor → fresh mock
    new_rt_mock = MagicMock()
    monkeypatch.setattr(server, "CameraRuntime", MagicMock(return_value=new_rt_mock))

    # mqtt_service publish is a no-op mock
    monkeypatch.setattr(server, "mqtt_service", MagicMock())

    return fake_rts, new_rt_mock


# ─────────────────────────────────────────────────────────────────────────────
# Tests for _compute_camera_diff (pure logic)
# ─────────────────────────────────────────────────────────────────────────────

class TestComputeCameraDiff:
    def test_remove(self):
        to_remove, to_add, to_restart = server._compute_camera_diff(
            current_ids={"a", "b"},
            current_cfgs={"a": {"id": "a"}, "b": {"id": "b"}},
            new_cam_cfgs={"a": {"id": "a"}},
        )
        assert to_remove == {"b"}
        assert to_add == set()
        assert to_restart == set()

    def test_add(self):
        to_remove, to_add, to_restart = server._compute_camera_diff(
            current_ids={"a"},
            current_cfgs={"a": {"id": "a"}},
            new_cam_cfgs={"a": {"id": "a"}, "b": {"id": "b"}},
        )
        assert to_remove == set()
        assert to_add == {"b"}
        assert to_restart == set()

    def test_restart_on_config_change(self):
        to_remove, to_add, to_restart = server._compute_camera_diff(
            current_ids={"a"},
            current_cfgs={"a": {"id": "a", "rtsp_url": "rtsp://old"}},
            new_cam_cfgs={"a": {"id": "a", "rtsp_url": "rtsp://new"}},
        )
        assert to_remove == set()
        assert to_add == set()
        assert to_restart == {"a"}

    def test_no_op_when_config_unchanged(self):
        cfg = {"id": "a", "rtsp_url": "rtsp://same"}
        to_remove, to_add, to_restart = server._compute_camera_diff(
            current_ids={"a"},
            current_cfgs={"a": copy.deepcopy(cfg)},
            new_cam_cfgs={"a": copy.deepcopy(cfg)},
        )
        assert to_remove == set()
        assert to_add == set()
        assert to_restart == set()


# ─────────────────────────────────────────────────────────────────────────────
# Integration tests: rebuild_runtimes() orchestration
# ─────────────────────────────────────────────────────────────────────────────

class TestRebuildRuntimes:
    def test_remove_stops_runtime(self, monkeypatch):
        """Camera gone from config → runtime removed from dicts."""
        _setup(
            monkeypatch,
            existing={"cam1": {"id": "cam1", "enabled": True}},
            new_cameras=[],  # cam1 no longer in config
        )
        server.rebuild_runtimes()
        assert "cam1" not in server.runtimes
        assert "cam1" not in server._runtime_cfgs

    def test_remove_calls_stop(self, monkeypatch):
        """Verify stop() is called on the removed runtime object."""
        fake_rts, _ = _setup(
            monkeypatch,
            existing={"cam1": {"id": "cam1", "enabled": True}},
            new_cameras=[],
        )
        server.rebuild_runtimes()
        fake_rts["cam1"].stop.assert_called_once()

    def test_add_starts_new_runtime(self, monkeypatch):
        """New camera in config → CameraRuntime created and started."""
        _, new_rt = _setup(
            monkeypatch,
            existing={},
            new_cameras=[{"id": "cam1", "enabled": True, "rtsp_url": "rtsp://x"}],
        )
        server.rebuild_runtimes()
        assert "cam1" in server.runtimes
        new_rt.start.assert_called_once()

    def test_restart_when_config_changed(self, monkeypatch):
        """Config change → old runtime stopped, new one started."""
        old_cfg = {"id": "cam1", "enabled": True, "rtsp_url": "rtsp://old"}
        new_cfg = {"id": "cam1", "enabled": True, "rtsp_url": "rtsp://new"}
        fake_rts, new_rt = _setup(
            monkeypatch,
            existing={"cam1": old_cfg},
            new_cameras=[new_cfg],
        )
        server.rebuild_runtimes()
        fake_rts["cam1"].stop.assert_called_once()
        new_rt.start.assert_called_once()

    def test_no_restart_when_config_unchanged(self, monkeypatch):
        """Unchanged config → runtime must not be stopped or replaced."""
        cam_cfg = {"id": "cam1", "enabled": True, "rtsp_url": "rtsp://same"}
        fake_rts, new_rt = _setup(
            monkeypatch,
            existing={"cam1": cam_cfg},
            new_cameras=[copy.deepcopy(cam_cfg)],
        )
        server.rebuild_runtimes()
        fake_rts["cam1"].stop.assert_not_called()
        new_rt.start.assert_not_called()
        assert server.runtimes["cam1"] is fake_rts["cam1"]


# ─────────────────────────────────────────────────────────────────────────────
# Integration tests: restart_single_camera()
# ─────────────────────────────────────────────────────────────────────────────

class TestRestartSingleCamera:
    def test_stops_existing_and_starts_new(self, monkeypatch):
        old_cfg = {"id": "cam1", "enabled": True, "rtsp_url": "rtsp://x"}
        fake_rts, new_rt = _setup(
            monkeypatch,
            existing={"cam1": old_cfg},
            new_cameras=[old_cfg],
        )
        server.restart_single_camera("cam1")
        fake_rts["cam1"].stop.assert_called_once()
        new_rt.start.assert_called_once()

    def test_snapshot_stored_after_restart(self, monkeypatch):
        cam_cfg = {"id": "cam1", "enabled": True, "rtsp_url": "rtsp://new"}
        _setup(monkeypatch, existing={}, new_cameras=[cam_cfg])
        server.restart_single_camera("cam1")
        assert server._runtime_cfgs.get("cam1") == cam_cfg

    def test_disabled_camera_not_started(self, monkeypatch):
        cam_cfg = {"id": "cam1", "enabled": False}
        _setup(monkeypatch, existing={}, new_cameras=[cam_cfg])
        server.restart_single_camera("cam1")
        assert "cam1" not in server.runtimes

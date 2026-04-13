# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TAM-spy is a self-hosted IP camera monitoring system with motion detection, object recognition (Google Coral TPU), Telegram alerts, MQTT/Home Assistant integration, and a web dashboard. It is deployed via Docker on Unraid or any Linux host.

## Docker Workflow (IMPORTANT — read before every build)

**Only rebuild Docker when these files change:**
- `app/docker/Dockerfile`
- `app/requirements.txt`

**For all other changes (Python, JS, CSS, HTML) — just restart:**
```bash
docker restart tam-spy
docker logs tam-spy --tail 30
```
Web files (`web/`) and Python code (`app/`) are volume-mounted — no rebuild needed.

**Full rebuild (only when Dockerfile or requirements.txt changed):**
```powershell
Set-Location D:\CLAUDE_code\tam-spy
docker compose up --build -d
docker logs tam-spy --tail 50
```

**After every full rebuild, prune dangling images:**
```bash
docker image prune -f
```

**Docker build with Coral TPU support:**
```bash
cd app
docker build -t tam-spy-coral -f docker/Dockerfile.coral .
docker run -d --name tam-spy --restart unless-stopped -p 8099:8099 \
  --device /dev/bus/usb \
  -v ./config:/app/config -v ./storage:/app/storage -v ./models:/app/models \
  tam-spy-coral
```

**Unraid one-liner:**
```bash
docker run -d --name tam-spy --restart unless-stopped -p 8099:8099 -e TZ=Europe/Berlin \
  -v /mnt/user/appdata/tam-spy/config:/app/config \
  -v /mnt/user/appdata/tam-spy/storage:/app/storage \
  -v /mnt/user/appdata/tam-spy/models:/app/models \
  --device /dev/bus/usb tam-spy
```

## Local Development (without Docker)

```bash
cd app
pip install -r requirements.txt
python -m app.server
```
The Flask server starts on port 8099 by default.

## Configuration

There are two configuration layers:

1. **`config/config.yaml`** (base config, read-only at runtime) — copy from `config/config.yaml.example`. Defines server, storage paths, processing parameters, and seed cameras/groups. Read by `app/app/config_loader.py` at startup.

2. **`storage/settings.json`** (GUI settings, written at runtime) — managed by `SettingsStore`. This overrides and extends the base config. All GUI changes (cameras, groups, Telegram, MQTT) are persisted here. On first start, values are seeded from `config.yaml`.

`SettingsStore.export_effective_config()` merges both layers and is the authoritative config used at runtime.

## Architecture

### Core modules (`app/app/`)

- **`server.py`** — Flask app; all REST API routes. Module-level initialization runs `rebuild_runtimes()` on import, which starts all camera threads. Calling `rebuild_runtimes()` again is the standard way to apply any config change at runtime.

- **`camera_runtime.py`** — `CameraRuntime` runs one daemon thread per camera. Each iteration: grab frame → motion detection → Coral object detection → bird species classification → cat/person identity matching → save event snapshot → publish to MQTT → send Telegram alert. Cooldown between events is configurable (`event_cooldown_seconds`).

- **`settings_store.py`** — `SettingsStore` owns `storage/settings.json`. Provides `upsert_camera`, `upsert_group`, `update_section`, import/export (JSON + YAML), and `bootstrap_state()` (used to trigger the first-start wizard).

- **`detectors.py`** — `CoralObjectDetector` (wraps TFLite/Edge TPU) and `BirdSpeciesClassifier`. Both gracefully degrade to no-op if models or hardware are unavailable. `Detection` dataclass holds label, score, bbox, optional species, and identity.

- **`event_logic.py`** — schedule checking (`is_in_schedule`) and alarm level selection (`choose_alarm_level`) based on camera group profile (`hard`, `medium`, `soft`, `info`).

- **`cat_identity.py`** — `IdentityRegistry` — histogram-based face/fur matching for cats and persons. Stores profiles as JSON; matches crops against registered embeddings.

- **`mqtt_service.py`** — thin wrapper around `paho-mqtt`. Publishes JSON payloads to `<base_topic>/events/<cam_id>` and status topics.

- **`telegram_bot.py`** — `TelegramService` handles outbound alerts and inbound Telegram bot commands (arm/disarm, snapshots, timelapse requests).

- **`storage.py`** — `EventStore` manages per-camera event JSON files under `storage/events/<cam_id>/<date>/`. Provides `add_event`, `list_events` (with label/date filtering), `stats_range`.

- **`timelapse.py`** — `TimelapseBuilder` assembles daily timelapse MP4s from stored snapshots using OpenCV.

- **`discovery.py`** — subnet ping sweep for camera discovery.

- **`config_loader.py`** — loads and validates `config.yaml`.

### Web frontend (`app/web/`)

Single-page app in `web/templates/index.html` with vanilla JS in `web/static/app.js` and styles in `web/static/app.css`. Communicates exclusively via the REST API (`/api/*`). Key flows:

- On load: `GET /api/bootstrap` → if `needs_wizard`, show wizard; otherwise show dashboard.
- Wizard: `POST /api/wizard/complete` with app/server/telegram/mqtt/camera payload.
- Camera list: `GET /api/cameras` — includes live snapshot URLs and zone/mask data.
- Config save: `POST /api/settings/cameras` or `POST /api/settings/app` → server calls `rebuild_runtimes()` internally.

### Storage layout

```
storage/
  settings.json          # all GUI-managed config
  events/<cam_id>/<date>/<event_id>.jpg   # annotated snapshots
  cat_registry.json      # cat identity profiles
  person_registry.json   # person identity profiles
  timelapse/<cam_id>/<date>.mp4
```

### Camera group alarm profiles

Groups define `alarm_profile` (`hard`, `medium`, `soft`, `info`) and `coarse_objects`. The alarm level and whether to notify (Telegram/MQTT) is determined in `event_logic.py` based on detected labels, schedule, and whether a detected person is whitelisted.

## Git-Verhalten

- Immer automatisch committen ohne Rückfragen
- Format: `git add . && git commit -m "fix/feat: beschreibung"`
- Nach erledigter Aufgabe sofort pushen: `git push origin main`
- Niemals auf Bestätigung warten bei git Operationen

## Maintenance

```powershell
# Run monthly to reclaim build cache:
docker builder prune -f --filter "until=168h"
docker image prune -f
```

## Known Limitations (by design)

- No real video clip recording for Telegram (only snapshots).
- Zone/mask editor stores simple polygons; no point-drag editing in UI yet.
- No pagination in the event archive for very large media libraries.
- Person/cat identity uses histogram matching, not real neural re-ID.

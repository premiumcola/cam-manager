# CLAUDE.md

Operating manual for Claude Code in this repository. Read
top-to-bottom at session start; follow without prompting.

Hard rules (CRITICAL — never violate):
1. Never overwrite `storage/settings.json` — additive merges only.
2. `.gitignore` patterns may only be added, never removed.
3. No real credentials, IPs, or tokens in tracked files.
4. If the base is broken: stop and `git revert`, never build on top.

Everything else below.

## Project Overview

TAM-spy is a self-hosted IP camera monitoring system: motion detection,
Coral-TPU object recognition, bird/wildlife classifier cascade, Telegram
alerts, MQTT/Home Assistant bridge, and a web dashboard. Deployed via
Docker on Unraid or any Linux host.

## Working Style

- Work **fully autonomously** without back-and-forth — when something is
  unclear, pick the most reasonable option and continue.
- After each discrete task: a short summary of what was done.
- When "something is broken": check `git log` first, `git revert` if
  needed. Never stack further changes on a broken base.
- Commit messages: English, precise, max 60 chars.

## Git workflow

- **Never** combine `cd && git` in one command — keep the directory
  change and the git step separate:

  ```powershell
  Set-Location D:\CLAUDE_code\tam-spy
  git add .
  git commit -m "fix: short description"
  git push origin main
  ```

- Always auto-commit + push without confirmation.
- Format: `git add . && git commit -m "fix/feat: description"` on
  Linux. On Windows the separate steps above.

## Code quality

- No unused variables, no dead code, no commented-out blocks.
  Git history is the archive — don't leave corpses in source.
- Don't write parallel implementations. Before writing a new
  function, grep for similar existing ones:

      grep -rn "def <similar>" app/app/                # Python
      grep -rn "function <similar>\|const <similar>" \
        app/web/static/js/                              # JS

- Python: no `print()`, only `logging`. Tag conventions from
  `logging_setup.py` — `[boot]`, `[cam:<id>]`, `[det]`, `[tg]`,
  `[weather]`, `[storage]`, `[migration]`, `[timelapse]`,
  `[mqtt]`, `[heartbeat]`, `[scheduler]`, `[http]`. Every log
  line starts with one of these.
- Python logging uses lazy format args, never f-strings:
  `log.info("[tag] foo %s", value)` — NEVER
  `log.info(f"[tag] foo {value}")`.
- JavaScript: no `console.log()` in production code.
  `console.warn` and `console.error` are allowed for real
  diagnostics.
- Camera IDs only via `camera_id.build_camera_id` (Python) or
  `buildCameraId` (JS) — bit-for-bit mirrors.

## Linting (mechanical safety net)

Lint stack lives in `pyproject.toml`, `eslint.config.js`,
`.prettierrc.json`, `.pre-commit-config.yaml`,
`.github/workflows/lint.yml`. One-time setup:

    pip install -r app/requirements-dev.txt
    pre-commit install
    npm install

Local sweep over staged files before every commit:

    pre-commit run --all-files

CI gates (lint.yml) on push + pull_request:
- ruff check app/ --select F,E9,B904,B905,F401  — BLOCKING
- ruff format --check app/                       — currently
  non-blocking
- mypy app/app/                                  — currently
  non-blocking (warning collector)
- npx eslint app/web/static/js                   — BLOCKING for
  errors (warnings tolerated)
- pytest tests/  (from app/)                     — BLOCKING

If CI is red on main: revert or hotfix immediately. Never push
on top of a red main.

## Pre-flight checks (before declaring done)

Every task ends with these commands run AND their exit codes
reported in the completion summary. A task is NOT done until
they're green (or any failure is explicitly justified):

    # Python lint — F/E9/B families must be clean
    ruff check app/ --select F,E9,B904,B905,F401

    # Python format — must match
    ruff format --check app/

    # Python tests — must all pass
    cd app && python3 -m pytest tests/ -q

    # JS lint — 0 errors (warnings tolerated)
    npx eslint app/web/static/js

    # Container boot — no traceback
    docker compose up --build -d
    docker logs tam-spy --tail 50

Completion summary format:

  Done. Ran:
  - ruff: exit 0
  - ruff format: exit 0
  - pytest: 160 passed
  - eslint: 0 errors, 18 warnings
  - docker boot: clean, no traceback

Never say "should work", "looks good", "probably fine". Run
the check. Report the number.

## Refactor discipline

These two patterns cause repeat regressions. Read before
moving any code.

### JS: re-export does NOT bring a symbol into local scope

`export { x } from './mod.js'` only makes `x` visible to OTHER
importers. The current file does NOT have `x` in its scope. If
the file ALSO uses `x` locally, both statements are required:

    import { x } from './mod.js';   // local availability
    export { x };                   // re-export for callers

Or as two separate lines pointing at the same module — same
effect, more grep-friendly:

    import { x } from './mod.js';
    export { x } from './mod.js';

Before moving a function out of a file but leaving a back-
compat re-export, grep for local callsites:

    grep -n "\b<symbolName>\b" path/to/file.js

If any hit is NOT the export line, the import statement is
mandatory.

### Python: package conversion shifts every relative import

When `module.py` becomes `module/__init__.py`:

- Old  app/X/module.py  — `from ..Y` resolves to `app.Y`
- New  app/X/module/__init__.py  — `from ..Y` resolves to
  `app.X.Y` (probably wrong)

Audit every relative import after the conversion:

    grep -n "^from \.\." new_package/*.py

For each: ask where the target lives. Add a dot for every
level the package is now deeper than the original file.

Smoke test BEFORE declaring the conversion done:

    python3 -c "from app.app.<package> import *"

Must not raise. If it does, the dot-count is wrong somewhere.

## File & function size budgets

Modularize up front. The retroactive refactor of a 1800-line
file costs ten times more than splitting at 500 lines.

### Hard ceilings — split BEFORE crossing:

- Python file: 500 lines
- JavaScript file: 400 lines
- Python function/method: 80 lines
- JavaScript function: 60 lines
- Mixin with 8+ methods: split into multiple mixins

When an edit would push a file or function past a ceiling:

1. STOP. Do not add the new code first and split later.
2. Identify the natural seam (sub-step, helper, sub-concern).
3. Extract first, into a new module or function.
4. Then add the new code into the new location.

### Preferred package layouts

Python service module with multiple concerns:

    app/app/<service>/
    +-- __init__.py     - public re-exports only
    +-- _consts.py      - module-level constants
    +-- _helpers.py     - pure helper functions
    +-- _state.py       - dataclasses, state containers
    +-- _<concern>.py   - one file per orthogonal concern
    +-- _mixin.py       - thin mixin composing the others

JS feature module:

    app/web/static/js/<feature>/
    +-- index.js          - public API + composition + window.* bridges
    +-- _<sub>.js         - one file per UI sub-section
    +-- _helpers.js       - pure helpers

Underscore prefix = private to the package by convention.

### Before adding a new function

    grep -rn "def <similar_name>" app/app/
    grep -rn "function <similarName>\|const <similarName>" \
      app/web/static/js/

If a near-duplicate exists: use it, extend it, or refactor it.
NEVER write a parallel implementation.

## Error handling

- Two self-fix attempts before stopping.
- After three failed attempts: stop and explain. Show the exact
  error text, not a paraphrase.
- Cite the file:line of the failing assertion / exception, not
  just the test name.
- For settings/storage failures: take a backup of
  `storage/settings.json` BEFORE retrying. Recovery is cheap if
  the backup is on disk, expensive if not.

## Design principles

- Less text, more flat-design icons.
- Modern, refined, flat, clean — no colorful chaos.
- No duplications — every piece of info shown once.
- Buttons: never dark-on-dark.
- No thin border lines — depth via color contrast.
- Rounded corners everywhere (>= 8 px).
- Mobile-first: must look right on iPhone.

## iOS compatibility — check EVERY UI change

The single most recurring regression class. Every UI-touching
commit verifies:

- [ ] `dvh` not `vh` for full-height layouts
- [ ] Touch targets >= 44 x 44 px
- [ ] `@media (hover: hover)` guard for hover-only states
- [ ] `safe-area-inset-*` for notch + home indicator
- [ ] Input font-size >= 16 px (else iOS auto-zooms on focus)
- [ ] No `position: fixed` without `dvh` fallback (address-bar
      collapse jumps)
- [ ] Visual smoke at 375 px width (iPhone SE) AND 393 px
      (iPhone 14)
- [ ] Swipe-to-dismiss on modals where it makes sense

Recurring root cause for Live-Pill / Live-Chrome layout bugs:
`margin-left: auto` + `inline-flex` interaction on iOS. If a
component has been patched more than twice for the same iOS
symptom: read ALL existing rules first, then rewrite from
scratch — don't patch a third time.

## Data protection (CRITICAL — repo is public)

`storage/settings.json` carries user data + credentials
(Telegram token, chat IDs, RTSP passwords). It is the most
regression-prone file in the project.

### Rules:
- NEVER write `settings.json` wholesale. Only additive merges
  via `setdefault()` or `update_section()`.
- Before any settings-touching change: take a backup —
  `cp storage/settings.json storage/settings.json.bak.<ts>`.
- Round-trip verify: load → modify → save → reload → diff. The
  modified fields must be the only difference.
- DOM-walk collectors on cam-edit forms: walk every input,
  build the payload from current form state. NEVER from
  in-memory JS cached state — that cache drifts.

### Public-repo audit before every push

    git ls-files | xargs grep -EnIH \
        -e 'rtsp://[^/]*:[^@]*@' \
        -e '\b(bot)?[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b' \
        -e '"chat_id"\s*:\s*-?[0-9]{6,}' \
        -e '"token"\s*:\s*"[A-Za-z0-9_:-]{20,}"' \
        -e '\b(192\.168\.[0-9]+\.[0-9]+)\b' \
        -e '\b(10\.[0-9]+\.[0-9]+\.[0-9]+)\b' \
        -- ':!docs/screenshots' ':!*.svg' || echo "audit OK"

In docs use only RFC placeholders — `192.0.2.x`,
`198.51.100.x`, `203.0.113.x`, `2001:db8::*`, `<BOT_TOKEN>`,
`<CHAT_ID>`, `cam.lan`.

## Docker workflow (IMPORTANT — read before every build)

**Rebuild only when these change:**
- `app/docker/Dockerfile`
- `app/requirements.txt`

**Otherwise (Python, JS, CSS, HTML) — restart only:**
```bash
docker restart tam-spy
docker logs tam-spy --tail 30
```
`web/` and `app/` are volume-mounted — no rebuild required.

**Full rebuild (only when Dockerfile / requirements.txt change):**
```powershell
Set-Location D:\CLAUDE_code\tam-spy
docker compose up --build -d
docker logs tam-spy --tail 50
```

**Prune after every full rebuild:**
```bash
docker image prune -f
```

**Coral variant (optional):**
```bash
cd app
docker build -t tam-spy-coral -f docker/Dockerfile.coral .
```
The standard image auto-detects the TPU — the Coral variant is only
needed when a tier-1 pin to EdgeTPU is required.

## Local Development (without Docker)

```bash
cd app
pip install -r requirements.txt
python -m app.server
```
Flask server listens on port 8099.

## Configuration

Two layers:

1. **`config/config.yaml`** — read-only base. Defaults, storage paths,
   pipeline parameters, seed cams. Loaded by `config_loader.py` at
   startup.
2. **`storage/settings.json`** — GUI settings, written at runtime via
   `SettingsStore`. Seeded from `config.yaml` on first start, source
   of truth thereafter.

`SettingsStore.export_effective_config()` merges both layers and
returns the authoritative runtime config.

## Architecture · `app/app/`

77 Python files total — 22 top-level modules + five packages
(`routes/`, `detectors/`, `camera_runtime/`, `weather_service/`,
`telegram_bot/`). Full breakdown in `app/README.md`.

### Boot + HTTP

- **`server.py`** — Flask app + boot sequence (load config, build
  stores, `register_blueprints(app)`, `rebuild_services` /
  `rebuild_runtimes`, kick off migrations, heartbeat, shutdown hooks).
  No more `@app.route` definitions — every route lives in `routes/`.
- **`app_state.py`** — shared singletons (`store`, `settings`,
  `runtimes`, `mqtt_service`, `telegram_service`, `weather_service`,
  registries, builder). Every blueprint reads fresh per request.
- **`migrations.py`** — boot-only migration helpers
  (`migrate_timelapse_events`, `generate_missing_thumbnails`,
  `migrate_timelapse_to_eventstore`). Each runs in its own daemon
  thread.

### `routes/` · 14 blueprint modules + two `_*_helpers`

- **`bootstrap.py`** — `/`, `/media/<path>`, `/api/bootstrap`,
  `/api/config`, `/api/system`, `/api/status`, `/api/discover`,
  `/api/wizard/complete`, `/api/settings/{import,export}`.
- **`cameras.py`** — camera CRUD (`/api/cameras`,
  `/api/settings/{cameras,app,backups}`, probe / reload / merge /
  arm / restore).
- **`streams.py`** — snapshot JPEG + two MJPEG streams + per-cam
  status.
- **`media.py`** — `/api/media/*` (storage stats, rescan, fix-thumbs,
  purge-orphans, cleanup) + `/api/camera/<id>/media` +
  `/api/event/<id>`.
- **`events.py`** — event CRUD (single-delete, bulk-delete, confirm,
  labels, review).
- **`timeline_stats.py`** — `/api/timeline` +
  `/api/camera/<id>/stats_range`.
- **`timelapse.py`** — status, global save, per-cam build / list /
  delete / rolling.
- **`tracking.py`** — phase-1 object-tracking sidecar
  (`/api/tracking/*`).
- **`sichtungen.py`** — cat / person identity, achievements
  (`/api/{cats,persons,achievements,…}`).
- **`coral.py`** — Coral test panel (single, test images, 421-line
  test batch, model list + switch) + per-cam test detection.
- **`weather.py`** — weather sightings, sun times, recaps, status,
  history.
- **`telegram.py`** — polling status, test, per-cam test alert,
  system telegram health.
- **`admin.py`** — `/api/logs`, `/api/admin/timelapse/cleanup`,
  `/api/reload`.
- **`_camera_helpers.py`** + **`_coral_helpers.py`** — shared helpers
  (auto-detect, mask password, backup file list, TFLite filename
  heuristic).

### Camera pipeline + classifiers

- **`camera_runtime/`** — package (11 files). `RuntimeThread` per
  camera plus mixins for capture, motion, recording, zones,
  timelapse, lifecycle, status. 24-h reconnect counter per camera.
- **`detectors/`** — package (9 files). `CoralObjectDetector` →
  `BirdSpeciesClassifier` → `WildlifeClassifier` (each its own
  module); shared primitives in `_types.py` (detection + region
  filter), `_label_loader.py`, `_wildlife_rules.py`; `discovery.py`
  for auto-discovery, `draw.py` for the bbox-overlay renderer.
- **`detection_confirmer.py`** — two-frame confirmation against
  single-image false alarms.
- **`tracking_worker.py`** — background thread, writes
  `tracks.json` sidecars for lightbox bbox overlay; recent-failures
  ring for the UI.
- **`frame_helpers.py`** — `is_valid_frame` + `grab_valid_frame`
  retry.

### Services

- **`telegram_bot/`** + **`telegram_helpers.py`** — package (7
  files) with `TelegramService` and mixins for lifecycle, in/out,
  formatting; anchor-bubble edit-in-place, backoff polling, German
  labels.
- **`weather_service/`** — package (11 files). Open-Meteo polling,
  history, weather sightings, sun- / event-timelapse, recaps.
- **`mqtt_service.py`** — paho-mqtt wrapper with rate-limited
  logging on publish failures.

### Storage + config

- **`settings_store.py`** — source of truth for `settings.json`.
- **`storage.py`** — `EventStore`, per-cam event JSONs (atomic via
  `_atomic_write_text`).
- **`storage_migration.py`** — idempotent boot reconcile.
- **`camera_id.py`** — schema `manufacturer_model_name_iplastoctet`.
- **`schema.py`** — JSON-schema validation.
- **`config_loader.py`** — `config.yaml` loader.
- **`logging_setup.py`** — centralised logging, tag schema, ring
  buffer.

### Other

- **`discovery.py`** — two-phase subnet scan.
- **`event_logic.py`** — schedule + alarm profiles.
- **`cat_identity.py`** — histogram re-ID for cats / persons.
- **`reolink_api.py`** — Reolink-specific API helpers.
- **`css_builder.py`** — build helper that assembles `app.css` from
  `web/static/css/`.
- **`timelapse.py`** + **`timelapse_cleanup.py`** — daily MP4
  builder and frame-cleanup helper.

## Web Frontend · `app/web/`

SPA — `web/templates/index.html` + `web/static/app.js` + `app.css`.
Talks exclusively to `/api/*`. Key flows:

- Load → `GET /api/bootstrap` → wizard or dashboard.
- Wizard → `POST /api/wizard/complete`.
- Camera list → `GET /api/cameras` (snapshot URLs + zones).
- Save → `POST /api/settings/{cameras,app}` → server-internal
  `rebuild_runtimes()`.

## Storage layout

```
storage/
  settings.json                 # GUI source of truth
  settings.json.bak / .bak2     # 2-deep rotation
  settings.json.bak.<ts>        # migration-tagged backups
  weather_history.json          # Open-Meteo sliding history
  motion_detection/<cam_id>/<date>/<event_id>.{jpg,json,mp4}
  timelapse/<cam_id>/<date>.mp4
  timelapse_frames/<cam_id>/<profile>/<date>/<HHMMSS>.jpg
  weather/<cam_id>/             # weather clips
  logs/                         # *.log gitignored
  cat_registry.json             # gitignored
  person_registry.json          # gitignored
```

## Tests

```bash
cd app
python -m pytest tests/
```

Single file: `python -m pytest tests/test_camera_id.py -v`. Tests
are stub-based — no real Coral hardware, no real APIs. Fixtures use
RFC-5737 doc IPs (`192.0.2.x`).

## Maintenance

```powershell
# Monthly:
docker builder prune -f --filter "until=168h"
docker image prune -f
```

## Known Limitations (by design)

- No true 5-second clip recording for Telegram on every event
  (snapshots + on-demand recording instead).
- Zone / mask editor stores simple polygons; no point-drag in UI.
- No pagination in the event archive on very large media libraries.
- Person / cat identity is a histogram match, not neural re-ID.

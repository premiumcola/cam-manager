# CLAUDE.md

Operating manual for Claude Code in this repository. Read
top-to-bottom at session start; follow without prompting.

Hard rules (CRITICAL — never violate):
1. settings.json niemals überschreiben, nur additiv ergänzen.
2. .gitignore-Patterns nur hinzufügen, niemals entfernen.
3. Keine echten Credentials, IPs oder Tokens in tracked files.
4. Bei kaputter Basis: stoppen + git revert, nicht weiterbauen.

Alles weitere unten.

## Project Overview

TAM-spy is a self-hosted IP camera monitoring system: motion detection,
Coral-TPU object recognition, bird/wildlife classifier-cascade, Telegram
alerts, MQTT/Home Assistant bridge, and a web dashboard. Deployed via
Docker on Unraid or any Linux host.

## Working Style

- **Vollständig selbständig** ohne Rückfragen arbeiten — bei
  Unklarheiten sinnvollste Lösung wählen und weiter.
- Nach jeder Einzelaufgabe: kurze Zusammenfassung was gemacht wurde.
- Bei „etwas kaputt": erst `git log` prüfen, ggf. `git revert`. Nie
  weitere Änderungen auf kaputter Basis aufbauen.
- Commit-Messages: English, präzise, max. 60 chars.

## Git-Verhalten

- **Nie** `cd && git` in einem Befehl — separate `Set-Location` und
  Git-Schritte:

  ```powershell
  Set-Location D:\CLAUDE_code\tam-spy
  git add .
  git commit -m "fix: kurze beschreibung"
  git push origin main
  ```

- Immer automatisch committen + pushen ohne Bestätigung.
- Format: `git add . && git commit -m "fix/feat: beschreibung"` — auf
  Linux. Auf Windows die separaten Schritte oben.

## Code-Qualität

- Keine ungenutzten Variablen, kein toter Code.
- Vorhandene Funktionen nicht doppelt schreiben — erst `Grep`/`Read`,
  dann implementieren.
- Python: kein `print()`, nur `logging`. Tag-Konventionen aus
  `logging_setup.py` nutzen — `[boot]`, `[cam:<id>]`, `[det]`, `[tg]`,
  `[weather]`, `[storage]`, `[migration]`, `[timelapse]`, `[mqtt]`,
  `[heartbeat]`.
- JavaScript: kein `console.log()` im Produktionscode.
- Camera-IDs ausschließlich über `camera_id.build_camera_id` erzeugen
  (Python) bzw. `buildCameraId` (JS) — beide sind bit-für-bit-Spiegel.

## Linting (mechanical safety net)

Lint stack lebt in `pyproject.toml`, `eslint.config.js`,
`.prettierrc.json`, `.pre-commit-config.yaml`,
`.github/workflows/lint.yml`. Setup einmalig:

```bash
pip install -r app/requirements-dev.txt
pre-commit install
npm install
```

Lokal alle Checks über staged files vor jedem Commit:

```bash
pre-commit run --all-files
```

Was geprüft wird:
- **ruff** — Python-Linter (pyflakes + pycodestyle + isort + pyupgrade
  + bugbear + simplify + naming). Auto-fixes bei `--fix`.
- **ruff format** — Python-Formatter (ersetzt black). `quote-style =
  preserve` damit der Vor-Linter-Stil unverändert bleibt.
- **mypy** — derzeit **permissiv** (`strict_optional = false`,
  `ignore_missing_imports = true`). Nur offensichtliche
  `None.foo()`-Fehler werden erfasst. Striktere Modi wandern später
  rein, wenn Type-Hints dichter sind.
- **eslint** — JavaScript-Linter (recommended + unicorn-Subset).
  `no-console: ['error', { allow: ['warn', 'error'] }]` — die alte
  `kein console.log()`-Konvention ist jetzt **erzwungen**, nicht nur
  Empfehlung. `console.warn`/`console.error` bleiben legal.
- **prettier** — JS-Formatter, läuft in `pre-commit` über bearbeitete
  Files. CI-prettier-check auf JS ist **bewusst aus** in dieser Phase
  (CSS-Split-Prompt aktiviert es danach).
- **pre-commit-hook** `no-console-log` — eigener Bash-Hook, scannt
  staged JS-Files auf `console.log(`; blockiert den Commit. Bypasst
  die ESLint-Konfig, falls die mal angefasst wird.

Baseline-Zahlen (Stand: linter foundation merge):
- ruff post auto-fix: 160 verbleibende violations (E702, B007, UP032
  dominieren — schrittweiser Cleanup in späteren PRs).
- mypy: ungezählt — derzeit nicht-blockierend, gibt warnings für
  Sichtbarkeit.
- eslint post auto-fix: 88 problems (59 errors, 29 warnings) — die
  meisten errors sind `eqeqeq` und ein paar `no-undef`-Hänger zu
  Helpers, die nie definiert wurden (`_setActiveNav`).
- prettier: ~48 JS-files würden durch eine Mass-`--write` umformatiert;
  bewusst übersprungen bis CSS-Split-Prompt.

Diese Zahlen sind die Untergrenze für künftige Refactor-Stufen — kein
Commit darf sie schlechter machen, ohne explizite Begründung.

## Fehlerbehandlung

- Bei Fehlern: 2× selbst zu fixen versuchen.
- Erst nach 3 fehlgeschlagenen Versuchen stoppen und genau erklären
  was das Problem ist — den exakten Fehlertext zeigen, nicht
  paraphrasieren.
- Niemals weitere Änderungen auf einer kaputten Basis aufbauen —
  erst `git log` prüfen, ggf. `git revert`, dann weiter.
- Bei "Daten weg"-Symptomen ZUERST diese drei Checks bevor Datenverlust
  angenommen wird:
    1. Browser hard-reload (Strg+Shift+R) — der häufigste Grund.
    2. `docker volume ls` und docker-compose.yml Bind-Mounts prüfen.
    3. `storage/settings.json.bak.*` durchsehen — Backups sind da.

## Design-Prinzipien

- Weniger Text, mehr individuell designte flat-design Icons.
- Modern, edel, flach, sauber — kein buntes Chaos.
- Keine Doppelungen, jede Info nur einmal.
- Buttons: nie dunkel auf dunkel.
- Keine dünnen Rahmenlinien — Tiefe durch Farbunterschiede.
- Abgerundete Ecken überall (≥ 8 px).
- Mobil-first: alles muss auf iPhone gut aussehen.

## iOS-Kompatibilität

- Touch-Targets ≥ 44×44 px.
- Kein hover-only — Touch-Alternativen einbauen.
- `dvh` statt `vh` für volle Höhe (sonst spring-loaded Address Bar).
- `safe-area-inset-*` für Notch / Home-Indicator.
- Inputs mindestens 16 px font-size (sonst Auto-Zoom auf Focus).
- `@media (max-width: 768px)` als Pflicht-Breakpoint für jedes neue
  Layout — desktop unverändert bleiben.
- Swipe-Gesten wo sinnvoll: Lightbox-Navigation prev/next, Modals
  swipe-to-dismiss.
- Lightbox, Modals, Overlays explizit auf iPhone-Width testen — der
  Edge-Case sind 375 px (iPhone SE) und Safe-Area-Insets bei Notch-
  Geräten.
- Keine `position: fixed`-Elemente, die auf iOS bei
  Address-Bar-Collapse springen — `position: sticky` oder
  `dvh`-basierte Layouts bevorzugen.

## Daten-Schutz (CRITICAL — repo is public)

- `storage/settings.json` enthält User-Daten + Credentials (Telegram
  Token, Chat-IDs, RTSP-Passwörter). **Niemals überschreiben**, nur
  additiv via `setdefault()` / `update_section`.
- `.gitignore` strikt halten — Patterns nur **hinzufügen**, nie entfernen.
- Bei Doc-Änderungen niemals echte IPs / Tokens / Passwörter — nur
  Platzhalter:
  - `192.0.2.x`, `198.51.100.x`, `203.0.113.x` (RFC 5737)
  - `2001:db8::*` (RFC 3849)
  - `<BOT_TOKEN>`, `<CHAT_ID>`, `<user>:<pass>`, `cam.lan` / `cam01`
- Vor jedem `git push` läuft dieser Audit auf dem Working Tree:

  ```bash
  git ls-files | xargs grep -EnIH \
      -e 'rtsp://[^/]*:[^@]*@' \
      -e '\b(bot)?[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b' \
      -e '"chat_id"\s*:\s*-?[0-9]{6,}' \
      -e '"token"\s*:\s*"[A-Za-z0-9_:-]{20,}"' \
      -e '\b(192\.168\.[0-9]+\.[0-9]+)\b' \
      -e '\b(10\.[0-9]+\.[0-9]+\.[0-9]+)\b' \
      -- ':!docs/screenshots' ':!*.svg' || \
      echo "audit OK"
  ```

  Treffer außerhalb von Doc-Placeholders fixen, nicht ignorieren.
  Erst dann pushen.

## Docker Workflow (IMPORTANT — read before every build)

**Nur rebuild bei Änderungen an:**
- `app/docker/Dockerfile`
- `app/requirements.txt`

**Sonst (Python, JS, CSS, HTML) — nur restart:**
```bash
docker restart tam-spy
docker logs tam-spy --tail 30
```
`web/` und `app/` sind Volume-Mounted — kein Rebuild nötig.

**Full rebuild (nur bei Dockerfile/requirements.txt-Änderung):**
```powershell
Set-Location D:\CLAUDE_code\tam-spy
docker compose up --build -d
docker logs tam-spy --tail 50
```

**Nach jedem Full-Rebuild prunen:**
```bash
docker image prune -f
```

**Coral-Variante (optional):**
```bash
cd app
docker build -t tam-spy-coral -f docker/Dockerfile.coral .
```
Standard-Image erkennt den TPU automatisch — Coral-Variante nur, wenn
ein Tier-1-Pin auf EdgeTPU gewünscht ist.

## Local Development (without Docker)

```bash
cd app
pip install -r requirements.txt
python -m app.server
```
Flask-Server lauscht auf Port 8099.

## Configuration

Zwei Schichten:

1. **`config/config.yaml`** — Read-only Base. Defaults, Storage-Pfade,
   Pipeline-Parameter, Seed-Cams. Geladen von `config_loader.py` beim
   Start.
2. **`storage/settings.json`** — GUI-Settings, zur Laufzeit geschrieben
   via `SettingsStore`. Beim ersten Start aus `config.yaml` geseedet,
   danach Source of Truth.

`SettingsStore.export_effective_config()` mergt beide Schichten und
liefert die maßgebliche Runtime-Config.

## Architektur · `app/app/`

77 Python-Dateien insgesamt — 22 Top-Level-Module + fünf Pakete
(`routes/`, `detectors/`, `camera_runtime/`, `weather_service/`,
`telegram_bot/`). Vollständige Aufstellung in `app/README.md`.

### Boot + HTTP

- **`server.py`** — Flask app + Boot-Sequenz (Config laden, Stores
  bauen, `register_blueprints(app)`, `rebuild_services` /
  `rebuild_runtimes`, Migrationen anstoßen, Heartbeat, Shutdown-Hooks).
  Keine `@app.route`-Definitionen mehr — alle Routen liegen in
  `routes/`.
- **`app_state.py`** — geteilte Singletons (`store`, `settings`,
  `runtimes`, `mqtt_service`, `telegram_service`, `weather_service`,
  Registries, Builder). Jedes Blueprint liest hier per Request frisch.
- **`migrations.py`** — boot-only Migrations-Helfer
  (`migrate_timelapse_events`, `generate_missing_thumbnails`,
  `migrate_timelapse_to_eventstore`). Jede läuft im eigenen
  Daemon-Thread.

### `routes/` · 14 Blueprint-Module + zwei `_*_helpers`

- **`bootstrap.py`** — `/`, `/media/<path>`, `/api/bootstrap`,
  `/api/config`, `/api/system`, `/api/status`, `/api/discover`,
  `/api/wizard/complete`, `/api/settings/{import,export}`.
- **`cameras.py`** — Camera-CRUD (`/api/cameras`, `/api/settings/{cameras,app,backups}`,
  Probe / Reload / Merge / Arm / Restore).
- **`streams.py`** — Snapshot-JPEG + zwei MJPEG-Streams + Per-Cam-Status.
- **`media.py`** — `/api/media/*` (Storage-Stats, Rescan,
  Fix-Thumbs, Purge-Orphans, Cleanup) + `/api/camera/<id>/media` +
  `/api/event/<id>`.
- **`events.py`** — Event-CRUD (Single-Delete, Bulk-Delete, Confirm,
  Labels, Review).
- **`timeline_stats.py`** — `/api/timeline` + `/api/camera/<id>/stats_range`.
- **`timelapse.py`** — Status, globaler Save, Per-Cam-Build / List /
  Delete / Rolling.
- **`tracking.py`** — Phase-1 Object-Tracking-Sidecar
  (`/api/tracking/*`).
- **`sichtungen.py`** — Cat- / Person-Identity, Achievements
  (`/api/{cats,persons,achievements,…}`).
- **`coral.py`** — Coral-Test-Panel (Single, Test-Images, 421-Zeilen
  Test-Batch, Models-List + Switch) + Per-Cam-Test-Detection.
- **`weather.py`** — Wetter-Sichtungen, Sun-Times, Recaps, Status,
  History.
- **`telegram.py`** — Polling-Status, Test, Per-Cam-Test-Alert,
  System-Telegram-Health.
- **`admin.py`** — `/api/logs`, `/api/admin/timelapse/cleanup`,
  `/api/reload`.
- **`_camera_helpers.py`** + **`_coral_helpers.py`** — gemeinsame
  Hilfen (Auto-Detect, Mask-Password, Backup-File-Liste, TFLite-
  Filename-Heuristik).

### Camera Pipeline + Klassifizierer

- **`camera_runtime/`** — Paket (11 Dateien). `RuntimeThread` pro
  Kamera plus Mixins für Capture, Motion, Recording, Zonen, Timelapse,
  Lifecycle, Status. 24-h-Reconnect-Counter pro Kamera.
- **`detectors/`** — Paket (9 Dateien). `CoralObjectDetector` →
  `BirdSpeciesClassifier` → `WildlifeClassifier` (je eigenes Modul);
  geteilte Primitive in `_types.py` (Detection + Region-Filter),
  `_label_loader.py`, `_wildlife_rules.py`; `discovery.py` für die
  Auto-Discovery, `draw.py` für die Bbox-Overlay-Renderer.
- **`detection_confirmer.py`** — Zwei-Frame-Bestätigung gegen
  Einzelbild-Fehlalarme.
- **`tracking_worker.py`** — Hintergrund-Thread, schreibt
  `tracks.json`-Sidecars für Lightbox-Bbox-Overlay; Recent-Failures-
  Ring fürs UI.
- **`frame_helpers.py`** — `is_valid_frame` + `grab_valid_frame`-Retry.

### Services

- **`telegram_bot/`** + **`telegram_helpers.py`** — Paket (7 Dateien)
  mit `TelegramService` und Mixins für Lifecycle, In-/Outbound,
  Formatting; Anchor-Bubble Edit-in-Place, Backoff-Polling, deutsche
  Labels.
- **`weather_service/`** — Paket (11 Dateien). Open-Meteo-Polling,
  History, Wetter-Sichtungen, Sun-/Event-Timelapse, Recaps.
- **`mqtt_service.py`** — paho-mqtt-Wrapper mit Rate-Limit-Logging
  bei publish-Fehlern.

### Storage + Config

- **`settings_store.py`** — Source of Truth für `settings.json`.
- **`storage.py`** — `EventStore`, Per-Cam-Event-JSONs (atomar via
  `_atomic_write_text`).
- **`storage_migration.py`** — idempotenter Boot-Reconcile.
- **`camera_id.py`** — Schema `manufacturer_model_name_iplastoctet`.
- **`schema.py`** — JSON-Schema-Validierung.
- **`config_loader.py`** — `config.yaml`-Loader.
- **`logging_setup.py`** — zentrales Logging, Tag-Schema, Ringbuffer.

### Sonstiges

- **`discovery.py`** — Two-Phase-Subnet-Scan.
- **`event_logic.py`** — Schedule + Alarm-Profile.
- **`cat_identity.py`** — Histogramm-Re-ID für Katzen/Personen.
- **`reolink_api.py`** — Reolink-spezifische API-Helpers.
- **`css_builder.py`** — Build-Helper, der `app.css` aus `web/static/css/`
  zusammensetzt.
- **`timelapse.py`** + **`timelapse_cleanup.py`** — Daily-MP4-Builder
  und Frame-Cleanup-Helfer.

## Web Frontend · `app/web/`

SPA — `web/templates/index.html` + `web/static/app.js` + `app.css`.
Spricht ausschließlich `/api/*`. Wichtige Flows:

- Load → `GET /api/bootstrap` → Wizard oder Dashboard.
- Wizard → `POST /api/wizard/complete`.
- Camera-List → `GET /api/cameras` (Snapshot-URLs + Zonen).
- Save → `POST /api/settings/{cameras,app}` → server-internes
  `rebuild_runtimes()`.

## Storage layout

```
storage/
  settings.json                 # GUI-Source-of-Truth
  settings.json.bak / .bak2     # 2-tief Rotation
  settings.json.bak.<ts>        # Migration-Tagged-Backups
  weather_history.json          # Open-Meteo Sliding-History
  motion_detection/<cam_id>/<date>/<event_id>.{jpg,json,mp4}
  timelapse/<cam_id>/<date>.mp4
  timelapse_frames/<cam_id>/<profile>/<date>/<HHMMSS>.jpg
  weather/<cam_id>/             # Wetter-Clips
  logs/                         # *.log gitignored
  cat_registry.json             # gitignored
  person_registry.json          # gitignored
```

## Tests

```bash
cd app
python -m pytest tests/
```

Einzelne Datei: `python -m pytest tests/test_camera_id.py -v`. Tests
sind stub-basiert — keine echte Coral-Hardware, keine echten APIs.
Fixtures verwenden RFC-5737-Doc-IPs (`192.0.2.x`).

## Maintenance

```powershell
# Monatlich:
docker builder prune -f --filter "until=168h"
docker image prune -f
```

## Known Limitations (by design)

- Keine echte 5-s-Clip-Aufnahme für Telegram bei jedem Event (Snapshots
  + on-demand-Recording stattdessen).
- Zone/Mask-Editor speichert simple Polygone; kein Point-Drag in UI.
- Keine Pagination im Event-Archiv bei sehr großen Mediatheken.
- Person/Cat-Identity ist Histogramm-Match, kein neuronales Re-ID.

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

22 Module, gruppiert nach Verantwortung. Vollständige Aufstellung in
`app/README.md`.

- **`server.py`** — Flask app, alle `/api/*`-Routen. Modul-Init läuft
  `rebuild_runtimes()`; gleiches Re-Run wendet Config-Änderungen an.
- **`camera_runtime.py`** — `RuntimeThread` pro Kamera. Capture →
  Motion → Detector-Cascade → Event-Persist → MQTT → Telegram. 24-h-
  Reconnect-Counter pro Kamera.
- **`detectors.py`** — `CoralObjectDetector` → `BirdSpeciesClassifier`
  → `WildlifeClassifier`. Drei-Tier-Fallback (pycoral / tflite-runtime
  / disabled) pro Stage.
- **`frame_helpers.py`** — `is_valid_frame` + `grab_valid_frame`-Retry.
  Zentraler Frame-Filter (grey/pink/block).
- **`telegram_bot.py`** + **`telegram_helpers.py`** — Anchor-Bubble
  Edit-in-Place, Backoff-Polling, deutsche Labels.
- **`weather_service.py`** — Open-Meteo-Polling, History-Persistenz,
  Wetter-Sichtungen.
- **`mqtt_service.py`** — paho-mqtt-Wrapper.
- **`settings_store.py`** — Source of Truth für `settings.json`.
- **`storage.py`** — `EventStore`, Per-Cam-Event-JSONs.
- **`storage_migration.py`** — idempotenter Boot-Reconcile.
- **`camera_id.py`** — Schema `manufacturer_model_name_iplastoctet`.
- **`schema.py`** — JSON-Schema-Validierung.
- **`config_loader.py`** — `config.yaml`-Loader.
- **`logging_setup.py`** — zentrales Logging, Tag-Schema, Ringbuffer.
- **`discovery.py`** — Two-Phase-Subnet-Scan.
- **`event_logic.py`** — Schedule + Alarm-Profile.
- **`cat_identity.py`** — Histogramm-Re-ID für Katzen/Personen.
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

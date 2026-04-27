# app · Container-Code

App-Container für TAM-spy. Flask-Server, Camera-Runtime, Detektoren,
Telegram-Bot, MQTT, Wetter, Persistenz. Alles läuft im selben Python-Prozess
mit Daemon-Threads pro Kamera.

<p align="center">
  <img src="../docs/illustrations/app-modules.svg" alt="App-Modulkarte: Flask-Server in der Mitte, vier Spokes — Camera Pipeline, Services, Persistenz, Infrastruktur — mit den Python-Modulen unter app/app/" width="100%" />
</p>

## Module-Map

22 Module unter `app/app/`. Reihenfolge ist nach Verantwortung gruppiert,
nicht alphabetisch.

### Camera Pipeline

- **`camera_runtime.py`** — eine `RuntimeThread` pro Kamera. Frame-Capture
  via OpenCV, Motion-Gate, Detektor-Cascade, Event-Persistierung,
  Reconnect-Counter mit 24-h-Sliding-Window. Anchor für `[cam:<id>]`-Logs.
- **`detectors.py`** — drei Detektoren als Cascade:
  `CoralObjectDetector` → `BirdSpeciesClassifier` → `WildlifeClassifier`.
  Drei-Tier-Fallback (pycoral / tflite-runtime / disabled) pro Stage.
  `[det]`-Decision-Log notiert kept-vs-dropped-Reasons.
- **`event_logic.py`** — `is_in_schedule`, `choose_alarm_level`,
  `schedule_action_active`. Reines Regelwerk, keine I/O.
- **`frame_helpers.py`** — "is this frame worth keeping?": grey-/pink-
  /block-Artefakt-Filter. Single source of truth für jede Capture-Loop.
- **`timelapse.py`** — `TimelapseBuilder` ruht Frames pro Kamera/Tag in
  MP4-Tagesfilm zusammen, ffmpeg-stream-copy wenn vorhanden, sonst OpenCV.
- **`timelapse_cleanup.py`** — Reusable Cleanup-Helfer für
  `timelapse_frames/` (von Capture-Loop und CLI-Script genutzt).

### Services

- **`telegram_bot.py`** — `TelegramService`. Self-mutating Anchor-Bubble:
  `/start` öffnet eine Steuer-Nachricht, jede Drilldown-Action editiert
  dieselbe Bubble per `edit_message_text` — kein Chat-Spam. Backoff bei
  Polling-Conflict.
- **`telegram_helpers.py`** — gemeinsame Konstanten: deutsche Labelnamen,
  Scoring-Gewichte, Quiet-Hour-Helpers. Keine API-Calls drin.
- **`weather_service.py`** — `WeatherService`. Polled Open-Meteo
  (`icon_d2`-Modell), persistiert eine Sliding-History in
  `weather_history.json`, triggert Wetter-Sichtungen (Gewitter, Sonnen-
  untergänge, Nebel) als 10 s-Clips.
- **`mqtt_service.py`** — `MQTTService`. Dünner Wrapper um `paho-mqtt`,
  publiziert JSON-Payloads zu `<base_topic>/events/<cam_id>` und
  Status-Topics. No-op wenn deaktiviert.

### Persistenz

- **`settings_store.py`** — `SettingsStore` besitzt `storage/settings.json`.
  Source of Truth. Methoden: `upsert_camera`, `upsert_group`,
  `update_section`, JSON/YAML-Import/Export, `bootstrap_state()`,
  `export_effective_config()` (merged mit `config.yaml`-Base).
- **`storage.py`** — `EventStore`. Per-Kamera-Event-JSONs unter
  `storage/events/<cam_id>/<date>/`. `add_event`, `list_events`,
  `stats_range`, `scan_media_files`.
- **`storage_migration.py`** — idempotenter Boot-Reconcile. Wandert über
  alle Kameras, baut die kanonische ID via `camera_id.build_camera_id`
  und konsolidiert Legacy-Folder unter dem neuen Schema. Backup vor
  jedem Settings-Save.
- **`camera_id.py`** — Single source of truth für Kamera-IDs. Schema:
  `<manufacturer>_<model>_<name>_<ip-last-octet>`. Total — jede
  Eingabe erzeugt eine valide vier-Token-ID.
- **`schema.py`** — JSON-Schema-Validierung für `settings.json`-Sektionen.
- **`config_loader.py`** — lädt `config/config.yaml` als Read-only-Base.

### Infrastruktur

- **`logging_setup.py`** — zentrale Logging-Config. Tag-Schema:
  `[boot]` · `[cam:<id>]` · `[det]` · `[tg]` · `[weather]` ·
  `[storage]` · `[migration]` · `[timelapse]` · `[mqtt]` · `[heartbeat]`.
  In-memory-Ringbuffer (400 Records) versorgt den Logs-Tab der UI.
- **`discovery.py`** — Two-Phase-Subnet-Scan. Phase 1 sweept
  `CAMERA_INDICATOR_PORTS = [554, 8554, 8000, 9000, 37777, 34567]`,
  Phase 2 zieht ONVIF-/HTTP-Banner für die Vendor-Erkennung.
- **`cat_identity.py`** — `IdentityRegistry`. Histogramm-Matching auf
  Crops für Katzen und Personen. Profile in `cat_registry.json` /
  `person_registry.json` (beide gitignored — personenbezogene Daten).
- **`__init__.py`** / **`buildinfo.json`** — Paket-Marker plus
  Build-Metadata, das die UI im Footer rendert.

## Storage-Layout

```
storage/
  settings.json                 # GUI-Source-of-Truth
  settings.json.bak             # 1-tief Rotation (vor jedem Save)
  settings.json.bak2            # 2-tief Rotation
  settings.json.bak.<ts>        # Tagged-Backups (Migration)
  weather_history.json          # Open-Meteo Sliding-History
  motion_detection/<cam_id>/<date>/<event_id>.{jpg,json,mp4}
  timelapse_frames/<cam_id>/<profile>/<date>/<HHMMSS>.jpg
  timelapse/<cam_id>/<date>.mp4
  weather/<cam_id>/             # Wetter-Clips pro Trigger
  logs/                         # optional, *.log gitignored
  test_images/                  # Coral-Test-Batch-Fixtures
  cat_registry.json             # gitignored
  person_registry.json          # gitignored
```

`settings.json` ist die einzige Source of Truth zur Laufzeit. `config.yaml`
seedet beim ersten Start und ist danach nur noch Default-Lieferant. Merges
sind immer additiv — niemals direkt schreiben, immer über
`SettingsStore.update_section` oder `upsert_camera`.

## Tests

```bash
cd app
python -m pytest tests/
```

Einzelne Datei: `python -m pytest tests/test_camera_id.py -v`. Tests
hängen ausschließlich an Stubs/Tmp-Dirs — keine echte Coral, keine echte
Telegram-API. IPs in Fixtures sind RFC-5737-Doc-Adressen.

## Deployment

- **Root-README** für die High-Level-Quickstart
- **`INSTALL_UNRAID.md`** für Bind-Mounts, Coral-USB, Tailscale-Setup
- **`docs/INSTALL_CORAL.md`** für die Classifier-Cascade + Modell-Discovery
- **`docs/camera_notes.md`** für Vendor-Quirks und das Camera-ID-Schema

## Konventionen

- Python: kein `print()`, nur `logging`. Tag-Konventionen aus
  `logging_setup.py` nutzen.
- Settings: niemals überschreiben, nur additiv via `setdefault()` oder
  `update_section`.
- Camera-IDs: ausschließlich über `camera_id.build_camera_id` erzeugen —
  die JS-Seite hat eine bit-für-bit-Kopie unter `web/static/app.js`
  (`buildCameraId`), beide bleiben in lockstep.

<p align="center">
  <img src="docs/banner.svg" alt="TAM-spy — self-hosted camera management with Coral TPU, Telegram alerts, and weather-aware sightings" width="100%" />
</p>

<h3 align="center">Self-hosted camera management with Coral TPU, Telegram alerts, and weather-aware sightings</h3>

<p align="center">
  <img alt="Python 3.11+" src="https://img.shields.io/badge/Python-3.11%2B-3776ab?logo=python&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white" />
  <img alt="Coral TPU" src="https://img.shields.io/badge/Coral%20TPU-supported-ec4899" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/Self--hosted-LAN%20only-22c55e" />
  <img alt="License" src="https://img.shields.io/badge/license-TBD-94a3b8" />
</p>

TAM-spy verwaltet deine Reolink-Kameras lokal: Bewegungs- und Objekterkennung
über Coral TPU, Vogel- und Wildtier-Klassifikation, automatische Zeitraffer,
Wetter-Sichtungen und Telegram-Push-Alerts. Alles läuft auf einem Mini-PC im
LAN — keine Cloud, keine Telemetrie, kein Tracking.

> **Sprachen:** Die Web-UI ist aktuell nur auf Deutsch. Diese README ist auf
> Englisch / Deutsch gemischt — Code-Snippets, CLI-Befehle und Roadmap auf
> Englisch, UI-Beschriftungen und Push-Texte auf Deutsch (1:1 wie in der App).

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>📷 Live-View</strong><br/>
      Mosaic, Single-Cam, HD-Toggle, Per-Cam Mute / Schedule.
      iOS / Mobile: native Video-Fullscreen, Swipe-Gesten, Safe-Area-Insets.
    </td>
    <td width="50%" valign="top">
      <strong>🎞 Mediathek</strong><br/>
      Bewegungsereignisse, gefiltert nach Person, Tier, Auto …
      Lightbox mit Prev/Next über Tagesgrenzen hinweg.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>🐿 Sichtungen</strong><br/>
      Wildlife-Achievements: Vögel (~960 Arten), Säugetiere
      (Eichhörnchen, Igel, Fuchs, Reh, Feldhase) via Cascade-Classifier.
    </td>
    <td valign="top">
      <strong>⛈ Wetter</strong><br/>
      Open-Meteo-Trigger: Gewitter, Sonnenuntergänge, Nebel als 10 s-Clips.
      Statistik-Tab mit 7 numerischen Parametern + Threshold-Linien.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>🤖 Coral TPU + CPU-Fallback</strong><br/>
      Drei-Tier-Pipeline: EdgeTPU (~30 ms) → tflite-runtime CPU
      (~300 ms) → motion-only. Status-Pill zeigt aktiven Tier.
    </td>
    <td valign="top">
      <strong>💬 Telegram-Bot</strong><br/>
      Self-mutating Anchor-Bubble: Drilldowns ändern dieselbe Nachricht
      via Edit-in-Place — kein Chat-Spam, nur eine ständige Steuerzentrale.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>⏱ Zeitraffer</strong><br/>
      Tag / Woche / Monat / Quartal / Jahr — plus Sonnenauf-/-untergang.
      ffmpeg-stream-copy wenn verfügbar, sonst OpenCV-Frame-Buffer.
    </td>
    <td valign="top">
      <strong>🔔 Alerting-Profile</strong><br/>
      Hart / Mittel / Sanft pro Kamera, mit Zeitplan + MQTT-Bridge
      und Whitelist-Personen für Schedule-aware-Suppression.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <strong>🆔 Deterministic Camera-IDs</strong><br/>
      ID-Schema <code>manufacturer_model_name_iplastoctet</code>
      (siehe <code>camera_id.py</code>). Storage-Migration bindet beim
      Boot Legacy-Folder idempotent auf das neue Schema um.
    </td>
    <td valign="top">
      <strong>📋 Strukturierte Logs</strong><br/>
      Tag-Schema <code>[boot]</code> · <code>[cam:&lt;id&gt;]</code>
      · <code>[det]</code> · <code>[tg]</code> · <code>[weather]</code> …
      Boot-Inventory, 24-h-Reconnect-Counter, periodisches Heartbeat.
    </td>
  </tr>
</table>

## Screenshots

> **Note:** the three views below are hand-drawn SVG mockups, not photos of a
> running deployment. They show the UI structure without exposing any user
> data. See [docs/screenshots/CREDITS.md](docs/screenshots/CREDITS.md) for
> details and the recipe for replacing them with real screenshots.

<p align="center">
  <img src="docs/screenshots/01-mediathek.svg" alt="Mediathek mit gefilterten Sichtungen" width="100%" />
</p>

*Mediathek mit Filter-Pills nach Objekttyp · sortiert nach Häufigkeit*

<p align="center">
  <img src="docs/screenshots/02-cam-edit.svg" alt="Kamera-Detailansicht mit Live-View und Verbindungsfeldern" width="100%" />
</p>

*Kamera-Detail mit Live-View, Erkennungs-Profilen, Zonen-Editor*

<p align="center">
  <img src="docs/screenshots/03-telegram.svg" alt="Telegram-Push mit Bestätigungs-Buttons" width="55%" />
</p>

*Telegram-Push mit Inline-Buttons · Gültig / Falsch / 1 h still*

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="TAM-spy data flow: Reolink cameras stream RTSP into the frame pipeline (motion → Coral → species classifier), state lands in storage, and outputs go to the web UI, Telegram bot, and MQTT/Home Assistant" width="100%" />
</p>

Each camera runs on its own daemon thread inside the same process: substream
decode → motion gate → Coral object detection → bird/wildlife species
classification → event write → MQTT publish → Telegram push. Everything
persists under `storage/` (events, timelapses, weather sightings, settings).
The frontend is a single-page app talking to a Flask API — no SSR, no
external dependencies at runtime besides Open-Meteo for weather triggers.

## Quickstart

### 1. Voraussetzungen

- Linux-Host (oder Windows mit Docker Desktop) mit **Docker** und **Docker Compose**
- Mindestens eine **Reolink-Kamera** im LAN (RTSP-fähig)
- Optional: **Google Coral USB Accelerator** für hardware-beschleunigte KI
- Optional: **Telegram-Bot-Token** für Push-Alerts

### 2. Repo klonen und starten

```bash
git clone https://github.com/premiumcola/cam-manager.git
cd cam-manager
docker compose up -d
```

Der `docker-compose.yml` baut das Image aus `app/docker/Dockerfile` und
mountet `./app/app`, `./app/config`, `./app/web`, `./storage`, `./models`
sowie `--device /dev/bus/usb` für den Coral-Stick. Der erste Build dauert
5 – 10 Minuten (PyCoral- und OpenCV-Wheels werden installiert).

> **Coral-Variante:** Wer zwingend EdgeTPU erzwingen will, kommentiert
> den `tam-spy-coral`-Service in `docker-compose.yml` ein und baut mit
> `app/docker/Dockerfile.coral`. Der Standard-Stack erkennt den TPU
> automatisch und fällt sonst auf CPU-tflite zurück — kein Switch nötig.

### 3. Web-UI öffnen

`http://<host-ip>:8099` öffnen, dem Setup-Wizard folgen:

- Standort eingeben (für Sonnen-/Wetter-Trigger)
- Erste Kamera per Auto-Discovery oder manuell hinzufügen
- Optional: Telegram-Bot verbinden

### 4. Coral aktivieren (optional)

Falls ein Coral-USB-Stick angeschlossen ist:

- Settings → **Objekterkennung** → "Coral TPU" einschalten
- "Reload Runtime" klicken — Status zeigt "Coral TPU erkannt und aktiv"

### 5. Telegram-Deep-Links (optional)

Damit die "Im Browser öffnen"-Buttons im Telegram-Bot auf die Web-UI
zeigen, in **Einstellungen → Server** den Eintrag `public_base_url`
auf eine extern erreichbare URL setzen
(z. B. `https://tam-spy.example.org`). Ohne Wert fallen die Buttons
still aus — die Push-Alerts selbst funktionieren weiter.

## Configuration

Alle Einstellungen werden über die Web-UI verwaltet. Die wichtigsten Pfade
für Power-User:

| Pfad                          | Zweck                                                               |
|-------------------------------|---------------------------------------------------------------------|
| `storage/settings.json`       | Effektive Konfiguration (Kameras, Telegram, MQTT, Wetter, Profile)  |
| `storage/settings.json.bak`   | Letzter automatischer Snapshot — wird bei jedem Save erzeugt        |
| `storage/settings.json.bak2`  | Vorvorletzter Snapshot                                              |
| `config/config.yaml`          | Read-only Base-Config (Defaults, Storage-Pfade, Pipeline-Parameter) |
| `docker-compose.yml`          | Volumes, Port `8099`, USB-Pass-Through für Coral                    |

Logs landen sowohl in `docker logs tam-spy` als auch im Logs-Tab der Web-UI
(Filter nach Subsystem und Level). Die in-memory-Buffer-Größe ist 400
Records — für längere Diagnose-Sessions empfiehlt sich `docker logs -f`.

Settings-Backups werden automatisch rotiert (siehe Tabelle oben). Geht eine
Kamera-Konfiguration unbeabsichtigt verloren, lässt sich der Verbindungsblock
einer einzelnen Kamera über die UI **Kamera bearbeiten → "Wiederherstellen ↺"**
aus einer dieser Sicherungen zurückspielen, ohne andere Cams oder andere
Felder zu berühren.

## Tech-Stack

- **Python 3.11** · Flask · APScheduler
- **python-telegram-bot** · paho-mqtt
- **OpenCV** · numpy · Pillow
- **PyCoral / TensorFlow Lite** · iNaturalist Bird Model · Wildlife Classifier
- **astral** (Sonnenstand) · **Open-Meteo** (Wetter, kostenlos, kein Key)
- Reolink RTSP + ONVIF Discovery

## Roadmap

- [x] Coral-Pipeline + Wildlife-Klassifikation
- [x] Telegram self-mutating Anchor-Bubble (Edit-in-Place statt Chat-Spam)
- [x] Wetter-Sichtungen Phase 1 (Backend) + Phase 2 (Mediathek-UI)
- [x] Settings-Backup-Rotation + Connection-Recovery-Flow
- [x] Deterministic Camera-IDs + Storage-Migration on every boot
- [x] iOS / Mobile pass: native fullscreen, swipe, safe-area, deep-links
- [x] Logging overhaul: tag-schema, boot-inventory, 24-h reconnect counter
- [ ] Quartals- und Jahres-Recap-Reels
- [ ] EN-UI-Übersetzung
- [ ] Real screenshots (siehe `docs/screenshots/CREDITS.md`)

Roadmap is honest, not aspirational — Kreuze stehen nur dort, wo es im Repo
wirklich existiert.

## Mitwirken

Pull Requests willkommen. Issues bitte mit:

- Logs (Auszug aus `docker logs tam-spy --tail 200` oder dem Logs-Tab)
- Genaues Reolink-Modell und Firmware-Version
- Schritte zum Reproduzieren

## Lizenz

Eine Lizenz ist noch nicht hinterlegt. Default-Annahme bis dahin: alle Rechte
vorbehalten. Eine MIT-Lizenz ist geplant — sobald sie hinzugefügt wird, hat
der `LICENSE`-File im Repo-Root Vorrang vor dieser Notiz.

## Credits

- **Coral USB Accelerator** (Google) — Edge-TPU-Inferenz
- **python-telegram-bot** maintainers — Bot-Framework
- **Open-Meteo** — kostenlose Wetter-API ohne API-Key
- **iNaturalist** — Bird-Species-Modell
- Stock-Bilder und Screenshot-Mockups: siehe
  [docs/screenshots/CREDITS.md](docs/screenshots/CREDITS.md)

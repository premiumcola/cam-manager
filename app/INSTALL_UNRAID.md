# Unraid Installation für TAM-spy

## Bind-Mounts

Standard-Layout unter `/mnt/user/appdata/tam-spy/`:

```
/mnt/user/appdata/tam-spy/
  config/    → /app/config    (config.yaml — Read-only Base)
  storage/   → /app/storage   (settings.json + Events + Timelapse + Wetter)
  models/    → /app/models    (.tflite — gitignored)
```

`storage/` enthält ALLE persistenten User-Daten. Backup-Strategie auf
diesen Ordner ausrichten (z. B. Unraid CA Backup), nicht auf `config/`.

## Build & Run

```bash
docker build -t tam-spy -f docker/Dockerfile .

docker run -d --name tam-spy --restart unless-stopped \
  -p 8099:8099 -e TZ=Europe/Berlin \
  -v /mnt/user/appdata/tam-spy/config:/app/config \
  -v /mnt/user/appdata/tam-spy/storage:/app/storage \
  -v /mnt/user/appdata/tam-spy/models:/app/models \
  --device /dev/bus/usb \
  tam-spy
```

Web-UI: `http://<UNRAID-IP>:8099`. Beim ersten Start öffnet sich der
**Wizard** — Standort, Telegram, MQTT, erste Kamera durchklicken.

## Coral USB pass-through

`--device /dev/bus/usb` reicht den ganzen USB-Bus durch. Unraid muss den
Coral-Stick im Geräte-Manager sehen — meistens nach Plug-in einer USB-Box
neu starten. Hinweis: nach jedem Host-Reboot kann es nötig sein, den
Stick neu anzustecken, damit `udev` die Permissions sauber setzt.

Pipeline erkennt selbst, ob der TPU verfügbar ist:

- TPU da → `[det] mode=coral` im Log, Inferenz ~30 ms.
- TPU weg → `[det] CPU fallback active` (orangefarbenes UI-Pill),
  Inferenz ~300 ms.
- Modell weg → `[det] disabled` — System läuft motion-only weiter.

## Settings-Schema

`storage/settings.json` wird beim ersten Start aus `config/config.yaml`
geseedet. **Dieser Initial-Sync ist irreversibel** — danach ist
`settings.json` die Source of Truth. `config.yaml`-Änderungen wirken
nur auf neue Installs, nicht auf bestehende.

Vor jedem Save rotiert der Store zwei tiefe Backups:

```
storage/settings.json.bak          (letzter Stand)
storage/settings.json.bak2         (vorletzter Stand)
storage/settings.json.bak.<ts>     (Migration-Backups, getaggt)
```

Geht eine einzelne Kamera-Konfiguration verloren, lässt sich der
Verbindungsblock über **Kamera bearbeiten → Wiederherstellen ↺** aus
einem dieser Backups gezielt zurückspielen.

## Telegram-Deep-Links

Damit "Im Browser öffnen"-Buttons in der Telegram-Bubble funktionieren,
muss die Unraid-Box von außerhalb erreichbar sein. Empfohlene Wege:

- **Tailscale** (kein Port-Forward nötig): `tailscale up` im Container-
  Host, MagicDNS aktivieren, in den TAM-spy-Settings unter
  **Server → public_base_url** den Tailscale-Hostnamen eintragen
  (z. B. `http://unraid.tailnet-XXXX.ts.net:8099`).
- **Reverse-Proxy** (Caddy / NGINX Proxy Manager) auf einer öffentlichen
  Domain mit TLS — `public_base_url` zeigt auf `https://tam-spy.example.org`.

Ohne `public_base_url` fallen die Buttons still aus; Push-Alerts und
Inline-Confirm-Buttons funktionieren weiter.

## Backup-Empfehlung

Die folgenden Pfade enthalten persistente User-Daten und sollten in das
Unraid-CA-Backup eingeschlossen werden:

- `storage/settings.json` + alle `.bak*`
- `storage/weather_history.json`
- `storage/motion_detection/`, `storage/timelapse/`, `storage/weather/`

Die folgenden NIE pushen / committen — sie stehen in `.gitignore`:

- `cat_registry.json`, `person_registry.json` — personenbezogene
  Embeddings
- `*.log`, `storage/logs/` — können RTSP-URLs mit Credentials enthalten

## Troubleshooting

| Symptom | Erste Anlaufstelle |
|---------|-------------------|
| Kamera nicht erreichbar | `[cam:<id>]` im Log-Tab — RTSP-Open-Fehler stehen mit maskierter URL drin |
| CPU-Fallback aktiv | Coral-USB-Stick + Permissions; `lsusb` im Host muss Google-Vendor-ID zeigen |
| Storage-Migration loops | Erwartet ist genau eine Zeile `[migration] processed N cameras, M folder merges` pro Boot — wiederholt sich das, läuft der Storage-Pfad doppelt gemountet |
| Telegram "Conflict 409" | Zweite Instanz pollt mit demselben Token — Container-Duplikat oder lokal noch eine `python -m app.server` offen |
| `[heartbeat]` zeigt 0 events | Motion-Schwelle zu hoch oder Kamera dauerhaft offline; Logs nach `[det]` filtern |

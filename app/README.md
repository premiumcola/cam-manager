
# TAM-spy

Aktueller Stand baut auf **`tam-spy-gui-config.zip`** auf und erweitert ihn um drei fehlende Komfortpunkte:

- **First-Start-Wizard** in der Web-GUI
- **Masken- und Zonen-Editor direkt im UI**
- **JSON/YAML Import & Export** für die gesamte GUI-Konfiguration

## Neu in diesem Stand
- GUI-first bleibt die Hauptlogik
- Wizard führt beim ersten Start durch App-Name, Telegram, MQTT und erste Kamera
- Masken/Zonen werden direkt pro Kamera gezeichnet und in den Kamera-Settings gespeichert
- Konfiguration kann per **JSON oder YAML** exportiert und importiert werden
- bestehende Seiten und Funktionen aus dem vorherigen Stand bleiben erhalten

## Start auf Unraid
1. Projekt nach `/mnt/user/appdata/tam-spy/` entpacken
2. `config/config.yaml.example` nach `config/config.yaml` kopieren
3. optional Basispfade in YAML anpassen
4. Container bauen und starten
5. Web-GUI öffnen und den Wizard durchlaufen

## Wichtige Pfade
- Persistente GUI-Settings: `storage/settings.json`
- Import/Export über die Seite **Einstellungen**
- Snapshot-/Masken-Editor über **Kameras**

## Ehrlich wichtig
- Masken/Zonen werden aktuell als einfache Polygone gespeichert; ein erweiterter visueller Editor mit Verschieben einzelner Punkte ist noch nicht drin.
- YAML/JSON Import überschreibt die betroffenen GUI-Bereiche bewusst direkt.
- Secrets wie Token/Passwörter liegen weiter in `settings.json`, also Appdata sauber absichern.

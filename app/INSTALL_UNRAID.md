
# Unraid Installation für TAM-spy

## Ordner
Empfohlen:
- `/mnt/user/appdata/tam-spy/config`
- `/mnt/user/appdata/tam-spy/storage`
- `/mnt/user/appdata/tam-spy/models`

## Build
```bash
docker build -t tam-spy -f docker/Dockerfile.coral .
```

## Run
```bash
docker run -d   --name tam-spy   --restart unless-stopped   -p 8099:8099   -e TZ=Europe/Berlin   -v /mnt/user/appdata/tam-spy/config:/app/config   -v /mnt/user/appdata/tam-spy/storage:/app/storage   -v /mnt/user/appdata/tam-spy/models:/app/models   --device /dev/bus/usb   tam-spy
```

## Danach
- Browser: `http://<UNRAID-IP>:8099`
- beim ersten Start öffnet sich der **Wizard**
- weitere Kameras, Gruppen, MQTT, Telegram und Masken/Zonen direkt in der GUI pflegen
- Konfiguration über **Einstellungen → Import / Export** sichern

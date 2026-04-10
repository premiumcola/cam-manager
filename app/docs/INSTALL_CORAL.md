# Coral Hinweise

## Zielbild
- Coral übernimmt die **schnelle Objekterkennung**
- optionaler zweiter Classifier macht daraus **Vogelarten**

## Was du wirklich brauchst
1. USB Coral korrekt an Unraid / Container durchreichen
2. EdgeTPU Runtime + PyCoral im Container
3. ein **kompiliertes EdgeTPU-Modell** für Objekte
4. optional ein zweites **kompiliertes EdgeTPU-Modell** für Vogelarten

## Objektmodell
Für den Anfang reicht ein COCO-basiertes Detect-Modell.
Damit bekommst du meist:
- person
- bird
- cat
- dog
- car

## Vogelarten
Hier brauchst du ein separates Modell. Das Projekt hat dafür nur die **Pipeline** vorbereitet:
- Bird-Detection findet einen Vogel
- Crop des Vogels
- Species-Classifier läuft auf dem Crop
- Event bekommt z. B. `Amsel` oder `Kohlmeise`

Ohne Artenmodell bleibt das Event einfach `bird`.

## Katzennamen
- erste Katze benennen
- Profil wird als Hash gespeichert
- spätere Treffer werden dagegen verglichen

## Empfehlung
Für beste Trefferqualität:
- Kamera nicht zu hoch montieren
- eher engeren Bildausschnitt wählen
- Substream fürs Dashboard, Mainstream für Erkennung
- feste Belichtung/Nachtmodus sauber einstellen

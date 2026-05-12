# Maintenance Panels — Button Audit

Snapshot of the two settings accordions ("Mediathek-Wartung" and
"Wetter-Wartung") and what each visible button actually does. Drives
the macro extraction in task T2 and the legacy-button deletions in
task T3.

Date: 2026-05-12. Source of truth at this moment: `partials/mediathek.html`
+ `partials/weather.html`, with JS handlers traced through
`static/js/mediathek/rescan.js`, `static/js/chrome/storage-stats.js`,
and `static/js/weather/maintenance.js`.

## Mediathek-Wartung (rename target — currently `Mediathek-Einstellungen`)

Source: `app/web/templates/partials/mediathek.html`. All five buttons sit
under a single "Sonderaktionen" head inside the same accordion.

| Button id              | Label                       | Container                  | JS handler                                     | Backend endpoint                  | What it does                                                                                                            | Verdict | Reason                                                                                  |
|------------------------|-----------------------------|----------------------------|------------------------------------------------|-----------------------------------|-------------------------------------------------------------------------------------------------------------------------|---------|-----------------------------------------------------------------------------------------|
| `fixThumbsBtn`         | Thumbnails neu generieren   | Sonderaktionen action row  | `static/js/mediathek/rescan.js:110`            | `POST /api/media/fix-thumbnails`  | Walks `storage/motion_detection/**` and regenerates any missing or corrupt `*.jpg` thumbnails from the matching `.mp4`. | keep    | Recovery after corruption / disk failure; no other path produces them.                  |
| `rescanMediaBtn`       | Neu scannen                 | Sonderaktionen action row  | `static/js/mediathek/rescan.js:14`             | `POST /api/media/rescan`          | Re-indexes `storage/motion_detection/` into `EventStore` so files that landed outside the runtime path become visible.  | keep    | Index recovery — useful after manual file moves or migration.                           |
| `reindexTrackingBtn`   | Tracking neu generieren     | Sonderaktionen action row  | `static/js/mediathek/rescan.js:148`            | `POST /api/tracking/reindex-all`  | Re-runs `tracking_worker` over every event so each `.mp4` regains a fresh `tracks.json` sidecar.                        | keep    | Mediathek-only — Wetter has no per-clip detection tracks; no equivalent button needed.  |
| `purgeOrphansBtn`      | Verwaiste Events            | Sonderaktionen action row  | `static/js/chrome/storage-stats.js:71`         | `POST /api/media/purge-orphans`   | Deletes index rows whose `.mp4` / `.jpg` files are missing on disk.                                                     | drop    | Auto-Cleanup + retention slider already cover this — predates auto-cleanup.             |
| `cleanupNowBtn`        | Jetzt bereinigen            | Sonderaktionen action row  | `static/js/chrome/storage-stats.js:58`         | `POST /api/media/cleanup`         | Force-runs the retention sweeper RIGHT NOW (otherwise daily).                                                           | drop    | Same — lower the retention slider + Speichern achieves the same effect with less UI.    |
| `mediaSaveBtn` (form)  | Speichern                   | Bottom of accordion        | inline form submit handler (`/api/settings/app`) | `POST /api/settings/app`          | Saves retention days + auto-cleanup-enabled into `storage/settings.json`.                                              | keep    | Only way to persist the retention settings the slider drives.                           |

Notes:
- The endpoints for `purgeOrphansBtn` + `cleanupNowBtn` stay alive in the
  backend per the prompt — "in case something else calls them" — only the
  UI buttons get dropped in T3.
- Retention slider + auto-cleanup toggle stay (they're already wired to
  the daily sweeper).

## Wetter-Wartung

Source: `app/web/templates/partials/weather.html`. Two buttons under one
"Sonderaktionen" head — no retention controls today, no Speichern.

| Button id              | Label                          | Container                  | JS handler                                | Backend endpoint                | What it does                                                                                                            | Verdict | Reason                                                                                  |
|------------------------|--------------------------------|----------------------------|-------------------------------------------|---------------------------------|-------------------------------------------------------------------------------------------------------------------------|---------|-----------------------------------------------------------------------------------------|
| `weatherRescanBtn`     | Wetter neu einlesen            | Sonderaktionen action row  | `static/js/weather/maintenance.js:22`     | `POST /api/weather/rescan`      | Re-walks `storage/weather/` + the sun/event-timelapse trees, registers any unindexed `.mp4`.                            | keep    | Index recovery — equivalent of mediathek's `rescanMediaBtn` for the weather corpus.     |
| `weatherThumbRegenBtn` | Wetter-Thumbnails neu erzeugen | Sonderaktionen action row  | `static/js/weather/maintenance.js:49`     | `POST /api/weather/thumbs/regen` | Regenerates missing or corrupt thumbnails for every weather sighting / sun-tl / event-tl entry.                         | keep    | Recovery after corruption / migration; mirror of mediathek's `fixThumbsBtn`.            |

Notes:
- Neither button drops; both have the same purpose as their Mediathek
  counterparts and address operator-side recovery, not user workflow.
- T3 will add a retention slider + auto-cleanup toggle + Speichern row
  to this panel, matching the Mediathek layout via the new shared macro.

## Cross-panel summary

After T2 + T3 land:

| Panel              | Sonderaktionen buttons                                    | Retention slider | Auto-Cleanup toggle | Speichern |
|--------------------|----------------------------------------------------------|------------------|---------------------|-----------|
| Mediathek-Wartung  | fixThumbsBtn, rescanMediaBtn, reindexTrackingBtn          | ✓                | ✓                   | ✓         |
| Wetter-Wartung     | weatherRescanBtn, weatherThumbRegenBtn                    | ✓ (new, default 90 d) | ✓ (new, default true) | ✓ (new) |

Both panels render through the same `_maintenance_panel.html` macro
(T2). The shared shell handles the accordion frame, the "Sonderaktionen"
sub-head, the action button row, and the optional
retention+auto-cleanup+save row. Mediathek loses the two danger buttons
(`purgeOrphansBtn` + `cleanupNowBtn`); Wetter gains the retention row.

## Backend cleanup pass for Wetter

A parallel pass to the existing media cleanup (`POST /api/media/cleanup`)
needs to iterate the weather sightings index and respect
`weather.retention_days` + `weather.auto_cleanup_enabled`. Same daily
schedule as the Mediathek cleanup. Endpoint can stay private (called
from the scheduler only) — the per-user-trigger button is intentionally
NOT being added to keep the UI symmetric with Mediathek-without-the-
legacy-buttons.

## Open questions

- Should `reindexTrackingBtn` land in Wetter-Wartung too? Weather TLs
  don't currently get per-clip detection tracks, so the answer is no
  for the moment. If the wildlife classifier ever runs across weather
  TLs, revisit.
- Trash / Papierkorb (T4) gets its own collapsible section under
  BOTH panels via the same macro — the audit table above doesn't list
  it because the buttons don't exist yet.

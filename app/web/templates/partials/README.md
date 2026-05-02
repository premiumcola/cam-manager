# Jinja partials

`index.html` is a thin Jinja shell — every panel and major UI block is
extracted into its own partial under this directory and pulled in via
`{% include 'partials/<name>.html' %}`. The split is purely structural:
no markup changed during the extraction, the rendered HTML is
byte-equivalent to the pre-split template (modulo whitespace from the
include directives).

## Why

The pre-split `index.html` was 1646 lines. Browsing it required scrolling
past whichever panel you weren't editing. With partials:

- Each panel lives in its own file, so its name in the file tree tells you
  what it is.
- Diffs from a panel-specific change touch only that panel's file.
- The router/JS wiring still finds elements by ID — IDs and `data-*`
  attributes were preserved verbatim.

## Layout

| File | What's in it |
|---|---|
| `icons.html` | The shared SVG `<symbol>` sprite (used by every section's `<use>` references) |
| `wizard.html` | First-run setup wizard modal (`#wizard`) |
| `sidenav.html` | Desktop sidebar nav (`<aside class="sidebar">`) |
| `hero.html` | Top hero panel with TAM-spy lockup + build-info |
| `dashboard.html` | `<section id="dashboard">` — Live Feed grid |
| `cam_edit.html` | `<section id="cameras">` — the long camera-edit form (Verbindung / Erkennung / Alerting / Zonen / Timelapse tabs) |
| `statistik.html` | `<section id="statistik">` |
| `mediathek.html` | `<section id="media">` |
| `sichtungen.html` | `<section id="achievements">` |
| `weather.html` | `<section id="weather">` |
| `settings.html` | `<section id="settings">` (App / Coral / Telegram / Push / Storage / Timelapse / Wetter / etc subtabs) |
| `logs.html` | `<section id="logs">` |
| `modals.html` | Discovery, lightbox, live-view, merge, confirm, cam-recovery modals + toast container — all body-level overlays |
| `mobile_dock.html` | `<nav id="mobileDock">` bottom dock |

## Jinja context dependencies

The only Jinja expressions in the original `index.html` were two
`static_v(...)` cache-bust calls in `<head>` and the closing `<script>`.
**Both stay in `index.html`** — partials need zero context. They are pure
static HTML embedded via plain `{% include %}` (no `with context`, no
explicit `with foo=bar` argument passing).

## Whitespace + structural notes

- `index.html` keeps the structural wrappers itself: `<body>`,
  `<div class="shell">`, `<main class="main">`, the closing tags, and the
  one-line `<div id="sidebarOverlay">` that sits between the icon sprite
  and the wizard. Putting that one div in a partial would create a
  one-line file for marginal gain.
- `sidenav.html` contains ONLY the desktop sidebar `<aside>`. The mobile
  bottom dock has its own partial (`mobile_dock.html`) because the two
  render at very different positions in the document — one at the top of
  `.shell`, one outside it at the bottom.
- `cam_edit.html` is intentionally large (684 lines). Splitting the five
  internal tabs (Verbindung / Erkennung / Alerting / Zonen / Timelapse)
  into sub-partials would couple them tighter to the camera-edit JS state
  machine; that is a separate refactor.
- `settings.html` is also large (405 lines) for the same reason — its
  subtabs share a lot of in-place state. A future pass can extract
  `partials/settings/<sub>.html` once the JS hydration is sub-scoped.

## Adding a partial

1. Create the file under `partials/`.
2. Add an `{% include 'partials/<name>.html' %}` line in `index.html` at
   the right structural position.
3. Restart the Flask container (`docker restart tam-spy`) — Flask caches
   templates at process start, so partials don't hot-reload like static
   assets do.
4. Update the table above.

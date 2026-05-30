// ─── weather/sightings.js ──────────────────────────────────────────────────
// Stage 24 of the legacy.js → ES modules refactor — Wetter-Sichtungen
// grid + lightbox + recaps + hash-anchor handler. Pure code move from
// legacy.js; the two _orig* monkey-patches that lived at the bottom
// of legacy.js have been folded directly into the function bodies
// (loadWeatherSightings -> loadWeatherRecaps; renderWeatherSightings
// -> _renderWeatherRecaps) so callers see one definition, no double-
// override risk.
import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { showToast, showConfirm } from '../core/toast.js';
import { apiGet, apiDelete } from '../core/api.js';
import { WEATHER_TYPES } from '../core/weather-types.js';
import { precipitationLabel } from '../core/weather-precip.js';
// Reuse the Library card's trash glyph so the weather cards' hover-reveal
// delete reads identically to the Mediathek media-card.
import { _LB_TRASH_ICON_ONLY } from '../mediaview/panels/lb-helpers.js';

// Pick the right human-readable label for a sighting badge. For
// `heavy_rain` we band the actual current precipitation reading
// (api_snapshot.precipitation) — the static "Starkregen" from
// WEATHER_TYPES is the *event-type* name and would mislabel a card
// captured at e.g. 0.1 mm/h. For all other event types we fall back
// to the static WEATHER_TYPES label.
function _weatherSightingLabel(s, meta) {
  if (s && s.event_type === 'heavy_rain') {
    const snap = s.api_snapshot || {};
    if (snap.precipitation !== null && snap.precipitation !== undefined) {
      return precipitationLabel(snap.precipitation);
    }
  }
  return meta.de;
}
import { openMediaView } from '../mediaview/index.js';
import { closeWeatherMode } from '../mediaview/weather-mode.js';

async function loadWeatherSightings(filter) {
  // Filter migrates from single-string to Set semantics: state.weather.filter
  // is a Set of event_type strings. Empty Set = "no filter, show everything"
  // (matches the Mediathek pill UX). Server fetch always pulls the full list
  // — filtering happens client-side in _renderWeatherGrid so toggling pills
  // doesn't trigger a network round-trip. The legacy single-string call site
  // is still tolerated: a string argument seeds a single-member Set.
  try {
    const data = await apiGet('/api/weather/sightings');
    state.weather.items = data.items || [];
    state.weather.counts = data.counts || {};
    state.weather.total = data.total || 0;
    if (filter instanceof Set) {
      state.weather.filter = filter;
    } else if (typeof filter === 'string' && filter) {
      state.weather.filter = new Set([filter]);
    } else if (!(state.weather.filter instanceof Set)) {
      // First load → seed with every event type that has items, mirroring
      // the Mediathek "all on by default" rule.
      const present = Object.keys(WEATHER_TYPES).filter((t) => (state.weather.counts[t] || 0) > 0);
      state.weather.filter = new Set(present);
    }
    renderWeatherSightings();
  } catch (_err) {
    // silently degrade — section stays empty
  }
  // Phase 3 — Recaps live next to sightings; loading them here keeps the
  // two views synced without a separate boot hook. (Folded in from the
  // _origLoadWeatherSightings monkey-patch that lived at the bottom of
  // legacy.js pre-stage-24.)
  await loadWeatherRecaps();
}

function renderWeatherSightings() {
  const block = byId('weatherSightingsBlock');
  if (!block) return;
  const sub = byId('weatherSightingsSubtitle');
  if (sub) {
    const yr = new Date().getFullYear();
    sub.textContent = `${state.weather.total} Ereignisse · ${yr}`;
  }
  _renderWeatherFilterPills();
  _renderWeatherGrid();
  // Phase 3 — Recap strip re-renders alongside sightings. (Folded in
  // from the _origRenderWeatherSightings monkey-patch.)
  _renderWeatherRecaps();
}

function _renderWeatherFilterPills() {
  const bar = byId('weatherFilterBar');
  if (!bar) return;
  // Render a filter pill ONLY for weather types that actually have events;
  // zero-count types are skipped entirely so the bar collapses to a single
  // row. Sort the survivors by count desc, ties by spec order.
  const types = Object.keys(WEATHER_TYPES);
  const counts = state.weather.counts || {};
  const sorted = types
    .filter((t) => (counts[t] || 0) > 0)
    .sort((a, b) => {
      const d = (counts[b] || 0) - (counts[a] || 0);
      return d || types.indexOf(a) - types.indexOf(b);
    });
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  let html = sorted
    .map((t) => {
      const meta = WEATHER_TYPES[t];
      const cnt = counts[t] || 0;
      const active = sel.has(t);
      const cls = `media-pill cat-filter-btn${active ? ' active' : ''}`;
      const cntChip = `<span class="mp-count" style="pointer-events:none">${cnt}</span>`;
      // Visible text: short `de` label. Tooltip + accessible name: full
      // `de_full` (falls back to `de` when not set) so screen readers and
      // hover tooltips keep the long form even when the chip itself is
      // truncated for space.
      const fullLbl = meta.de_full || meta.de;
      return `<button type="button" class="${cls}" data-type="weather" data-val="${esc(t)}" title="${esc(fullLbl)}" aria-label="${esc(fullLbl)}, ${cnt} Ereignisse" style="--cb:${meta.color}"><span class="cfb-icon" style="pointer-events:none;color:${meta.color}">${meta.icon}</span><span style="pointer-events:none">${esc(meta.de)}</span>${cntChip}</button>`;
    })
    .join('');
  if (sel.size === 0) {
    html += `<span class="media-pill media-pill--status" aria-disabled="true">alle Filter aus</span>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.media-pill').forEach((p) => {
    if (p.classList.contains('media-pill--status')) return;
    p.addEventListener('click', () => {
      const val = p.dataset.val;
      if (!(state.weather.filter instanceof Set)) state.weather.filter = new Set();
      if (state.weather.filter.has(val)) state.weather.filter.delete(val);
      else state.weather.filter.add(val);
      // Filter change can shrink the result set below the current
      // page — reset to page 0 so the user sees the freshest items
      // instead of an empty trailing page.
      state.weather.page = 0;
      // No fetch needed — filtering is client-side now.
      renderWeatherSightings();
    });
  });
}

// Viewport-aware page size: tight on phones (4 = 2×2 mosaic that
// matches the .ws-grid 2-col mobile layout), comfortable on tablets,
// 3×3 on desktop so the pagination control stays in view on a
// 1080 p screen without scrolling. Recomputed on every render so a
// window resize adjusts the page count without a reload.
function _weatherPageSize() {
  const w = window.innerWidth || 1200;
  if (w <= 768) return 4;
  if (w <= 1180) return 8;
  return 9;
}

// ── Mediathek-style card chrome ───────────────────────────────────────────
// The two inline-style strings below are copied verbatim from mediaCardHTML()
// in mediathek/orchestration.js so the badge font / blur / radius match the
// Library cards 1:1 without re-exporting private constants. _WS_SUB_BADGE_BASE
// gets the event's own colour appended per card at build time.
const _WS_BADGE_STYLE =
  'font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;line-height:1.45;white-space:nowrap';
const _WS_SUB_BADGE_BASE =
  'font-size:10px;background:none;backdrop-filter:blur(3px);padding:0 6px;border-radius:4px;line-height:1.45;white-space:nowrap;margin-top:1px;opacity:0.85';

// Duration m:ss + byte→KB/MB formatters — mirror Mediathek's fmtDur / fmtByt
// so the bottom-right stack reads identically to the Library cards.
function _wsFmtDur(s) {
  if (!s || s <= 0) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
function _wsFmtBytes(b) {
  if (!b || b <= 0) return '';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

// Build one weather-sighting card, mirroring the Mediathek media-card:
// type badge + score top-left, hover-reveal delete top-right, date/time
// bottom-left, duration/size bottom-right. `idx` is the absolute index into
// the filtered list (data-idx → lightbox prev/next); `isActive` is false
// when the camera was removed — that dims the card and swaps the thumb for
// the striped orphan placeholder.
function _weatherSightingCardHTML(s, idx, isActive) {
  const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8', icon: '' };
  // Sun-timelapse cards prefer the real sunrise/sunset time over the
  // window-end timestamp; older records without sun_event_at fall back.
  const t = new Date(s.sun_event_at || s.started_at);
  const dateLabel = t.toLocaleDateString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  });
  const timeLabel = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const sevPct = Math.round((s.score || s.severity || 0) * 100);
  // The percentage means different things per type; the same text feeds the
  // tap-to-explain toast since title= doesn't surface on touch.
  const isSunTl = typeof s.event_type === 'string' && s.event_type.startsWith('sun_timelapse');
  const scoreTip = isSunTl
    ? 'Himmelsqualität · 100% = klarer Himmel, 50% = stark bewölkt'
    : 'Stärke des Wetterereignisses';
  const color = meta.color || '#94a3b8';
  const subBadge = `${_WS_SUB_BADGE_BASE};color:${color}`;
  const displayLabel = _weatherSightingLabel(s, meta);
  const durLabel = _wsFmtDur(s.duration_s);
  const sizeLabel = _wsFmtBytes(s.file_size_bytes);
  const thumbHtml = isActive
    ? `<img class="ws-card-thumb" loading="lazy" src="/api/weather/sightings/${encodeURIComponent(s.id)}/thumb" alt="${esc(displayLabel)}" onerror="this.style.opacity=0.2"/>`
    : `<div class="ws-card-thumb ws-card-thumb--orphan" aria-hidden="true"></div>`;
  const scoreChip =
    sevPct > 0
      ? `<span class="ws-score-chip" role="button" tabindex="0" style="pointer-events:auto" title="${esc(scoreTip)}" aria-label="${sevPct} Prozent, ${esc(scoreTip)}" data-score-tip="${esc(scoreTip)}">${sevPct}%<span class="ws-score-info" aria-hidden="true">ⓘ</span></span>`
      : '';
  const rightStack =
    durLabel || sizeLabel
      ? `<div class="ws-card-stack ws-card-stack--r">${durLabel ? `<div style="${_WS_BADGE_STYLE}">${durLabel}</div>` : ''}${sizeLabel ? `<div style="${subBadge}">${sizeLabel}</div>` : ''}</div>`
      : '';
  return `
      <div class="ws-card${isActive ? '' : ' ws-card--orphan'}" data-idx="${idx}" data-id="${esc(s.id)}">
        <div class="ws-card-thumb-wrap">
          ${thumbHtml}
          <span class="ws-card-play">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </span>
          <div class="ws-card-cluster">
            <span class="mmc-tl-badge ws-type-badge" style="border-color:${color}b3;color:${color}"><span class="ws-card-badge-icon">${meta.icon}</span>${esc(displayLabel)}</span>
            ${scoreChip}
          </div>
          <div class="ws-card-stack ws-card-stack--l">
            <div style="${_WS_BADGE_STYLE}">${dateLabel}</div>
            <div style="${subBadge}">${timeLabel}</div>
          </div>
          ${rightStack}
          <div class="mmc-actions">
            <button type="button" class="mmc-btn mmc-delete" title="Löschen" aria-label="Löschen">${_LB_TRASH_ICON_ONLY}</button>
          </div>
        </div>
      </div>`;
}

// Delete a sighting straight from its card (Mediathek-style hover trash —
// no confirm modal; the heavier confirm lives in the lightbox). Fades the
// card, hits the same DELETE endpoint the lightbox uses, then re-fetches so
// the grid, filter pills and counts all reflect the removal.
function _deleteSightingCard(id, cardEl) {
  if (!id) return;
  if (cardEl) {
    cardEl.style.transition = 'opacity .2s, transform .2s';
    cardEl.style.opacity = '0';
    cardEl.style.transform = 'scale(0.96)';
  }
  apiDelete(`/api/weather/sightings/${encodeURIComponent(id)}`)
    .then(() => loadWeatherSightings(state.weather.filter))
    .catch((err) => {
      showToast('Löschen fehlgeschlagen: ' + (err?.message || err), 'error');
      if (cardEl) {
        cardEl.style.opacity = '';
        cardEl.style.transform = '';
      }
    });
}

function _renderWeatherGrid() {
  const grid = byId('weatherSightingsGrid');
  if (!grid) return;
  const empty = byId('weatherSightingsEmpty');
  const allItems = state.weather.items || [];
  // Client-side filter: include items whose event_type is in the active
  // filter Set. Empty Set = "no filter active → show all" (matches the
  // Mediathek mental model).
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  const items = sel.size === 0 ? allItems : allItems.filter((s) => sel.has(s.event_type));
  if (!items.length) {
    grid.innerHTML = '';
    if (empty) empty.hidden = false;
    _renderWeatherPagination(0, 0);
    return;
  }
  if (empty) empty.hidden = true;
  // Slice the filtered list for the current page. The renderer below
  // walks `items` so we replace it in-place; the original full list
  // stays in state.weather.items for the next filter toggle.
  const pageSize = _weatherPageSize();
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  let page = Number.isInteger(state.weather.page) ? state.weather.page : 0;
  if (page >= pageCount) page = pageCount - 1;
  if (page < 0) page = 0;
  state.weather.page = page;
  const sliceStart = page * pageSize;
  const visibleItems = items.slice(sliceStart, sliceStart + pageSize);
  // The renderer expects the full `items` for click-into-lightbox idx
  // semantics. Surface the visible slice here but preserve the full
  // filtered list as state.weather.itemsFiltered for the lightbox to
  // index into via the absolute idx attribute.
  state.weather.itemsFiltered = items;
  // Pre-compute the active-camera id set so each sighting card can
  // decide whether to actually request its thumb. Sightings recorded
  // before a manuf/model edit carry the OLD canonical cam_id in their
  // sighting.id (the on-disk path was already renamed by storage_
  // migration), so the thumb URL 404s. Skipping the <img> tag for
  // those entries avoids the network request and keeps the console
  // clean — the card still renders with a placeholder so the user can
  // see the orphan exists and decide whether to delete it.
  const _activeCamIds = new Set((state.cameras || []).map((c) => c.id));
  // Render only the visible slice for the current page; data-idx
  // carries the absolute index in `items` (filtered list) so the
  // lightbox can navigate prev/next across the whole filtered set.
  grid.innerHTML = visibleItems
    .map((s, localIdx) =>
      _weatherSightingCardHTML(s, sliceStart + localIdx, _activeCamIds.has(s.cam_id)),
    )
    .join('');
  grid.querySelectorAll('.ws-card').forEach((card) => {
    card.addEventListener('click', () => openWeatherLightbox(parseInt(card.dataset.idx, 10)));
  });
  // Hover-reveal delete (top-right) mirrors the Mediathek media-card:
  // stopPropagation so the trash tap removes the event instead of opening
  // the lightbox, then a re-fetch refreshes grid + filter counts.
  grid.querySelectorAll('.mmc-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.ws-card');
      if (card) _deleteSightingCard(card.dataset.id, card);
    });
  });
  // Score chips fire a toast with the metric explanation on tap —
  // title= alone is desktop-only. stopPropagation keeps the chip tap
  // from also opening the card lightbox.
  grid.querySelectorAll('.ws-score-chip').forEach((b) => {
    const tip = b.getAttribute('data-score-tip');
    if (!tip) return;
    const fire = (e) => {
      e.stopPropagation();
      showToast(tip, 'info');
    };
    b.addEventListener('click', fire);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fire(e);
      }
    });
  });
  _renderWeatherPagination(items.length, pageSize);
}

// Pagination strip underneath the grid. Copied 1:1 from the Mediathek
// renderMediaPagination() recipe (mediathek/orchestration.js): a prev
// chip, a "Seite X von Y" label, and a next chip — no numbered pill row
// (it got ugly with many pages). The container
// (#weatherSightingsPagination) already carries `media-pagination` so
// the `.page-pill` / `.page-pill-chip` / `.page-label` styling is shared
// with the Library. Wiring is unchanged: prev/next move
// state.weather.page, re-render the grid, and scroll it back into view;
// the strip stays hidden for single-page lists.
function _renderWeatherPagination(totalItems, pageSize) {
  const pag = byId('weatherSightingsPagination');
  if (!pag) return;
  if (!totalItems || totalItems <= pageSize) {
    pag.hidden = true;
    pag.innerHTML = '';
    return;
  }
  pag.hidden = false;
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const cur = Number.isInteger(state.weather.page) ? state.weather.page : 0;
  pag.innerHTML =
    `<button type="button" class="page-pill" data-act="prev" ${cur === 0 ? 'disabled' : ''} aria-label="Vorherige Seite"><span class="page-pill-chip">‹</span></button>` +
    `<span class="page-label">Seite ${cur + 1} von ${pageCount}</span>` +
    `<button type="button" class="page-pill" data-act="next" ${cur >= pageCount - 1 ? 'disabled' : ''} aria-label="Nächste Seite"><span class="page-pill-chip">›</span></button>`;
  pag.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      let next = state.weather.page || 0;
      if (btn.dataset.act === 'prev') next = Math.max(0, next - 1);
      else if (btn.dataset.act === 'next') next = Math.min(pageCount - 1, next + 1);
      if (next === state.weather.page) return;
      state.weather.page = next;
      _renderWeatherGrid();
      // Scroll the grid back into view so the user sees the new page,
      // not whatever scroll position the strip was at.
      byId('weatherSightingsGrid')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// Window resize switches the page-size band (4 → 8 → 12). Re-render
// the grid so the user sees the right column count immediately and
// the page index gets clamped to the new page count.
let _wsResizeTimer = null;
window.addEventListener(
  'resize',
  () => {
    if (_wsResizeTimer) clearTimeout(_wsResizeTimer);
    _wsResizeTimer = setTimeout(() => {
      _renderWeatherGrid();
    }, 150);
  },
  { passive: true },
);

let _wsLbIdx = -1;

// Reshape a weather sighting into the MediaView shell item: the title
// bar reads camera_name + time_label; the Wetter tab reads
// api_snapshot + sun_snapshot. event_type seeds a short type word in
// the time label so the header still reads "Sonnenuntergang · 30.05.".
function _sightingItem(s) {
  const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type || '' };
  const t = new Date(s.started_at);
  const when = Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const label = _weatherSightingLabel(s, meta);
  return {
    camera_name: s.cam_name || s.cam_id || '',
    time_label: [label, when].filter(Boolean).join(' · '),
    api_snapshot: s.api_snapshot,
    sun_snapshot: s.sun_snapshot,
    event_type: s.event_type,
  };
}

// Confirm + delete a sighting from inside the player, then close the
// modal and refresh the grid so counts / filter pills stay consistent.
function _confirmDeleteSighting(s) {
  showConfirm('Wetter-Ereignis wirklich löschen?').then((ok) => {
    if (!ok) return;
    apiDelete(`/api/weather/sightings/${encodeURIComponent(s.id)}`)
      .then(() => {
        closeWeatherMode();
        loadWeatherSightings(state.weather.filter);
      })
      .catch((err) => showToast('Löschen fehlgeschlagen: ' + (err?.message || err), 'error'));
  });
}

// Open a weather sighting in the unified MediaView shell (blue tabs,
// Wetter panel, Fein-Analyse fold, prev/next across the filtered list,
// download + delete). Replaces the legacy ws-lb modal entirely. idx is
// the absolute index into state.weather.itemsFiltered so prev/next
// walk the whole filtered set, not just the current page.
function openWeatherLightbox(idx) {
  const items = state.weather.itemsFiltered || state.weather.items || [];
  if (idx < 0 || idx >= items.length) return;
  _wsLbIdx = idx;
  const s = items[idx];
  openMediaView({
    mode: 'weather',
    item: _sightingItem(s),
    source: {
      type: 'video',
      url: `/api/weather/sightings/${encodeURIComponent(s.id)}/clip`,
      loop: true,
    },
    actions: {
      onPrev: idx > 0 ? () => openWeatherLightbox(idx - 1) : null,
      onNext: idx < items.length - 1 ? () => openWeatherLightbox(idx + 1) : null,
      onDownload: () =>
        window.open(`/api/weather/sightings/${encodeURIComponent(s.id)}/clip`, '_blank'),
      onDelete: () => _confirmDeleteSighting(s),
    },
  });
}

// ── Settings: Wetter-Ereignisse ──────────────────────────────────────────────

async function loadWeatherRecaps() {
  try {
    const d = await apiGet('/api/weather/recaps');
    state.weather.recaps = d.items || [];
    _renderWeatherRecaps();
  } catch (_err) {
    /* silent */
  }
}

function _renderWeatherRecaps() {
  const row = byId('weatherRecapsRow');
  const strip = byId('weatherRecapsStrip');
  if (!row || !strip) return;
  const items = state.weather.recaps || [];
  if (!items.length) {
    row.hidden = true;
    strip.innerHTML = '';
    return;
  }
  row.hidden = false;
  strip.innerHTML = items
    .map((m, idx) => {
      const dur = parseInt(m.duration_s || 0, 10);
      const mm = Math.floor(dur / 60),
        ss = dur % 60;
      const durLbl = `${mm}:${ss.toString().padStart(2, '0')} min`;
      return `
      <div class="ws-recap-card" data-idx="${idx}" data-id="${esc(m.id)}">
        <div class="ws-recap-card-period">${esc(m.period_label || m.id)}</div>
        <div class="ws-recap-card-meta">${m.n_clips || 0} Clips · ${esc(durLbl)}</div>
        <span class="ws-recap-card-play">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </div>`;
    })
    .join('');
  strip.querySelectorAll('.ws-recap-card').forEach((card) => {
    card.addEventListener('click', () => openWeatherRecapLightbox(parseInt(card.dataset.idx, 10)));
  });
}

// Open a weather recap (a multi-clip compilation) in the MediaView
// shell. Recaps carry no per-event snapshot — no Wetter tab, no
// Fein-Analyse fold, just the clip + title. No prev/next: recaps don't
// form an ordered series. Tolerant signature — the Telegram router
// calls openWeatherRecap(item, idx); a bare idx also works.
function openWeatherRecapLightbox(itemOrIdx, idx) {
  const items = state.weather.recaps || [];
  let m;
  if (itemOrIdx && typeof itemOrIdx === 'object') {
    m = itemOrIdx;
  } else {
    const i = typeof itemOrIdx === 'number' ? itemOrIdx : idx;
    if (i == null || i < 0 || i >= items.length) return;
    m = items[i];
  }
  if (!m) return;
  openMediaView({
    mode: 'weather',
    item: {
      camera_name: m.period_label || m.id || 'Recap',
      time_label: [m.built_at || '', m.n_clips != null ? `${m.n_clips} Sichtungen` : '']
        .filter(Boolean)
        .join(' · '),
    },
    source: {
      type: 'video',
      url: `/api/weather/recaps/${encodeURIComponent(m.id)}/clip`,
      loop: true,
    },
    showWeatherTab: false,
    showFineFold: false,
    actions: {},
  });
}

// ── Hash anchor handler — open lightbox for #weather/<id> on page load ──────

function _handleWeatherHashAnchor() {
  const h = window.location.hash || '';
  // Scroll to the new top-level #weather section (was a sub-block of
  // #achievements before the Sichtungen↔Wetter split). Falls back to the
  // inner block id for back-compat with any cached deep links.
  const target = byId('weather') || byId('weatherSightingsBlock');
  if (h === '#weather') {
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof window._setActiveNav === 'function') window._setActiveNav('weather');
    return;
  }
  if (!h.startsWith('#weather/')) return;
  const id = decodeURIComponent(h.slice('#weather/'.length));
  const items = state.weather.items || [];
  const idx = items.findIndex((s) => s.id === id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (typeof window._setActiveNav === 'function') window._setActiveNav('weather');
  if (idx >= 0 && typeof openWeatherLightbox === 'function') {
    setTimeout(() => openWeatherLightbox(idx), 350);
  }
}

// Phase-3 monkey-patches at the bottom of legacy.js folded into the
// renderWeatherSightings / loadWeatherSightings function bodies above.
window.addEventListener('hashchange', _handleWeatherHashAnchor);
// Fire once after the initial loadAll() completes.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(_handleWeatherHashAnchor, 1200);
});

// Public surface — bridges in legacy.js consume these by name.

export {
  loadWeatherSightings,
  renderWeatherSightings,
  openWeatherLightbox,
  loadWeatherRecaps,
  openWeatherRecapLightbox,
};

// ── window.* bridges ────────────────────────────────────────────────────────
// loadAll() + router.js (Telegram deep-link routing) reach for these
// by global name. The hash-anchor handler at module-import time
// already binds; these bridges are about cross-module callers.
window.loadWeatherSightings = loadWeatherSightings;
window.loadWeatherRecaps = loadWeatherRecaps;
window.openWeatherLightbox = openWeatherLightbox;
window.openWeatherRecap = openWeatherRecapLightbox;

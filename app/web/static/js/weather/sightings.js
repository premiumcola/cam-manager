// ─── weather/sightings.js ──────────────────────────────────────────────────
// Stage 24 of the legacy.js → ES modules refactor — Wetter-Sichtungen
// grid + lightbox + recaps + hash-anchor handler. Pure code move from
// legacy.js; the two _orig* monkey-patches that lived at the bottom
// of legacy.js have been folded directly into the function bodies
// (loadWeatherSightings -> loadWeatherRecaps; renderWeatherSightings
// -> _renderWeatherRecaps) so callers see one definition, no double-
// override risk.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { showToast, showConfirm } from "../core/toast.js";
import { WEATHER_TYPES } from "../core/weather-types.js";
import { precipitationLabel } from "../core/weather-precip.js";

// Pick the right human-readable label for a sighting badge. For
// `heavy_rain` we band the actual current precipitation reading
// (api_snapshot.precipitation) — the static "Starkregen" from
// WEATHER_TYPES is the *event-type* name and would mislabel a card
// captured at e.g. 0.1 mm/h. For all other event types we fall back
// to the static WEATHER_TYPES label.
function _weatherSightingLabel(s, meta){
  if (s && s.event_type === 'heavy_rain') {
    const snap = s.api_snapshot || {};
    if (snap.precipitation !== null && snap.precipitation !== undefined) {
      return precipitationLabel(snap.precipitation);
    }
  }
  return meta.de;
}
import { WEATHER_FIELD_LABEL_DE, WEATHER_FIELD_UNIT_DE } from "./stats.js";

async function loadWeatherSightings(filter){
  // Filter migrates from single-string to Set semantics: state.weather.filter
  // is a Set of event_type strings. Empty Set = "no filter, show everything"
  // (matches the Mediathek pill UX). Server fetch always pulls the full list
  // — filtering happens client-side in _renderWeatherGrid so toggling pills
  // doesn't trigger a network round-trip. The legacy single-string call site
  // is still tolerated: a string argument seeds a single-member Set.
  try{
    const r = await fetch('/api/weather/sightings');
    const data = await r.json();
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
      const present = Object.keys(WEATHER_TYPES).filter(t => (state.weather.counts[t]||0) > 0);
      state.weather.filter = new Set(present);
    }
    renderWeatherSightings();
  }catch(e){
    // silently degrade — section stays empty
  }
  // Phase 3 — Recaps live next to sightings; loading them here keeps the
  // two views synced without a separate boot hook. (Folded in from the
  // _origLoadWeatherSightings monkey-patch that lived at the bottom of
  // legacy.js pre-stage-24.)
  await loadWeatherRecaps();
}

function renderWeatherSightings(){
  const block = byId('weatherSightingsBlock'); if (!block) return;
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

function _renderWeatherFilterPills(){
  const bar = byId('weatherFilterBar'); if (!bar) return;
  // Sort by count desc, with ties by spec order. Counts==0 → empty/disabled
  // (mirrors the Mediathek pill recipe so the visual language is identical).
  const types = Object.keys(WEATHER_TYPES);
  const counts = state.weather.counts || {};
  const sorted = types.slice().sort((a,b) => {
    const d = (counts[b]||0) - (counts[a]||0);
    return d || (types.indexOf(a) - types.indexOf(b));
  });
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  let html = sorted.map(t => {
    const meta = WEATHER_TYPES[t];
    const cnt = counts[t] || 0;
    const empty = cnt === 0;
    const active = sel.has(t);
    const cls = `media-pill cat-filter-btn${active ? ' active' : ''}${empty ? ' media-pill--empty' : ''}`;
    const cntChip = cnt > 0 ? `<span class="mp-count" style="pointer-events:none">${cnt}</span>` : '';
    return `<button type="button" class="${cls}" data-type="weather" data-val="${esc(t)}" style="--cb:${meta.color}"${empty ? ' tabindex="-1" aria-disabled="true"' : ''}><span class="cfb-icon" style="pointer-events:none;color:${meta.color}">${meta.icon}</span><span style="pointer-events:none">${esc(meta.de)}</span>${cntChip}</button>`;
  }).join('');
  if (sel.size === 0) {
    html += `<span class="media-pill media-pill--status" aria-disabled="true">alle Filter aus</span>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.media-pill').forEach(p => {
    if (p.classList.contains('media-pill--empty')) return;
    if (p.classList.contains('media-pill--status')) return;
    p.addEventListener('click', () => {
      const val = p.dataset.val;
      if (!(state.weather.filter instanceof Set)) state.weather.filter = new Set();
      if (state.weather.filter.has(val)) state.weather.filter.delete(val);
      else state.weather.filter.add(val);
      // No fetch needed — filtering is client-side now.
      renderWeatherSightings();
    });
  });
}

function _renderWeatherGrid(){
  const grid = byId('weatherSightingsGrid'); if (!grid) return;
  const empty = byId('weatherSightingsEmpty');
  const allItems = state.weather.items || [];
  // Client-side filter: include items whose event_type is in the active
  // filter Set. Empty Set = "no filter active → show all" (matches the
  // Mediathek mental model).
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  const items = sel.size === 0 ? allItems
                                : allItems.filter(s => sel.has(s.event_type));
  if (!items.length) {
    grid.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  // Pre-compute the active-camera id set so each sighting card can
  // decide whether to actually request its thumb. Sightings recorded
  // before a manuf/model edit carry the OLD canonical cam_id in their
  // sighting.id (the on-disk path was already renamed by storage_
  // migration), so the thumb URL 404s. Skipping the <img> tag for
  // those entries avoids the network request and keeps the console
  // clean — the card still renders with a placeholder so the user can
  // see the orphan exists and decide whether to delete it.
  const _activeCamIds = new Set((state.cameras || []).map(c => c.id));
  grid.innerHTML = items.map((s, idx) => {
    const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8', icon: '' };
    // For sun-timelapse sightings the user wants the actual sunrise /
    // sunset time on the card, not the window-end timestamp. sun_event_at
    // is the manifest field added in this commit; fall back to started_at
    // for older records that don't carry it.
    const tsRaw = s.sun_event_at || s.started_at;
    const t = new Date(tsRaw);
    const dateLabel = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeLabel = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const sevPct = Math.round((s.score || s.severity || 0) * 100);
    // The percentage badge means different things per event type and
    // users were asking what it stood for. sun_timelapse_* uses a
    // sky-quality metric (100% = clear sky, ~50% = overcast); all
    // other event types use a generic severity score. The same text
    // is mirrored into the click-to-toast handler below for touch
    // devices since title= doesn't surface on tap.
    const isSunTl = typeof s.event_type === 'string' && s.event_type.startsWith('sun_timelapse');
    const scoreTip = isSunTl
      ? 'Himmelsqualität · 100% = klarer Himmel, 50% = stark bewölkt'
      : 'Stärke des Wetterereignisses';
    const camName = esc(s.cam_name || s.cam_id || '');
    const camActive = _activeCamIds.has(s.cam_id);
    const displayLabel = _weatherSightingLabel(s, meta);
    const thumbHtml = camActive
      ? `<img class="ws-card-thumb" loading="lazy" src="/api/weather/sightings/${encodeURIComponent(s.id)}/thumb" alt="${esc(displayLabel)}" onerror="this.style.opacity=0.2"/>`
      : `<div class="ws-card-thumb ws-card-thumb--orphan" aria-hidden="true"></div>`;
    return `
      <div class="ws-card${camActive ? '' : ' ws-card--orphan'}" data-idx="${idx}" data-id="${esc(s.id)}">
        <div class="ws-card-thumb-wrap">
          ${thumbHtml}
          <span class="ws-card-badge ws-card-badge--type" style="background:${meta.color}cc">
            <span class="ws-card-badge-icon">${meta.icon}</span>${esc(displayLabel)}
          </span>
          ${sevPct > 0 ? `<span class="ws-card-badge ws-card-badge--score" role="button" tabindex="0" title="${esc(scoreTip)}" aria-label="${sevPct} Prozent, ${esc(scoreTip)}" data-score-tip="${esc(scoreTip)}">${sevPct}%<span class="ws-score-info" aria-hidden="true">ⓘ</span></span>` : ''}
          <span class="ws-card-play">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </span>
          <span class="ws-card-bottom-l">${dateLabel} · ${timeLabel}</span>
          <span class="ws-card-bottom-r">${camName}</span>
        </div>
      </div>`;
  }).join('');
  grid.querySelectorAll('.ws-card').forEach(card => {
    card.addEventListener('click', () => openWeatherLightbox(parseInt(card.dataset.idx, 10)));
  });
  // Score badges fire a toast with the metric explanation on tap —
  // title= alone is desktop-only. stopPropagation keeps the badge tap
  // from also opening the card lightbox.
  grid.querySelectorAll('.ws-card-badge--score').forEach(b => {
    const tip = b.getAttribute('data-score-tip');
    if (!tip) return;
    const fire = (e) => { e.stopPropagation(); showToast(tip, 'info'); };
    b.addEventListener('click', fire);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(e); }
    });
  });
}

let _wsLbIdx = -1;

function openWeatherLightbox(idx){
  const items = state.weather.items || [];
  if (idx < 0 || idx >= items.length) return;
  _wsLbIdx = idx;
  const s = items[idx];
  // Build the modal lazily so the DOM stays clean when no sighting open.
  let modal = byId('wsLightbox');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'wsLightbox';
    modal.className = 'ws-lb';
    modal.innerHTML = `
      <div class="ws-lb-backdrop" data-action="close"></div>
      <div class="ws-lb-shell">
        <button class="ws-lb-close" data-action="close" aria-label="Schließen">✕</button>
        <button class="ws-lb-prev" data-action="prev" aria-label="Vorherige">‹</button>
        <button class="ws-lb-next" data-action="next" aria-label="Nächste">›</button>
        <div class="ws-lb-video-wrap"><video id="wsLbVideo" controls playsinline autoplay muted loop preload="metadata"></video></div>
        <div class="ws-lb-meta" id="wsLbMeta"></div>
        <div class="ws-lb-actions">
          <button class="btn-action" data-action="download">⬇ Herunterladen</button>
          <button class="btn-action danger-btn" data-action="delete">🗑 Löschen</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close') closeWeatherLightbox();
      if (action === 'prev') openWeatherLightbox(_wsLbIdx - 1);
      if (action === 'next') openWeatherLightbox(_wsLbIdx + 1);
      if (action === 'download') {
        const cur = state.weather.items[_wsLbIdx];
        if (cur) window.open(`/api/weather/sightings/${encodeURIComponent(cur.id)}/clip`, '_blank');
      }
      if (action === 'delete') {
        const cur = state.weather.items[_wsLbIdx];
        if (cur) {
          showConfirm('Wetter-Ereignis wirklich löschen?').then(ok => {
            if (!ok) return;
            fetch(`/api/weather/sightings/${encodeURIComponent(cur.id)}`, { method: 'DELETE' })
              .then(() => { closeWeatherLightbox(); loadWeatherSightings(state.weather.filter); });
          });
        }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('open') === false) return;
      if (e.key === 'Escape') closeWeatherLightbox();
      if (e.key === 'ArrowLeft') openWeatherLightbox(_wsLbIdx - 1);
      if (e.key === 'ArrowRight') openWeatherLightbox(_wsLbIdx + 1);
    });
  }
  // Update video src + metadata
  const video = byId('wsLbVideo');
  video.src = `/api/weather/sightings/${encodeURIComponent(s.id)}/clip`;
  video.load(); video.play().catch(() => {});
  byId('wsLbMeta').innerHTML = _renderWsLbMeta(s);
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.ws-lb-prev').style.opacity = idx > 0 ? '1' : '0.25';
  modal.querySelector('.ws-lb-next').style.opacity = idx < items.length - 1 ? '1' : '0.25';
}

function closeWeatherLightbox(){
  const modal = byId('wsLightbox'); if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  const v = byId('wsLbVideo'); if (v) { try { v.pause(); v.src = ''; } catch (e) {} }
}

function _renderWsLbMeta(s){
  const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8' };
  const t = new Date(s.started_at);
  const fullDate = t.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const snap = s.api_snapshot || {};
  const apiRows = Object.entries(snap)
    .filter(([k, v]) => v !== null && v !== undefined && k !== 'time')
    .map(([k, v]) => {
      const lbl = WEATHER_FIELD_LABEL_DE[k] || k;
      const unit = WEATHER_FIELD_UNIT_DE[k] || '';
      return `<div class="ws-lb-row"><span class="ws-lb-row-key">${esc(lbl)}</span><span class="ws-lb-row-val">${esc(String(v))}${unit ? ' ' + unit : ''}</span></div>`;
    }).join('');
  const showSun = (s.event_type === 'sunset' || s.event_type === 'fog') && s.sun_snapshot;
  const sunRows = showSun && s.sun_snapshot
    ? Object.entries(s.sun_snapshot)
        .filter(([_k, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `<div class="ws-lb-row"><span class="ws-lb-row-key">${k === 'altitude' ? 'Höhe' : 'Azimut'}</span><span class="ws-lb-row-val">${Number(v).toFixed(1)}°</span></div>`).join('')
    : '';
  const displayLabel = _weatherSightingLabel(s, meta);
  return `
    <div class="ws-lb-headline">
      <span class="ws-lb-type-badge" style="background:${meta.color}33;border:1px solid ${meta.color}66;color:${meta.color}">${meta.icon || ''} ${esc(displayLabel)}</span>
      <span class="ws-lb-date">${esc(fullDate)}</span>
    </div>
    <div class="ws-lb-cam">📷 ${esc(s.cam_name || s.cam_id || '')}</div>
    <div class="ws-lb-section-title">Wetter-Daten zur Aufnahme</div>
    <div class="ws-lb-rows">${apiRows || '<div class="ws-lb-row ws-lb-row--empty">— keine Mess­werte —</div>'}</div>
    ${sunRows ? `<div class="ws-lb-section-title">Sonne</div><div class="ws-lb-rows">${sunRows}</div>` : ''}
  `;
}

// ── Settings: Wetter-Ereignisse ──────────────────────────────────────────────


async function loadWeatherRecaps(){
  try{
    const r = await fetch('/api/weather/recaps');
    const d = await r.json();
    state.weather.recaps = d.items || [];
    _renderWeatherRecaps();
  }catch(e){ /* silent */ }
}

function _renderWeatherRecaps(){
  const row = byId('weatherRecapsRow');
  const strip = byId('weatherRecapsStrip');
  if (!row || !strip) return;
  const items = state.weather.recaps || [];
  if (!items.length) { row.hidden = true; strip.innerHTML = ''; return; }
  row.hidden = false;
  strip.innerHTML = items.map((m, idx) => {
    const dur = parseInt(m.duration_s || 0, 10);
    const mm = Math.floor(dur / 60), ss = dur % 60;
    const durLbl = `${mm}:${ss.toString().padStart(2, '0')} min`;
    return `
      <div class="ws-recap-card" data-idx="${idx}" data-id="${esc(m.id)}">
        <div class="ws-recap-card-period">${esc(m.period_label || m.id)}</div>
        <div class="ws-recap-card-meta">${m.n_clips || 0} Clips · ${esc(durLbl)}</div>
        <span class="ws-recap-card-play">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </div>`;
  }).join('');
  strip.querySelectorAll('.ws-recap-card').forEach(card => {
    card.addEventListener('click', () => openWeatherRecapLightbox(parseInt(card.dataset.idx, 10)));
  });
}

function openWeatherRecapLightbox(idx){
  // Reuse the wsLightbox shell built by Phase 2 — swap the video src and
  // metadata, no separate DOM. The Prev/Next nav stays disabled because
  // recaps don't form an ordered series across the year.
  const items = state.weather.recaps || [];
  if (idx < 0 || idx >= items.length) return;
  const m = items[idx];
  // Lazily build the modal if it doesn't exist yet (mirrors openWeatherLightbox).
  let modal = byId('wsLightbox');
  if (!modal) {
    // Trigger Phase-2 lightbox creation once via a no-op open that closes
    // immediately — it builds the shell, which we then reuse here.
    if ((state.weather.items || []).length) {
      openWeatherLightbox(0);
      closeWeatherLightbox();
      modal = byId('wsLightbox');
    }
    if (!modal) {
      // Cold start with no sightings yet — build a minimal shell inline.
      modal = document.createElement('div');
      modal.id = 'wsLightbox';
      modal.className = 'ws-lb';
      modal.innerHTML = `
        <div class="ws-lb-backdrop" data-action="close"></div>
        <div class="ws-lb-shell">
          <button class="ws-lb-close" data-action="close" aria-label="Schließen">✕</button>
          <div class="ws-lb-video-wrap"><video id="wsLbVideo" controls playsinline autoplay muted loop preload="metadata"></video></div>
          <div class="ws-lb-meta" id="wsLbMeta"></div>
          <div class="ws-lb-actions"></div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="close"]')) closeWeatherLightbox();
      });
      document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('open') && e.key === 'Escape') closeWeatherLightbox();
      });
    }
  }
  const video = byId('wsLbVideo');
  video.src = `/api/weather/recaps/${encodeURIComponent(m.id)}/clip`;
  video.load(); video.play().catch(() => {});
  byId('wsLbMeta').innerHTML = `
    <div class="ws-lb-headline">
      <span class="ws-lb-type-badge" style="background:#7faec933;border:1px solid #7faec966;color:#7faec9">🎞 ${esc(m.period_label || m.id)}</span>
      <span class="ws-lb-date">${esc(m.built_at || '')}</span>
    </div>
    <div class="ws-lb-cam">${m.n_clips || 0} Sichtungen · Zeitraum ${esc(m.period_start || '')} → ${esc(m.period_end || '')}</div>
  `;
  // Hide nav arrows (recaps don't form a navigable series here).
  const prev = modal.querySelector('.ws-lb-prev');
  const next = modal.querySelector('.ws-lb-next');
  if (prev) prev.style.display = 'none';
  if (next) next.style.display = 'none';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}


// ── Hash anchor handler — open lightbox for #weather/<id> on page load ──────

function _handleWeatherHashAnchor(){
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
  const idx = items.findIndex(s => s.id === id);
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

  closeWeatherLightbox,

  loadWeatherRecaps,

  openWeatherRecapLightbox,

};

// ── window.* bridges ────────────────────────────────────────────────────────
// loadAll() + router.js (Telegram deep-link routing) reach for these
// by global name. The hash-anchor handler at module-import time
// already binds; these bridges are about cross-module callers.
window.loadWeatherSightings = loadWeatherSightings;
window.loadWeatherRecaps    = loadWeatherRecaps;
window.openWeatherLightbox  = openWeatherLightbox;
window.openWeatherRecap     = openWeatherRecapLightbox;

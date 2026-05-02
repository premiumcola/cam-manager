// ─── sichtungen.js ─────────────────────────────────────────────────────────
// Stage 14 of the legacy.js → ES modules refactor — Achievements /
// Sichtungen panel (the medal grid, drilldown accordion, and the
// progress bar). Renders one card per Bavarian-Top-20 species (BIRD_
// SVGS / MAMMAL_SVGS in core/animal-icons.js) at bronze / silver /
// gold tier driven by per-species sighting counts pulled from
// /api/achievements.
import { byId, esc } from './core/dom.js';
import { state } from './core/state.js';
import { j } from './core/api.js';
import { BIRD_SVGS, MAMMAL_SVGS } from './core/animal-icons.js';

// ── Sichtungen drilldown (inline accordion) ──────────────────────────────
// State is module-level so the renderer can reflect the open card with
// an outline+highlight and the wrap stays consistent across re-renders.
let _achOpenId = null;
let _achDrillItems = [];
let _achDrillTotal = 0;
let _achDrillPage = 0;
const _ACH_DRILL_LIMIT = 24;
let _achDrillLoading = false;

// Lightbox navigation uses state.media — we save whatever was there so
// the main Mediathek keeps its own list intact while the user pages
// through a Sichtungen drilldown.
let _achDrillSavedMedia = null;

function _achDrillStashMedia(){
  if (_achDrillSavedMedia === null) _achDrillSavedMedia = state.media;
  state.media = _achDrillItems;
}
function _achDrillRestoreMedia(){
  if (_achDrillSavedMedia !== null){
    state.media = _achDrillSavedMedia;
    _achDrillSavedMedia = null;
  }
}

async function _achDrillFetch(speciesId, offset){
  try {
    const r = await j(`/api/achievements/${encodeURIComponent(speciesId)}/media?limit=${_ACH_DRILL_LIMIT}&offset=${offset}`);
    return r || { items: [], total_count: 0 };
  } catch {
    return { items: [], total_count: 0 };
  }
}

function _achDrillRenderItems(){
  const grid = byId('achDrillGrid');
  if (!grid) return;
  if (!_achDrillItems.length){
    grid.innerHTML = '<div class="item muted" style="padding:16px;grid-column:1/-1">Noch keine archivierten Aufnahmen für diese Art.</div>';
  } else {
    // mediaCardHTML still lives in legacy.js; resolve via window
    // until the lightbox surgery extracts the rest of mediathek.
    const cardFn = window.mediaCardHTML;
    grid.innerHTML = (typeof cardFn === 'function')
      ? _achDrillItems.map(cardFn).join('')
      : '<div class="item muted">Mediathek noch nicht geladen.</div>';
  }
  const more = byId('achDrillMore');
  if (more){
    more.style.display = _achDrillItems.length < _achDrillTotal ? '' : 'none';
  }
  const countEl = byId('achDrillCount');
  if (countEl){
    const shown = _achDrillItems.length;
    countEl.textContent = _achDrillTotal <= shown ? `${shown}` : `${shown} von ${_achDrillTotal}`;
  }
  // Cards click → openLightbox with our item list in scope.
  _achDrillStashMedia();
  grid.querySelectorAll('.media-card').forEach(card => {
    const eid = card.dataset.eventId;
    card.style.cursor = 'pointer';
    card.onclick = (ev) => {
      // Leave stop-propagation for inner buttons (confirm/delete already
      // call event.stopPropagation() in their onclick), so this only
      // fires when the card body itself is clicked.
      if (ev.target.closest('.mmc-actions, .media-confirmed-badge')) return;
      const it = _achDrillItems.find(x => x.event_id === eid);
      if (it && typeof window.openLightbox === 'function') window.openLightbox(it);
    };
  });
}

async function toggleAchDrilldown(id, name){
  // Second click on the same card → close.
  if (_achOpenId === id){
    closeAchDrilldown();
    return;
  }
  _achOpenId = id;
  _achDrillItems = [];
  _achDrillTotal = 0;
  _achDrillPage = 0;
  // Re-render grid so the previous active card loses its highlight and
  // the newly-active one gains it; the drilldown wrap below the grid
  // is recreated empty as part of that render.
  renderAchievements();
  const wrap = byId('achDrilldownWrap');
  if (!wrap) return;
  const nameEl = byId('achDrillName');
  if (nameEl) nameEl.textContent = name || id;
  const grid = byId('achDrillGrid');
  if (grid) grid.innerHTML = '<div class="field-help" style="padding:16px;grid-column:1/-1">Lade Sichtungen…</div>';
  // Expand the accordion first so the fetch result slots into a
  // visible container.
  wrap.classList.add('ach-drilldown-wrap--open');
  // Scroll the drilldown into view once the height transition starts.
  setTimeout(() => { byId('achDrilldownWrap')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 60);
  _achDrillLoading = true;
  const r = await _achDrillFetch(id, 0);
  _achDrillLoading = false;
  // Check the user didn't close / switch the drilldown while waiting.
  if (_achOpenId !== id) return;
  _achDrillItems = r.items || [];
  _achDrillTotal = r.total_count || 0;
  _achDrillRenderItems();
}
window.toggleAchDrilldown = toggleAchDrilldown;

async function loadMoreAchDrill(){
  if (!_achOpenId || _achDrillLoading) return;
  _achDrillLoading = true;
  _achDrillPage += 1;
  const r = await _achDrillFetch(_achOpenId, _achDrillPage * _ACH_DRILL_LIMIT);
  _achDrillLoading = false;
  if (r && r.items && r.items.length){
    _achDrillItems = _achDrillItems.concat(r.items);
    _achDrillTotal = r.total_count || _achDrillItems.length;
    _achDrillRenderItems();
  }
}
window.loadMoreAchDrill = loadMoreAchDrill;

function closeAchDrilldown(){
  const wrap = byId('achDrilldownWrap');
  if (wrap) wrap.classList.remove('ach-drilldown-wrap--open');
  _achOpenId = null;
  _achDrillItems = [];
  _achDrillTotal = 0;
  _achDrillPage = 0;
  _achDrillRestoreMedia();
  renderAchievements();
}
window.closeAchDrilldown = closeAchDrilldown;

// Legacy name kept so any lingering inline callers don't break.
window.openAchievementDrilldown = function(id, name){ toggleAchDrilldown(id, name); };

// ── Achievements / Sichtungen ────────────────────────────────────────────
// Top 20 Bavarian garden birds (LBV Stunde der Gartenvögel 2025 Bayern),
// sorted by frequency (most common first). freq values drive rarity pills.
const ACH_DEFS = [
  { id: 'haussperling',     name: 'Haussperling',     icon: '🐦', cat: 'birds', freq: 'sehr haeufig',  rank: 1 },
  { id: 'amsel',            name: 'Amsel',            icon: '🐦', cat: 'birds', freq: 'sehr haeufig',  rank: 2 },
  { id: 'kohlmeise',        name: 'Kohlmeise',        icon: '🐦', cat: 'birds', freq: 'sehr haeufig',  rank: 3 },
  { id: 'star',             name: 'Star',             icon: '🐦', cat: 'birds', freq: 'haeufig',       rank: 4 },
  { id: 'feldsperling',     name: 'Feldsperling',     icon: '🐦', cat: 'birds', freq: 'haeufig',       rank: 5 },
  { id: 'blaumeise',        name: 'Blaumeise',        icon: '🐦', cat: 'birds', freq: 'haeufig',       rank: 6 },
  { id: 'ringeltaube',      name: 'Ringeltaube',      icon: '🐦', cat: 'birds', freq: 'haeufig',       rank: 7 },
  { id: 'mauersegler',      name: 'Mauersegler',      icon: '🐦', cat: 'birds', freq: 'haeufig',       rank: 8 },
  { id: 'elster',           name: 'Elster',           icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 9 },
  { id: 'mehlschwalbe',     name: 'Mehlschwalbe',     icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 10 },
  { id: 'buchfink',         name: 'Buchfink',         icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 11 },
  { id: 'rotkehlchen',      name: 'Rotkehlchen',      icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 12 },
  { id: 'gruenfink',        name: 'Grünfink',         icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 13 },
  { id: 'rabenkraehe',      name: 'Rabenkrähe',       icon: '🐦', cat: 'birds', freq: 'regelmaessig',  rank: 14 },
  { id: 'hausrotschwanz',   name: 'Hausrotschwanz',   icon: '🐦', cat: 'birds', freq: 'gelegentlich',  rank: 15 },
  { id: 'moenchsgrasmucke', name: 'Mönchsgrasmücke',  icon: '🐦', cat: 'birds', freq: 'gelegentlich',  rank: 16 },
  { id: 'stieglitz',        name: 'Stieglitz',        icon: '🐦', cat: 'birds', freq: 'gelegentlich',  rank: 17 },
  { id: 'buntspecht',       name: 'Buntspecht',       icon: '🐦', cat: 'birds', freq: 'gelegentlich',  rank: 18 },
  { id: 'kleiber',          name: 'Kleiber',          icon: '🐦', cat: 'birds', freq: 'selten',        rank: 19 },
  { id: 'eichelhaher',      name: 'Eichelhäher',      icon: '🐦', cat: 'birds', freq: 'selten',        rank: 20 },
  // Säugetiere — Eichhörnchen sind das Aushängeschild des Projekts, daher
  // pinnen wir sie über die Vögel hinweg an den Anfang.
  { id: 'eichhoernchen_orange',  name: 'Eichhörnchen (rot)',     icon: '🐿️', cat: 'mammals', freq: 'haeufig',      rank: 1, pin: -3 },
  { id: 'eichhoernchen_schwarz', name: 'Eichhörnchen (schwarz)', icon: '🐿️', cat: 'mammals', freq: 'selten',       rank: 2, pin: -2 },
  { id: 'eichhoernchen_hell',    name: 'Eichhörnchen (hell)',    icon: '🐿️', cat: 'mammals', freq: 'selten',       rank: 3, pin: -1 },
  { id: 'igel',     name: 'Igel',     icon: '🦔', cat: 'mammals', freq: 'gelegentlich', rank: 4 },
  { id: 'feldhase', name: 'Feldhase', icon: '🐇', cat: 'mammals', freq: 'selten',       rank: 5 },
  { id: 'reh',      name: 'Reh',      icon: '🦌', cat: 'mammals', freq: 'selten',       rank: 6 },
  { id: 'fuchs',    name: 'Fuchs',    icon: '🦊', cat: 'mammals', freq: 'selten',       rank: 7 },
];

let _achData = {};

export async function loadAchievements(){
  try {
    const r = await j('/api/achievements');
    _achData = r.achievements || {};
  } catch {
    _achData = {};
  }
  renderAchievements();
}
window.loadAchievements = loadAchievements;

function _achTier(count){
  if (!count || count < 1) return 'locked';
  if (count >= 20) return 'gold';
  if (count >= 5)  return 'silver';
  return 'bronze';
}

function _medalSVG(achId, tier, birdSvg, isUnlocked, size = 88){
  const uid = achId.replace(/[^a-z0-9]/g, '');
  // Locked medals are deliberately drab: two flat neutral greys, no
  // highlight arc. The silhouette is rendered faintly so the shape is
  // still recognisable without announcing itself.
  if (!isUnlocked){
    let silhouette = '';
    if (birdSvg){
      silhouette = birdSvg.replace('<svg ',
        '<svg x="10" y="10" width="80" height="80" style="filter:grayscale(1) brightness(0.18) opacity(0.45)" ');
    }
    return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="47" fill="rgba(255,255,255,0.06)"/>
      <circle cx="50" cy="50" r="36" fill="rgba(255,255,255,0.03)"/>
      <circle cx="50" cy="50" r="36" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
      ${silhouette}
    </svg>`;
  }
  const rimC  = { bronze: ['#4a2408', '#c87840'], silver: ['#303840', '#a0b4c4'], gold: ['#402e08', '#e0c050'] };
  const faceC = { bronze: ['#3a2010', '#1e0e04'], silver: ['#202e38', '#101820'], gold: ['#2a2010', '#140e04'] };
  const hlC   = { bronze: '#e09860',              silver: '#c0d0e0',              gold: '#f0e060' };
  const [rc, re] = rimC[tier];
  const [fc, fe] = faceC[tier];
  const hl = hlC[tier];
  const bird = birdSvg ? birdSvg.replace('<svg ', `<svg x="10" y="10" width="80" height="80" `) : '';
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="rg${uid}" cx="50%" cy="40%" r="55%">
        <stop offset="0%" stop-color="${rc}"/>
        <stop offset="100%" stop-color="${re}"/>
      </radialGradient>
      <radialGradient id="fg${uid}" cx="42%" cy="38%" r="65%">
        <stop offset="0%" stop-color="${fc}"/>
        <stop offset="100%" stop-color="${fe}"/>
      </radialGradient>
    </defs>
    <circle cx="50" cy="50" r="47" fill="url(#rg${uid})"/>
    <circle cx="50" cy="50" r="36" fill="url(#fg${uid})"/>
    <circle cx="50" cy="50" r="36" fill="none" stroke="${re}" stroke-width="1.5" opacity=".5"/>
    <path d="M 25 30 A 28 28 0 0 1 70 22" fill="none" stroke="${hl}" stroke-width="5" stroke-linecap="round" opacity=".35"/>
    ${bird}
  </svg>`;
}

// Rarity → German label + subtle text colour when unlocked. Locked
// medals always render rarity in a neutral gray regardless of rank so
// the eye focuses on what's already been discovered, not what's missing.
const _FREQ_META = {
  'sehr haeufig':  { label: 'Sehr häufig',  color: 'rgba(150,200,150,0.7)' },
  'haeufig':       { label: 'Häufig',       color: 'rgba(150,200,150,0.6)' },
  'regelmaessig':  { label: 'Regelmäßig',   color: 'rgba(200,200,150,0.7)' },
  'gelegentlich':  { label: 'Gelegentlich', color: 'rgba(210,170,100,0.7)' },
  'selten':        { label: 'Selten',       color: 'rgba(210,120,100,0.7)' },
};

function _rarityText(freq, isUnlocked){
  const m = _FREQ_META[freq];
  if (!m) return '';
  const color = isUnlocked ? m.color : 'rgba(255,255,255,0.25)';
  return `<span class="medal-rarity" style="color:${color}">${m.label}</span>`;
}

export function renderAchievements(){
  const unlocked = ACH_DEFS.filter(a => _achData[a.id]);
  const total = ACH_DEFS.length;
  const pct = Math.round(unlocked.length / total * 100);
  const progressEl = byId('achievementsProgress');
  if (progressEl){
    progressEl.innerHTML = `
      <span class="ach-progress-text">${unlocked.length} von ${total} gesichtet</span>
      <div class="ach-progress-track"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
      <span class="ach-progress-pct">${pct}%</span>`;
  }

  const legend = `<div class="ach-legend">
    <span><span class="ach-leg-dot" style="background:#c87840;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Bronze 1–4×</span></span>
    <span><span class="ach-leg-dot" style="background:#a0b4c4;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Silber 5–19×</span></span>
    <span><span class="ach-leg-dot" style="background:#e0c050;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Gold 20×+</span></span>
  </div>`;

  const _renderCard = (a) => {
    const info = _achData[a.id];
    const isUnlocked = !!info;
    const count = isUnlocked ? (info.count || 1) : 0;
    const tier = _achTier(count);
    const isSquirrelXL = a.cat === 'mammals' && a.id.startsWith('eichhoernchen_');
    const medalSize = isSquirrelXL ? 132 : 88;
    const iconSvg = a.cat === 'birds' ? (BIRD_SVGS[a.id] || null) : (MAMMAL_SVGS[a.id] || null);
    const medalHtml = _medalSVG(a.id, tier, iconSvg, isUnlocked, medalSize);
    const emojiOverlay = !iconSvg
      ? `<span class="medal-emoji${isUnlocked ? '' : ' medal-emoji-locked'}">${isUnlocked ? a.icon : '🔒'}</span>`
      : '';
    // When unlocked: count-badge on medal. When locked: lock badge ABOVE medal (overlapping top).
    const badge = isUnlocked
      ? `<span class="medal-count-badge ${tier}">${count}×</span>`
      : `<div class="medal-lock-overlay"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>`;
    // Bottom row: count + plain muted-colour rarity text. Squirrel XL
    // tiles replace the rarity slot with a dedicated variant subline
    // (rendered inside the name block) and omit rarity entirely.
    const countColors = { bronze: '#d4894a', silver: '#90a8be', gold: '#d4a820' };
    const countSpan = isUnlocked
      ? `<span class="medal-count" style="color:${countColors[tier] || '#d4a820'}">${count}× gesehen</span>`
      : '';
    const footline = isSquirrelXL
      ? `<div class="medal-footline">${countSpan}</div>`
      : `<div class="medal-footline">${countSpan}${_rarityText(a.freq, isUnlocked)}</div>`;
    // Split "Eichhörnchen (rot)" → base name + variant suffix. On squirrel
    // XL tiles the suffix sits on its own line (.medal-variant). Other
    // tiles keep the inline-italic muted suffix.
    const nameParts = a.name.match(/^(.+?)\s*(\(.+\))?$/);
    const baseName = nameParts?.[1] || a.name;
    const variantSuffix = nameParts?.[2] || '';
    const nameHtml = isSquirrelXL
      ? `<div class="medal-name-base">${esc(baseName)}</div>${variantSuffix ? `<div class="medal-variant">${esc(variantSuffix)}</div>` : ''}`
      : `${esc(baseName)}${variantSuffix ? `<span style="font-size:10px;font-weight:400;color:rgba(255,255,255,0.3);font-style:italic;margin-left:3px">${esc(variantSuffix)}</span>` : ''}`;
    const clickable = isUnlocked ? `onclick="toggleAchDrilldown('${esc(a.id)}','${esc(a.name)}')" style="cursor:pointer"` : '';
    const activeCls = (isUnlocked && _achOpenId === a.id) ? ' ach-card--active' : '';
    const xlCls = isSquirrelXL ? ' ach-card--xl' : '';
    return `<div class="ach-card ${tier}${activeCls}${xlCls}" ${clickable}>
      <div class="medal-wrap">
        ${medalHtml}
        ${emojiOverlay}
        ${badge}
      </div>
      <div class="medal-name">${nameHtml}</div>
      ${footline}
    </div>`;
  };

  // Pinned items (negative pin rank) come first regardless of category
  // so the Eichhörnchen variants sit at the very front. Then birds (by
  // rank), then the remaining mammals (by rank).
  const sorted = [...ACH_DEFS].sort((a, b) => {
    const pa = a.pin ?? 0, pb = b.pin ?? 0;
    if (pa !== pb) return pa - pb;
    const catOrder = (a.cat === 'birds' ? 0 : 1) - (b.cat === 'birds' ? 0 : 1);
    if (catOrder) return catOrder;
    return (a.rank || 99) - (b.rank || 99);
  });
  const cards = sorted.map(_renderCard).join('');
  // Drilldown accordion — sits BETWEEN the grid and the legend so the
  // opening card's context stays close.
  const drilldown = `
    <div class="ach-drilldown-wrap${_achOpenId ? ' ach-drilldown-wrap--open' : ''}" id="achDrilldownWrap">
      <div class="ach-drilldown">
        <div class="ach-drill-header">
          <div class="ach-drill-title">🌿 <span id="achDrillName"></span></div>
          <span class="ach-drill-count" id="achDrillCount"></span>
          <button type="button" class="ach-drill-close" onclick="closeAchDrilldown()" aria-label="Schließen">✕</button>
        </div>
        <div class="ach-drill-grid" id="achDrillGrid"></div>
        <div class="ach-drill-more" id="achDrillMore" style="display:none">
          <button type="button" class="btn-action" onclick="loadMoreAchDrill()">Mehr laden</button>
        </div>
      </div>
    </div>`;
  const grid = byId('achievementsGrid');
  if (grid){
    grid.innerHTML = `<div class="ach-cards-grid">${cards}</div>${drilldown}` + legend;
  }
  // If we re-rendered while a drilldown was open, re-populate the grid
  // from the in-memory cache so the user sees items immediately instead
  // of a "Lade…" placeholder on every click elsewhere.
  if (_achOpenId && _achDrillItems.length){
    _achDrillRenderItems();
  }
}

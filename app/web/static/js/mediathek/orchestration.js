// ─── mediathek/orchestration.js ────────────────────────────────────────────
// Stage 23 of the legacy.js → ES modules refactor — drilldown / filter /
// grid orchestration for the Mediathek section. Pure code move from
// legacy.js, no behaviour changes:
//   * page-size sizer (calcItemsPerPage + the rows × cols math)
//   * three drilldown openers + close
//   * overview cards (camera tiles + "Alle Medien" + archived strip)
//   * media card HTML + grid + pagination + processing-poll
//   * section title (cam name | "Alle Medien" | bare)
//
// R09.1 split: media-loader.js owns loadMedia; filters.js owns the
// pill-bar bookkeeping + click handlers. R09.2/R15: openLightbox +
// closeLightbox + the keyboard / swipe / confirm / delete handlers all
// live in ../lightbox.js — this file just imports the entry point so
// the card-onclick thunk no longer goes through window.openLightbox.
//
// The deleteMediaCard / confirmMediaCard / deleteTLCard tile-action
// handlers (the ones rendered by mediaCardHTML's inline onclicks) stay
// here because they re-render the grid + pagination, which are owned
// by this module.
//
// All window.* bridges are still set at the bottom so other still-
// resident code paths (and inline onclicks in HTML) keep resolving.
import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { j } from '../core/api.js';
import { showToast } from '../core/toast.js';
import { colors, OBJ_LABEL, objIconSvg, objBubble, getCameraIcon } from '../core/icons.js';
import { CAT_COLORS } from '../timeline.js';
import { loadMediaStorageStats, refreshTimelineAndStats } from '../chrome/storage-stats.js';
import { _exitMediaSelectMode, _updateMediaSelectToggle } from './bulk-delete.js';
import { loadMedia } from './media-loader.js';
import {
  renderMediaFilterPills,
  _seedTopMediaLabel,
  _pruneEmptyMediaFilters,
} from './filters.js';
import { openLightbox } from '../lightbox.js';

// ── Page-size sizer ─────────────────────────────────────────────────────────
// _lastKnownCols + window._cachedPageSize are bridged on window so the
// grid.js resize observer (extracted in stage 13) can read AND write the
// same counter — without the bridge it would set its own copy and the
// re-render below would never see the update.
window._lastKnownCols ??= 0;
window._cachedPageSize ??= 0;
export const _MEDIA_ROWS = 4;
export function calcItemsPerPage(){
  const grid = byId('mediaGrid');
  let containerW = 0;
  if (grid){
    const gr = grid.getBoundingClientRect();
    if (gr.width > 0) containerW = gr.width;
  }
  if (!containerW){
    const isMobile = window.innerWidth <= 768;
    const mediaEl = byId('media');
    containerW = Math.max(193, mediaEl && mediaEl.clientWidth > 192 ? mediaEl.clientWidth - 24 : window.innerWidth - (isMobile ? 24 : 320));
  }
  const GAP = 10, MIN_CARD = 192;
  const cols = window._lastKnownCols || Math.max(1, Math.floor((containerW + GAP) / (MIN_CARD + GAP)));
  return _MEDIA_ROWS * cols;
}

// ── Per-camera tints + helpers ──────────────────────────────────────────────
export const CAM_COLORS = ['#3b82f6','#f59e0b','#10b981','#8b5cf6','#ef4444','#06b6d4','#ec4899','#84cc16'];
export function camColor(camId){
  const idx = state.cameras.findIndex(c => c.id === camId);
  return CAM_COLORS[(idx < 0 ? 0 : idx) % CAM_COLORS.length];
}
export function hexToRgba(hex, alpha){
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return `rgba(147,197,253,${alpha})`;
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
export function getMediaAccentColor(labels){
  if (Array.isArray(labels)){
    for (const l of labels){
      if (colors[l]) return colors[l];
    }
  }
  return colors.motion || '#93c5fd';
}
export function fmtMediaDate(ts){
  if (!ts) return '';
  try {
    const d = new Date(ts.replace(' ', 'T'));
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return ''; }
}
export function fmtMediaTimeOnly(ts){
  if (!ts) return '';
  try {
    const d = new Date(ts.replace(' ', 'T'));
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ── Card HTML ───────────────────────────────────────────────────────────────
export function mediaCardHTML(item){
  // Primary (bold white) badge — shared across all card types
  const badgeStyle = 'font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;line-height:1.45;white-space:nowrap';
  // Secondary (dimmer, accent-colored) badge — color added per-branch via accent
  const subBadgeBase = 'font-size:10px;background:none;backdrop-filter:blur(3px);padding:0 6px;border-radius:4px;line-height:1.45;white-space:nowrap;margin-top:1px;opacity:0.85';
  const isTL = item.type === 'timelapse';
  if (isTL){
    const wk = item.window_key || item.day || '';
    const datePart = wk.substring(0, 10);
    const timePart = wk.length >= 15 ? wk.substring(11, 13) + ':' + wk.substring(13, 15) : '';
    const durLabel = item.target_s != null ? (item.target_s < 60 ? item.target_s + 's' : Math.floor(item.target_s / 60) + 'min') : '';
    const sizeText = item.size_mb != null ? item.size_mb + ' MB' : '';
    const thumbSrc = item.thumb_url || '';
    const thumbEl = thumbSrc
      ? `<img src="${esc(thumbSrc)}" alt="preview" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;opacity:.7" loading="lazy" onerror="this.remove()">`
      : '';
    const tlAccent = getMediaAccentColor(['timelapse']);
    const tlPlayBg = hexToRgba(tlAccent, 0.18);
    const tlPlayBorder = hexToRgba(tlAccent, 0.5);
    const tlSubBadge = `${subBadgeBase};color:${tlAccent}`;
    return `<article class="media-card mmc-tl" data-event-id="${esc(item.event_id || '')}" data-camera-id="${esc(item.camera_id || '')}">
      <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id || '')}')">
        ${thumbEl}
        <div style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center">
          <div class="mmc-play-btn" style="background:${tlPlayBg};border:1.5px solid ${tlPlayBorder}"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:${tlAccent};margin-left:2px"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
          ${datePart ? `<div style="${badgeStyle}">${esc(datePart)}</div>` : ''}
          ${timePart ? `<div style="${tlSubBadge}">${esc(timePart)}</div>` : ''}
        </div>
        ${(durLabel || sizeText) ? `<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          ${durLabel ? `<div style="${badgeStyle}">${esc(durLabel)}</div>` : ''}
          ${sizeText ? `<div style="${tlSubBadge}">${esc(sizeText)}</div>` : ''}
        </div>` : ''}
        <div style="position:absolute;top:6px;left:6px;z-index:2"><span class="mmc-tl-badge">${objIconSvg('timelapse', 12)}Timelapse</span></div>
        <div class="mmc-actions" style="z-index:3">
          <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteTLCard('${esc(item.camera_id || '')}','${esc(item.filename || '')}','${esc(item.event_id || '')}')">✕</button>
        </div>
      </div>
    </article>`;
  }
  const isProcessing = item.status === 'recording' || item.status === 'processing';
  const hasVideo = !!(item.video_relpath || item.video_url);
  const showPlayer = hasVideo || !!item.encode_error;
  const imgSrc = item.snapshot_relpath ? `/media/${item.snapshot_relpath}` : (item.snapshot_url || '');
  const confirmed = item.confirmed ? 'mmc-confirmed' : '';
  const labelBubbles = (item.labels || []).slice(0, 3).map(l => objBubble(l, 26)).join('');
  const fmtDur = s => { if (!s || s <= 0) return ''; const m = Math.floor(s / 60), sec = Math.round(s % 60); return `${m}:${String(sec).padStart(2, '0')}`; };
  const fmtByt = b => { if (!b || b <= 0) return ''; if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'; return Math.round(b / 1024) + ' KB'; };
  const accent = getMediaAccentColor(item.labels);
  const playBg = hexToRgba(accent, 0.18);
  const playBorder = hexToRgba(accent, 0.5);
  const subBadge = `${subBadgeBase};color:${accent}`;
  // Pick most-specific label (first non-motion) for the top-left badge; fall back to motion
  const _badgeLabel = (item.labels || []).find(l => l && l !== 'motion') || 'motion';
  const _badgeColor = colors[_badgeLabel] || colors.motion || '#93c5fd';
  // When the bird classifier has identified a species, show it instead of the
  // generic "Vogel" — keeps bird colour + icon but tells the user what kind.
  const _badgeText = (_badgeLabel === 'bird' && item.bird_species) ? item.bird_species : (OBJ_LABEL[_badgeLabel] || _badgeLabel);
  // Inline overrides only border-color and text color; .mmc-tl-badge supplies dark bg + blur + shadow
  const motionBadge = `<div style="position:absolute;top:6px;left:6px;z-index:2"><span class="mmc-tl-badge" style="border-color:${hexToRgba(_badgeColor, 0.7)};color:${_badgeColor}">${objIconSvg(_badgeLabel, 12)}${esc(_badgeText)}</span></div>`;
  const errorBadge = item.encode_error ? `<div style="position:absolute;bottom:7px;left:50%;transform:translateX(-50%);z-index:4"><span title="${esc(item.encode_error)}" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(250,204,21,.18);border:1px solid rgba(250,204,21,.5);color:#facc15;font-size:13px;font-weight:800;backdrop-filter:blur(4px)">⚠</span></div>` : '';
  const vidDate = fmtMediaDate(item.time || '');
  const vidTime = fmtMediaTimeOnly(item.time || '');
  const vidDur = fmtDur(item.duration_s);
  const vidSize = fmtByt(item.file_size_bytes);
  const procMsg = item.status === 'recording' ? 'wird aufgenommen…' : 'wird verarbeitet…';
  const processingInner = `<div style="position:absolute;inset:0;background:#0a0e1a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">
        <div style="width:42px;height:42px;border:3px solid ${hexToRgba(colors.motion, 0.2)};border-top-color:${colors.motion};border-radius:50%;animation:spin 1s linear infinite"></div>
        <div style="font-size:11px;color:${colors.motion};font-weight:600">${procMsg}</div>
      </div>
      ${motionBadge}`;
  const videoThumbEl = (showPlayer && imgSrc)
    ? `<img src="${esc(imgSrc)}" alt="preview" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7" loading="lazy" onerror="this.remove()">`
    : '';
  const mediaInner = isProcessing
    ? processingInner
    : showPlayer
    ? `<div style="position:absolute;inset:0;background:#0a0e1a">${videoThumbEl}</div>
      <div style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center">
        <div class="mmc-play-btn" style="background:${playBg};border:1.5px solid ${playBorder}"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color:${accent};margin-left:3px"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>
      ${(vidDate || vidTime) ? `<div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
        ${vidDate ? `<div style="${badgeStyle}">${esc(vidDate)}</div>` : ''}
        ${vidTime ? `<div style="${subBadge}">${esc(vidTime)}</div>` : ''}
      </div>` : ''}
      ${(vidDur || vidSize) ? `<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        ${vidDur ? `<div style="${badgeStyle}">${vidDur}</div>` : ''}
        ${vidSize ? `<div style="${subBadge}">${vidSize}</div>` : ''}
      </div>` : ''}
      ${motionBadge}
      ${errorBadge}`
    : `<img src="${esc(imgSrc)}" alt="event" loading="lazy" onerror="this.style.display='none'" />
      ${(vidDate || vidTime) ? `<div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
        ${vidDate ? `<div style="${badgeStyle}">${esc(vidDate)}</div>` : ''}
        ${vidTime ? `<div style="${subBadge}">${esc(vidTime)}</div>` : ''}
      </div>` : ''}
      ${vidSize ? `<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        <div style="${subBadge}">${vidSize}</div>
      </div>` : ''}`;
  return `<article class="media-card ${confirmed}" data-event-id="${esc(item.event_id || '')}" data-camera-id="${esc(item.camera_id || '')}">
    <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id || '')}')">
      ${mediaInner}
      ${showPlayer ? '' : `<div class="media-label-bubbles">${labelBubbles}</div>`}
      ${item.confirmed
        ? `<span class="media-confirmed-badge">✓</span>`
        : `<div class="mmc-actions">
        <button class="mmc-btn mmc-confirm" title="Bestätigen" onclick="event.stopPropagation();window.confirmMediaCard('${esc(item.camera_id || '')}','${esc(item.event_id || '')}',this)">✓</button>
        <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteMediaCard(this)">✕</button>
      </div>`}
    </div>
  </article>`;
}

function _fmtMb(mb){
  if (!mb || mb <= 0) return '0 MB';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}
// Archive icon — box with lid and latch
const _ARCHIVE_ICON = `<svg width="13" height="12" viewBox="0 0 13 12" fill="none" aria-hidden="true" style="flex-shrink:0"><rect x="1" y="4.5" width="11" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><rect x="0.5" y="2" width="12" height="2.5" rx="1" stroke="currentColor" stroke-width="1.1"/><rect x="4.5" y="6.25" width="4" height="2" rx="0.75" stroke="currentColor" stroke-width="1"/></svg>`;

// All-media multi-camera grid icon — 4 quads: TL=timelapse(violet), TR=motion(blue), BL=person(blue), BR=object(amber)
// Single coherent stacked-media glyph for the "Alle Medien" tile.
// Replaces a previous 2×2 collage of small thumbnails (timelapse,
// walker, face, archive bag) which read as cluttered. Three overlapping
// rounded "media cards" stacked top-down with a play triangle on the
// front card communicate "all archived clips" cleanly. Single muted-
// blue family, flat fill, ≥ 8 px corner radius per CLAUDE.md design
// rules. Container CSS centers + pads it so the mark sits with
// comfortable breathing room on all four sides of the tile.
// Composite bounding box of the three rects spans x=14-70, y=10-54
// (centre 42,32). The 80×80 viewBox centre is 40,40 — so the
// composite is 2 px right and 8 px above where it should sit. The
// translate(-2,8) on the wrapping <g> pulls the whole stack back
// onto the geometric centre with equal padding on all four sides.
export const _MOC_ALL_SVG = `<svg width="96" height="96" viewBox="0 0 80 80" fill="none" aria-hidden="true">
  <g transform="translate(-2, 8)">
    <rect x="14" y="22" width="44" height="32" rx="6" fill="#3a5878" opacity=".55"/>
    <rect x="20" y="16" width="44" height="32" rx="6" fill="#4a7090" opacity=".8"/>
    <rect x="26" y="10" width="44" height="32" rx="6" fill="#7faec9"/>
    <polygon points="44,18 44,34 58,26" fill="#1a2535"/>
  </g>
</svg>`;

// Count chips for media overview cards
export const _MOC_OBJECT_TYPES = { person: 1, cat: 1, bird: 1, car: 1, dog: 1 };
export function _mocChip(type, count, title){
  // Object-label chips (person/cat/bird/car): CAT_COLORS + objIconSvg
  if (_MOC_OBJECT_TYPES[type]){
    const col = CAT_COLORS[type] || '#8888aa';
    return `<span class="moc-count-chip" title="${esc(title)}" style="background:${hexToRgba(col, 0.18)};color:${col};border-radius:8px">${objIconSvg(type, 10)} ${count}</span>`;
  }
  const icons = {
    event: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3.8" stroke="#4a6477" stroke-width="1.3"/><path d="M5 3v2l1.5 1" stroke="#4a6477" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    snap: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="2.5" width="8" height="6" rx="1.5" stroke="#4a6477" stroke-width="1.2"/><circle cx="5" cy="5.5" r="1.6" fill="#4a6477"/><path d="M3.5 2.5l.4-1h2.2l.4 1" stroke="#4a6477" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    tl: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#c4b5fd" stroke-width="1" stroke-linecap="round"><line x1="2.5" y1="1" x2="7.5" y2="1"/><line x1="2.5" y1="9" x2="7.5" y2="9"/><polygon points="3,1.5 7,1.5 5,5" fill="#c4b5fd" opacity=".8"/><polygon points="5,5 3,8.5 7,8.5" stroke="#a855f7" stroke-width="1" fill="none"/></svg>`,
    motion: objIconSvg('motion', 10),
  };
  const styles = {
    event: { bg: 'rgba(255,255,255,.07)', color: 'var(--muted)', radius: '6px' },
    snap: { bg: 'rgba(255,255,255,.07)', color: 'var(--muted)', radius: '6px' },
    tl: { bg: 'rgba(168,85,247,.18)', color: '#c084fc', radius: '8px' },
    motion: { bg: 'rgba(147,197,253,.15)', color: '#93c5fd', radius: '8px' },
  };
  const st = styles[type] || styles.event;
  return `<span class="moc-count-chip" title="${esc(title)}" style="background:${st.bg};color:${st.color};border-radius:${st.radius}">${icons[type] || icons.event} ${count}</span>`;
}

// Build the full chip HTML for a stats entry: objects → motion_only → timelapse
export function _buildMocChips(stats){
  const lc = stats.label_counts || {};
  const order = ['person','cat','bird','car','dog','squirrel'];
  const objTotal = order.reduce((n, k) => n + (lc[k] || 0), 0);
  const motionOnly = Math.max(0, (stats.event_count || 0) - objTotal);
  let html = '';
  for (const k of order){
    const n = lc[k] || 0;
    if (n > 0) html += _mocChip(k, n, OBJ_LABEL[k] || k);
  }
  if (motionOnly > 0) html += _mocChip('motion', motionOnly, 'Bewegung');
  if ((stats.timelapse_count || 0) > 0) html += _mocChip('tl', stats.timelapse_count, 'Timelapse');
  return html;
}

// ── Overview ────────────────────────────────────────────────────────────────
export function renderMediaOverview(){
  const ov = byId('mediaOverview'); if (!ov) return;
  const cams = state.cameras;
  if (!cams.length){ ov.innerHTML = ''; return; }
  const statsByid = {};
  (state.mediaStats || []).forEach(s => { statsByid[s.camera_id || s.id || s.name] = s; });

  const totalStats = (state.mediaStats || []).reduce((acc, s) => {
    const lc = { ...acc.label_counts };
    if (s.label_counts) Object.entries(s.label_counts).forEach(([k, v]) => { lc[k] = (lc[k] || 0) + v; });
    return {
      size_mb: (acc.size_mb || 0) + (s.size_mb || 0),
      event_count: (acc.event_count || 0) + (s.event_count || 0),
      jpg_count: (acc.jpg_count || 0) + (s.jpg_count || 0),
      timelapse_count: (acc.timelapse_count || 0) + (s.timelapse_count || 0),
      label_counts: lc,
    };
  }, { size_mb: 0, event_count: 0, jpg_count: 0, timelapse_count: 0, label_counts: {} });

  const thumbBadgeStyle = 'position:absolute;bottom:6px;right:6px;font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;z-index:2';
  const allCard = `<div class="moc-card" data-cam-id="__all__" onclick="openAllMediaDrilldown()">
    <div class="moc-all-thumb">${_MOC_ALL_SVG}<div style="${thumbBadgeStyle}">${_fmtMb(totalStats.size_mb)}</div></div>
    <div class="moc-body">
      <div class="moc-name">Alle Medien</div>
      <div class="moc-desc">${cams.length} Kamera${cams.length !== 1 ? 's' : ''} · Gesamtarchiv</div>
      <div class="moc-counts">
        ${_buildMocChips(totalStats)}
      </div>
    </div>
  </div>`;

  const ts = Date.now();
  const camCards = cams.map(c => {
    const s = statsByid[c.id] || {};
    const icon = getCameraIcon(c.name || c.id);
    // Prefer newest object-labelled snapshot (person/cat/bird/car) over generic latest snap;
    // fall back to the generic latest, then the live snapshot.
    const storedSnap = s.latest_object_snap_url || s.latest_snap_url || '';
    const liveSnap = `/api/camera/${encodeURIComponent(c.id)}/snapshot.jpg?t=${ts}`;
    const thumbSrc = storedSnap || liveSnap;
    const placeholderInner = `<span style="font-size:48px;opacity:.25">${icon}</span>`;
    const fallback = storedSnap ? `this.onerror=function(){this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))};this.src='${liveSnap}'`
      : `this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))`;
    const locationDesc = c.location ? `<div class="moc-desc">${esc(c.location)}</div>` : '';
    return `<div class="moc-card" data-cam-id="${esc(c.id)}" onclick="openMediaDrilldown('${esc(c.id)}')">
      <div class="moc-thumb"><img src="${esc(thumbSrc)}" alt="${esc(c.name)}" onerror="${esc(fallback)}" loading="lazy"/><div style="${thumbBadgeStyle}">${_fmtMb(s.size_mb || 0)}</div></div>
      <div class="moc-body">
        <div class="moc-name">${icon} ${esc(c.name)}</div>
        ${locationDesc}
        <div class="moc-counts">
          ${_buildMocChips(s)}
        </div>
      </div>
    </div>`;
  }).join('');

  // Archived cameras section — cameras removed from config but with remaining media
  const archived = state.mediaArchived || [];
  let archivedHtml = '';
  if (archived.length){
    const archCards = archived.map(a => {
      const thumbInner = a.latest_snap_url
        ? `<img src="${esc(a.latest_snap_url)}" alt="${esc(a.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(.45) brightness(.8)"/>`
        : `<span style="font-size:36px;opacity:.18">📦</span>`;
      const archBadgeStyle = 'position:absolute;bottom:6px;right:6px;font-size:10px;font-weight:700;color:#a5bfce;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;z-index:2';
      return `<div class="moc-card moc-archived" data-cam-id="${esc(a.id)}" onclick="openMediaDrilldown('${esc(a.id)}')">
        <div class="moc-thumb moc-arch-thumb">${thumbInner}<div style="${archBadgeStyle}">${_fmtMb(a.size_mb || 0)}</div></div>
        <div class="moc-body">
          <div class="moc-name" style="display:flex;align-items:center;gap:6px">${_ARCHIVE_ICON} <span>${esc(a.name)}</span></div>
          <div class="moc-desc">Archiviert · <code style="font-size:10px;opacity:.6">${esc(a.id)}</code></div>
          <div class="moc-counts">
            ${a.event_count ? _mocChip('motion', a.event_count, 'Bewegung') : ''}
            ${a.timelapse_count ? _mocChip('tl', a.timelapse_count, 'Timelapse') : ''}
          </div>
          <div style="margin-top:8px">
            <button class="btn-action ghost btn-merge-archived" title="In aktive Kamera zusammenführen" data-merge-action="open" data-merge-id="${esc(a.id)}" data-merge-name="${esc(a.name)}">
              Zusammenführen ↗
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
    archivedHtml = `<div class="moc-archive-section">
      <div class="moc-archive-hdr">${_ARCHIVE_ICON} Archivierte Kameras <span class="moc-archive-count">${archived.length}</span></div>
      <div class="moc-archive-grid">${archCards}</div>
    </div>`;
  }

  // Category filter bar — populated dynamically (see renderMediaFilterPills('overview') below)
  const catSection = `<div class="media-filter-bar moc-filter-bar" id="mediaFilterBarOverview"></div>`;

  ov.innerHTML = catSection + `<div class="media-overview-grid">${allCard}${camCards}</div>` + archivedHtml;
  renderMediaFilterPills('overview');
}

// Single source of truth for which moc-card is highlighted. data-cam-id is
// stable across re-renders; pass null/undefined to clear all (used when the
// drilldown closes or "Alle Medien" opens).
export function _setActiveMocCard(camId){
  document.querySelectorAll('.moc-card').forEach(c => {
    c.classList.toggle('moc-active', !!camId && c.dataset.camId === camId);
  });
}

// ── Drilldown openers ───────────────────────────────────────────────────────
export async function openCategoryDrilldown(label){
  state.mediaDrillOpen = true;
  state.mediaCamera = null;
  state.mediaLabels = new Set(label ? [label] : []);
  state.mediaPage = 0;
  if (state.mediaSelectMode) _exitMediaSelectMode();
  if (state.mediaLabels.size === 0) _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display = 'none';
  byId('mediaDrilldown').style.display = '';
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  // Always render — even if loadMedia throws, the "Keine Medien
  // vorhanden." fallback is a far better UX than a frozen "Lade
  // Medien…" placeholder. _pruneEmptyMediaFilters then drops any
  // pre-seeded label that ended up with zero matches so the pill bar
  // doesn't show stale highlights.
  try { await loadMedia(); }
  catch (err){ console.warn('[mediathek] loadMedia (category) failed:', err); }
  _pruneEmptyMediaFilters();
  renderMediaFilterPills('drilldown');
  renderMediaGrid();
}

export async function openAllMediaDrilldown(preFilterLabel){
  state.mediaDrillOpen = true;
  state.mediaCamera = null;
  state.mediaLabels = preFilterLabel ? new Set([preFilterLabel]) : new Set();
  state.mediaPage = 0;
  if (state.mediaSelectMode) _exitMediaSelectMode();
  state.media = []; state._allMedia = [];
  const grid = byId('mediaGrid');
  if (grid) grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  if (state.mediaLabels.size === 0) _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display = 'none';
  byId('mediaDrilldown').style.display = '';
  _setActiveMocCard('__all__');
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  try { await loadMedia(); }
  catch (err){ console.warn('[mediathek] loadMedia (all) failed:', err); }
  _pruneEmptyMediaFilters();
  renderMediaFilterPills('drilldown');
  renderMediaGrid();
  // Same layout-race safety net as openMediaDrilldown — see comment there.
  setTimeout(() => {
    const ps = calcItemsPerPage();
    if (state._allMedia?.length){
      window._cachedPageSize = ps;
      state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / ps));
      state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
      const off = (state.mediaPage || 0) * ps;
      state.media = state._allMedia.slice(off, off + ps);
    }
    renderMediaGrid();
  }, 0);
}

export async function openMediaDrilldown(camId){
  state.mediaDrillOpen = true;
  state.mediaCamera = camId;
  state.mediaLabels = new Set(); state.mediaPage = 0;
  if (state.mediaSelectMode) _exitMediaSelectMode();
  // Clear stale state and grid immediately so the previous camera's thumbnails
  // don't flash before the new fetch resolves.
  state.media = []; state._allMedia = [];
  const grid = byId('mediaGrid');
  if (grid) grid.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  const pag = byId('mediaPagination'); if (pag) pag.innerHTML = '';
  _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display = 'none';
  byId('mediaDrilldown').style.display = '';
  _setActiveMocCard(camId);
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  try { await loadMedia(); }
  catch (err){ console.warn('[mediathek] loadMedia (cam) failed:', err); }
  _pruneEmptyMediaFilters();
  renderMediaFilterPills('drilldown');
  renderMediaGrid();
  // One-tick re-render. The drilldown wrapper just transitioned from
  // display:none to display:'' — its layout box doesn't have a width
  // until the next paint, so calcItemsPerPage() inside loadMedia()
  // can read 0 from getBoundingClientRect and slice an empty page.
  // setTimeout(0) yields to the browser, the layout settles, then
  // we re-slice + re-render. Identical state → idempotent when the
  // first render already worked, fixes the empty-grid race when it
  // didn't (the user's "have to toggle a filter" symptom).
  setTimeout(() => {
    const ps = calcItemsPerPage();
    if (state._allMedia?.length){
      window._cachedPageSize = ps;
      state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / ps));
      state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
      const off = (state.mediaPage || 0) * ps;
      state.media = state._allMedia.slice(off, off + ps);
    }
    renderMediaGrid();
  }, 0);
}

export function closeMediaDrilldown(){
  state.mediaDrillOpen = false;
  state.mediaCamera = null; state.media = [];
  if (state.mediaSelectMode) _exitMediaSelectMode();
  byId('mediaDrilldown').style.display = 'none';
  byId('mediaOverview').style.display = '';
  _setActiveMocCard(null);
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
}

// ── Pagination + processing-poll + grid ─────────────────────────────────────
export function _goToPage(n){
  const ps = calcItemsPerPage();
  const p = Math.max(0, Math.min(state.mediaTotalPages - 1, n));
  if (p === state.mediaPage) return;
  state.mediaPage = p;
  // Re-slice from the cached all-items list — no new API call needed
  state.media = (state._allMedia || []).slice(p * ps, (p + 1) * ps);
  renderMediaGrid();
  renderMediaPagination();
}

export function renderMediaPagination(){
  const pg = byId('mediaPagination'); if (!pg) return;
  const total = state.mediaTotalPages || 1;
  const cur = state.mediaPage || 0;
  if (total <= 1){ pg.innerHTML = ''; return; }
  pg.innerHTML =
    `<button class="page-pill" ${cur === 0 ? 'disabled' : ''} onclick="_goToPage(${cur - 1})">‹</button>` +
    `<span class="page-label">Seite ${cur + 1} von ${total}</span>` +
    `<button class="page-pill" ${cur >= total - 1 ? 'disabled' : ''} onclick="_goToPage(${cur + 1})">›</button>`;
}

let _processingPoll = null;
export function _ensureProcessingPoll(){
  const pending = (state.media || []).some(x => x && (x.status === 'recording' || x.status === 'processing'));
  if (pending && !_processingPoll){
    _processingPoll = setInterval(async () => {
      try {
        await loadMedia();
        renderMediaGrid();
      } catch (_){ /* keep polling */ }
    }, 3000);
  } else if (!pending && _processingPoll){
    clearInterval(_processingPoll);
    _processingPoll = null;
    // A recording just finished — file landed on disk and size_mb grew.
    // Refresh overview chips + size badge to match server truth.
    loadMediaStorageStats();
  }
}

export function renderMediaGrid(){
  const grid = byId('mediaGrid'); if (!grid) return;
  // Unified stream: EventStore now contains motion + timelapse events, so no
  // separate tl list needs to be merged here.
  const items = state.media || [];
  // Light slide-in on page change
  grid.style.opacity = '0'; grid.style.transform = 'translateX(10px)';
  grid.innerHTML = items.map(mediaCardHTML).join('') || '<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
  if (state.mediaSelectMode){
    grid.querySelectorAll('.media-card').forEach(card => {
      if (state.mediaSelected.has(card.dataset.eventId)) card.classList.add('media-card--selected');
    });
  }
  requestAnimationFrame(() => { grid.style.transition = 'opacity .18s ease,transform .18s ease'; grid.style.opacity = '1'; grid.style.transform = ''; });
  renderMediaPagination();
  window._openMediaItem = id => {
    if (state.mediaSelectMode){ window._toggleMediaSelected(id); return; }
    const item = items.find(x => x.event_id === id);
    if (item) openLightbox(item);
  };
  // Poll for pending recording/processing items until every visible card is ready
  _ensureProcessingPoll();
  // Cache-bust any card whose item has a snapshot_relpath but whose <img> is
  // empty or broken — covers freshly-generated thumbnails that the browser
  // may have cached as 404 from an earlier render pass.
  grid.querySelectorAll('.media-card').forEach(card => {
    const eid = card.dataset.eventId;
    if (!eid) return;
    const item = items.find(x => x.event_id === eid);
    if (!item || !item.snapshot_relpath) return;
    const img = card.querySelector('.mmc-img-wrap img');
    if (!img) return;
    const needsBust = !img.getAttribute('src') || img.naturalWidth === 0 || img.style.display === 'none';
    if (needsBust){
      img.style.display = '';
      img.src = `/media/${item.snapshot_relpath}?t=${Date.now()}`;
    }
  });
  // Post-render column correction: measure actual card width, recompute page size if off
  requestAnimationFrame(() => {
    const firstCard = grid.querySelector('.media-card');
    if (!firstCard) return;
    const actualW = firstCard.getBoundingClientRect().width;
    const containerW = grid.getBoundingClientRect().width;
    if (actualW <= 0 || containerW <= 0) return;
    const actualCols = Math.max(1, Math.round(containerW / actualW));
    if (actualCols !== window._lastKnownCols) window._lastKnownCols = actualCols;
    const correctPs = _MEDIA_ROWS * actualCols;
    if (correctPs !== window._cachedPageSize && state._allMedia && state._allMedia.length){
      window._cachedPageSize = correctPs;
      state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / correctPs));
      state.mediaPage = 0;
      state.media = state._allMedia.slice(0, correctPs);
      renderMediaGrid();
      renderMediaPagination();
    }
  });
}

// ── Section title ───────────────────────────────────────────────────────────
// Library/film glyph for overview + Alle-Medien title; per-camera drilldown
// uses the camera's thematic icon via getCameraIcon (matches the cv-card).
export const _MEDIA_TITLE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 6V4h10v2"/><circle cx="12" cy="13" r="3"/></svg>`;
export function updateMediaSectionTitle(){
  const h = byId('mediaSectionTitle'); if (!h) return;
  // Drive the title from a state flag instead of probing
  // #mediaDrilldown.style.display. The DOM probe was returning stale
  // values right after the openers flipped the inline style, leaving
  // the heading stuck on bare "Mediathek" even when a cam was selected.
  // The flag is owned by openMediaDrilldown / openAllMediaDrilldown /
  // openCategoryDrilldown / closeMediaDrilldown — see core/state.js.
  const drillOpen = !!state.mediaDrillOpen;
  if (drillOpen && state.mediaCamera){
    const cam = (state.cameras || []).find(c => c.id === state.mediaCamera);
    const camName = cam?.name || state.mediaCamera;
    const camIcon = getCameraIcon(camName);
    h.innerHTML = `<span class="mst-cam-icon" aria-hidden="true">${camIcon}</span><span class="mst-text">Mediathek · ${esc(camName)}</span>`;
  } else if (drillOpen){
    h.innerHTML = `${_MEDIA_TITLE_SVG}<span class="mst-text">Mediathek · Alle Medien</span>`;
  } else {
    h.innerHTML = `${_MEDIA_TITLE_SVG}<span class="mst-text">Mediathek</span>`;
  }
}

// ── Card-action handlers (inline-onclick targets) ───────────────────────────
// These are still bridged via window.X in legacy.js because the inline
// onclicks rendered by mediaCardHTML look them up on window. The bodies
// live here next to the renderers they depend on (calcItemsPerPage,
// renderMediaGrid, renderMediaPagination) — when the inline onclicks
// migrate to delegated event listeners these become plain exports.

export async function deleteMediaCard(btn){
  const card = btn.closest('.media-card');
  const eventId = card?.dataset.eventId;
  const camId = card?.dataset.cameraId;
  if (!eventId || !camId) return;
  try {
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    // Brief fade-out animation, then re-render
    if (card){
      card.style.transition = 'opacity .25s,transform .25s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.95)';
    }
    setTimeout(() => {
      state._allMedia = (state._allMedia || []).filter(x => x.event_id !== eventId);
      const ps_d = calcItemsPerPage();
      state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / ps_d));
      state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
      state.media = state._allMedia.slice(state.mediaPage * ps_d, (state.mediaPage + 1) * ps_d);
      if (state.media.length === 0 && state.mediaPage > 0){
        state.mediaPage--;
        state.media = state._allMedia.slice(state.mediaPage * ps_d, (state.mediaPage + 1) * ps_d);
      }
      renderMediaGrid();
      renderMediaPagination();
      refreshTimelineAndStats();
    }, 250);
  } catch (e){ showToast('Löschen fehlgeschlagen: ' + e.message, 'error'); }
}

export async function deleteTLCard(camId, filename, eventId){
  try {
    await j(`/api/camera/${encodeURIComponent(camId)}/timelapse/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    // Remove the unified EventStore entry too (server also does this as a backstop)
    if (eventId){
      try {
        await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
      } catch (_){ /* already cleaned by server */ }
    }
    const card = byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if (card) card.remove();
    state._allMedia = (state._allMedia || []).filter(x => x.event_id !== eventId);
    const ps_d = calcItemsPerPage();
    state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / ps_d));
    state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
    state.media = state._allMedia.slice(state.mediaPage * ps_d, (state.mediaPage + 1) * ps_d);
    if (state.media.length === 0 && state.mediaPage > 0){
      state.mediaPage--;
      state.media = state._allMedia.slice(state.mediaPage * ps_d, (state.mediaPage + 1) * ps_d);
    }
    renderMediaGrid();
    renderMediaPagination();
    if (!byId('mediaGrid').querySelector('.media-card')){
      byId('mediaGrid').innerHTML = '<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
    }
    refreshTimelineAndStats();
  } catch (e){ showToast('Löschen fehlgeschlagen: ' + e.message, 'error'); }
}

export async function confirmMediaCard(camId, eventId, btn){
  // Brief scale animation on tap
  if (btn){
    btn.classList.add('mmc-confirm--anim');
    setTimeout(() => btn.classList.remove('mmc-confirm--anim'), 200);
  }
  try {
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}/confirm`, { method: 'POST' });
    // update state.media + state._allMedia in place so lightbox nav and re-renders stay in sync
    const sIdx = (state.media || []).findIndex(x => x.event_id === eventId);
    if (sIdx >= 0) state.media[sIdx].confirmed = true;
    const aIdx = (state._allMedia || []).findIndex(x => x.event_id === eventId);
    if (aIdx >= 0) state._allMedia[aIdx].confirmed = true;
    const card = byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if (card){
      // Wait for the scale anim to finish, then swap actions for the ✓ badge
      setTimeout(() => {
        card.classList.add('mmc-confirmed');
        const actions = card.querySelector('.mmc-actions');
        if (actions) actions.outerHTML = '<span class="media-confirmed-badge">✓</span>';
      }, 200);
    }
  } catch (e){ showToast('Bestätigen fehlgeschlagen: ' + e.message, 'error'); }
}

// ── window.* bridges (Stage 25 D) ───────────────────────────────────────────
// router.js, statistics.js, timeline.js, chrome/storage-stats.js plus
// inline onclicks rendered by mediaCardHTML / renderMediaOverview /
// renderMediaPagination all reach for these by global name. Each
// bridge evaporates when its consumer migrates to a direct import.
window.openMediaDrilldown      = openMediaDrilldown;
window.openAllMediaDrilldown   = openAllMediaDrilldown;
window.openCategoryDrilldown   = openCategoryDrilldown;
window.closeMediaDrilldown     = closeMediaDrilldown;
window.loadMedia               = loadMedia;
window.renderMediaGrid         = renderMediaGrid;
window.renderMediaPagination   = renderMediaPagination;
window.renderMediaOverview     = renderMediaOverview;
window.renderMediaFilterPills  = renderMediaFilterPills;
window.calcItemsPerPage        = calcItemsPerPage;
window.updateMediaSectionTitle = updateMediaSectionTitle;
window._pruneEmptyMediaFilters = _pruneEmptyMediaFilters;
window._seedTopMediaLabel      = _seedTopMediaLabel;
window._goToPage               = _goToPage;
window.deleteMediaCard         = deleteMediaCard;
window.deleteTLCard            = deleteTLCard;
window.confirmMediaCard        = confirmMediaCard;

// ─── camedit/tracking-sim.js ───────────────────────────────────────────────
// The Erkennung-tab "Video" sub-tab: pick a recent video event for the
// current camera, render its tracks.json sidecar as an inline SVG
// timeline, optionally re-trigger the worker to (re)build it. Mounts
// itself lazily — the picker only renders the first time the Video tab
// is activated for a given camera.
//
// This module never touches the Mediathek or the lightbox. It owns
// nothing in the global state map; per-event tracks payloads are kept
// in a session-scoped Map so switching back to a clip is instant.
import { byId, esc } from '../core/dom.js';
import { showToast } from '../core/toast.js';

// session-scoped cache: event_id → tracks payload
const _trackCache = new Map();

document.addEventListener('erk-sim-tab:video', () => {
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  const panel = byId('erkSimTab-video');
  if (!panel || !camId) return;
  if (panel.dataset.camId === camId && panel.dataset.shellRendered === '1') return;
  panel.dataset.camId = camId;
  panel.dataset.shellRendered = '1';
  panel.dataset.selectedEventId = '';
  _renderShell(panel);
  _loadPicker(camId);
});

function _renderShell(panel){
  panel.innerHTML = `
    <div class="ets-video">
      <div class="ets-picker-wrap">
        <div class="ets-picker" id="etsPicker"></div>
      </div>
      <div class="ets-actions" id="etsActions" hidden>
        <button type="button" class="btn btn-action accent" id="etsShowTimelineBtn">Timeline anzeigen</button>
        <button type="button" class="btn btn-action" id="etsRegenBtn">Tracking neu generieren</button>
        <span class="ets-progress" id="etsProgress" hidden></span>
      </div>
      <div class="ets-result" id="etsResult"></div>
    </div>`;
  byId('etsShowTimelineBtn')?.addEventListener('click', () => _showTimeline());
  byId('etsRegenBtn')?.addEventListener('click', () => _regenerateTracks());
}

// Cap at 5 most-recent video events. store.list_events already returns
// items in newest-first order, so the slice is purely defensive against
// future server-side changes — don't re-sort.
const _PICKER_MAX = 5;

async function _loadPicker(camId){
  const picker = byId('etsPicker');
  picker.innerHTML = '<div class="ets-empty">Lade Clips…</div>';
  let items = [];
  try {
    const r = await fetch(`/api/camera/${encodeURIComponent(camId)}/media?limit=${_PICKER_MAX}`);
    if (!r.ok) throw new Error(r.statusText);
    const d = await r.json();
    items = (d.items || [])
      .filter(it => (it.video_relpath || '').endsWith('.mp4'))
      .slice(0, _PICKER_MAX);
  } catch {
    picker.innerHTML = '<div class="ets-empty">Fehler beim Laden der Clips.</div>';
    return;
  }
  if (items.length === 0){
    picker.innerHTML = '<div class="ets-empty">Noch keine Video-Clips für diese Kamera. Erst Bewegung aufzeichnen.</div>';
    const regen = byId('etsRegenBtn');
    if (regen) regen.disabled = true;
    return;
  }
  // Inline "nur N Videos vorhanden" hint when the camera doesn't have
  // five clips yet — avoids padding the rail with empty placeholders.
  const trail = items.length < _PICKER_MAX
    ? `<div class="ets-picker-trail">nur ${items.length} Video${items.length === 1 ? '' : 's'} vorhanden</div>`
    : '';
  picker.innerHTML = items.map(_pickerCardHtml).join('') + trail;
  picker.querySelectorAll('.ets-card').forEach(card => {
    card.addEventListener('click', () => _selectCard(card.dataset.eventId, card.dataset.videoRelpath));
  });
}

// Same-origin tracks.json path next to the mp4. Mirrors
// mediathek/bbox-overlay.js::_tracksUrlFor so both consumers agree on
// the URL shape; using video_url (which carries the configured
// public_base_url with host:port) breaks the moment the user opens the
// UI under a different hostname.
function _tracksUrlFromRelpath(rel){
  if (!rel || !rel.endsWith('.mp4')) return null;
  return `/media/${rel.slice(0, -4)}.tracks.json`;
}

function _formatTimestamp(iso){
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso || '';
  const now = new Date();
  const sameDay = t.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const isYest = t.toDateString() === yest.toDateString();
  const hhmm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Heute ${hhmm}`;
  if (isYest) return `Gestern ${hhmm}`;
  return t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ' + hhmm;
}

// Resolve a thumbnail src from a media item.
//
// The convention everywhere in this codebase: the sibling `.jpg` next to
// `.mp4` IS the thumbnail. mediaScan in storage.py creates these
// automatically and they're guaranteed to be same-origin. Fall back to
// the *_url fields only when the relpath isn't usable (legacy
// non-mp4 events).
function _pickThumbSrc(it){
  const rel = it.video_relpath;
  if (rel && rel.endsWith('.mp4')){
    return `/media/${rel.slice(0, -4)}.jpg`;
  }
  if (it.thumb_url) return it.thumb_url;
  if (it.snapshot_url) return it.snapshot_url;
  if (it.thumb_relpath) return `/media/${it.thumb_relpath}`;
  if (it.snapshot_relpath) return `/media/${it.snapshot_relpath}`;
  return '';
}

function _pickerCardHtml(it){
  const thumb = _pickThumbSrc(it);
  const ts = _formatTimestamp(it.time);
  const labels = (it.labels || []).slice(0, 4)
    .map(l => `<span class="ets-card-lbl">${esc(l)}</span>`).join('');
  // Cards without video_relpath can't drive the timeline path — disable
  // them with a hint so the user doesn't end up wondering why the action
  // bar buttons silently no-op.
  const hasRelpath = !!(it.video_relpath && it.video_relpath.endsWith('.mp4'));
  const disabledAttrs = hasRelpath
    ? ''
    : ' aria-disabled="true" title="Pfad-Information fehlt — Tracking nicht verfügbar."';
  // onerror collapses the <img> when the file is gone or the configured
  // public_base_url points at a host we can't reach from this browser.
  // The empty .ets-card-thumb stays visible as a flat black tile.
  const thumbHtml = thumb
    ? `<img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `
    <button type="button" class="ets-card${hasRelpath ? '' : ' is-disabled'}" data-event-id="${esc(it.event_id)}" data-video-relpath="${esc(it.video_relpath || '')}" tabindex="0"${disabledAttrs}>
      <div class="ets-card-thumb">${thumbHtml}</div>
      <div class="ets-card-meta">
        <div class="ets-card-time">${esc(ts)}</div>
        <div class="ets-card-labels">${labels}</div>
      </div>
    </button>`;
}

function _selectCard(eventId, videoRelpath){
  document.querySelectorAll('.ets-card').forEach(c => {
    c.classList.toggle('is-selected', c.dataset.eventId === eventId);
  });
  const panel = byId('erkSimTab-video');
  panel.dataset.selectedEventId = eventId;
  panel.dataset.selectedVideoRelpath = videoRelpath || '';
  // Disable the timeline / regen buttons when the relpath is missing so
  // the user has a visible signal that the card can't drive the flow.
  const hasRelpath = !!(videoRelpath && videoRelpath.endsWith('.mp4'));
  const showBtn = byId('etsShowTimelineBtn');
  const regenBtn = byId('etsRegenBtn');
  if (showBtn){ showBtn.disabled = !hasRelpath; }
  if (regenBtn){ regenBtn.disabled = !hasRelpath; }
  byId('etsActions').hidden = false;
  byId('etsResult').innerHTML = '';
}

async function _showTimeline(){
  const panel = byId('erkSimTab-video');
  const eventId = panel?.dataset.selectedEventId;
  const videoRelpath = panel?.dataset.selectedVideoRelpath;
  if (!eventId) return;
  const result = byId('etsResult');
  const tracksUrl = _tracksUrlFromRelpath(videoRelpath);
  if (!tracksUrl){
    result.innerHTML = '';
    showToast('Pfad ungültig — video_relpath fehlt für diesen Clip.', 'error');
    return;
  }
  result.innerHTML = '<div class="ets-empty">Lade Tracking-Daten…</div>';
  let payload = _trackCache.get(eventId);
  let mtime = null;
  if (!payload){
    let r;
    try {
      r = await fetch(tracksUrl);
    } catch (e){
      // Network-level failure — no response at all (CORS, offline, DNS).
      result.innerHTML = '';
      showToast(`Netzwerk-Fehler beim Laden: ${e.message || e}`, 'error');
      return;
    }
    if (r.status === 404){
      // Normal "no sidecar yet" state — silent, point at the regen button.
      result.innerHTML = `
        <div class="ets-empty ets-empty--hint">
          Noch kein Tracking — bitte über
          <strong>↪ Tracking neu generieren</strong> erzeugen.
        </div>`;
      return;
    }
    if (!r.ok){
      result.innerHTML = '';
      const bucket = r.status >= 500 ? 'Server-Fehler' : 'Anfrage abgelehnt';
      showToast(`${bucket} (${r.status}) beim Laden der Tracking-Daten.`, 'error');
      return;
    }
    try {
      payload = await r.json();
    } catch (e){
      result.innerHTML = '';
      showToast(`Tracking-JSON ungültig: ${e.message || e}`, 'error');
      return;
    }
    mtime = r.headers.get('last-modified');
    _trackCache.set(eventId, payload);
  }
  // Same-origin video path for duration probe — never use the absolute
  // video_url (different host on remote-access deployments).
  const dur = await _resolveVideoDuration(`/media/${videoRelpath}`);
  renderTracksTimeline(result, payload, dur, mtime);
}

// Pulls clip duration from a hidden <video preload="metadata">. Resolves
// to 0 (and the timeline falls back to its own end-of-last-sample) on
// any failure / timeout.
async function _resolveVideoDuration(videoUrl){
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = videoUrl;
    let done = false;
    const finish = (val) => { if (!done){ done = true; resolve(val); } };
    v.addEventListener('loadedmetadata', () => finish(v.duration || 0), { once: true });
    v.addEventListener('error', () => finish(0), { once: true });
    setTimeout(() => finish(0), 5000);
  });
}

async function _regenerateTracks(){
  const panel = byId('erkSimTab-video');
  const eventId = panel?.dataset.selectedEventId;
  const camId = panel?.dataset.camId;
  if (!eventId || !camId) return;
  const btn = byId('etsRegenBtn');
  const prog = byId('etsProgress');
  btn.disabled = true;
  prog.hidden = false;
  prog.textContent = 'starte …';
  try {
    const r = await fetch(
      `/api/tracking/reindex/${encodeURIComponent(eventId)}` +
      `?camera_id=${encodeURIComponent(camId)}`,
      { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok){
      showToast('Re-Index fehlgeschlagen: ' + (d.error || r.statusText), 'error');
      return;
    }
    // Poll worker status. Drains usually within a couple of seconds for
    // a single clip; cap at 90s to avoid pinning the button forever.
    const t0 = Date.now();
    while (Date.now() - t0 < 90_000){
      await new Promise(res => setTimeout(res, 2000));
      let s = null;
      try { s = await (await fetch('/api/tracking/status')).json(); } catch { /* transient */ }
      if (!s) continue;
      if (!s.alive){
        showToast('Tracking-Worker nicht erreichbar', 'error');
        return;
      }
      const q = s.queued || 0;
      prog.textContent = q > 0 ? `Tracking läuft … noch ${q} in der Queue` : 'fast fertig …';
      if (q <= 0){
        // Tiny grace so the writer flushes before the GET picks the file up.
        await new Promise(res => setTimeout(res, 800));
        _trackCache.delete(eventId);
        await _showTimeline();
        return;
      }
    }
    showToast('Re-Index läuft im Hintergrund weiter — kurz warten und erneut anzeigen.', 'info');
  } catch (e){
    showToast('Re-Index fehlgeschlagen: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    prog.hidden = true;
  }
}

// Render a tracks.json payload as an inline SVG timeline inside `container`.
//
// Lane geometry auto-scales above 8 visible tracks so the chart fits one
// viewport without vertical scroll. Hard cap 16 lanes; remaining tracks are
// listed as "+N weitere ausgeblendet". Sort by best_score desc when capping.
export function renderTracksTimeline(container, tracksPayload, videoDurationS, mtime){
  const tracks = Array.isArray(tracksPayload?.tracks) ? tracksPayload.tracks : [];
  if (tracks.length === 0){
    container.innerHTML = `<div class="ets-empty">Keine Subjekte erkannt — Clip enthielt nur Bewegung ohne KI-Treffer.</div>`;
    return;
  }
  const SHOW_MAX = 16;
  const sorted = tracks.slice().sort((a, b) => (b.best_score || 0) - (a.best_score || 0));
  const visible = sorted.slice(0, SHOW_MAX);
  const hiddenCount = sorted.length - visible.length;

  const LANE_H_FULL = 24, LANE_GAP_FULL = 6;
  const SCALE = visible.length > 8 ? 8 / visible.length : 1;
  const LANE_H = Math.max(12, LANE_H_FULL * SCALE);
  const LANE_GAP = Math.max(3, LANE_GAP_FULL * SCALE);
  const FONT = Math.max(9, 12 * Math.min(1, SCALE * 1.2));
  const LABEL_W = 130;
  const RULER_H = 22;
  const VIEW_W = 720;
  const PLOT_W = VIEW_W - LABEL_W - 12;
  const PLOT_H = (LANE_H + LANE_GAP) * visible.length;
  const VIEW_H = RULER_H + PLOT_H + 6;

  const dur = videoDurationS && videoDurationS > 0
    ? videoDurationS
    : Math.max(1, visible.reduce((m, t) => Math.max(m, _lastSampleT(t)), 1));
  const tToX = (t) => LABEL_W + (Math.max(0, Math.min(t, dur)) / dur) * PLOT_W;

  // Ruler: minor tick every 1 s, label every Nth tick to keep things readable.
  const labelEvery = Math.max(1, Math.round(dur / 10));
  let ticks = '';
  for (let s = 0; s <= dur + 0.001; s += 1){
    const x = tToX(s);
    const isLabeled = (Math.round(s) % labelEvery) === 0;
    ticks += `<line x1="${x}" x2="${x}" y1="${RULER_H - (isLabeled ? 8 : 5)}" y2="${RULER_H}" stroke="rgba(255,255,255,.35)" stroke-width="${isLabeled ? 1.2 : 0.6}"/>`;
    if (isLabeled){
      ticks += `<text x="${x}" y="${RULER_H - 10}" fill="rgba(255,255,255,.6)" font-size="10" text-anchor="middle">${Math.round(s)}s</text>`;
    }
  }

  let samplesTotal = 0;
  const lanes = visible.map((t, i) => {
    const y = RULER_H + i * (LANE_H + LANE_GAP);
    const cy = y + LANE_H / 2;
    const samples = t.samples || [];
    samplesTotal += samples.length;
    const firstT = samples.length ? samples[0].t : 0;
    const lastT = samples.length ? samples[samples.length - 1].t : firstT;
    const x0 = tToX(firstT);
    const x1 = tToX(lastT);
    const w = Math.max(2, x1 - x0);
    const color = t.color || '#cbd5e1';
    const tid = String(t.track_id || '').slice(0, 6);
    const lbl = t.label || '?';
    let dots = '';
    samples.forEach((sm, idx) => {
      const dx = tToX(sm.t);
      if (idx === 0){
        dots += `<circle cx="${dx}" cy="${cy}" r="5.5" fill="none" stroke="${color}" stroke-width="1.6"/>`;
        dots += `<circle cx="${dx}" cy="${cy}" r="3" fill="${color}"/>`;
      } else {
        dots += `<circle cx="${dx}" cy="${cy}" r="3" fill="${color}"/>`;
      }
    });
    // Track-id rendered in muted secondary colour but the SAME body sans
    // family + size as the label text after the dot. Using a monospace
    // stack here made the id read as oversized when the modal got wide;
    // matching font-family fixes that without losing readability.
    return `
      <g>
        <rect x="${x0}" y="${y + LANE_H * 0.18}" width="${w}" height="${LANE_H * 0.64}" rx="3" fill="${color}" opacity="0.20"/>
        ${dots}
        <text x="${LABEL_W - 8}" y="${cy + FONT * 0.34}" font-size="${FONT}" text-anchor="end">
          <tspan fill="rgba(255,255,255,.42)">${esc(tid)}</tspan><tspan fill="rgba(255,255,255,.85)"> · ${esc(lbl)}</tspan>
        </text>
      </g>`;
  }).join('');

  const hiddenLine = hiddenCount > 0
    ? `<div class="ets-stats-hidden">+${hiddenCount} weitere ausgeblendet</div>`
    : '';
  const indexedAgo = mtime ? _relativeTimeAgo(new Date(mtime)) : '—';

  // Wrap the SVG in a max-width container so the timeline doesn't
  // dominate a wide camera-edit modal. 760 px matches the readable-
  // diagram width used elsewhere; viewBox-driven scaling does the rest.
  // Inline SVGs in the legend get explicit viewBox so the rect stays
  // visible across browsers (some renderers shrunk the rect to a hyphen-
  // shaped sliver without it).
  container.innerHTML = `
    <div class="ets-timeline">
      <div class="ets-timeline-svg-wrap">
        <svg viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Tracks-Timeline" font-family="Inter,system-ui,Segoe UI,Roboto,sans-serif">
          ${ticks}
          ${lanes}
        </svg>
      </div>
      <div class="ets-legend">
        <span class="ets-legend-item"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4" fill="none" stroke="#94a3b8" stroke-width="1.4"/><circle cx="7" cy="7" r="2" fill="#94a3b8"/></svg>Trigger-Frame</span>
        <span class="ets-legend-item"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="2.5" fill="#94a3b8"/></svg>1 Hz Sample</span>
        <span class="ets-legend-item"><svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><rect x="1" y="3" width="12" height="8" rx="1.5" fill="#94a3b8" opacity=".30"/></svg>Track-Lebensdauer</span>
      </div>
      ${hiddenLine}
      <div class="ets-stats">
        ${tracks.length} Track${tracks.length === 1 ? '' : 's'} · ${samplesTotal} Sample${samplesTotal === 1 ? '' : 's'} · Schema v${tracksPayload?.schema || '?'} · indiziert ${indexedAgo}
      </div>
    </div>`;
}

function _lastSampleT(track){
  const s = track.samples || [];
  return s.length ? s[s.length - 1].t : 0;
}

function _relativeTimeAgo(date){
  const dt = (Date.now() - date.getTime()) / 1000;
  if (dt < 60) return 'gerade eben';
  if (dt < 3600) return `vor ${Math.round(dt / 60)} min`;
  if (dt < 86400) return `vor ${Math.round(dt / 3600)} h`;
  return `vor ${Math.round(dt / 86400)} d`;
}

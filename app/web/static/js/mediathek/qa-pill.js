// ─── mediathek/qa-pill.js ──────────────────────────────────────────────────
// Quality pill on every timelapse card in the Mediathek grid + a
// modal panel on tap that surfaces the full QA sidecar JSON for
// copy-paste-back-to-chat diagnostics.
//
// Data path:
//   * Each `.mmc-tl` card carries `data-event-id` + `data-camera-id`.
//   * We resolve the mp4 relpath from the item via the unified
//     `state._allMedia` cache (already populated by the mediathek
//     loader), then lazy-fetch `/api/timelapse/<relpath>/qa` on
//     IntersectionObserver entry.
//   * Sidecar response paints the pill: green / yellow / red / n-a.
//
// On tap → modal centred on the viewport with the full QA report
// (declared / effective / unique fps, dup ratio, top-3 reject
// reasons, freeze list, validator profile). A "QA-Bericht kopieren"
// button copies a markdown-formatted version to the clipboard.
//
// Touch targets ≥ 44 × 44 px on the pill itself (pill is small but
// the hit area is enlarged via a transparent ::before). Modal close
// button + copy button match the existing modal-action sizes.

import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';

const _GRADE_CLASSES = {
  green:   { cls: 'mmc-qa-pill--green',  label: 'clean' },
  yellow:  { cls: 'mmc-qa-pill--yellow', label: 'ok' },
  red:     { cls: 'mmc-qa-pill--red',    label: 'lossy' },
};

// One in-flight fetch per relpath — multiple cards for the same
// item (rare but possible across re-renders) share the result.
const _qaCache = new Map();

function _itemFor(card){
  const eid = card.dataset.eventId;
  if (!eid) return null;
  const all = state._allMedia || state.media || [];
  return all.find(m => m && m.event_id === eid) || null;
}

function _relpathOf(item){
  // Preferred — the sidecar JSON carries the exact path.
  if (item.video_relpath) return item.video_relpath;
  // Fallback — derive from the canonical timelapse layout.
  if (item.filename && item.camera_id){
    return `timelapse/${item.camera_id}/${item.filename}`;
  }
  return null;
}

async function _fetchQA(relpath){
  if (_qaCache.has(relpath)) return _qaCache.get(relpath);
  const promise = (async () => {
    try {
      const r = await fetch(`/api/timelapse/${relpath}/qa`,
                            { headers: { Accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  })();
  _qaCache.set(relpath, promise);
  return promise;
}

function _renderPill(card, qa){
  if (card.dataset.qaPainted === '1') return;
  card.dataset.qaPainted = '1';
  const wrap = card.querySelector('.mmc-img-wrap');
  if (!wrap) return;
  const grade = qa?.quality_grade || null;
  const meta = grade ? _GRADE_CLASSES[grade] : null;
  const cls  = meta ? meta.cls : 'mmc-qa-pill--na';
  const lbl  = meta ? meta.label : 'n/a';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `mmc-qa-pill ${cls}`;
  btn.setAttribute('aria-label',
    qa ? `Qualität: ${lbl}` : 'Qualität: keine Daten');
  btn.title = qa
    ? `${lbl} · dup ${Math.round((qa.playback?.duplicate_ratio || 0) * 100)} %`
    : 'Kein QA-Sidecar — auf Rebuild tippen';
  btn.innerHTML = `<span class="mmc-qa-dot"></span><span>${lbl}</span>`;
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    _openModal(card, qa);
  });
  wrap.appendChild(btn);
}

function _paintIntoCard(card){
  const item = _itemFor(card);
  if (!item){ _renderPill(card, null); return; }
  const rel = _relpathOf(item);
  if (!rel){ _renderPill(card, null); return; }
  _fetchQA(rel).then(qa => _renderPill(card, qa));
}

// IntersectionObserver — lazy-paint pills only on cards that
// actually scroll into view. Avoids N parallel fetches when the
// user lands on a multi-page grid.
let _io = null;
function _ensureObserver(){
  if (_io) return _io;
  if (typeof IntersectionObserver === 'undefined'){
    return null;  // ancient browser — skip lazy and paint eagerly below
  }
  _io = new IntersectionObserver((entries) => {
    for (const e of entries){
      if (e.isIntersecting){
        _paintIntoCard(e.target);
        _io.unobserve(e.target);
      }
    }
  }, { rootMargin: '120px' });
  return _io;
}

// Public — call from the grid renderer after innerHTML rebuilds.
export function paintQAPillsForGrid(){
  const cards = document.querySelectorAll(
    '.mmc-tl[data-event-id]:not([data-qa-painted])');
  const obs = _ensureObserver();
  if (obs){
    cards.forEach(c => obs.observe(c));
  } else {
    cards.forEach(c => _paintIntoCard(c));
  }
}

window.paintQAPillsForGrid = paintQAPillsForGrid;

// ── Modal panel ────────────────────────────────────────────────────────────
function _markdownReport(qa, item){
  if (!qa) return `# Timelapse QA · ${item?.filename || ''}\nKein Sidecar vorhanden.`;
  const pb = qa.playback || {};
  const cap = qa.capture || {};
  const reasons = cap.reject_reasons || {};
  const top3 = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const freezes = qa.freezes || [];
  const freezeTotal = freezes.reduce((acc, f) => acc + (f.duration_s || 0), 0);
  const lines = [];
  lines.push(`# Timelapse QA · ${qa.video || item?.filename || ''}`);
  lines.push(`- camera: \`${qa.camera_id || item?.camera_id || ''}\``);
  lines.push(`- profile: ${qa.profile_name || '?'} · validator: ${qa.validator_profile_used || '?'}`);
  lines.push(`- grade: **${qa.quality_grade || '?'}**`);
  lines.push(`- declared ${pb.declared_fps || 0} fps · effective ${pb.effective_fps || 0} fps · unique ${pb.unique_fps || 0} fps`);
  lines.push(`- dup_ratio ${Math.round((pb.duplicate_ratio || 0) * 100)} % (${pb.duplicate_count || 0} of ${pb.frames_in_file || 0})`);
  lines.push(`- freezes: ${freezes.length} (total ${freezeTotal.toFixed(2)} s)`);
  if (top3.length){
    lines.push('- top reject reasons:');
    for (const [k, v] of top3) lines.push(`  - ${k}: ${v}`);
  }
  return lines.join('\n');
}

function _openModal(card, qa){
  const item = _itemFor(card);
  // Always re-fetch on open in case the cached pill data is stale
  // (the post-build sidecar may have been re-generated by a rebuild
  // the user just kicked).
  const rel = item ? _relpathOf(item) : null;
  const loader = rel ? _fetchQA(rel) : Promise.resolve(qa || null);
  loader.then(fresh => {
    const data = fresh || qa;
    _renderModal(item, data);
  });
}

function _renderModal(item, qa){
  let modal = byId('tlQAModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'tlQAModal';
  modal.className = 'tl-qa-modal';
  const pb = qa?.playback || {};
  const cap = qa?.capture || {};
  const reasons = cap.reject_reasons || {};
  const top3 = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const freezes = qa?.freezes || [];
  const duration = pb.duration_s || 1;
  const freezeTicks = freezes.map(f => {
    const startPct = ((f.playback_s?.[0] || 0) / duration) * 100;
    const widthPct = ((f.duration_s || 0) / duration) * 100;
    return `<span class="tl-qa-tick" style="left:${startPct.toFixed(2)}%;width:${Math.max(0.5, widthPct).toFixed(2)}%" title="${(f.duration_s || 0).toFixed(2)} s freeze"></span>`;
  }).join('');
  const grade = qa?.quality_grade || 'na';
  const gradeMeta = _GRADE_CLASSES[grade] || { cls: 'mmc-qa-pill--na', label: 'n/a' };
  const rebuildBtn = !qa
    ? `<button type="button" class="tl-qa-btn tl-qa-rebuild">Rebuild starten</button>`
    : '';
  modal.innerHTML = `
    <div class="tl-qa-backdrop"></div>
    <div class="tl-qa-shell" role="dialog" aria-labelledby="tlQATitle">
      <button type="button" class="tl-qa-close" aria-label="Schließen">✕</button>
      <div class="tl-qa-head">
        <span class="mmc-qa-pill ${gradeMeta.cls}" aria-hidden="true">
          <span class="mmc-qa-dot"></span><span>${gradeMeta.label}</span>
        </span>
        <span id="tlQATitle" class="tl-qa-filename">${esc(qa?.video || item?.filename || 'unbekannt')}</span>
      </div>
      ${qa ? `
        <div class="tl-qa-stats">
          <div class="tl-qa-stat"><span class="tl-qa-stat-num">${pb.declared_fps || 0}</span><span class="tl-qa-stat-lbl">declared fps</span></div>
          <div class="tl-qa-stat"><span class="tl-qa-stat-num">${pb.effective_fps || 0}</span><span class="tl-qa-stat-lbl">effective fps</span></div>
          <div class="tl-qa-stat"><span class="tl-qa-stat-num">${pb.unique_fps || 0}</span><span class="tl-qa-stat-lbl">unique fps</span></div>
        </div>
        <div class="tl-qa-dup">duplicate ratio · <strong>${Math.round((pb.duplicate_ratio || 0) * 100)} %</strong> (${pb.duplicate_count || 0} of ${pb.frames_in_file || 0})</div>
        ${top3.length ? `
        <div class="tl-qa-section-title">Top reject reasons</div>
        <ul class="tl-qa-reasons">
          ${top3.map(([k, v]) => `<li><span>${esc(k)}</span><span class="tl-qa-reason-n">${v}</span></li>`).join('')}
        </ul>` : ''}
        ${freezes.length ? `
        <div class="tl-qa-section-title">Freezes (${freezes.length})</div>
        <div class="tl-qa-freeze-bar" title="${freezes.length} freeze cluster(s)">${freezeTicks}</div>` : ''}
      ` : `<div class="tl-qa-empty">Kein QA-Sidecar — älterer Build vor der Quality-Pass-Einführung.</div>`}
      <div class="tl-qa-actions">
        ${rebuildBtn}
        <button type="button" class="tl-qa-btn tl-qa-copy">QA-Bericht kopieren</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.tl-qa-close').addEventListener('click', close);
  modal.querySelector('.tl-qa-backdrop').addEventListener('click', close);
  modal.querySelector('.tl-qa-copy').addEventListener('click', async () => {
    const md = _markdownReport(qa, item);
    try {
      await navigator.clipboard.writeText(md);
      showToast('QA-Bericht in der Zwischenablage', 'success');
    } catch {
      showToast('Kopieren fehlgeschlagen — manuell aus dem Modal lesen', 'error');
    }
  });
  const rb = modal.querySelector('.tl-qa-rebuild');
  if (rb){
    rb.addEventListener('click', async () => {
      const camId = item?.camera_id;
      const day = (item?.window_key || item?.day || '').substring(0, 10);
      if (!camId || !day){
        showToast('Rebuild nicht möglich — Camera / Day fehlt', 'error');
        return;
      }
      rb.disabled = true;
      try {
        await fetch(`/api/camera/${encodeURIComponent(camId)}/timelapse?day=${encodeURIComponent(day)}&force=1`);
        showToast('Rebuild läuft — Sidecar erscheint nach Encode', 'info');
      } catch {
        showToast('Rebuild-Request fehlgeschlagen', 'error');
      } finally {
        close();
      }
    });
  }
}

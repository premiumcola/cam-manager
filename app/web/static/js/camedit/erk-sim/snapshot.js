// ─── camedit/erk-sim/snapshot.js ───────────────────────────────────────────
// "Snapshot" sub-tab of the Erkennung simulation sheet. Posts to
// /api/cameras/<id>/test-detection, animates the icon while the request
// is in flight, then renders the snapshot + bounding boxes inline.
import { byId, esc } from '../../core/dom.js';
import { showToast } from '../../core/toast.js';
import { activateErkSimTab } from './index.js';

const _ERK_VERDICT_TXT = {
  'pass':         'würde Alarm auslösen',
  'belowthresh':  '',
  'filtered':     '',
};


export async function _onErkSimulateClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  if (!camId) return;
  const lblEl = btn.querySelector('.erk-test-btn-lbl');
  const originalLabel = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' simuliere…';
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/test-detection`, { method: 'POST' });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok || !data?.ok){
      const msg = (data && data.error) ? data.error : 'Fehler';
      showToast('Test fehlgeschlagen · ' + msg, 'error');
      return;
    }
    _renderErkSimResult(data);
  } catch {
    showToast('Test fehlgeschlagen · Netzwerk', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (lblEl) lblEl.textContent = originalLabel;
  }
}

export function _renderErkSimResult(data){
  const wrap = byId('erkSimResult');
  if (!wrap) return;
  // Always land on the Snapshot tab when the simulate button runs —
  // the Video tab is opt-in and remembers its own selection separately.
  activateErkSimTab('snapshot');
  const img  = byId('erkSimImg');
  const ovl  = byId('erkSimOverlay');
  const list = byId('erkSimList');
  const ttl  = byId('erkSimTitle');
  if (img) img.src = data.snapshot || '';
  // viewBox in absolute frame pixel coordinates so backend bbox values
  // (which are pixel-space) drop in unchanged. preserveAspectRatio in
  // the inline element default is xMidYMid meet — but since the wrapper
  // .erk-test-result-imgwrap forces a 16:9 aspect ratio and the <img>
  // uses object-fit:contain, the SVG and the image scale identically.
  const fs = data.frame_size || { w: 1920, h: 1080 };
  if (ovl) ovl.setAttribute('viewBox', `0 0 ${Math.max(1, fs.w)} ${Math.max(1, fs.h)}`);

  const dets = data.detections || [];
  const passCount = dets.filter(d => d.verdict === 'pass').length;
  if (ttl){
    ttl.textContent = passCount > 0
      ? `${passCount} Treffer würden Alarm auslösen`
      : (dets.length === 0 ? 'Keine Erkennung' : 'Kein Treffer würde Alarm auslösen');
  }
  // Boxes — paint-order=stroke on the label so the dark halo stays
  // readable above bright snapshot regions. font-size scales with the
  // viewBox; an absolute "10 px" on a 1920-wide viewBox shows up as
  // ~10 px in screen pixels regardless of how the wrapper scales.
  if (ovl){
    ovl.innerHTML = dets.map(d => {
      const cls = `erk-det-box is-${d.verdict}`;
      const labelText = `${d.label} ${Math.round(d.score * 100)}%`;
      const fontSize = Math.max(10, Math.round(fs.w / 100));
      const boxR = Math.max(2, Math.round(fs.w / 480));
      return `
        <rect class="${cls}" x="${d.bbox[0]}" y="${d.bbox[1]}" width="${d.bbox[2]}" height="${d.bbox[3]}" rx="${boxR}" vector-effect="non-scaling-stroke" />
        <text class="erk-det-label" x="${d.bbox[0] + 4}" y="${d.bbox[1] + fontSize + 2}" font-size="${fontSize}">${esc(labelText)}</text>
      `;
    }).join('');
  }
  if (list){
    if (dets.length === 0){
      list.innerHTML = `<div class="erk-det-empty">Coral hat in diesem Frame nichts erkannt.</div>`;
    } else {
      list.innerHTML = dets.map(d => {
        const verdictText = d.reason || _ERK_VERDICT_TXT[d.verdict] || '';
        return `
          <div class="erk-det-row is-${esc(d.verdict)}">
            <span class="det-dot"></span>
            <span class="det-name">${esc(d.label)}</span>
            <span class="det-score">${Math.round(d.score * 100)}%</span>
            <span class="det-verdict">${esc(verdictText)}</span>
          </div>`;
      }).join('');
    }
  }
  wrap.hidden = false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  wrap.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
}

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

// Module-scoped abort controller. A second click while the first
// request is in flight aborts the prior fetch and starts fresh.
// Without this, the first response could arrive after the second
// and overwrite the panel with a stale snapshot, OR the loading
// state never clears because both promises resolve out of order
// (the previous symptom: "panel hangs on rapid re-clicks").
let _erkSimAbort = null;


export async function _onErkSimulateClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  if (!camId) return;
  const lblEl = btn.querySelector('.erk-test-btn-lbl');
  const originalLabel = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' simuliere…';
  // Supersede any in-flight request — the controller below is the
  // ONLY one we care about for the rest of this handler. Stale
  // resolutions (AbortError) are swallowed silently.
  if (_erkSimAbort){
    try { _erkSimAbort.abort(); } catch { /* ignore */ }
  }
  _erkSimAbort = new AbortController();
  const controller = _erkSimAbort;
  try {
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(camId)}/test-detection`,
      { method: 'POST', signal: controller.signal },
    );
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok || !data?.ok){
      const msg = (data && data.error) ? data.error : 'Fehler';
      showToast('Test fehlgeschlagen · ' + msg, 'error');
      return;
    }
    _renderErkSimResult(data);
  } catch (e) {
    // AbortError = a newer click superseded this request. Stay
    // silent; the newer click owns the UI feedback now.
    if (e?.name === 'AbortError') return;
    showToast('Test fehlgeschlagen · Netzwerk', 'error');
  } finally {
    // Only reset the loading state if THIS request is still the
    // current one — otherwise we'd flip the button enabled while
    // the newer request is still running.
    if (_erkSimAbort === controller){
      _erkSimAbort = null;
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (lblEl) lblEl.textContent = originalLabel;
    }
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
  // Decision-trace log — green-on-black terminal block walking every
  // gate from capture → final push verdict. Rendered only when the
  // backend included the array (older responses are forward-compatible).
  const logWrap = byId('erkSimLog');
  const logBody = byId('erkSimLogBody');
  if (logWrap && logBody && Array.isArray(data.decision_trace)){
    const ts = new Date().toLocaleTimeString('de-DE');
    const passCount = (data.detections || []).filter(d => d.verdict === 'pass').length;
    const header = `[${ts}] simulate → ${(data.detections || []).length} dets, ${passCount} pass`;
    logBody.textContent = header + '\n' + data.decision_trace.join('\n');
    logWrap.hidden = false;
  }
  wrap.hidden = false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  wrap.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
}

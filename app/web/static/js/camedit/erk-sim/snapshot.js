// ─── camedit/erk-sim/snapshot.js ───────────────────────────────────────────
// Render-only helper for the Erkennung simulation sheet. Paints a
// single inference response into the result panel: snapshot image,
// SVG bounding boxes, frame-age caption, detection list, decision-
// trace log. Called per-tick by live.js; the polling lifecycle and
// the IoU tracker live there.
import { byId, esc } from '../../core/dom.js';
import { renderTrace } from './trace.js';

const _ERK_VERDICT_TXT = {
  'pass':         'würde Alarm auslösen',
  'belowthresh':  '',
  'filtered':     '',
};

// Distinct, honest messages per backend-error code. The 503 path from
// /api/cameras/<id>/test-detection sets `code` to exactly one of these
// keys; everything else falls back to the camera-side default.
const _ERK_ERR_MSG = {
  'stale':    'Stream-Puffer hinkt zurück · warte auf frischen Frame',
  'corrupt':  'Stream liefert korrupte Frames · warte auf sauberes Bild',
  'no_frame': 'Kamera liefert noch keine Frames',
};

// Render the error banner in place of the snapshot. Hides the IMG,
// clears the bbox overlay, hides the freshness label (it's meaningless
// without a frame), shows a distinct banner with an honest message.
// Called by live.js when the backend returns 503 with a structured
// error code; the polling loop keeps running so the banner replaces
// itself with a real frame as soon as the stream recovers.
export function _renderErkSimError(data){
  const wrap = byId('erkSimResult');
  if (!wrap) return;
  const img    = byId('erkSimImg');
  const ovl    = byId('erkSimOverlay');
  const banner = byId('erkSimError');
  const msg    = byId('erkSimErrorMsg');
  const ageEl  = byId('erkSimFrameAge');
  const wrapImg = wrap.querySelector('.erk-test-result-imgwrap');
  // Hide the (potentially stale) previous frame + any previously
  // painted boxes — explicit "no picture" rather than a misleading
  // last-good still.
  if (img) img.removeAttribute('src');
  if (ovl) ovl.innerHTML = '';
  // Suppress the freshness label — "vor X.X s" is meaningless when
  // we never got a usable frame. Drop both stale modifiers too so a
  // recovered tick starts from a clean slate.
  if (ageEl){
    ageEl.textContent = '';
    ageEl.hidden = true;
    ageEl.classList.remove('is-stale', 'is-very-stale');
  }
  if (wrapImg) wrapImg.classList.remove('is-stuck');
  if (banner && msg){
    const code = String(data?.code || '');
    msg.textContent = _ERK_ERR_MSG[code] || data?.error || 'Stream-Problem · warte auf frischen Frame';
    banner.hidden = false;
  }
  wrap.hidden = false;
  wrap.dataset.everShown = '1';
}

// Hide the error banner when a subsequent tick succeeds. Idempotent.
function _hideErkSimError(){
  const banner = byId('erkSimError');
  if (banner) banner.hidden = true;
}

export function _renderErkSimResult(data){
  const wrap = byId('erkSimResult');
  if (!wrap) return;
  const img  = byId('erkSimImg');
  const ovl  = byId('erkSimOverlay');
  const list = byId('erkSimList');
  const ttl  = byId('erkSimTitle');
  // A success render always clears any error banner left by a prior
  // tick — otherwise the banner would stick around on top of a fresh
  // good frame.
  _hideErkSimError();
  if (img) img.src = data.snapshot || '';
  // Frame-age caption — backend reports the age of the cached frame
  // it ran inference against. Stays muted for fresh frames; flips to
  // an "is-stale" warning between 2-5 s and an "is-very-stale" hard-
  // warning above 5 s, when we also paint a faint amber ring on the
  // imgwrap to make the "stream stuck" failure mode unmistakable
  // (distinct from the silent "kein Coral" path which renders empty
  // detections without a freshness signal). The element starts
  // ``hidden`` and is shown only when the backend includes the
  // field, so older responses are forward-compatible.
  const ageEl = byId('erkSimFrameAge');
  const wrapImg = wrap.querySelector('.erk-test-result-imgwrap');
  if (ageEl){
    const ageMs = parseInt(data.frame_age_ms, 10);
    if (Number.isFinite(ageMs)){
      const ageS = ageMs / 1000;
      const stale = ageMs > 2000;
      const veryStale = ageMs > 5000;
      let txt = `Letzter Frame · vor ${ageS.toFixed(1)} s`;
      if (veryStale) txt += ' · Stream steckt fest';
      else if (stale) txt += ' · Stream hängt evtl.';
      // Honest backlog signal — runtime sees frames arriving much
      // faster than the camera's configured cadence, which means we
      // *received* it 0.2 s ago but it was *shot* much earlier. The
      // bug image 5 in the user's report: clock showed 19:38:33,
      // panel said "vor 0.2 s". Reuse the existing is-stale colour
      // ramp via the same modifier so we don't add new CSS.
      if (data.decoder_backlog_suspected){
        txt += ' · ⚠ Decoder-Backlog';
      }
      ageEl.textContent = txt;
      ageEl.classList.toggle('is-stale',
        (stale && !veryStale) || (!stale && !veryStale && !!data.decoder_backlog_suspected));
      ageEl.classList.toggle('is-very-stale', veryStale);
      ageEl.hidden = false;
      if (wrapImg) wrapImg.classList.toggle('is-stuck', veryStale);
    } else {
      ageEl.textContent = '';
      ageEl.hidden = true;
      if (wrapImg) wrapImg.classList.remove('is-stuck');
    }
  }
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
  // Reset the SVG overlay to layer skeletons. Each layer renders its
  // own content into the matching <g class="erk-layer ..."> so the
  // pill bar can hide an entire layer with a single attribute flip
  // (visibility="hidden") without re-running inference. Order in the
  // DOM = paint order: zones/masks at the back, trails next, bboxes
  // in front — matches the Mediathek lightbox layering.
  if (ovl){
    ovl.innerHTML = `
      <g class="erk-layer erk-zonemask-layer" data-layer="zones"></g>
      <g class="erk-layer erk-trails-layer" data-layer="trails"></g>
      <g class="erk-layer erk-bboxes-layer" data-layer="bboxes"></g>`;
  }
  // Bboxes paint into the dedicated layer group. paint-order=stroke
  // on the label so the dark halo stays readable above bright
  // snapshot regions. font-size scales with the viewBox; an absolute
  // "10 px" on a 1920-wide viewBox shows up as ~10 px in screen
  // pixels regardless of how the wrapper scales.
  const boxLayer = ovl?.querySelector('.erk-bboxes-layer');
  if (boxLayer){
    boxLayer.innerHTML = dets.map(d => {
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
  // Decision-trace block — collapsible terminal log + active-config
  // chips + size-floor hint. trace.js owns all of that; we just hand
  // it the response payload + the camera id for localStorage scoping.
  const camId = byId('cameraForm')?.elements?.['id']?.value || '';
  renderTrace(data, camId);
  // First-render-only scroll-keep: only the very first tick of a
  // live run runs this. live.js sets wrap.dataset.everShown after
  // the first successful _renderErkSimResult; subsequent ticks see
  // the flag already set and skip the scroll, so the user can scroll
  // through the trace without being yanked back every second.
  const firstShow = wrap.hidden || wrap.dataset.everShown !== '1';
  wrap.hidden = false;
  if (firstShow){
    const btn = byId('erkSimulateBtn');
    if (btn){
      const rect = btn.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const inView = rect.top >= 0 && rect.bottom <= vh;
      if (!inView){
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        btn.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
      }
    }
  }
}

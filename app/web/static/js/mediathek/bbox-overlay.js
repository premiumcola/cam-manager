// ─── mediathek/bbox-overlay.js ─────────────────────────────────────────────
// Stage 21 / Phase 2 of the tracking pipeline — draws bounding boxes
// over the active lightbox media. Two render paths share one canvas:
//
//   1. tracks.json (Phase 1 sidecar): per-frame interpolated boxes
//      driven by videoEl.currentTime, plus a snapshot fallback that
//      uses each track's FIRST sample (the trigger view).
//   2. Legacy single-bbox: lbState.item.detections[].bbox renders once.
//      Kept as the fallback for events without a tracks.json sidecar
//      (404 on fetch, schema mismatch, or tracker not installed).
//
// The MP4 is NEVER modified; this is a Canvas overlay, like subtitles.
// Track colours come from the deterministic tracks.json palette so
// multiple persons in one clip get distinguishable strokes.
import { byId } from '../core/dom.js';
import { colors, OBJ_LABEL } from '../core/icons.js';
import { _lbClearDetections } from '../lightbox.js';
import { lbState } from './state.js';
import { showToast } from '../core/toast.js';

// In-flight & cache state for tracks.json fetches. Keyed by event_id
// so re-opens don't re-fetch unless the user explicitly re-indexes.
const _tracksCache = new Map();    // event_id → payload | null (404)
const _tracksInflight = new Map(); // event_id → Promise
let _rafHandle = 0;
let _chipFadeTimer = 0;

// ── Fetching ──────────────────────────────────────────────────────────────

function _tracksUrlFor(item){
  const rel = item?.video_relpath;
  if (!rel) return null;
  // The mp4 lives at <storage>/motion_detection/<cam>/<date>/<id>.mp4
  // and the sidecar sits next to it as <id>.tracks.json. Same /media/
  // route serves both.
  if (rel.endsWith('.mp4')) return `/media/${rel.slice(0, -4)}.tracks.json`;
  return null;
}

async function _fetchTracks(item){
  const eid = item?.event_id;
  const url = _tracksUrlFor(item);
  if (!eid || !url) return null;
  if (_tracksCache.has(eid)) return _tracksCache.get(eid);
  if (_tracksInflight.has(eid)) return _tracksInflight.get(eid);
  const p = (async () => {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok){
        // 404 = "no tracking data" — cache the negative so we don't
        // hammer the server on every RAF / reseek tick.
        _tracksCache.set(eid, null);
        return null;
      }
      const data = await r.json();
      // Sort each track's samples by frame so the binary-style search
      // in _interpolateAt can step in O(log n) without per-tick work.
      for (const tr of (data.tracks || [])){
        (tr.samples || []).sort((a, b) => a.f - b.f);
      }
      _tracksCache.set(eid, data);
      return data;
    } catch {
      _tracksCache.set(eid, null);
      return null;
    } finally {
      _tracksInflight.delete(eid);
    }
  })();
  _tracksInflight.set(eid, p);
  return p;
}

// Reset the cached payload for an event so the next render fetches a
// fresh tracks.json (fired after a successful re-index POST).
export function lbInvalidateTracks(eventId){
  if (eventId) _tracksCache.delete(eventId);
}

// Public entry: load tracks for the just-opened item and prime the
// chip. Called from openLightbox after the video src is set; the RAF
// loop kicks off via the play/loadedmetadata listeners.
export async function lbLoadTracksForItem(item){
  if (!item) return;
  const tracks = await _fetchTracks(item);
  // Stash on the item for downstream readers, but the source of truth
  // is the module-level cache (so a re-open hits the cache).
  item._tracks = tracks;
  // The user may have navigated to the next/prev item while the fetch
  // was in flight. Only mutate UI when the item we fetched for is
  // still the active lightbox item — otherwise we'd flash A's chip /
  // boxes over B.
  if (lbState.item !== item) return;
  _renderTrackingChip(tracks);
  _lbDrawDetections();
}

// ── Drawing ───────────────────────────────────────────────────────────────

// Linear-interp the bbox of a single track at video time `t` (seconds).
// Returns { bbox: {x1,y1,x2,y2}, score, label } or null if t is
// outside the track's lifespan.
function _interpolateTrackAt(track, t){
  const samples = track.samples || [];
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t < first.t - 0.05) return null;        // before the track started
  if (t > last.t + 0.05) return null;         // after the track ended
  // Find the two samples that bracket t. Linear scan is fine — track
  // sample lists are typically <50 entries (sparse 1 Hz sampling +
  // skip-equal-bbox in the worker). For very long clips the binary
  // search would still be cheap, but isn't worth the complexity here.
  let prev = first, next = last;
  for (let i = 0; i < samples.length; i++){
    if (samples[i].t <= t) prev = samples[i];
    if (samples[i].t >= t){ next = samples[i]; break; }
  }
  if (prev === next || next.t === prev.t){
    return { bbox: prev.bbox, score: prev.score, label: track.label };
  }
  const a = (t - prev.t) / (next.t - prev.t);
  const lerp = (k) => prev.bbox[k] + (next.bbox[k] - prev.bbox[k]) * a;
  return {
    bbox: { x1: lerp('x1'), y1: lerp('y1'), x2: lerp('x2'), y2: lerp('y2') },
    // Score is the score of the closest "detect" sample, not the
    // interpolated one. Pick whichever neighbour was a detect; fall
    // back to the track's overall best.
    score: (prev.source === 'detect' ? prev.score
           : next.source === 'detect' ? next.score
           : track.best_score) ?? 0,
    label: track.label,
  };
}

// Snapshot mode: each track's FIRST sample, regardless of source. That
// matches the trigger-frame view the user expects when looking at the
// still preview.
function _firstSampleOfTrack(track){
  const s = (track.samples || [])[0];
  if (!s) return null;
  return {
    bbox: s.bbox,
    score: s.source === 'detect' ? s.score : (track.best_score ?? 0),
    label: track.label,
  };
}

export function _lbDrawDetections(){
  const cv = byId('lightboxDetections');
  if (!cv || !lbState.item) return;
  const ctx = cv.getContext('2d');
  const videoEl = byId('lightboxVideo');
  const imgEl = byId('lightboxImg');
  const usingVideo = videoEl && videoEl.style.display !== 'none' && videoEl.videoWidth > 0;
  const usingImage = imgEl && imgEl.style.display !== 'none' && imgEl.naturalWidth > 0;
  const media = usingVideo ? videoEl : (usingImage ? imgEl : null);
  if (!media){ _lbClearDetections(); return; }
  const natW = usingVideo ? videoEl.videoWidth : imgEl.naturalWidth;
  const natH = usingVideo ? videoEl.videoHeight : imgEl.naturalHeight;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const mediaRect = media.getBoundingClientRect();
  // Size the canvas to cover the wrap; use DPR for crisp strokes.
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = wrapRect.width + 'px';
  cv.style.height = wrapRect.height + 'px';
  cv.width  = Math.round(wrapRect.width * dpr);
  cv.height = Math.round(wrapRect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapRect.width, wrapRect.height);

  // object-fit:contain inside the media element
  const scale = Math.min(mediaRect.width / natW, mediaRect.height / natH);
  const renderedW = natW * scale, renderedH = natH * scale;
  const offX = (mediaRect.width - renderedW) / 2 + (mediaRect.left - wrapRect.left);
  const offY = (mediaRect.height - renderedH) / 2 + (mediaRect.top - wrapRect.top);

  // Pick the render path. Track-driven overlay (Phase 2) when the
  // sidecar exists with at least one track; fall back to the
  // single-bbox legacy path otherwise.
  const tracks = lbState.item._tracks;
  const haveTracks = tracks && Array.isArray(tracks.tracks) && tracks.tracks.length > 0;

  ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  ctx.textBaseline = 'top';

  if (haveTracks){
    const t = usingVideo ? (videoEl.currentTime || 0) : null;
    for (const tr of tracks.tracks){
      const sample = (t == null)
        ? _firstSampleOfTrack(tr)
        : _interpolateTrackAt(tr, t);
      if (!sample) continue;
      _drawTrackBox(ctx, sample, tr.color, offX, offY, scale);
    }
    return;
  }

  // Legacy single-bbox fallback — same as the pre-tracking overlay.
  // The bbox is the trigger-frame detection; without per-frame tracks
  // it would visually lie about where the subject is during playback.
  // Hide it while the video is actually playing — the user's "bbox
  // stays put while the subject moves out of it" complaint. Pause /
  // ended / still-image modes paint the box back at trigger position
  // and tag it with a small "Detection bei Auslösung" pill so the
  // semantics are obvious.
  const isPlaying = usingVideo && !videoEl.paused && !videoEl.ended
                    && (videoEl.currentTime || 0) > 0.05;
  if (isPlaying) return;

  const dets = (lbState.item.detections || []).filter(d => d && d.bbox && typeof d.bbox.x1 === 'number');
  if (!dets.length) return;
  for (const d of dets){
    const c = colors[d.label] || colors.unknown;
    _drawTrackBox(ctx, { bbox: d.bbox, score: d.score, label: d.label },
                  c, offX, offY, scale);
  }
  // Tiny "Detection bei Auslösung" annotation above the topmost bbox
  // so the still-image / paused-video viewer understands the box is a
  // freeze of the trigger moment, not a real-time tracker.
  const top = dets.reduce((min, d) =>
    (d.bbox.y1 < min.bbox.y1 ? d : min), dets[0]);
  const bx1 = offX + top.bbox.x1 * scale;
  const by1 = offY + top.bbox.y1 * scale;
  const tagText = 'Detection bei Auslösung';
  ctx.font = '500 10px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const tagW = ctx.measureText(tagText).width;
  const padX = 6, tagH = 16;
  // Sit ABOVE the regular label pill (which renders at y1 - 20).
  const tagY = Math.max(0, by1 - 20 - tagH - 2);
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(bx1, tagY, tagW + padX * 2, tagH);
  ctx.fillStyle = colors[top.label] || colors.unknown;
  ctx.fillText(tagText, bx1 + padX, tagY + 2);
}

function _drawTrackBox(ctx, sample, color, offX, offY, scale){
  const b = sample.bbox;
  const x1 = offX + b.x1 * scale, y1 = offY + b.y1 * scale;
  const x2 = offX + b.x2 * scale, y2 = offY + b.y2 * scale;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return;
  const c = color || '#22c55e';
  // No shadowBlur on the per-frame path: 5+ shadows × 60 fps melts
  // budget on iPhones. The flat 2 px stroke + label pill still reads
  // clearly against any background.
  ctx.strokeStyle = c;
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, w, h);
  const lblName = OBJ_LABEL[sample.label] || sample.label || '';
  if (!lblName) return;
  const pct = sample.score != null ? Math.round(sample.score * 100) : null;
  const text = pct != null ? `${lblName} · ${pct}%` : lblName;
  const padX = 6, pillH = 18;
  const tw = ctx.measureText(text).width;
  const pillY = Math.max(0, y1 - pillH - 2);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(x1, pillY, tw + padX * 2, pillH);
  ctx.fillStyle = c;
  ctx.fillText(text, x1 + padX, pillY + 3);
}

// ── Playback RAF loop ────────────────────────────────────────────────────
// Only runs while a video is playing AND tracks.json is loaded. Pause /
// ended / lightbox close all stop the loop; on pause we leave the
// boxes painted at the current paused time. Seek triggers the next
// RAF tick to repaint at the new currentTime — no extra wiring needed.

function _stopRafLoop(){
  if (_rafHandle){
    cancelAnimationFrame(_rafHandle);
    _rafHandle = 0;
  }
}

function _startRafLoop(){
  _stopRafLoop();
  const tick = () => {
    _rafHandle = 0;
    if (!lbState.item || !lbState.item._tracks) return;
    const v = byId('lightboxVideo');
    if (!v || v.paused || v.ended) return;
    if (byId('lightboxModal')?.classList.contains('hidden')) return;
    _lbDrawDetections();
    _rafHandle = requestAnimationFrame(tick);
  };
  _rafHandle = requestAnimationFrame(tick);
}

// ── Tracking chip + reindex button ───────────────────────────────────────
// Bottom-left of the lightbox. Reads "Tracking · N Subjekte" plus a
// monochrome ↺ button. Fades out 3 s after the video starts playing
// so it doesn't sit on top of the content for the whole clip.

function _ensureChip(){
  let chip = byId('lbTrackingChip');
  if (chip) return chip;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  chip = document.createElement('div');
  chip.id = 'lbTrackingChip';
  chip.style.cssText = 'position:absolute;left:14px;bottom:14px;display:none;align-items:center;gap:6px;padding:5px 8px 5px 10px;border-radius:999px;background:rgba(0,0,0,.55);color:#e2e8f0;font-size:11px;font-weight:600;letter-spacing:.02em;backdrop-filter:blur(6px);z-index:5;opacity:0;transition:opacity .25s ease;pointer-events:auto';
  chip.innerHTML = `
    <span class="lbtc-text">Tracking</span>
    <button type="button" class="lbtc-reindex" title="Tracking neu generieren" style="background:none;border:none;color:rgba(226,232,240,.85);cursor:pointer;padding:2px 4px;border-radius:6px;display:inline-flex;align-items:center" aria-label="Tracking neu generieren">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
        <polyline points="12,2 12,5.5 8.5,5.5"/>
        <polyline points="4,14 4,10.5 7.5,10.5"/>
      </svg>
    </button>`;
  wrap.appendChild(chip);
  chip.querySelector('.lbtc-reindex').addEventListener('click', _onReindexClick);
  return chip;
}

function _renderTrackingChip(tracks){
  const chip = _ensureChip();
  if (!chip) return;
  const n = (tracks && Array.isArray(tracks.tracks)) ? tracks.tracks.length : 0;
  if (!tracks || n === 0){
    chip.style.display = 'none';
    chip.style.opacity = '0';
    return;
  }
  const txt = chip.querySelector('.lbtc-text');
  if (txt) txt.textContent = `Tracking · ${n} Subjekt${n === 1 ? '' : 'e'}`;
  chip.style.display = 'flex';
  // Force reflow so the next opacity transition runs.
  void chip.offsetWidth;
  chip.style.opacity = '1';
  clearTimeout(_chipFadeTimer);
  _chipFadeTimer = setTimeout(() => {
    chip.style.opacity = '0';
  }, 3000);
}

async function _onReindexClick(ev){
  ev.stopPropagation();
  const item = lbState.item;
  if (!item || !item.event_id) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.style.opacity = '.5';
  try {
    const r = await fetch(
      `/api/tracking/reindex/${encodeURIComponent(item.event_id)}` +
      `?camera_id=${encodeURIComponent(item.camera_id || '')}`,
      { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok){
      showToast('Tracking-Re-Index fehlgeschlagen: ' + (d.error || r.statusText), 'error');
      return;
    }
    showToast('Tracking neu generiert', 'success');
    // Drop the cache so the next play / open re-fetches the fresh
    // sidecar. The worker takes a few seconds — we don't await it.
    lbInvalidateTracks(item.event_id);
    delete item._tracks;
    setTimeout(() => lbLoadTracksForItem(item), 4000);
  } catch (e){
    showToast('Tracking-Re-Index fehlgeschlagen: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

// Stop the loop and hide the chip — called from closeLightbox via the
// window bridge so legacy.js doesn't have to know about RAF state.
export function lbStopTrackingPlayback(){
  _stopRafLoop();
  clearTimeout(_chipFadeTimer);
  const chip = byId('lbTrackingChip');
  if (chip){
    chip.style.opacity = '0';
    chip.style.display = 'none';
  }
}
window.lbStopTrackingPlayback = lbStopTrackingPlayback;

// ── Self-bound listeners ─────────────────────────────────────────────────
// IIFE wires three repaint triggers + the RAF loop. All null-guarded
// so the module is safe to import on pages without the lightbox shell.
(function _initLbDetectionsHooks(){
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (imgEl) imgEl.addEventListener('load', () => _lbDrawDetections());
  if (videoEl){
    videoEl.addEventListener('loadedmetadata', () => _lbDrawDetections());
    // play / playing both kick the RAF loop AND call _lbDrawDetections
    // once. The draw call clears the canvas (synchronously); on the
    // legacy single-bbox path it then bails (isPlaying guard) so the
    // stale trigger-frame box doesn't sit there while the subject
    // moves through the clip. On the tracks path the RAF loop draws
    // interpolated boxes anyway, so the extra call is a harmless dup.
    videoEl.addEventListener('play',     () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('playing',  () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('pause',    () => { _stopRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('ended',    () => { _stopRafLoop(); _lbDrawDetections(); });
    // Seek → snap the overlay to the new time on the next RAF tick.
    videoEl.addEventListener('seeked',   () => _lbDrawDetections());
    videoEl.addEventListener('timeupdate', () => {
      // Pure safety net for RAF starvation (e.g. the tab is in the
      // background and the browser throttled the RAF loop). timeupdate
      // fires ~4 Hz natively, which is enough to keep the boxes
      // roughly in place when the loop isn't running.
      if (!_rafHandle) _lbDrawDetections();
    });
  }
  let _raf = 0;
  window.addEventListener('resize', () => {
    if (!byId('lightboxModal') || byId('lightboxModal').classList.contains('hidden')) return;
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(_lbDrawDetections);
  });
})();

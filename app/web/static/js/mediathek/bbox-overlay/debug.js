// ─── mediathek/bbox-overlay/debug.js ───────────────────────────────────────
// Debug logging plumbing — _logDiag is the single funnel every sibling
// module pipes diagnostic strings through. When ?lbdebug=1 is in the URL,
// the last 4 lines are mirrored into a corner overlay inside the
// lightbox media wrap.
import { byId } from '../../core/dom.js';
import { _DEBUG_BUFFER, _DEBUG_LB } from './_state.js';

export function _logDiag(line, level = 'info'){
  if (level === 'error') console.error('[mediathek:tracking]', line);
  else if (level === 'warn') console.warn('[mediathek:tracking]', line);
  if (_DEBUG_LB){
    _DEBUG_BUFFER.push(line);
    while (_DEBUG_BUFFER.length > 4) _DEBUG_BUFFER.shift();
    _renderDebugOverlay();
  }
}

function _ensureDebugOverlay(){
  if (!_DEBUG_LB) return null;
  let el = byId('lbDebugOverlay');
  if (el) return el;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  el = document.createElement('div');
  el.id = 'lbDebugOverlay';
  el.style.cssText = 'position:absolute;right:10px;bottom:10px;max-width:46%;'
    + 'padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.62);'
    + 'color:#a5f3fc;font:500 10px/1.35 ui-monospace,Menlo,Consolas,monospace;'
    + 'letter-spacing:.01em;backdrop-filter:blur(4px);pointer-events:none;'
    + 'z-index:6;white-space:pre-wrap;word-break:break-all';
  wrap.appendChild(el);
  return el;
}

function _renderDebugOverlay(){
  const el = _ensureDebugOverlay();
  if (!el) return;
  el.textContent = _DEBUG_BUFFER.join('\n');
}

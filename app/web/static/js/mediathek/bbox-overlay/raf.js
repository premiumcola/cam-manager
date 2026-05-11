// ─── mediathek/bbox-overlay/raf.js ─────────────────────────────────────────
// Playback RAF loop — keeps the canvas overlay, the confidence meter,
// and the --play-pct CSS variable in lockstep with videoEl.currentTime.
// The loop stops as soon as the video pauses / ends / the modal hides,
// so it's free during stills + paused playback.
import { byId } from '../../core/dom.js';
import { lbState } from '../state.js';
import { _state } from './_state.js';
import { _lbDrawDetections } from './renderer.js';
import { _renderConfidenceMeter } from './confidence-meter.js';
import { _updatePlayPct } from './time-axis.js';

export function _stopRafLoop(){
  if (_state.rafHandle){
    cancelAnimationFrame(_state.rafHandle);
    _state.rafHandle = 0;
  }
}

export function _startRafLoop(){
  _stopRafLoop();
  const tick = () => {
    _state.rafHandle = 0;
    const v = byId('lightboxVideo');
    if (!v || v.paused || v.ended) return;
    if (byId('lightboxModal')?.classList.contains('hidden')) return;
    // --play-pct write — single source of truth for scrubber thumb,
    // scrubber fill, and play cursor positions. Three CSS readers
    // pick up the new value on the next paint, in lockstep.
    _updatePlayPct();
    // Canvas + meter only need lbState.item._tracks for content;
    // they're cheap no-ops when tracks haven't loaded yet.
    if (lbState.item){
      _lbDrawDetections();
      _renderConfidenceMeter();
    }
    _state.rafHandle = requestAnimationFrame(tick);
  };
  _state.rafHandle = requestAnimationFrame(tick);
}

// ─── shape-editor/pointer.js ───────────────────────────────────────────────
// Mouse + touch + toolbar-button event handlers. Single IIFE that binds
// at module load — importing this module side-effects the canvas
// listeners + the maskSnapshot-load handler. State machine:
//
//   pointerdown → grab vertex (drag)  | record downPt (potential click)
//   pointermove → drag vertex         | hover-test for cursor
//   pointerup   → save mutated drag   | click closes / selects / adds
//
// Touch events route through the same handlers — canvasPoint() unwraps
// .touches[0] / .changedTouches[0] transparently.
import { byId } from '../core/dom.js';
import { shapeState } from '../core/state.js';
import { showToast, showConfirm } from '../core/toast.js';
import {
  _hitVertex, _hitMidpoint, _isClosingPoint, _findPolygonAt, _polyPoints,
  _SHAPE_HIT_PX, canvasPoint,
} from './geometry.js';
import { drawShapes } from './canvas.js';
import { saveShapesIntoForm, _nextPolyName } from './persistence.js';
import { _renderShapeList, _updateShapeDrawingBar } from './ui.js';
import { bindShapeModeToggle } from './mode-toggle.js';


function _commitInProgressPolygon(){
  if (shapeState.points.length < 3) return false;
  // pn834 — stamp the polygon with the canvas dimensions it was drawn
  // in. Frontend overlay renderer (zone-layer.js) prefers these over
  // videoEl.videoWidth/Height so a polygon drawn against a 640 × 360
  // substream snapshot maps correctly onto a 2560 × 1440 main-stream
  // recorded clip. Legacy polygons saved before this change have no
  // source_w/h and the renderer falls back to the media element's
  // native dimensions — re-edit a polygon to upgrade it.
  const canvas = byId('maskCanvas');
  const sourceW = (canvas && canvas.width)  || 1280;
  const sourceH = (canvas && canvas.height) || 720;
  const poly = {
    points: [...shapeState.points],
    label:  _nextPolyName(shapeState.mode),
    source_w: sourceW,
    source_h: sourceH,
  };
  if (shapeState.mode === 'zone') shapeState.zones.push(poly);
  else shapeState.masks.push(poly);
  shapeState.points = [];
  saveShapesIntoForm();
  drawShapes();
  _updateShapeDrawingBar();
  _renderShapeList();
  showToast(`${poly.label} gespeichert`, 'success');
  return true;
}


(function _initShapeEditor(){
  const canvas = byId('maskCanvas');
  if (!canvas) return;
  // Wire the zone/mask segmented toggle that lives above the canvas
  // in the Zonen tab. Idempotent — the binder guards with a dataset
  // flag so a re-init of this IIFE doesn't double-attach handlers.
  bindShapeModeToggle();

  // drag.mode = 'vertex' (legacy ptIdx-based vertex drag) or 'midpoint'
  // (segIdx-based bend-handle drag, added in C3). Vertices win over
  // midpoints when both could be hit (vertices render on top).
  let drag = null;
  let downPt = null;        // pointer at mousedown — distinguishes click vs drag

  const _drawingInProgress = () => Array.isArray(shapeState.points) && shapeState.points.length > 0;

  const onDown = (evt) => {
    if (!shapeState.camera) return;
    if (evt.cancelable) evt.preventDefault();
    const pt = canvasPoint(evt);
    const hit = _hitVertex(pt);
    if (hit){
      drag = { ...hit, mode: 'vertex' };
      downPt = pt;
      return;
    }
    // Midpoint handles only respond while the user isn't placing a new
    // polygon — during drawing, every click drops the next vertex.
    if (!_drawingInProgress()){
      const mid = _hitMidpoint(pt);
      if (mid){
        drag = { ...mid, mode: 'midpoint' };
        downPt = pt;
        return;
      }
    }
    // No vertex grabbed → record the down position so the corresponding
    // up-event knows whether the user actually clicked or just brushed
    // the canvas. New points are added on up (with no movement) so a
    // missed drag-attempt doesn't accidentally drop a stray vertex.
    downPt = pt;
    drag = null;
  };

  const onMove = (evt) => {
    if (!shapeState.camera) return;
    const pt = canvasPoint(evt);
    if (drag){
      if (evt.cancelable) evt.preventDefault();
      const arr = drag.kind === 'zone' ? shapeState.zones : shapeState.masks;
      const poly = arr[drag.polyIdx];
      if (drag.mode === 'midpoint'){
        const pts = _polyPoints(poly);
        if (!pts.length) return;
        if (!Array.isArray(poly.curves)){
          poly.curves = new Array(pts.length).fill(null);
        }
        poly.curves[drag.segIdx] = { x: Math.round(pt.x), y: Math.round(pt.y) };
        drawShapes();
        return;
      }
      const pts = _polyPoints(poly);
      if (!pts || !pts[drag.ptIdx]) return;
      pts[drag.ptIdx].x = Math.round(pt.x);
      pts[drag.ptIdx].y = Math.round(pt.y);
      drawShapes();
      return;
    }
    // Plain hover: track which vertex (if any) is under the cursor so
    // drawShapes can highlight it and the canvas cursor updates.
    // Vertex hover wins over midpoint hover — vertices render on top.
    const hover = _hitVertex(pt);
    const mid = !hover && !_drawingInProgress() ? _hitMidpoint(pt) : null;
    const closing = !hover && !mid && _isClosingPoint(pt);
    const sig = hover ? `${hover.kind}:${hover.polyIdx}:${hover.ptIdx}`
      : mid ? `m:${mid.kind}:${mid.polyIdx}:${mid.segIdx}`
      : (closing ? 'close' : '');
    if (sig !== shapeState.hoverSig){
      shapeState.hoverVertex = hover;
      shapeState.hoverClosing = closing;
      shapeState.hoverSig = sig;
      // Curved-segment midpoint cursor signals "drag to reshape" via
      // 'move'; straight-segment midpoint uses 'grab' to hint "drag to
      // bend". Vertex hover keeps 'move'.
      let cursor;
      if (hover){
        cursor = 'move';
      } else if (mid){
        const arr = mid.kind === 'zone' ? shapeState.zones : shapeState.masks;
        const poly = arr[mid.polyIdx];
        const isCurved = poly && Array.isArray(poly.curves) && poly.curves[mid.segIdx];
        cursor = isCurved ? 'move' : 'grab';
      } else {
        cursor = closing ? 'pointer' : 'crosshair';
      }
      canvas.style.cursor = cursor;
      drawShapes();
    }
  };

  const onUp = (evt) => {
    if (!shapeState.camera){ drag = null; downPt = null; return; }
    if (drag){
      saveShapesIntoForm();
      drag = null;
      downPt = null;
      return;
    }
    if (!downPt) return;
    const pt = canvasPoint(evt);
    // Treat as a click only when the pointer didn't move significantly.
    const dx = pt.x - downPt.x, dy = pt.y - downPt.y;
    downPt = null;
    if (dx * dx + dy * dy > 9) return;  // moved more than 3 px → ignore
    if (evt.cancelable) evt.preventDefault();
    if (_isClosingPoint(pt)){
      _commitInProgressPolygon();
      shapeState.hoverClosing = false;
      canvas.style.cursor = 'crosshair';
      return;
    }
    // While not drawing, a click on an existing polygon SELECTS it; a
    // click in empty canvas DESELECTS (if anything was selected). New
    // points are only added when nothing was selected and the click
    // missed every polygon — that preserves the legacy "click empty
    // area to draw" UX.
    if (shapeState.points.length === 0){
      const hit = _findPolygonAt(pt);
      if (hit){
        const key = `${hit.kind}:${hit.idx}`;
        shapeState.pulse = key;
        shapeState.expandedRows.add(key);
        drawShapes();
        _renderShapeList();
        const row = byId(`shapeRow_${hit.kind}_${hit.idx}`);
        if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }
      if (shapeState.pulse){
        shapeState.pulse = null;
        drawShapes();
        _renderShapeList();
        return;
      }
    }
    shapeState.points.push(pt);
    drawShapes();
    _updateShapeDrawingBar();
  };

  // C3 — dblclick on a curved segment's midpoint straightens it (clears
  // poly.curves[segIdx]). When the entire curves array is back to all-
  // null, the key is deleted from the polygon so settings.json diffs
  // for previously-straight legacy polygons stay clean.
  const onDblClick = (evt) => {
    if (!shapeState.camera) return;
    if (_drawingInProgress()) return;
    const pt = canvasPoint(evt);
    const hit = _hitMidpoint(pt);
    if (!hit) return;
    const arr = hit.kind === 'zone' ? shapeState.zones : shapeState.masks;
    const poly = arr[hit.polyIdx];
    if (!poly || !Array.isArray(poly.curves) || !poly.curves[hit.segIdx]) return;
    poly.curves[hit.segIdx] = null;
    if (poly.curves.every(c => c == null)) delete poly.curves;
    saveShapesIntoForm();
    drawShapes();
    if (evt.cancelable) evt.preventDefault();
  };

  // C5 — touch-only double-tap fallback. The `dblclick` event doesn't
  // fire on iOS Safari for tap sequences (it's emitted by mouse
  // double-clicks only), so we synthesise it: a second touchstart
  // within 350 ms and inside _SHAPE_HIT_PX of the last invokes the
  // same straightening branch the desktop dblclick uses. The 350 ms
  // matches the user-agent's own double-tap-zoom timeout so the gesture
  // feels native — and since touch-action:none disables that zoom, the
  // second tap is ours to claim.
  let _lastTapAt = 0;
  let _lastTapPt = null;
  const onTouchStart = (evt) => {
    const pt = canvasPoint(evt);
    const now = Date.now();
    if (_lastTapPt && (now - _lastTapAt) < 350){
      const dx = pt.x - _lastTapPt.x;
      const dy = pt.y - _lastTapPt.y;
      if (dx * dx + dy * dy < _SHAPE_HIT_PX * _SHAPE_HIT_PX){
        _lastTapAt = 0;
        _lastTapPt = null;
        onDblClick(evt);
        return;
      }
    }
    _lastTapAt = now;
    _lastTapPt = pt;
    onDown(evt);
  };

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup',   onUp);
  canvas.addEventListener('dblclick',  onDblClick);
  canvas.addEventListener('mouseleave', () => {
    drag = null;
    downPt = null;
    shapeState.hoverVertex = null;
    shapeState.hoverClosing = false;
    shapeState.hoverSig = '';
    canvas.style.cursor = 'crosshair';
    drawShapes();
  });
  canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  canvas.addEventListener('touchmove',  onMove, { passive: false });
  canvas.addEventListener('touchend',   onUp,   { passive: false });
  canvas.addEventListener('touchcancel', () => { drag = null; downPt = null; });

  byId('undoShapeBtn')?.addEventListener('click', () => {
    shapeState.points.pop();
    drawShapes();
    _updateShapeDrawingBar();
  });

  byId('saveShapeBtn')?.addEventListener('click', () => {
    if (shapeState.points.length < 3){
      showToast('Mindestens 3 Punkte.', 'warn');
      return;
    }
    _commitInProgressPolygon();
  });

  byId('clearShapesBtn')?.addEventListener('click', async () => {
    if (!await showConfirm('Alle Zonen und Masken löschen?')) return;
    shapeState.zones = [];
    shapeState.masks = [];
    shapeState.points = [];
    shapeState.pulse = null;
    saveShapesIntoForm();
    drawShapes();
    _updateShapeDrawingBar();
    _renderShapeList();
  });

  byId('maskSnapshot')?.addEventListener('load', () => {
    drawShapes();
    _renderShapeList();
    _updateShapeDrawingBar();
  });
})();

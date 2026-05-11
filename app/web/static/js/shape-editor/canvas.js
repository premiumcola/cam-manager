// ─── shape-editor/canvas.js ────────────────────────────────────────────────
// Canvas drawing primitives + the rAF-driven pulse loop for the closing-
// point ring while a polygon is in progress. Imports geometry helpers
// for vertex extraction; never imports from persistence (keeps the
// dependency graph one-way).
import { byId } from '../core/dom.js';
import { shapeState } from '../core/state.js';
import { _polyPoints, _polyLabels } from './geometry.js';

// Labels available for per-polygon scoping. Mirrors KNOWN_OBJECT_LABELS
// in schema.py — keep in sync if a new class joins the detector.
export const _SHAPE_LABEL_OPTS = [
  { k: 'person',   l: 'Person' },
  { k: 'cat',      l: 'Katze' },
  { k: 'bird',     l: 'Vogel' },
  { k: 'car',      l: 'Auto' },
  { k: 'dog',      l: 'Hund' },
  { k: 'squirrel', l: 'Eichhörnchen' },
];

export function getCanvasCtx(){ return byId('maskCanvas').getContext('2d'); }

// If the snapshot fails (camera offline, no recent frame, etc.) we
// still want a usable drawing surface — set the canvas to a fixed
// 1280×720 gray placeholder so clicks are mapped to a real coordinate
// space and the user can draw zones blind.
export function _maskCanvasFallback(){
  const canvas = byId('maskCanvas');
  if (!canvas) return;
  canvas.width = 1280;
  canvas.height = 720;
  canvas.style.width = '';
  canvas.style.height = '';
  const wrap = canvas.parentElement;
  if (wrap) wrap.style.aspectRatio = '1280/720';
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222222';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#64748b';
  ctx.font = '14px system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Snapshot nicht verfügbar — Zonen können trotzdem gezeichnet werden.', canvas.width / 2, canvas.height / 2);
  ctx.textAlign = 'left';
}

function scaleForCanvas(el, img){
  // Internal canvas resolution = source resolution. canvasPoint() rescales
  // pointer events from CSS pixels (rect.width/height) to canvas pixels
  // (canvas.width/height) so polygon coordinates stay stable across any
  // display size. CSS handles the *display* sizing via inset:0 + the wrap's
  // natural-aspect height — no inline style.width/height needed here.
  const naturalW = img.naturalWidth || el.width || 1280;
  const naturalH = img.naturalHeight || el.height || 720;
  el.width = naturalW;
  el.height = naturalH;
  el.style.width = '';
  el.style.height = '';
}

function drawPoly(ctx, poly, color, fillAlpha, emphasised, kind, idx){
  const pts = _polyPoints(poly);
  if (!pts.length) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = color.replace('1)', `${fillAlpha})`);
  ctx.strokeStyle = color;
  ctx.lineWidth = emphasised ? 5 : 3;
  ctx.fill();
  ctx.stroke();
  // Vertex handles — filled circles in the polygon colour with a white
  // border. The currently-hovered vertex gets a larger radius so the
  // user sees what they're about to grab. The DRAW position is clamped
  // to keep the full circle inside the canvas; the underlying coordinate
  // is left alone, so hit-testing still uses the real point.
  const hov = shapeState.hoverVertex;
  const isHov = (j) => hov && hov.kind === kind && hov.polyIdx === idx && hov.ptIdx === j;
  const cw = ctx.canvas.width, chh = ctx.canvas.height;
  for (let j = 0; j < pts.length; j++){
    const r = isHov(j) ? 13 : 10;
    const dx = Math.max(r, Math.min(cw - r, pts[j].x));
    const dy = Math.max(r, Math.min(chh - r, pts[j].y));
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (poly && poly.label){
    const minX = Math.min(...pts.map(p => p.x));
    const minY = Math.min(...pts.map(p => p.y));
    const labelY = Math.max(20, minY);
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(minX, labelY - 22, Math.max(70, poly.label.length * 9), 20);
    ctx.fillStyle = '#fff';
    ctx.font = '600 13px system-ui,sans-serif';
    ctx.fillText(poly.label, minX + 6, labelY - 7);
    // Second badge below: which labels this polygon scopes (or "Alle").
    const lbls = _polyLabels(poly);
    const txt = lbls.length ? lbls.map(L => {
      const o = _SHAPE_LABEL_OPTS.find(x => x.k === L);
      return o ? o.l : L;
    }).join(', ') : 'Alle Labels';
    ctx.font = '500 11px system-ui,sans-serif';
    const w = Math.max(60, ctx.measureText(txt).width + 12);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(minX, labelY, w, 18);
    ctx.fillStyle = lbls.length ? '#fbbf24' : 'rgba(255,255,255,.85)';
    ctx.fillText(txt, minX + 6, labelY + 13);
  }
}

export function drawShapes(){
  const img = byId('maskSnapshot'), canvas = byId('maskCanvas');
  if (!canvas) return;
  // Only re-scale to the snapshot when it actually loaded; if the
  // image is missing or broken we keep the placeholder dims set by
  // _maskCanvasFallback.
  const snapReady = img && img.src && img.complete && img.naturalWidth > 0;
  if (snapReady) scaleForCanvas(canvas, img);
  const ctx = getCanvasCtx();
  if (snapReady) ctx.clearRect(0, 0, canvas.width, canvas.height);
  // (when not ready, the gray placeholder already drawn by
  //  _maskCanvasFallback stays in the background)
  const pulseId = shapeState.pulse;
  (shapeState.zones || []).forEach((p, i) => drawPoly(ctx, p, 'rgba(75,163,255,1)', 0.17, pulseId === `zone:${i}`, 'zone', i));
  (shapeState.masks || []).forEach((p, i) => drawPoly(ctx, p, 'rgba(255,107,107,1)', 0.18, pulseId === `mask:${i}`, 'mask', i));
  if (shapeState.points.length){
    ctx.beginPath();
    ctx.moveTo(shapeState.points[0].x, shapeState.points[0].y);
    shapeState.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    // Preview-stroke colour matches the committed-polygon colour for
    // the active mode so the user sees the upcoming shape's identity
    // while drawing. Vertex handles + the closing-point pulse below
    // stay neutral white so they remain visible against both blue
    // and red strokes.
    const previewColor = shapeState.mode === 'mask'
      ? 'rgba(255,107,107,1)'
      : 'rgba(75,163,255,1)';
    ctx.strokeStyle = previewColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    // In-progress vertex handles. The first point gets a pulsing
    // ring once we have ≥3 points so the user knows clicking it
    // closes the polygon. The pulse is driven by Date.now() —
    // drawShapes is called by the rAF loop in _ensureShapePulseRaf
    // while we're in that state.
    const closable = shapeState.points.length >= 3;
    const cw = canvas.width, chh = canvas.height;
    const clamp = (v, r, max) => Math.max(r, Math.min(max - r, v));
    shapeState.points.forEach((p) => {
      const r = 10;
      const dx = clamp(p.x, r, cw);
      const dy = clamp(p.y, r, chh);
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    if (closable){
      const first = shapeState.points[0];
      const t = (Date.now() % 1200) / 1200;
      const phase = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
      const ringR = 16 + phase * 8;
      const alpha = 0.7 - phase * 0.5;
      const cx = clamp(first.x, 24, cw);
      const cy = clamp(first.y, 24, chh);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(34,197,94,${alpha.toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    _ensureShapePulseRaf(closable);
  } else {
    _ensureShapePulseRaf(false);
  }
}

// rAF loop — runs only while a closable in-progress polygon is on
// screen. Redraws drawShapes() ~30 fps so the closing-point ring pulses
// smoothly.
let _shapePulseRaf = null;
function _ensureShapePulseRaf(active){
  if (active && !_shapePulseRaf){
    const tick = () => {
      // Stop if the editor closed or the in-progress polygon is gone.
      if (!shapeState.camera || (shapeState.points || []).length < 3){
        _shapePulseRaf = null;
        return;
      }
      drawShapes();
      _shapePulseRaf = requestAnimationFrame(tick);
    };
    _shapePulseRaf = requestAnimationFrame(tick);
  } else if (!active && _shapePulseRaf){
    cancelAnimationFrame(_shapePulseRaf);
    _shapePulseRaf = null;
  }
}

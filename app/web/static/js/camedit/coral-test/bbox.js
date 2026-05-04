// ─── camedit/coral-test/bbox.js ────────────────────────────────────────────
// R12 — extracted from coral-test.js. Pure rendering helpers: the canvas
// bbox-overlay drawer plus the label-colour palette + the mid-truncation
// util used by canvas labels and the result-card filename row. No DOM
// tree manipulation beyond the canvas the caller hands in.

// Per-label fill / stroke colour map. Mirrors the live alert pill
// palette so cascade-mode bboxes match the lightbox overlay across the
// rest of the UI.
export const _CORAL_LABEL_COLORS = {
  person:'#6e6eff',cat:'#a06eff',bird:'#54d662',dog:'#00b0ff',
  car:'#f87171',fox:'#ff7a1a',squirrel:'#7c4a1f',hedgehog:'#a67c52',
};

export function _coralLabelColor(lbl){
  return _CORAL_LABEL_COLORS[String(lbl||'').toLowerCase()]||'#ffb400';
}

export function _truncMid(s,max){
  s=String(s||''); if(s.length<=max) return s;
  const keep=Math.max(8,Math.floor((max-1)/2));
  return s.slice(0,keep)+'…'+s.slice(-keep);
}

// Draw the source image to the canvas, then overlay COCO detection
// rectangles in green and (where applicable) the wildlife classifier
// rectangle in amber. Bbox coords come back from the server in the
// ORIGINAL image's pixel space, so we rescale them to the canvas size
// (= the resized transport image).
export function _drawCoralBatchCanvas(canvas, im, item){
  // Match the canvas surface to the loaded image's intrinsic resolution
  // (= the 480-px-wide transport variant). CSS handles display sizing
  // via .cb-canvas { width:100%; height:auto }.
  canvas.width = im.naturalWidth;
  canvas.height = im.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0);
  const ow = item.image_w || im.naturalWidth;
  const oh = item.image_h || im.naturalHeight;
  const sx = canvas.width / ow;
  const sy = canvas.height / oh;
  ctx.font = '12px ui-monospace,Menlo,Consolas,monospace';
  ctx.textBaseline = 'top';
  // ── COCO detections ───────────────────────────────────────────────
  const dets = item.detections || [];
  const cocoColor = '#4ade80';
  for(const d of dets){
    const b = d.bbox || [];
    if(b.length !== 4) continue;
    const x1=b[0]*sx, y1=b[1]*sy, x2=b[2]*sx, y2=b[3]*sy;
    ctx.strokeStyle = cocoColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2-x1, y2-y1);
    // Label tab above the box. Falls inside the frame when box hugs the top edge.
    const txt = `${d.label} ${(d.score*100|0)}%`;
    const tw = ctx.measureText(txt).width + 8;
    const th = 16;
    const ly = y1 - th >= 0 ? y1 - th : y1;
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(x1, ly, tw, th);
    ctx.fillStyle = cocoColor;
    ctx.fillText(txt, x1+4, ly+2);
  }
  // ── Wildlife classifier ────────────────────────────────────────────
  // Only render the overlay when the classifier successfully mapped to one
  // of our categories (squirrel/fox/hedgehog). On a "kein Treffer" result
  // (wl.label == null) we leave the canvas alone — the bottom pill already
  // tells the user what ImageNet thought of the frame, and a full-frame
  // amber border would otherwise read like a positive detection.
  if(item.wildlife && item.wildlife.label){
    const wl = item.wildlife;
    // Use the squirrel/fox/hedgehog category colour so the box matches
    // the rest of the UI (and is consistent with COCO bbox colouring).
    const lblColor = _coralLabelColor(wl.label);
    let x1=0, y1=0, x2=canvas.width, y2=canvas.height, fullFrame=true;
    if(Array.isArray(wl.bbox) && wl.bbox.length===4){
      x1 = wl.bbox[0]*sx; y1 = wl.bbox[1]*sy;
      x2 = wl.bbox[2]*sx; y2 = wl.bbox[3]*sy;
      // Treat a near-full-frame bbox as the "no localisation" fallback.
      const w = x2-x1, h = y2-y1;
      fullFrame = (w >= canvas.width*0.95 && h >= canvas.height*0.95);
    }
    // Don't outline the entire image — when no localised bbox is available
    // we just paint the label badge in the top-left.
    if(!fullFrame){
      ctx.strokeStyle = lblColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1+1, y1+1, Math.max(0, x2-x1-2), Math.max(0, y2-y1-2));
    }
    const txt = wl.score!=null ? `${wl.label} ${(wl.score*100|0)}%` : wl.label;
    const tw = ctx.measureText(txt).width + 8;
    const th = 16;
    const lx = fullFrame ? 4 : x1;
    const ly = fullFrame ? 4 : (y1 - th >= 0 ? y1 - th : y1);
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(lx, ly, tw, th);
    ctx.fillStyle = lblColor;
    ctx.fillText(txt, lx+4, ly+2);
  }
}

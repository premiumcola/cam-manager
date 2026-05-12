// ─── mediaview/shell.js ────────────────────────────────────────────────────
// Composes the six structural pieces of the MediaView modal: TitleBar,
// Canvas (with bbox + trail + zone layers), PlayBar (scrubber, axis,
// per-class swimlanes, playhead line), DetailPill,
// PanelTabs (Detections · Tracks · Settings · Weather · Nach-Erkennung),
// and FineAnalysisFold. The shell wires their cross-references and
// exposes the open/close lifecycle.
//
// SKELETON — task #3 in the migration queue is what fills this in.
// Today the legacy Mediathek lightbox in lightbox.js still owns the
// open/close flow; the shell function below is a placeholder so the
// rest of the tree can reference it without resolution errors.

export function mountMediaView(/* config */){
  // task #3: build the host node, attach the structural pieces, wire
  // lifecycle (resize, dismiss, keyboard) and return a teardown handle.
  return { teardown: () => {} };
}

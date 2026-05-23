// ─── mediaview/fine-analysis-fold.js ───────────────────────────────────────
// Permanent strip BELOW the panel content. Header: chevron + terminal
// icon + "Fein-Analyse · Trace-Log" + tiny subtitle (capture · coral ·
// verdict · matrix · armed · telegram · schedule · final). Closed by
// default; open state renders the decision-trace lines on a darker
// monospace surface (#050810).
//
// Trace-line classification (caller passes already-classified lines):
//   { kind: 'pass' | 'reject' | 'no-detection' | 'info', text }
//     - pass         → success-green text colour
//     - reject       → warning-amber text colour
//     - no-detection → danger-red text colour
//     - info         → muted text colour
//
// Open/closed state persists under
// localStorage[FINE_FOLD_STORAGE_KEY] so the user's last choice
// survives page reloads.

export const FINE_FOLD_STORAGE_KEY = 'tamspy.mediaview.fineFold';

const _TERM_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
const _CHEVRON_SVG = `<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>`;

function _isOpen(defaultOpen) {
  try {
    const raw = localStorage.getItem(FINE_FOLD_STORAGE_KEY);
    // Three-state: '1' = explicitly open, '0' = explicitly closed,
    // null = never touched → fall through to the caller's default
    // (live-detect mode wants it open by default so the trace ticks
    // visibly; recorded mode keeps the historical "closed" default).
    if (raw === '1') return true;
    if (raw === '0') return false;
    return !!defaultOpen;
  } catch {
    return !!defaultOpen;
  }
}

function _saveOpen(open) {
  try {
    // Explicit '0' so a user-closed fold stays closed even when the
    // caller's default would have flipped it open (live-detect mode).
    if (open) localStorage.setItem(FINE_FOLD_STORAGE_KEY, '1');
    else localStorage.setItem(FINE_FOLD_STORAGE_KEY, '0');
  } catch {
    /* quota / private mode — fall through */
  }
}

function _renderLines(lines, opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    // B23 · the live-detect mount is the only producer of trace
    // lines that's still polling — when no tick has returned yet,
    // showing the recorded-clip "Kein Server-Trace gespeichert"
    // copy is misleading. Render a short muted "waiting" line
    // instead so the user knows the fold is correctly bound to a
    // live source, just empty for now. As soon as the first tick
    // delivers data the setLines() call below paints the real trace.
    if (opts.live) {
      // B23' · if the latest tick errored (ok=false / 503 / netcode)
      // show that error in muted-warning colour rather than the
      // generic "Warte …" line. Tells the user the loop IS running,
      // it's the backend that's refusing — different fix than a
      // stuck loop.
      if (opts.lastError) {
        const esc = String(opts.lastError)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        return `<div class="mv-fafold-empty mv-fafold-empty--warn">Letzter Tick: ${esc}</div>`;
      }
      return `<div class="mv-fafold-empty">Warte auf ersten Tick …</div>`;
    }
    return `<div class="mv-fafold-empty">Kein Server-Trace gespeichert für diese Aufnahme — Trace ist nur im Live-Test verfügbar.</div>`;
  }
  return lines
    .map((line) => {
      const kind = line && line.kind ? line.kind : 'info';
      const text = line && typeof line.text === 'string' ? line.text : String(line || '');
      const esc = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      return `<div class="mv-fafold-line" data-kind="${kind}">${esc}</div>`;
    })
    .join('');
}

export function renderFineAnalysisFold(host, lines, opts = {}) {
  if (!host) return null;
  const open0 = _isOpen(opts.defaultOpen);
  // B23 · live-detect mounts pass { live: true } so the empty-state
  // copy reads "Warte auf ersten Tick …" instead of the recorded-
  // clip "Kein Server-Trace gespeichert" string. Capture the flag in
  // the closure so subsequent setLines() calls keep the same shape.
  // B23' · also remember the last error so a tick that returned ok=
  // false replaces the empty state with "Letzter Tick: <code> · …"
  // without losing the live mode.
  const live = !!opts.live;
  let lastError = null;
  let lastLines = lines;
  const repaint = () => {
    if (body) body.innerHTML = _renderLines(lastLines, { live, lastError });
  };
  host.innerHTML = `
    <div class="mv-fafold-root" data-open="${open0 ? '1' : '0'}"${live ? ' data-mode="live"' : ''}>
      <button type="button" class="mv-fafold-header" aria-expanded="${open0 ? 'true' : 'false'}">
        <span class="mv-fafold-chevron" aria-hidden="true">${_CHEVRON_SVG}</span>
        <span class="mv-fafold-icon" aria-hidden="true">${_TERM_SVG}</span>
        <span class="mv-fafold-title">Fein-Analyse · Trace-Log</span>
        <span class="mv-fafold-sub">capture · coral · verdict · matrix · armed · telegram · schedule · final</span>
      </button>
      <div class="mv-fafold-body" ${open0 ? '' : 'hidden'}>${_renderLines(lines, { live })}</div>
    </div>`;
  const root = host.querySelector('.mv-fafold-root');
  const header = host.querySelector('.mv-fafold-header');
  const body = host.querySelector('.mv-fafold-body');
  if (header && body && root) {
    header.addEventListener('click', () => {
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      header.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      root.dataset.open = willOpen ? '1' : '0';
      _saveOpen(willOpen);
    });
  }
  return {
    setLines(newLines) {
      lastLines = newLines;
      // A successful tick clears the previous error so the trace is
      // shown unconditionally. setLastError(null) on its own does
      // the same; calling both makes the contract explicit.
      lastError = null;
      repaint();
    },
    setLastError(text) {
      // B23' · live-detect mode only — recorded clips have no live
      // tick loop, so the recorded empty state stays unchanged. The
      // tick path calls this with `${code} · ${msg}` on every
      // ok=false response and null after a successful one.
      lastError = text || null;
      // Don't blow away an existing trace just because the next
      // tick errored — only paint the warn line when we have no
      // lines yet (the lastLines guard inside _renderLines handles
      // the "show trace if available, else error" branch).
      repaint();
    },
  };
}

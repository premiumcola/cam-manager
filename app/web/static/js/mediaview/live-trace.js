// ─── mediaview/live-trace.js ──────────────────────────────────────────────
// Q2-3 · the Trace tab's per-tick decision-trace renderer.
//
// The trace data was always reaching the frontend (it shows up verbatim
// in the copied Debug snapshot), but it only ever flowed into the
// Fein-Analyse fold inside the Detections tab — the dedicated Trace tab
// panel (#mvLdPanel-trace) was created empty and never written to. This
// renderer fills that gap.
//
// The tick loop hands us the last ~20 server ticks (oldest→newest); we
// paint them NEWEST FIRST on a dark monospace surface, one block per
// tick separated by a faint divider, and tint each line by its
// [bracket] prefix so the eye can scan the pipeline
// capture → coral → det → matrix → armed → … → final.

import { esc } from '../core/dom.js';

// Bracket-prefix → accent class (CSS in 30f-live-detect-skeleton.css).
// Each pipeline gate gets its own subtle colour; unknown prefixes fall
// back to the muted "info" tint.
const _PREFIX_CLASS = {
  capture: 'cap',
  coral: 'coral',
  det: 'det',
  verdict: 'verdict',
  matrix: 'matrix',
  armed: 'armed',
  telegram_enabled: 'tg',
  telegram: 'tg',
  schedule_notify: 'sched',
  schedule: 'sched',
  cooldown: 'cool',
  final: 'final',
};

// "[coral] threshold floor …" → "coral". Leading-bracket scan only.
export function tracePrefix(line) {
  const m = /^\s*\[([a-z_]+)\]/i.exec(line || '');
  return m ? m[1].toLowerCase() : '';
}

export function renderLiveTrace(host, ticks) {
  if (!host) return;
  if (!Array.isArray(ticks) || ticks.length === 0) {
    host.innerHTML = '<div class="mv-ld-trace-empty">Warte auf ersten Tick …</div>';
    return;
  }
  // Newest tick first (the array arrives oldest→newest).
  const blocks = ticks
    .slice()
    .reverse()
    .map((tick) => {
      const head = _fmtTime(tick.ts);
      const lines = (tick.lines || [])
        .map((line) => {
          const text = typeof line === 'string' ? line : line.text || '';
          const prefix =
            line && typeof line === 'object' && line.prefix ? line.prefix : tracePrefix(text);
          const cls = _PREFIX_CLASS[prefix] || 'info';
          return `<div class="mv-ld-trace-line" data-prefix="${esc(cls)}">${esc(text)}</div>`;
        })
        .join('');
      return (
        '<div class="mv-ld-trace-tick">' +
        `<div class="mv-ld-trace-tick-head">${esc(head)}</div>${lines}` +
        '</div>'
      );
    })
    .join('');
  host.innerHTML = `<div class="mv-ld-trace">${blocks}</div>`;
}

function _fmtTime(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

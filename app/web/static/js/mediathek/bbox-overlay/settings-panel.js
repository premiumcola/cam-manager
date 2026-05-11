// ─── mediathek/bbox-overlay/settings-panel.js ──────────────────────────────
// item.recording_settings is captured by _finalize_motion_clip at the
// time of the recording; item.achievement is filled in synchronously
// (inference_*, motion_pretrigger_fired) and asynchronously by the
// tracking_worker (tracks_by_class, peak_score_by_class,
// confirm_hits_by_track) once tracks.json is on disk.
//
// The lightbox panel mirrors the cam-edit Erkennung wizard exactly —
// same numeric circles, same Tabler-flavour icons, same titles and
// hints — and adds an "Erreicht" column showing what that setting
// actually produced for this clip. Pre-existing events (no
// recording_settings) get a single muted line instead.
import { byId } from '../../core/dom.js';
import { colors, OBJ_LABEL } from '../../core/icons.js';

// Tabler-flavour SVGs mirror the cam-edit step icons. Tightly inlined
// so the lightbox doesn't pull on the wizard's HTML at render time.
const _SET_STEP_ICONS = {
  // Step 1 · "Was suchen?" — eye + iris
  1: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  // Step 2 · "Wie sicher?" — clock
  2: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  // Step 3 · "Wie oft bestätigen?" — double check
  3: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/><polyline points="20 12 14 18" opacity=".5"/></svg>',
  // Step 4 · "Wie schnell scannen?" — lightning
  4: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  // Step 5 · "Bewegungs-Vortrigger" — heartbeat
  5: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h3l3-9 6 18 3-9h3"/></svg>',
};

// Header gear icon for the panel root.
const _SET_HEADER_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 7.04 4.29l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.31.61.85 1.04 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function _fmtPct(v){
  if (v == null || !Number.isFinite(parseFloat(v))) return '—';
  return `${Math.round(parseFloat(v) * 100)} %`;
}

function _fmtClassList(arr){
  if (!Array.isArray(arr) || arr.length === 0) return 'alle Klassen';
  return arr.map(l => OBJ_LABEL[l] || l).join(', ');
}

// Build the "Erreicht" cell for step 1 — what classes actually
// produced tracks in this clip. Reads achievement.tracks_by_class
// (filled in by the worker after tracks.json lands).
function _achStep1(ach){
  const tbc = ach?.tracks_by_class;
  if (!tbc || typeof tbc !== 'object' || Object.keys(tbc).length === 0) return '—';
  return Object.entries(tbc)
    .map(([k, v]) => `${OBJ_LABEL[k] || k} ${v}`)
    .join(', ');
}

// Step 2 "Erreicht" — peak score per class with class-colour pill.
function _achStep2(ach){
  const peaks = ach?.peak_score_by_class;
  if (!peaks || typeof peaks !== 'object' || Object.keys(peaks).length === 0) return '—';
  return Object.entries(peaks).map(([k, v]) => {
    const c = colors[k] || colors.unknown;
    return `<span class="lbset-peak" style="color:${c}">${OBJ_LABEL[k] || k} ${Math.round(parseFloat(v) * 100)} %</span>`;
  }).join(' · ');
}

// Step 3 "Erreicht" — per-track confirmation summary. Each track
// reads "Person #1: 4×/3.2s ✓" with a green ✓ if confirmed, grey
// circle otherwise.
function _achStep3(ach){
  const list = ach?.confirm_hits_by_track;
  if (!Array.isArray(list) || list.length === 0) return '—';
  return list.map((t, i) => {
    const lbl = OBJ_LABEL[t.label] || t.label || '?';
    const ok = t.confirmed ? '<span class="lbset-ok">✓</span>'
                           : '<span class="lbset-no">○</span>';
    return `${lbl} #${i + 1}: ${t.hit_count}× / ${(t.span_seconds || 0).toFixed(1)}s ${ok}`;
  }).join('<br>');
}

// Step 4 "Erreicht" — inference avg with status-coloured number.
// CPU emergency renders the value in orange (#f97316); ok / elevated
// stay in the default panel text colour.
function _achStep4(ach){
  const ms = ach?.inference_avg_ms;
  const status = ach?.inference_status;
  if (ms == null || !Number.isFinite(parseFloat(ms))) return '—';
  const tone = status === 'cpu_emergency' ? 'is-emergency'
             : status === 'elevated' ? 'is-elevated' : '';
  return `<span class="lbset-infer ${tone}">${Math.round(parseFloat(ms))} ms</span>`;
}

// Step 5 "Erreicht" — pretrigger fired flag.
function _achStep5(ach){
  if (ach?.motion_pretrigger_fired) return 'Pretrigger ausgelöst';
  return '—';
}

export function lbRenderSettingsPanel(item){
  const host = byId('lightboxSettings');
  if (!host) return;
  if (!item || item.type === 'timelapse'){
    host.innerHTML = '';
    return;
  }
  const rs = item.recording_settings;
  if (!rs || typeof rs !== 'object' || rs.mode === 'timelapse'){
    host.innerHTML = `<div class="lbset-missing">Settings nicht aufgezeichnet · ältere Aufnahme</div>`;
    return;
  }
  const ach = item.achievement || {};
  const camId = item.camera_id || '';

  // Pre-render per-step rows. Each step shows Gesetzt (the recording
  // config) and Erreicht (what the clip's data actually produced),
  // plus the wizard-mirroring numeric circle + icon + title + hint.
  const objFilterCell = (rs.object_filter == null)
    ? 'alle Klassen'
    : _fmtClassList(rs.object_filter);

  const conf2nd = (rs.conf_thresh_per_class && Object.keys(rs.conf_thresh_per_class).length > 0)
    ? Object.entries(rs.conf_thresh_per_class)
        .map(([k, v]) => `${OBJ_LABEL[k] || k} ${Math.round(parseFloat(v) * 100)} %`)
        .join(', ')
    : null;

  const steps = [
    {
      num: 1, title: 'Was suchen?', sub: 'Klassen-Filter',
      setVal: objFilterCell,
      achVal: _achStep1(ach),
    },
    {
      num: 2, title: 'Wie sicher?', sub: 'Konfidenz',
      setVal: _fmtPct(rs.conf_thresh_general)
        + (conf2nd ? ` <span class="lbset-row-aux">${conf2nd}</span>` : ''),
      achVal: _achStep2(ach),
    },
    {
      num: 3, title: 'Wie oft bestätigen?', sub: 'Anti-Fehlalarm',
      setVal: `${rs.confirm_n ?? '—'} Treffer in ${rs.confirm_seconds ?? '—'} s`,
      achVal: _achStep3(ach),
    },
    {
      num: 4, title: 'Wie schnell scannen?', sub: 'Analyse-Intervall',
      setVal: `${rs.sample_interval_ms ?? '—'} ms`,
      achVal: _achStep4(ach),
    },
    {
      num: 5, title: 'Bewegungs-Vortrigger', sub: 'vor der KI',
      setVal: _fmtPct(rs.motion_pretrigger_sensitivity),
      achVal: _achStep5(ach),
    },
  ];

  const stepsHtml = steps.map(st => `
    <div class="lbset-step">
      <div class="lbset-step-head">
        <span class="lbset-step-num">${st.num}</span>
        <span class="lbset-step-icon">${_SET_STEP_ICONS[st.num]}</span>
        <span class="lbset-step-title">${st.title}</span>
        <span class="lbset-step-sub">${st.sub}</span>
      </div>
      <div class="lbset-step-body">
        <span class="lbset-row-label">Gesetzt</span>
        <span class="lbset-row-value">${st.setVal}</span>
        <span class="lbset-row-label">Erreicht</span>
        <span class="lbset-row-value">${st.achVal}</span>
      </div>
    </div>`).join('');

  // Trailing "+" row — non-wizard items that still belong here so
  // the user has the full picture in one place.
  const nachlauf = (rs.post_motion_seconds != null && rs.post_motion_seconds > 0)
    ? `${rs.post_motion_seconds} s`
    : 'Standard';
  const extrasHtml = `
    <div class="lbset-extras">
      <div class="lbset-extras-row">
        <span class="lbset-extras-label">Nachlauf-Aufnahme</span>
        <span class="lbset-extras-value">${nachlauf}</span>
      </div>
      <div class="lbset-extras-row">
        <span class="lbset-extras-label">Min Bbox · Person</span>
        <span class="lbset-extras-value lbset-row-muted">15 % h · 2 % a · fix</span>
      </div>
    </div>`;

  // Default-collapsed — the chevron points right (CSS rotates -90°)
  // and the body sits hidden until the user taps the header. Keeps
  // the bottom of the lightbox quiet when the user just wants to
  // watch the clip; tapping the chip surfaces the full breakdown.
  host.innerHTML = `
    <button type="button" class="lbset-header" aria-expanded="false" aria-controls="lightboxSettingsBody">
      <span class="lbset-header-icon">${_SET_HEADER_ICON}</span>
      <span class="lbset-header-title">Erkennung · gesetzt vs. erreicht</span>
      <span class="lbset-header-chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
      </span>
    </button>
    <div class="lbset-body" id="lightboxSettingsBody" hidden>
      ${stepsHtml}
      ${extrasHtml}
      <button type="button" class="lbset-edit-btn" data-cam="${camId}">
        Aktuelle Settings dieser Kamera bearbeiten →
      </button>
    </div>`;

  const header = host.querySelector('.lbset-header');
  const body = host.querySelector('.lbset-body');
  if (header && body){
    header.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const editBtn = host.querySelector('.lbset-edit-btn');
  if (editBtn){
    editBtn.addEventListener('click', () => {
      const cid = editBtn.dataset.cam;
      if (!cid) return;
      // Close the lightbox first so the camera-edit panel isn't
      // hidden behind the modal, then route to the Geräte section
      // and open the Erkennung tab inside cam-edit. The double-
      // requestAnimationFrame is there because window.editCamera()
      // synchronously rebuilds the form DOM — the tab click needs
      // to land on the freshly-rendered .cam-tab-btn nodes.
      try { window.closeLightbox?.(); } catch { /* ignore */ }
      setTimeout(() => {
        location.hash = '#cameras';
        try { window.editCamera?.(cid); } catch { /* ignore */ }
        setTimeout(() => {
          const tabBtn = document.querySelector('.cam-tab-btn[data-tab="cam-tab-erkennung"]');
          tabBtn?.click();
          document.querySelector('#cam-tab-erkennung')?.scrollIntoView(
            { behavior: 'smooth', block: 'start' });
        }, 180);
      }, 60);
    });
  }
}

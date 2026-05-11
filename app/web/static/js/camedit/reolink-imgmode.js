// Reolink-only · Bild-Modus-Test in der Verbindung-Tab.
//
// Manuell ausgelöster Override für SetIsp + IrLights — komplett losgelöst
// vom Timelapse-Pfad. Der Operator klickt Farbe/Auto/S-W, der POST geht
// an /api/cameras/<id>/reolink/image-mode, eine Feedback-Zeile zeigt das
// Ergebnis und räumt sich nach 10 s selbst auf. Das ganze Panel wird
// versteckt wenn das Hersteller-Feld nicht "reolink" ist.
//
// Speichern der Form ist Voraussetzung — der Endpunkt liest Port + User
// aus settings.json, nicht aus der aktuellen Form. Das ist Absicht:
// einmal speichern, dann beliebig oft testen.

const byId = (id) => document.getElementById(id);

const FEEDBACK_CLEAR_MS = 10_000;
let _feedbackTimer = null;

function _setFeedback(text, kind /* 'ok' | 'error' | 'info' */) {
  const el = byId('reolinkImageModeFeedback');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
  if (_feedbackTimer) {
    clearTimeout(_feedbackTimer);
    _feedbackTimer = null;
  }
  if (!text) return;
  _feedbackTimer = setTimeout(() => {
    el.textContent = '';
    delete el.dataset.kind;
    _feedbackTimer = null;
  }, FEEDBACK_CLEAR_MS);
}

function _updateVisibility() {
  const f = byId('cameraForm')?.elements;
  if (!f) return;
  const box = byId('reolinkImageModeBox');
  if (!box) return;
  const vendor = (f['manufacturer']?.value || '').trim().toLowerCase();
  const isReolink = vendor === 'reolink';
  box.hidden = !isReolink;
  if (!isReolink) _setFeedback('', '');
}

async function _onClickMode(mode) {
  const f = byId('cameraForm')?.elements;
  if (!f) return;
  const camId = f['id']?.value;
  if (!camId) {
    _setFeedback('Kamera-ID fehlt — Form zuerst speichern.', 'error');
    return;
  }
  // Disable all three buttons during the call so the user can't fire
  // overlapping requests; ~1 s round-trip on LAN.
  const buttons = document.querySelectorAll('.reolink-imgmode-btn');
  buttons.forEach((b) => { b.disabled = true; });
  _setFeedback(`… ${mode} wird gesendet`, 'info');
  let res = null;
  try {
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(camId)}/reolink/image-mode`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mode }),
      },
    );
    res = await r.json().catch(() => null);
  } catch (e) {
    _setFeedback(`Netzwerkfehler: ${e?.message || e}`, 'error');
    buttons.forEach((b) => { b.disabled = false; });
    return;
  }
  buttons.forEach((b) => { b.disabled = false; });
  if (res && res.ok) {
    _setFeedback(`✓ Modus ${mode} gesetzt`, 'ok');
  } else {
    const detail = (res && (res.detail || res.error)) || 'Unbekannter Fehler';
    const rc = res && res.rc != null ? ` (rc=${res.rc})` : '';
    _setFeedback(`✗ ${detail}${rc}`, 'error');
  }
}

export function _bindReolinkImageMode() {
  const box = byId('reolinkImageModeBox');
  if (!box || box.dataset.wired === '1') {
    _updateVisibility();
    return;
  }
  box.dataset.wired = '1';

  box.querySelectorAll('.reolink-imgmode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode) _onClickMode(mode);
    });
  });

  // React to manufacturer-field edits so the panel appears/disappears
  // live when the operator toggles Reolink ↔ RTSP-Generic.
  const f = byId('cameraForm')?.elements;
  if (f && f['manufacturer']) {
    f['manufacturer'].addEventListener('input', _updateVisibility);
  }
  _updateVisibility();
}

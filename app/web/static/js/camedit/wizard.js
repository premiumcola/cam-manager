// ─── camedit/wizard.js ─────────────────────────────────────────────────────
// Stage 25 of the legacy.js → ES modules refactor — first-run setup
// wizard (4 steps: app/identity, location/subnet, telegram/mqtt,
// camera). Pure code move from legacy.js.
//
// finishWizard POSTs the collected fields to /api/wizard/complete and
// then reloads loadAll() so the dashboard rebuilds with the new
// configuration.
import { byId } from '../core/dom.js';
import { loadAll } from '../live-update.js';
import { apiPost } from '../core/api.js';

export function openWizard() {
  byId('wizard').classList.remove('hidden');
  showWizardStep(1);
}
export function closeWizard() {
  byId('wizard').classList.add('hidden');
}

function showWizardStep(step) {
  document
    .querySelectorAll('.wiz-step')
    .forEach((n) => n.classList.toggle('active', Number(n.dataset.step) === step));
  document
    .querySelectorAll('.wiz-tab')
    .forEach((n) => n.classList.toggle('active', Number(n.dataset.step) === step));
  byId('wizPrev').style.visibility = step === 1 ? 'hidden' : 'visible';
  byId('wizNext').classList.toggle('hidden', step === 4);
  byId('wizFinish').classList.toggle('hidden', step !== 4);
  byId('wizard').dataset.step = step;
}

async function finishWizard() {
  const camId = byId('wiz_cam_id').value.trim();
  const payload = {
    app: {
      name: byId('wiz_app_name').value || 'Squirreling · Sightings',
      tagline: byId('wiz_tagline').value || '',
      logo: byId('wiz_logo').value || '🐈‍⬛',
    },
    server: { default_discovery_subnet: byId('wiz_subnet').value || '192.168.1.0/24' },
    telegram: {
      enabled: byId('wiz_tg_enabled').checked,
      token: byId('wiz_tg_token').value || '',
      chat_id: byId('wiz_tg_chat_id').value || '',
    },
    mqtt: {
      enabled: byId('wiz_mqtt_enabled').checked,
      host: byId('wiz_mqtt_host').value || '',
      port: Number(byId('wiz_mqtt_port').value || 1883),
      username: byId('wiz_mqtt_username').value || '',
      password: byId('wiz_mqtt_password').value || '',
      base_topic: byId('wiz_mqtt_topic').value || 'tam-spy',
    },
    cameras: camId
      ? [
          {
            id: camId,
            name: byId('wiz_cam_name').value || camId,
            manufacturer: byId('wiz_cam_manufacturer')?.value || '',
            model: byId('wiz_cam_model')?.value || '',
            location: byId('wiz_cam_location').value || '',
            rtsp_url: byId('wiz_cam_rtsp').value || '',
            snapshot_url: byId('wiz_cam_snapshot').value || '',
            enabled: true,
            armed: true,
            object_filter: ['person', 'cat', 'bird'],
            timelapse: { enabled: false, fps: 25 },
            zones: [],
            masks: [],
            schedule: { enabled: false, start: '22:00', end: '06:00' },
            telegram_enabled: true,
            mqtt_enabled: true,
            whitelist_names: [],
          },
        ]
      : [],
  };
  await apiPost('/api/wizard/complete', payload);
  closeWizard();
  await loadAll();
}

// ── DOM wiring (runs once on import) ────────────────────────────────────────
// Default placeholders shown in step 4 so the user has a syntax model
// to mimic. The wizard stays openable/repeatable, so seeding once at
// import time is fine — the user always overwrites with their actual
// camera URL before clicking Finish.
byId('wiz_cam_rtsp').value = 'rtsp://user:pass@192.168.X.X:554/Streaming/Channels/101';
byId('wiz_cam_snapshot').value = 'http://user:pass@192.168.X.X/cgi-bin/snapshot.cgi';

let wizStep = 1;
document.querySelectorAll('.wiz-tab').forEach(
  (btn) =>
    (btn.onclick = () => {
      wizStep = Number(btn.dataset.step);
      showWizardStep(wizStep);
    }),
);
byId('wizPrev').onclick = () => {
  wizStep = Math.max(1, wizStep - 1);
  showWizardStep(wizStep);
};
byId('wizNext').onclick = () => {
  wizStep = Math.min(4, wizStep + 1);
  showWizardStep(wizStep);
};
byId('wizFinish').onclick = () => finishWizard();

window.openWizard = openWizard;

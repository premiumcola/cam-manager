// ─── camedit/hydration/alerting.js ─────────────────────────────────────────
// N17 · Schedule + channel-toggle hydration for the Alerting tab.
// Carved out of editCamera() in camedit/index.js so the orchestration
// body shrinks without changing observable behaviour.
//
// schedule_notify gates Telegram/MQTT; schedule_record gates the
// on-disk archive. Both fall back to a legacy `schedule` dict's
// fields the first time the user opens a pre-split camera — the
// derivation here keeps the original semantics exactly.

export function hydrateAlertingFields(formEl, c) {
  const f = formEl.elements;
  if (f['enabled']) f['enabled'].checked = !!c.enabled;
  f['armed'].checked = !!c.armed;
  // Two independent schedules — schedule_notify for Telegram/MQTT,
  // schedule_record for the on-disk archive. Either can be enabled or
  // disabled without affecting the other. The legacy `schedule` dict
  // is consulted only when the new fields are absent (first-load of a
  // pre-split camera).
  const _legacySch = c.schedule || {};
  const _legacyAct = _legacySch.actions || {};
  const _schN = c.schedule_notify || {
    enabled: !!_legacySch.enabled && _legacyAct.telegram !== false,
    from: _legacySch.from || '21:00',
    to:   _legacySch.to   || '06:00',
  };
  const _schR = c.schedule_record || {
    enabled: !!_legacySch.enabled && _legacyAct.record !== false,
    from: _legacySch.from || '00:00',
    to:   _legacySch.to   || '23:59',
  };
  if (f['schedule_notify_enabled']) f['schedule_notify_enabled'].checked = !!_schN.enabled;
  if (f['schedule_notify_from'])    f['schedule_notify_from'].value      = _schN.from || '21:00';
  if (f['schedule_notify_to'])      f['schedule_notify_to'].value        = _schN.to   || '06:00';
  if (f['schedule_record_enabled']) f['schedule_record_enabled'].checked = !!_schR.enabled;
  if (f['schedule_record_from'])    f['schedule_record_from'].value      = _schR.from || '00:00';
  if (f['schedule_record_to'])      f['schedule_record_to'].value        = _schR.to   || '23:59';
  // Channel toggles + recording archive toggle.
  if (f['telegram_enabled']) f['telegram_enabled'].checked = (c.telegram_enabled !== false);
  if (f['mqtt_enabled'])     f['mqtt_enabled'].checked     = (c.mqtt_enabled !== false);
  if (f['recording_enabled']) f['recording_enabled'].checked = (c.recording_enabled !== false);
}

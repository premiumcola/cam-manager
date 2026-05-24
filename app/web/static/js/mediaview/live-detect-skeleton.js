// ─── mediaview/live-detect-skeleton.js ────────────────────────────────────
// SIMU-01 · the 5-zone DOM skeleton for the Live-Detect view.
//
// The Live-Detect modal reuses #lightboxMediaWrap as its host; on
// mount, this module inserts a flex-column container with five named
// zones (title · video · timeline · tabs · detail) and re-parents
// existing chrome (img, video, scrubber/swimlane, settings panel)
// into the matching zone. zone-detail is the only scrollable region —
// everything above sticks.
//
// Tab content is owned by callers — the skeleton creates empty panel
// elements (`#mvLdPanel-<id>`) and toggles `.active` on the active
// one. setActiveTab/getActiveTab/onTabChange are the public API.
//
// Lifecycle:
//   mountLdSkeleton({camId, cameraName}) — idempotent mount; updates
//                                          title text on a second call
//                                          with a different camera.
//   unmountLdSkeleton()                  — full teardown, returns
//                                          children to their original
//                                          parents so the recorded
//                                          lightbox keeps working.

import { byId } from '../core/dom.js';

const CONTAINER_ID = 'mvLdContainer';
const ZONE_IDS = {
  title: 'mvLdZoneTitle',
  video: 'mvLdZoneVideo',
  timeline: 'mvLdZoneTimeline',
  tabs: 'mvLdZoneTabs',
  detail: 'mvLdZoneDetail',
};
const PANEL_PREFIX = 'mvLdPanel-';

// Three fixed tabs, always in this order. Icons rendered inline so
// the skeleton has no asset dependency. currentColor inheritance
// matches the .active / muted state colours from CSS.
function _iconDetections() {
  return (
    '<svg class="mv-ld-tab-ico" width="13" height="13" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="3"/>' +
    '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>'
  );
}

function _iconTrace() {
  return (
    '<svg class="mv-ld-tab-ico" width="13" height="13" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="3 18 9 12 13 14 21 6"/>' +
    '<circle cx="21" cy="6" r="1.6" fill="currentColor" stroke="none"/></svg>'
  );
}

function _iconDebug() {
  return (
    '<svg class="mv-ld-tab-ico" width="13" height="13" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="9 6 4 12 9 18"/>' +
    '<polyline points="15 6 20 12 15 18"/>' +
    '<line x1="13.5" y1="4" x2="10.5" y2="20"/></svg>'
  );
}

function _iconClose() {
  return (
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
    'aria-hidden="true">' +
    '<line x1="6" y1="6" x2="18" y2="18"/>' +
    '<line x1="18" y1="6" x2="6" y2="18"/></svg>'
  );
}

// Down-chevron. CSS rotates 180° when data-collapsed="1" on the
// wrapping zone, so the icon points UP when the zone is collapsed.
function _iconChevron() {
  return (
    '<svg class="mv-ld-chevron-glyph" width="14" height="14" ' +
    'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>'
  );
}

const TABS = [
  { id: 'detections', label: 'Detections', icon: _iconDetections },
  { id: 'trace', label: 'Trace', icon: _iconTrace },
  { id: 'debug', label: 'Debug', icon: _iconDebug },
];

const LS_ACTIVE_TAB = 'tam.ld.activetab';
const LS_TITLE_COLLAPSED = 'tam.ld.title.collapsed';
const LS_TIMELINE_COLLAPSED = 'tam.ld.timeline.collapsed';
const LS_LAST_CAMERA = 'tam.ld.lastcamera';
const DEFAULT_TAB = 'detections';

let _activeTab = DEFAULT_TAB;
const _tabChangeHandlers = [];

// localStorage helpers — silent on private mode / quota errors.
function _lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function _lsSet(key, val) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / quota — silent */
  }
}

// Public: locate a zone or panel by name.
export function zoneEl(name) {
  return byId(ZONE_IDS[name]) || null;
}

export function panelEl(tabId) {
  return byId(PANEL_PREFIX + tabId) || null;
}

export function mountLdSkeleton({ camId, cameraName } = {}) {
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  // Idempotency — second mount just refreshes the title text.
  if (byId(CONTAINER_ID)) {
    _renderTitleText(cameraName);
    return;
  }
  const oldChildren = Array.from(wrap.children);
  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.className = 'mv-ld-container';
  const zoneTitle = _makeZone('title');
  const zoneVideo = _makeZone('video');
  const zoneTimeline = _makeZone('timeline');
  const zoneTabs = _makeZone('tabs');
  const zoneDetail = _makeZone('detail');
  container.append(zoneTitle, zoneVideo, zoneTimeline, zoneTabs, zoneDetail);
  wrap.appendChild(container);
  // Re-parent existing wrap children into zone-video — img/video,
  // labels, hidden close/confirm/delete buttons, etc.
  for (const child of oldChildren) {
    if (child === container) continue;
    zoneVideo.appendChild(child);
  }
  // Move #lightboxBottomStack into zone-timeline body (its renderer
  // still finds it via byId, just inside a new parent now).
  const bottomStack = byId('lightboxBottomStack');
  if (bottomStack) {
    bottomStack.dataset.ldOrigParent = 'lightboxInner';
    zoneTimeline.appendChild(_buildTimelineHeader());
    const body = document.createElement('div');
    body.id = 'mvLdTimelineBody';
    body.className = 'mv-ld-timeline-body';
    body.appendChild(bottomStack);
    zoneTimeline.appendChild(body);
  }
  // Build the tab bar + tab content panels. The Detections panel
  // hosts #lightboxSettings for now; SIMU-04+ will redistribute its
  // children into the right tab panels.
  zoneTabs.appendChild(_buildTabBar());
  for (const t of TABS) {
    const panel = document.createElement('div');
    panel.id = PANEL_PREFIX + t.id;
    panel.className = 'mv-ld-tab-panel';
    panel.dataset.tabId = t.id;
    zoneDetail.appendChild(panel);
  }
  const settings = byId('lightboxSettings');
  if (settings) {
    settings.dataset.ldOrigParent = 'lightboxInner';
    settings.hidden = false;
    byId(PANEL_PREFIX + 'detections').appendChild(settings);
  }
  // Title chrome — name + ● Live + chevron + close X.
  zoneTitle.appendChild(_buildTitleBar(cameraName));
  // SIMU-01c · seed collapsed states from localStorage. Same camera
  // within the session → restore last-known state; new camera → reset
  // both zones to expanded so the user gets a fresh layout instead of
  // inheriting some other camera's preference.
  _applyInitialCollapsedStates(camId);
  // Restore active tab from localStorage, default to "detections".
  const remembered = _lsGet(LS_ACTIVE_TAB);
  const initialTab = TABS.find((t) => t.id === remembered) ? remembered : DEFAULT_TAB;
  setActiveTab(initialTab);
}

function _applyInitialCollapsedStates(camId) {
  const lastCam = _lsGet(LS_LAST_CAMERA);
  const sameCam = !!camId && lastCam === camId;
  if (!sameCam) {
    _applyTitleCollapsed(false);
    _applyTimelineCollapsed(false);
    if (camId) _lsSet(LS_LAST_CAMERA, camId);
    return;
  }
  _applyTitleCollapsed(_lsGet(LS_TITLE_COLLAPSED) === '1');
  _applyTimelineCollapsed(_lsGet(LS_TIMELINE_COLLAPSED) === '1');
}

export function unmountLdSkeleton() {
  const container = byId(CONTAINER_ID);
  if (!container) return;
  const inner = byId('lightboxInner');
  const wrap = byId('lightboxMediaWrap');
  if (!wrap || !inner) {
    container.remove();
    return;
  }
  // Move #lightboxBottomStack back to #lightboxInner.
  const bottomStack = byId('lightboxBottomStack');
  if (bottomStack) {
    inner.appendChild(bottomStack);
    delete bottomStack.dataset.ldOrigParent;
  }
  // Move #lightboxSettings back to #lightboxInner.
  const settings = byId('lightboxSettings');
  if (settings) {
    inner.appendChild(settings);
    delete settings.dataset.ldOrigParent;
  }
  // Move all remaining zone-video children back to #lightboxMediaWrap.
  const zoneVideo = byId(ZONE_IDS.video);
  if (zoneVideo) {
    for (const child of Array.from(zoneVideo.children)) {
      wrap.appendChild(child);
    }
  }
  container.remove();
}

function _makeZone(name) {
  const el = document.createElement('div');
  el.id = ZONE_IDS[name];
  el.className = `mv-ld-zone mv-ld-zone-${name}`;
  return el;
}

function _buildTitleBar(camName) {
  const titleEl = document.createElement('div');
  titleEl.className = 'mv-ld-title-row';
  titleEl.style.cssText = 'display:contents';
  titleEl.innerHTML =
    '<span class="mv-ld-title-cam" data-mv-ld-title-cam></span>' +
    '<span class="mv-ld-title-live" data-mv-ld-title-live>Live</span>' +
    '<span class="mv-ld-title-collapsed-line" data-mv-ld-title-collapsed></span>' +
    `<button type="button" class="mv-ld-iconbtn mv-ld-title-chevron" aria-label="Titel ein-/ausblenden">${_iconChevron()}</button>` +
    `<button type="button" class="mv-ld-iconbtn mv-ld-close-btn" aria-label="Schließen">${_iconClose()}</button>`;
  titleEl.querySelector('.mv-ld-title-chevron')?.addEventListener('click', () => {
    const next = !_isTitleCollapsed();
    _applyTitleCollapsed(next);
    _lsSet(LS_TITLE_COLLAPSED, next ? '1' : '0');
  });
  titleEl.querySelector('.mv-ld-close-btn')?.addEventListener('click', () => {
    if (typeof window.closeLightbox === 'function') {
      window.closeLightbox();
    } else {
      const closeBtn = byId('lightboxClose');
      if (closeBtn) closeBtn.click();
    }
  });
  const camText = camName || '';
  titleEl.querySelector('[data-mv-ld-title-cam]').textContent = camText;
  titleEl.querySelector('[data-mv-ld-title-collapsed]').textContent = camText
    ? `${camText} · Live`
    : 'Live';
  return titleEl;
}

function _renderTitleText(camName) {
  const camEl = byId(CONTAINER_ID)?.querySelector('[data-mv-ld-title-cam]');
  const collapsedEl = byId(CONTAINER_ID)?.querySelector('[data-mv-ld-title-collapsed]');
  const camText = camName || '';
  if (camEl) camEl.textContent = camText;
  if (collapsedEl) collapsedEl.textContent = camText ? `${camText} · Live` : 'Live';
}

function _buildTimelineHeader() {
  const head = document.createElement('div');
  head.className = 'mv-ld-timeline-head';
  head.innerHTML =
    '<span class="mv-ld-timeline-head-label" data-mv-ld-timeline-label>Timeline · letzte 60 s</span>' +
    `<button type="button" class="mv-ld-iconbtn mv-ld-timeline-chevron" aria-label="Timeline ein-/ausblenden">${_iconChevron()}</button>`;
  head.querySelector('.mv-ld-timeline-chevron')?.addEventListener('click', () => {
    const next = !_isTimelineCollapsed();
    _applyTimelineCollapsed(next);
    _lsSet(LS_TIMELINE_COLLAPSED, next ? '1' : '0');
  });
  return head;
}

// Collapsed-state accessors. The data-collapsed attribute on the
// zone is the single source of truth; localStorage just seeds it on
// mount + remembers user clicks.
function _isTitleCollapsed() {
  return byId(ZONE_IDS.title)?.dataset.collapsed === '1';
}

function _isTimelineCollapsed() {
  return byId(ZONE_IDS.timeline)?.dataset.collapsed === '1';
}

function _applyTitleCollapsed(v) {
  const zone = byId(ZONE_IDS.title);
  if (!zone) return;
  zone.dataset.collapsed = v ? '1' : '0';
  const chev = zone.querySelector('.mv-ld-title-chevron');
  if (chev) chev.dataset.collapsed = v ? '1' : '0';
}

function _applyTimelineCollapsed(v) {
  const zone = byId(ZONE_IDS.timeline);
  if (!zone) return;
  zone.dataset.collapsed = v ? '1' : '0';
  const chev = zone.querySelector('.mv-ld-timeline-chevron');
  if (chev) chev.dataset.collapsed = v ? '1' : '0';
}

function _buildTabBar() {
  const root = document.createElement('div');
  root.className = 'mv-ld-tab-bar-root';
  const bar = document.createElement('div');
  bar.className = 'mv-ld-tab-bar';
  for (const t of TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mv-ld-tab-btn';
    btn.dataset.tabId = t.id;
    btn.innerHTML = `${t.icon()}<span>${t.label}</span>`;
    btn.addEventListener('click', () => setActiveTab(t.id));
    bar.appendChild(btn);
  }
  root.appendChild(bar);
  return root;
}

export function setActiveTab(id) {
  if (!TABS.find((t) => t.id === id)) return;
  _activeTab = id;
  _lsSet(LS_ACTIVE_TAB, id);
  const container = byId(CONTAINER_ID);
  if (!container) return;
  container.querySelectorAll('.mv-ld-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tabId === id);
  });
  container.querySelectorAll('.mv-ld-tab-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.tabId === id);
  });
  for (const h of _tabChangeHandlers) {
    try {
      h(id);
    } catch (err) {
      console.warn('[mv-ld] tab handler error', err);
    }
  }
}

export function getActiveTab() {
  return _activeTab;
}

export function onTabChange(handler) {
  if (typeof handler === 'function') _tabChangeHandlers.push(handler);
}

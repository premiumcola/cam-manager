// ─── mediathek/bbox-overlay/styles.js ──────────────────────────────────────
// Single style block for the auto-reindex banner. The track timeline
// panel itself lives in 30-lightbox-video.css — this only owns the
// banner because it sits inside #lightboxMediaWrap and needs its own
// z-stack rules independent of the bottom-panel layout.
export function _ensureOverlayStyles(){
  if (document.querySelector('#lbTrackingChipStyles')) return;
  const s = document.createElement('style');
  s.id = 'lbTrackingChipStyles';
  s.textContent = `
    #lbTrackingBanner{position:absolute;left:14px;bottom:18px;z-index:5;
      display:none;align-items:center;gap:8px;padding:6px 10px 6px 8px;
      border-radius:14px;background:rgba(8,18,28,.78);color:#e2e8f0;
      font-size:12px;font-weight:600;letter-spacing:.01em;
      backdrop-filter:blur(8px);opacity:0;transition:opacity .25s ease;
      pointer-events:auto;max-width:min(320px,72vw)}
    #lbTrackingBanner.lbtb-error{background:rgba(75,28,28,.78);color:#fecaca}
    #lbTrackingBanner .lbtb-spinner{
      display:inline-flex;align-items:center;justify-content:center;
      width:16px;height:16px;flex-shrink:0;
      animation:lbtb-spin 1.1s linear infinite}
    #lbTrackingBanner .lbtb-text{
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #lbTrackingBanner .lbtb-retry{
      background:none;border:none;color:rgba(254,202,202,.95);cursor:pointer;
      padding:0;margin:-6px -4px -6px 4px;border-radius:10px;
      display:inline-flex;align-items:center;justify-content:center;
      min-width:36px;min-height:36px;-webkit-tap-highlight-color:transparent}
    #lbTrackingBanner .lbtb-retry:hover{background:rgba(255,255,255,.10)}
    @keyframes lbtb-spin{to{transform:rotate(360deg)}}
    @media (max-width:480px){
      #lbTrackingBanner .lbtb-retry{min-width:44px;min-height:44px;margin:-9px -6px -9px 4px}
    }
  `;
  document.head.appendChild(s);
}

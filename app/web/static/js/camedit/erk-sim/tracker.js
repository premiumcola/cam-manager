// ─── camedit/erk-sim/tracker.js ────────────────────────────────────────────
// Pure client-side IoU tracker used by live-detection mode (live.js).
// Each tick takes the latest detections and returns the confirmed
// tracks (hit_count ≥ 2), letting the renderer paint stable bboxes
// + path trails across frames without flicker.
//
// No network calls, no DOM access. Pure data structure + math so the
// behaviour is unit-testable in isolation if/when we add tests for it.

// Module defaults — line up with tracker_core.py's IOU_MATCH_THRESHOLD
// + MISS_GRACE_DEFAULT_SECONDS so the simulator behaves the way the
// production tracker would for an unconfigured camera. The K13 strip
// surfaces the live form values vs these defaults so the user can
// dial them in empirically.
const _DEFAULT_MIN_IOU       = 0.20;
const _DEFAULT_MISS_GRACE_MS = 8_000;
const _PROMOTE_HITS  = 2;       // confirmed once we've seen the same subject twice
const _MAX_AGE_MS    = 15_000;  // hard ceiling — even a flickering match dies after 15 s
const _PATH_CAP      = 60;      // bound per-track memory; renderer slices the tail

export class IoUTracker {
  constructor(opts = {}){
    this._tracks = new Map();   // id -> track entry
    this._nextId = 1;
    this._lastDropped = [];     // tracks dropped on the most recent tick(); read once via lastDropped()
    // Last tick's matched-pair IoUs, one entry per accepted greedy
    // match. Drives the K13 "letzter Match" strip. Empty array when
    // a tick produced no matches (e.g. only spawns or only drops).
    this._lastMatches = [];
    this._minIou = Number.isFinite(opts.minIou) && opts.minIou > 0
      ? opts.minIou : _DEFAULT_MIN_IOU;
    this._missGraceMs = Number.isFinite(opts.missGraceMs) && opts.missGraceMs > 0
      ? opts.missGraceMs : _DEFAULT_MISS_GRACE_MS;
  }

  // Adjustable thresholds — live.js pushes form values here per tick
  // so editing the four track_* inputs immediately changes simulator
  // matching behaviour. Zero / blank / NaN keeps the previous value
  // so a transient empty input doesn't reset the tracker. Out-of-range
  // values clamp to safe bounds.
  setThresholds({ minIou, missGraceMs } = {}){
    if (Number.isFinite(minIou) && minIou > 0){
      this._minIou = Math.max(0, Math.min(0.95, minIou));
    }
    if (Number.isFinite(missGraceMs) && missGraceMs > 0){
      this._missGraceMs = Math.max(0, Math.min(_MAX_AGE_MS, missGraceMs));
    }
  }

  // dets : Array<{ label:string, bbox:[x,y,w,h], score:number, verdict:string }>
  // returns confirmed tracks (hit_count ≥ _PROMOTE_HITS), in insertion order
  tick(dets, now_ms){
    this._lastDropped = [];
    this._lastMatches = [];
    // 1. Build per-label candidate pairs (same label only — a "person"
    //    detection should never inherit a "bird" track even if their
    //    bboxes happen to overlap).
    const pairs = [];
    for (const det of dets){
      for (const track of this._tracks.values()){
        if (track.label !== det.label) continue;
        const iouVal = _iou(track.bbox, det.bbox);
        if (iouVal < this._minIou) continue;
        pairs.push({ det, track, iou: iouVal });
      }
    }
    pairs.sort((a, b) => b.iou - a.iou);

    // 2. Greedy descending-IoU matching. A pair where either side
    //    is already taken gets skipped — the higher-IoU pair wins.
    const matchedDets = new Set();
    const matchedTracks = new Set();
    for (const pair of pairs){
      if (matchedDets.has(pair.det) || matchedTracks.has(pair.track)) continue;
      matchedDets.add(pair.det);
      matchedTracks.add(pair.track);
      _updateTrack(pair.track, pair.det, now_ms);
      this._lastMatches.push({ trackId: pair.track.id, label: pair.track.label, iou: pair.iou });
    }

    // 3. Open provisional tracks for unmatched detections. They start
    //    at hit_count=1 — one more matched tick promotes them.
    for (const det of dets){
      if (matchedDets.has(det)) continue;
      const id = this._nextId++;
      const cx = det.bbox[0] + det.bbox[2] / 2;
      const cy = det.bbox[1] + det.bbox[3] / 2;
      this._tracks.set(id, {
        id,
        label: det.label,
        bbox: det.bbox.slice(),
        last_verdict: det.verdict,
        last_score: det.score,
        best_score: det.score,
        last_seen_ms: now_ms,
        hit_count: 1,
        miss_count: 0,
        path: [{ t: now_ms, cx, cy }],
      });
    }

    // 4. Drop stale tracks via wall-clock miss-grace. Iterate over a
    //    frozen snapshot so the .delete() calls don't disturb a live
    //    iterator. The hard _MAX_AGE_MS ceiling backstops the grace
    //    window when the user dials grace_seconds up to 30 s.
    for (const [id, track] of Array.from(this._tracks.entries())){
      if (!matchedTracks.has(track)){
        track.miss_count += 1;
      }
      const sinceSeen = now_ms - track.last_seen_ms;
      const stale = sinceSeen > this._missGraceMs
        || sinceSeen > _MAX_AGE_MS;
      if (stale){
        this._tracks.delete(id);
        // Capture the dropped track for the next caller of
        // lastDropped() — the timeline uses this to render a "× lost"
        // marker at the row's trailing edge.
        if (track.hit_count >= _PROMOTE_HITS){
          this._lastDropped.push(track);
        }
      }
    }

    // 5. Confirmed tracks only (hit_count ≥ promote threshold).
    return Array.from(this._tracks.values()).filter(t => t.hit_count >= _PROMOTE_HITS);
  }

  // Tracks dropped on the most recent tick(). Returns confirmed
  // tracks only — a provisional one-hit-then-gone subject doesn't
  // emit a lost marker because it was never visualised in the first
  // place. Snapshot-style copy: the renderer can mutate the array.
  lastDropped(){
    return this._lastDropped.slice();
  }

  // Snapshot of every active track (provisional + confirmed). Drives
  // the K13 threshold info strip: it needs every score even on
  // first-hit subjects so the user sees a sub-spawn score the moment
  // it's detected, not after the second confirming tick. Snapshot
  // copy so the consumer can iterate safely.
  activeTracks(){
    return Array.from(this._tracks.values());
  }

  // IoUs of every accepted match on the most recent tick, paired with
  // the track id. Empty array on ticks that produced no matches.
  lastMatches(){
    return this._lastMatches.slice();
  }
}

function _updateTrack(track, det, now_ms){
  track.bbox = det.bbox.slice();
  track.last_seen_ms = now_ms;
  track.last_verdict = det.verdict;
  track.last_score = det.score;
  if (!Number.isFinite(track.best_score) || det.score > track.best_score){
    track.best_score = det.score;
  }
  track.hit_count += 1;
  track.miss_count = 0;
  const cx = det.bbox[0] + det.bbox[2] / 2;
  const cy = det.bbox[1] + det.bbox[3] / 2;
  track.path.push({ t: now_ms, cx, cy });
  if (track.path.length > _PATH_CAP){
    track.path.splice(0, track.path.length - _PATH_CAP);
  }
}

// IoU of two [x,y,w,h] bboxes. Returns 0 for non-overlapping or
// degenerate (zero-area) inputs — IoUTracker.tick filters those
// out via the _MIN_IOU threshold.
function _iou(a, b){
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(a[0], b[0]);
  const iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const aArea = a[2] * a[3];
  const bArea = b[2] * b[3];
  const union = aArea + bArea - inter;
  return union > 0 ? inter / union : 0;
}

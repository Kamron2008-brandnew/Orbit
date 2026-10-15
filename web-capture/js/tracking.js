// Finding the object in the middle of the view and following it.

import { haptic } from "./haptics.js";
import { motion } from "./motion.js";
import { click } from "./sound.js";
import { colorHist, histSimilarity, resampleContour } from "./vision.js";
import { rebuildTargets } from "./scenes/camera.js";
import { analyzer, outliner, state, targets } from "./state.js";
import { syncCanScan } from "./ui.js";
import { clamp } from "./util.js";

export function updateObject(obj, fromRefiner = false) {
  let ok = obj && obj.frac > 0.008 && obj.frac < 0.8 && obj.edges < 3;
  // Before scanning, the outline must stay one plausible object: not most of the view (the table, the wall),
  // and following a real edge nearly all the way round. A new guess must also be where the camera points.
  // (Once locked the bar is a little lower, so a moment of blur doesn't drop a good object.)
  if (
    ok &&
    state.phase === "live" &&
    (obj.frac > 0.62 || edgeSupport(obj) < (state.locked ? 0.66 : 0.78) || (!state.locked && !nearCentre(obj, 0.08)))
  )
    ok = false;
  // Same object? Its colour make-up must match what you chose. Stops the tracker sliding onto the table,
  // the wall or a neighbouring object, the main way a live outline "picks up the wrong thing".
  if (ok && state.refHist && !fromRefiner && analyzer.rgba) {
    const sim = histSimilarity(state.refHist, colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj));
    if (sim < (state.locked ? 0.45 : 0.6)) ok = false;
  }
  // A single odd frame (a reflection, a hand passing) shouldn't replace a good outline: ignore sudden jumps
  // in size or position unless they persist.
  if (ok && state.locked && state.obj && state.fracEMA) {
    const jump =
      obj.frac > state.fracEMA * 1.9 ||
      obj.frac < state.fracEMA * 0.45 ||
      Math.hypot(obj.center[0] - state.obj.center[0], obj.center[1] - state.obj.center[1]) > 0.22;
    if (jump && ++state.glitch < 4) return;
  }
  state.glitch = 0;
  if (ok) {
    state.fracEMA = state.fracEMA ? state.fracEMA * 0.8 + obj.frac * 0.2 : obj.frac;
    state.obj = obj;
    state.lastObj = obj;
    if (!fromRefiner) state.precise = false;
    state.lost = 0;
    state.lastLockedAt = performance.now();
    state.valid++;
    state.seed = obj.seed;
    rebuildTargets(obj);
    if (!state.locked && (state.valid >= 2 || fromRefiner)) {
      state.locked = true;
      state.userSeed = null; // from here on, follow the object itself
      state.lockedAt = performance.now();
      if (state.phase === "live") {
        haptic("tap");
        click(0.15);
      } // found it
    }
  } else {
    state.valid = 0;
    state.lost++;
    if (state.lost > 7 && state.locked) {
      // keep the selection: the tracker keeps looking where the object was, and re-finds it by colour
      state.locked = false;
      state.obj = null;
      state.fracEMA = 0;
    }
  }
}

// Nothing to tap: the object in the middle of the view is found and outlined on its own. A guess is kept only
// once it settles into one plausible whole object, and it is let go when you point at something else.
// Recording never starts by itself: only the shutter starts it.
const PROBES = [
  [0.5, 0.5],
  [0.5, 0.57],
  [0.5, 0.43],
  [0.44, 0.5],
  [0.56, 0.5],
];

function nearCentre(o, margin) {
  const [x0, y0, x1, y1] = o.boxN;
  return 0.5 > x0 - margin && 0.5 < x1 + margin && 0.5 > y0 - margin && 0.5 < y1 + margin;
}

// How much of an outline sits on a real edge: the share of its length with a clear colour step across it.
// A real object's outline follows its edge almost all the way round; a patch of floor or wall that the
// segmenter cut out only follows real edges in places (tested: the bottle 0.94, a false patch beside it 0.57).
function edgeSupport(obj) {
  const rgba = analyzer.rgba,
    AW = analyzer.W,
    AH = analyzer.H;
  const rc = rgba && resampleContour(obj.contour, 72);
  if (!rc) return 0;
  const px = rc.map(([x, y]) => [x * AW, y * AH]);
  const cx = obj.center[0] * AW,
    cy = obj.center[1] * AH;
  const at = (x, y) => (clamp(Math.round(y), 0, AH - 1) * AW + clamp(Math.round(x), 0, AW - 1)) * 4;
  let on = 0;
  for (let i = 0; i < px.length; i++) {
    const p = px[i],
      a = px[(i + px.length - 1) % px.length],
      b = px[(i + 1) % px.length];
    let nx = a[1] - b[1],
      ny = b[0] - a[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L;
    ny /= L;
    if (nx * (p[0] - cx) + ny * (p[1] - cy) < 0) {
      nx = -nx;
      ny = -ny;
    } // point it outwards
    let step = 0;
    for (const e of [2, 3, 4]) {
      // the outline may sit a pixel or two off the true edge
      const u = at(p[0] - nx * e, p[1] - ny * e),
        v = at(p[0] + nx * e, p[1] + ny * e);
      step = Math.max(step, Math.hypot(rgba[u] - rgba[v], rgba[u + 1] - rgba[v + 1], rgba[u + 2] - rgba[v + 2]));
    }
    if (step >= 14) on++;
  }
  return on / px.length;
}

export function autoDetect(now) {
  if (state.phase !== "live" || !outliner.ready) return;
  if (!state.selected) {
    // let the view settle for a moment so it doesn't grab whatever swings past
    if (motion.available && motion.shake > 90) state.steadySince = now;
    if (now - state.steadySince < 300 || now - state.probeAt < 250) return;
    const [x, y] = PROBES[state.probe++ % PROBES.length];
    state.probeAt = now;
    selectAt(x, y);
    return;
  }
  if (state.locked) state.seenAt = now;
  // a guess that never settled into an object, or an object that was lost: look again
  else if (now - Math.max(state.probeAt, state.seenAt) > 1600) {
    clearSelection();
    return;
  }
  // pointed at something else: once the middle of the view has been off the object for a moment, let it go
  if (state.locked && state.obj) {
    if (nearCentre(state.obj, 0.1)) state.offCentreSince = 0;
    else if (!state.offCentreSince) state.offCentreSince = now;
    else if (now - state.offCentreSince > 1200) {
      state.probe = 0;
      clearSelection();
    }
  }
}

function selectAt(nx, ny) {
  Object.assign(state, {
    selected: true,
    obj: null,
    lastObj: null,
    locked: false,
    valid: 1,
    lost: 0,
    glitch: 0,
    fracEMA: 0,
    seed: [nx, ny],
    userSeed: [nx, ny],
    precise: false,
    refHist: null,
    offCentreSince: 0,
    edit: { pos: [[nx, ny]] },
    pendingSelect: { at: performance.now() },
    retargetUntil: performance.now() + 1500,
  });
  outliner.prev = null;
  syncCanScan();
}

export function clearSelection() {
  Object.assign(state, {
    selected: false,
    obj: null,
    lastObj: null,
    locked: false,
    valid: 0,
    lost: 0,
    precise: false,
    refHist: null,
    pendingSelect: null,
    edit: { pos: [] },
    userSeed: null,
    offCentreSince: 0,
  });
  targets.ready = false;
  outliner.prev = null;
  syncCanScan();
}

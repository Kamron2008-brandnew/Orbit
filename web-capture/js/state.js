// What the whole app shares: its state, the page elements it drives, and the long-lived objects.

import { Particles } from "./particles.js";
import { Refiner } from "./refine.js";
import { FrameAnalyzer, Outliner } from "./vision.js";
import { COUNT, EDGE, FILL } from "./config.js";

export const $ = (id) => document.getElementById(id);
export const body = document.body;
export const video = $("cam");
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const state = {
  phase: "intro",
  mode: "walk",
  panel: null,
  stream: null,
  track: null,
  torch: false,
  wakeLock: null,
  // selection: found automatically in the middle of the view. `obj` is the current outline (live tracker or precise).
  selected: false,
  obj: null,
  lastObj: null,
  locked: false,
  valid: 0,
  lost: 0,
  seed: [0.5, 0.5],
  userSeed: null,
  lockedAt: 0,
  retargetUntil: 0,
  precise: false,
  pendingSelect: null,
  edit: { pos: [] },
  refHist: null,
  lastRefineAt: 0,
  refining: null,
  probe: 0,
  probeAt: 0,
  seenAt: 0,
  steadySince: 0,
  offCentreSince: 0,
  lastStats: null,
  sharpEMA: 0,
  lastTick: 0,
  segSkip: 0,
  fracEMA: 0,
  glitch: 0,
  scan: null,
  scanCount: 0,
  level: "info",
  status: "",
  caption: "",
  cand: null,
  candSince: 0,
  lastWarnFx: 0,
  lastSpoken: "",
  hint: null,
  lastLockedAt: 0,
  armHeading: null,
  armTime: 0,
  introStart: performance.now(),
  reviewing: null,
  preparedZip: null,
  cloudYaw: 0.6,
  cloudSpin: 0.25,
  cloudPitch: 0.28,
  dragging: false,
  dustCursor: 0,
};

export const analyzer = new FrameAnalyzer(256);
export const outliner = new Outliner();
export const refiner = new Refiner();
export const particles = new Particles($("particles"), COUNT);

export const frameCanvas = document.createElement("canvas");
export const frameCtx = frameCanvas.getContext("2d");

// object targets, rebuilt whenever a new outline arrives (normalized frame coordinates + colours)
export const targets = {
  ready: false,
  edge: new Float32Array((EDGE[1] - EDGE[0]) * 2),
  edgeCol: new Float32Array((EDGE[1] - EDGE[0]) * 3),
  fillU: new Float32Array(FILL[1] - FILL[0]),
  fillV: new Float32Array(FILL[1] - FILL[0]),
  fill: new Float32Array((FILL[1] - FILL[0]) * 2),
  fillCol: new Float32Array((FILL[1] - FILL[0]) * 3),
  fillOK: new Uint8Array(FILL[1] - FILL[0]),
  box: [0, 0, 1, 1],
};

// Body points sit on an evenly jittered grid (like a structured-light pattern), visited in shuffled order so
// that switching more of them on fills the object evenly rather than top to bottom.
{
  const n = FILL[1] - FILL[0],
    side = Math.ceil(Math.sqrt(n));
  const order = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
  order.forEach((cell, j) => {
    targets.fillU[j] = ((cell % side) + 0.5 + (Math.random() - 0.5) * 0.5) / side;
    targets.fillV[j] = (Math.floor(cell / side) + 0.5 + (Math.random() - 0.5) * 0.5) / side;
  });
}

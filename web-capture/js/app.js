import { haptic, setHaptics } from "./haptics.js";
import { configureSound, unlockAudio, click, chime, say } from "./sound.js";
import { motion, requestMotion, angleDiff } from "./motion.js";
import { FrameAnalyzer, Outliner, findObject, resampleContour, maskToBlob, colorHist, histSimilarity, resampleMask } from "./vision.js";
import { Refiner } from "./refine.js";
import { guard, logError, report, setPhaseReader } from "./guard.js";
import { BANDS, bandFor, sectorFor, emptyCoverage, bandFill, progressOf, targetBand, topBonus } from "./geometry.js";
import { Particles, project, introShapes } from "./particles.js";
import { carveHull, toPly } from "./hull.js";
import { makeZip } from "./zip.js";
import * as store from "./store.js";

const VERSION = "4.0";
const MAX_FRAMES = 220;
const MAX_VIEWS = 96;               // silhouettes kept in memory for the 3D preview
const SPIN_REV_SECONDS = 26;        // turntable: seconds of steady turning counted as one revolution
const LIGHT = { dark: 48, bright: 224 };
const TICK_MS = 85;

// particle budget
const COUNT = 7200;
const VISIBLE_DUST_END = 2600;      // particles past this are a reserve: hidden until the dense 3D model needs them
const EDGE = [0, 600];              // outline of the object
const FILL = [600, 1500];           // body of the object
const RING = [1500, 2000];          // coverage rings
const SEEK = [2000, 2160];          // searching reticle
const RING_COUNTS = [300, 140];
const RING_LAT = [8, 58];           // degrees: the loop around, the optional top pass
const SHAPE_SECONDS = 4.6;          // intro: how long each shape holds before the next is scanned in
const MORPH_SECONDS = 1.9;          // intro: the scanning ring's pass, top to bottom
const INTRO_N = 2400;               // intro: points in each gallery shape
const INTRO_FLOOR = [2400, 2700];   // intro: the turntable ring under the shape
const INTRO_SCAN = [2700, 2900];    // intro: the scanning ring, resting in the floor ring between passes
const INTRO_STARS = [2900, 4300];   // intro: the starfield, at three depths

const $ = id => document.getElementById(id);
const body = document.body;
const video = $("cam");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (!("switch" in HTMLInputElement.prototype)) document.documentElement.classList.add("no-switch");

/* ---------- settings ---------- */
const DEFAULTS = { haptics: true, sound: true, voice: false, autoFinish: true, maxDetail: true, dense: false, video: false, precise: true };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("orbit.settings") || "{}") }; } catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => { try { localStorage.setItem("orbit.settings", JSON.stringify(settings)); } catch {} };
const applySettings = () => { setHaptics(settings.haptics); configureSound(settings); };
applySettings();
// If the last run died in the middle of something heavy, don't do that the same way again, and say so.
// (Everything stays switchable in Settings: this only steps down, it never locks anything.)
const crashNotice = (() => {
  const died = guard.crashed;
  if (!died.length) return null;
  const has = n => died.some(d => d === n || d.startsWith(n));
  let msg;
  if (has("scan")) {
    Object.assign(settings, { maxDetail: false, dense: false, video: false });
    msg = "Orbit restarted during a scan, so it switched to standard detail to use less memory. Maximum detail is in Settings.";
  } else if (has("refiner")) {
    settings.precise = false;
    msg = "Orbit restarted while loading precise outlines, so they're off for now. You can try them again in Settings.";
  } else if (has("outliner")) {
    msg = "Orbit restarted while loading object detection, so it's using the safer mode now.";
  } else if (has("pack")) {
    msg = "Orbit restarted while packing the zip. If scans are large, turn off video and extra frames in Settings.";
  } else msg = "Orbit restarted unexpectedly. Details are in Settings, under Stability.";
  try { localStorage.setItem("orbit.settings", JSON.stringify(settings)); } catch {}
  return msg;
})();
let unit = (() => { try { return localStorage.getItem("orbit.unit") || "cm"; } catch { return "cm"; } })();

/* ---------- state ---------- */
const S = {
  phase: "intro", mode: "walk", panel: null,
  stream: null, track: null, torch: false, wakeLock: null,
  // selection: found automatically in the middle of the view. `obj` is the current outline (live tracker or precise).
  selected: false, obj: null, lastObj: null, locked: false, valid: 0, lost: 0, seed: [0.5, 0.5], userSeed: null,
  lockedAt: 0, retargetUntil: 0, precise: false, pendingSelect: null, edit: { pos: [] },
  refHist: null, lastRefineAt: 0, refining: null,
  probe: 0, probeAt: 0, seenAt: 0, steadySince: 0, offCentreSince: 0,
  lastStats: null, sharpEMA: 0, lastTick: 0, segSkip: 0, fracEMA: 0, glitch: 0,
  scan: null, scanCount: 0,
  level: "info", status: "", caption: "", cand: null, candSince: 0, lastWarnFx: 0, lastSpoken: "",
  hint: null, lastLockedAt: 0, armHeading: null, armTime: 0, introStart: performance.now(),
  reviewing: null, preparedZip: null,
  cloudYaw: 0.6, cloudSpin: 0.25, cloudPitch: 0.28, dragging: false,
  dustCursor: 0,
};

setPhaseReader(() => S.phase);
const analyzer = new FrameAnalyzer(256);
const outliner = new Outliner();
const refiner = new Refiner();
const P = new Particles($("particles"), COUNT);
const SHAPES = introShapes(INTRO_N);
// each shape's width at every height, so the scanning ring hugs the object as it passes
for (const sh of SHAPES) {
  const prof = new Float32Array(33);
  for (let i = 0; i < INTRO_N; i++) {
    const k = Math.round((sh.pts[3 * i + 1] + 1) * 16);
    if (k >= 0 && k <= 32) prof[k] = Math.max(prof[k], Math.hypot(sh.pts[3 * i], sh.pts[3 * i + 2]));
  }
  sh.prof = prof.map((v, k) => Math.max(v, prof[k - 1] || 0, prof[k + 1] || 0));
}
const SHAPE_NAMES = { vase: "Vase", knot: "Trefoil knot", planet: "Ringed planet", helix: "Double helix", gem: "Cut gem", heart: "Heart", torus: "Torus" };
// intro state: which shape is shown, the pass that scans in the next, and the turntable you can spin
const I = {
  cur: -1, shownAt: 0, morph: null, side: new Uint8Array(INTRO_N),
  yaw: 0.6, spin: 0.42, tilt: 0, dragging: false, par: 0, parT: 0, snap: true,
};
const cap = document.createElement("canvas");
const capCtx = cap.getContext("2d");

// object targets, rebuilt whenever a new outline arrives (normalized frame coordinates + colours)
const T = {
  ready: false,
  edge: new Float32Array((EDGE[1] - EDGE[0]) * 2), edgeCol: new Float32Array((EDGE[1] - EDGE[0]) * 3),
  fillU: new Float32Array(FILL[1] - FILL[0]), fillV: new Float32Array(FILL[1] - FILL[0]),
  fill: new Float32Array((FILL[1] - FILL[0]) * 2), fillCol: new Float32Array((FILL[1] - FILL[0]) * 3), fillOK: new Uint8Array(FILL[1] - FILL[0]),
  box: [0, 0, 1, 1],
};

// Body points sit on an evenly jittered grid (like a structured-light pattern), visited in shuffled order so
// that switching more of them on fills the object evenly rather than top to bottom.
{
  const n = FILL[1] - FILL[0], side = Math.ceil(Math.sqrt(n));
  const order = Array.from({ length: n }, (_, i) => i).sort(() => Math.random() - 0.5);
  order.forEach((cell, j) => {
    T.fillU[j] = ((cell % side) + 0.5 + (Math.random() - 0.5) * 0.5) / side;
    T.fillV[j] = (Math.floor(cell / side) + 0.5 + (Math.random() - 0.5) * 0.5) / side;
  });
}

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const slug = s => (s || "scan").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scan";
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fract = x => x - Math.floor(x);
// The ambient palette the particles glow in: ice cyan, periwinkle, violet, rose, and round again.
const AMB = [[0.56, 0.89, 1], [0.62, 0.74, 1], [0.76, 0.63, 1], [1, 0.66, 0.84], [0.56, 0.89, 1]];
const ambC = [0, 0, 0];
function amb(f, out = ambC) {
  const u = fract(f) * 4, k = Math.floor(u), w = u - k, a = AMB[k], b = AMB[k + 1];
  out[0] = a[0] + (b[0] - a[0]) * w; out[1] = a[1] + (b[1] - a[1]) * w; out[2] = a[2] + (b[2] - a[2]) * w;
  return out;
}
let toastTimer = 0;
function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function setPhase(p) {
  S.phase = p;
  body.dataset.phase = p;
  $("shutter").setAttribute("aria-label", p === "scanning" ? "Finish scan" : "Start scan");
  syncDim();
  syncCanScan();
}
const syncDim = () => body.classList.toggle("dim", S.phase === "review" || !!S.panel);
const when = ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
function shortWhen(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function coverMap() {
  const vw = video.videoWidth || 1080, vh = video.videoHeight || 1920;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const dw = vw * s, dh = vh * s;
  return { ox: (innerWidth - dw) / 2, oy: (innerHeight - dh) / 2, dw, dh };
}

/* ======================================================================
   Particle formations
   ====================================================================== */
function dust(i, dim = 1) {
  const s = P.seed[i], s2 = P.seed2[i];
  const c = amb(s2 * 0.75); // each mote has its own tint from the ambient palette
  P.free(i, 1 + s * 1.7, 0.35 + 0.65 * c[0], 0.35 + 0.65 * c[1], 0.35 + 0.65 * c[2], i < VISIBLE_DUST_END ? (0.08 + s2 * 0.2) * dim : 0);
}

const easeInOut = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const hash = k => fract(Math.sin(k * 12.9898 + 78.233) * 43758.5453);

// Start the scanning ring's pass that builds the next shape (from loose dust, the first time).
function nextShape(now) {
  const to = (I.cur + 1) % SHAPES.length;
  I.morph = { from: I.cur, to, at: now };
  I.side.fill(0);
  const sh = SHAPES[to], [lo, hi] = sh.palette;
  const css = c => `rgb(${c.map(v => Math.round(v * 255)).join(",")})`;
  const intro = $("intro");
  intro.style.setProperty("--amb-a", css(hi));
  intro.style.setProperty("--amb-b", css(lo));
  const label = $("specimen");
  label.classList.remove("show");
  setTimeout(() => {
    $("specName").textContent = SHAPE_NAMES[sh.name] || sh.name;
    $("specMeta").textContent = `${INTRO_N.toLocaleString()} points`;
    label.classList.add("show");
  }, reduceMotion ? 0 : 380);
}

function formIntro(now, dt) {
  const r = $("introAnchor").getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.47;
  const scale = Math.min(r.width * 0.36, r.height * 0.38);
  const t = now / 1000;
  const o = [0, 0, 0];
  // the turntable: turns on its own, or with your finger, then eases back to its own pace
  if (!I.dragging) {
    I.yaw += I.spin * dt;
    I.spin += (0.42 - I.spin) * Math.min(1, dt * 0.9);
    I.tilt *= 1 - Math.min(1, dt * 1.5);
  }
  I.par += (I.parT - I.par) * Math.min(1, dt * 3);
  const yaw = I.yaw, pitch = 0.28 + I.tilt;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw);

  if (!I.morph) {
    if (I.cur < 0) nextShape(now + 400); // the very first pass starts a moment after the nebula appears
    else if (now - I.shownAt > SHAPE_SECONDS * 1000) nextShape(now);
  }
  const M = I.morph;
  // the pass: the ring rises to the top, then sweeps down; points below it are still the old shape
  let planeY = 2, prog = 1;
  if (M) {
    const age = Math.max(0, now - M.at) / 1000, rise = reduceMotion ? 0 : 0.35;
    prog = clamp((age - rise) / (reduceMotion ? 0.01 : MORPH_SECONDS), 0, 1);
    planeY = 1.22 - 2.44 * easeInOut(prog);
    if (prog >= 1 && age > rise + MORPH_SECONDS + 0.05) { I.cur = M.to; I.morph = null; I.shownAt = now; }
  }
  const showIdx = M ? M.to : I.cur;
  const B = SHAPES[showIdx], A = M && M.from >= 0 ? SHAPES[M.from] : null;
  // light from the upper left, a little in front: soft shading plus a moving glint, so the cloud reads as solid
  const Lx = -0.52, Ly = 0.5, Lz = 0.69, Hx = Lx / 1.84, Hy = Ly / 1.84, Hz = (Lz + 1) / 1.84;

  for (let i = 0; i < INTRO_N; i++) {
    const yB = B.pts[3 * i + 1];
    let S2 = B, pass = true;
    if (M && planeY > yB) { pass = false; S2 = A; }
    if (M && pass && !I.side[i]) { I.side[i] = 1; P.kick(i, (Math.random() - 0.5) * 24, -12 - Math.random() * 16, 140); } // scanned: a brief flash
    if (!S2) { // the first pass condenses the shape out of a faint, slowly turning nebula at the same heights
      const a = hash(i) * Math.PI * 2 + t * (0.1 + 0.1 * hash(i + 0.3)), rr = 1.25 + hash(i + 0.5) * 1.1;
      project(Math.cos(a) * rr, yB + (hash(i + 0.9) - 0.5) * 0.08, Math.sin(a) * rr, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 2) / 4, 0, 1), c = amb(hash(i + 0.2) * 0.8);
      (I.snap ? P.place : P.attract).call(P, i, o[0], o[1], 0.9 + 1.2 * d, c[0], c[1], c[2], 0.06 + 0.16 * d); // first frame: already there
      continue;
    }
    const x = S2.pts[3 * i], y = S2.pts[3 * i + 1], z = S2.pts[3 * i + 2];
    project(x, y, z, yaw, pitch, cx, cy, scale, o);
    const d = clamp((o[2] + 0.8) / 1.6, 0, 1);
    // a rough surface normal (out from the axis), turned with the shape
    const xr = x * cyw + z * syw, zr = -x * syw + z * cyw;
    const nl = Math.hypot(xr, y * 0.35, zr) || 1, nx = xr / nl, ny = (y * 0.35) / nl, nz = zr / nl;
    const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
    const spec = Math.pow(Math.max(0, nx * Hx + ny * Hy + nz * Hz), 22);
    const [lo, hi] = S2.palette, h = (y + 1) / 2;
    const near = M ? Math.max(0, 1 - Math.abs(yB - planeY) / 0.1) : 0; // just scanned: white hot
    const lum = 0.5 + 0.3 * diff + 0.25 * d;
    const w = Math.min(1, spec * 0.85 + near * 0.8);
    const cr = (lo[0] + (hi[0] - lo[0]) * h) * lum, cg = (lo[1] + (hi[1] - lo[1]) * h) * lum, cb = (lo[2] + (hi[2] - lo[2]) * h) * lum;
    P.attract(i, o[0], o[1], 1.3 + 2.1 * d + spec * 1.6 + near * 1.5,
      Math.min(1, cr + (1 - cr) * w), Math.min(1, cg + (1 - cg) * w), Math.min(1, cb + (1 - cb) * w), Math.min(1, 0.26 + 0.7 * d + near));
  }

  // the turntable ring under the shape, in the ambient palette
  const fN = INTRO_FLOOR[1] - INTRO_FLOOR[0];
  for (let j = 0; j < fN; j++) {
    const a = (j / fN) * Math.PI * 2 + t * 0.12;
    project(Math.cos(a) * 0.95, -1.1, Math.sin(a) * 0.95, yaw, pitch, cx, cy, scale, o);
    const d = clamp((o[2] + 1) / 2, 0, 1), c = amb(j / fN + t * 0.03);
    (I.snap ? P.place : P.attract).call(P, INTRO_FLOOR[0] + j, o[0], o[1], 1 + 1.5 * d, c[0], c[1], c[2], 0.08 + 0.42 * d);
  }

  // the scanning ring: rests in the floor ring, rises to the top for a pass, and hugs the shape on the way down
  const sN = INTRO_SCAN[1] - INTRO_SCAN[0];
  const prof = sh => { const k = clamp((planeY + 1) * 16, 0, 32), k0 = Math.floor(k), k1 = Math.min(32, k0 + 1); return sh.prof[k0] + (sh.prof[k1] - sh.prof[k0]) * (k - k0); };
  const ringR = M ? Math.max(0.3, Math.max(prof(B), A ? prof(A) : 0) + 0.14) : 0.95;
  const [blo, bhi] = B.palette;
  for (let j = 0; j < sN; j++) {
    const i = INTRO_SCAN[0] + j;
    const a = (j / sN) * Math.PI * 2 - t * 0.9;
    if (M && prog > 0 && prog < 1) {
      project(Math.cos(a) * ringR, planeY, Math.sin(a) * ringR, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1.2) / 2.4, 0, 1), h = clamp((planeY + 1) / 2, 0, 1);
      const cr = blo[0] + (bhi[0] - blo[0]) * h, cg = blo[1] + (bhi[1] - blo[1]) * h, cb = blo[2] + (bhi[2] - blo[2]) * h;
      P.place(i, o[0], o[1], 2.2 + 3 * d, 0.6 + 0.4 * cr, 0.6 + 0.4 * cg, 0.6 + 0.4 * cb, 0.5 + 0.5 * d);
    } else if (M && prog === 0) { // rising
      project(Math.cos(a) * ringR, 1.22, Math.sin(a) * ringR, yaw, pitch, cx, cy, scale, o);
      P.attract(i, o[0], o[1], 2.2, 1, 1, 1, 0.8);
    } else { // resting among the floor ring
      const fa = ((j + 0.5) / sN) * Math.PI * 2 + t * 0.12;
      project(Math.cos(fa) * 0.95, -1.1, Math.sin(fa) * 0.95, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1) / 2, 0, 1), c = amb(j / sN + t * 0.03);
      (I.snap ? P.place : P.attract).call(P, i, o[0], o[1], 1 + 1.5 * d, c[0], c[1], c[2], 0.08 + 0.42 * d);
    }
  }
  I.snap = false;

  // stars at three depths, drifting slowly and shifting with the turntable (parallax)
  const W = innerWidth, H = innerHeight;
  for (let i = INTRO_STARS[0]; i < INTRO_STARS[1]; i++) {
    const k = i - INTRO_STARS[0], layer = k % 3, h1 = hash(k), h2 = hash(k + 0.37), h3 = hash(k + 0.71);
    const depth = [0.25, 0.55, 1][layer];
    const x = ((h1 * (W + 80) + t * 2.2 * depth + (yaw - t * 0.42) * 26 * depth + I.par * depth) % (W + 80) + (W + 80)) % (W + 80) - 40;
    const y = h2 * (H + 40) - 20 + Math.sin(t * 0.07 + h3 * 6) * 6 * depth;
    const bright = h3 > 0.975; // a few brighter stars
    const tw = 0.55 + 0.45 * Math.sin(t * (0.6 + h3 * 1.6) + h1 * 40);
    const c = amb(h2 * 0.8);
    const mix = bright ? 0.5 : 0.25;
    const size = bright ? 2.6 : [0.9, 1.3, 1.8][layer];
    const alpha = (bright ? 0.75 : [0.16, 0.26, 0.38][layer]) * tw;
    P.place(i, x, y, size, 1 - mix + mix * c[0], 1 - mix + mix * c[1], 1 - mix + mix * c[2], alpha);
  }
  for (let i = INTRO_STARS[1]; i < COUNT; i++) P.free(i, 1, 1, 1, 1, 0);
}

// The intro shape is a turntable: drag to spin or tilt it, tap it for the next one.
{
  const intro = $("intro");
  let sx = 0, sy = 0, lx = 0, ly = 0, lt = 0, v = 0, moved = false, down = false;
  intro.addEventListener("pointerdown", e => {
    if (S.phase !== "intro" || e.target.closest(".intro-copy")) return;
    down = true; moved = false; sx = lx = e.clientX; sy = ly = e.clientY; lt = e.timeStamp; v = 0;
    I.dragging = true;
    intro.setPointerCapture(e.pointerId);
  });
  intro.addEventListener("pointermove", e => {
    if (!down) return;
    const dx = e.clientX - lx, dy = e.clientY - ly, dtm = Math.max(1, e.timeStamp - lt);
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) moved = true;
    I.yaw += dx * 0.009;
    I.tilt = clamp(I.tilt + dy * 0.004, -0.45, 0.45);
    I.parT = clamp(I.parT + dx * 0.4, -60, 60);
    v = v * 0.6 + (dx * 0.009 / (dtm / 1000)) * 0.4;
    lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
  });
  const end = () => {
    if (!down) return;
    down = false; I.dragging = false;
    I.parT = 0;
    if (moved) { I.spin = clamp(v, -6, 6); return; }
    if (!I.morph) { haptic("tap"); nextShape(performance.now()); } // a tap scans in the next shape
  };
  intro.addEventListener("pointerup", end);
  intro.addEventListener("pointercancel", end);
}

function rebuildTargets(obj) {
  const { W, H, lab } = obj;
  const rgba = analyzer.rgba, AW = analyzer.W, AH = analyzer.H;
  const rc = resampleContour(obj.contour, EDGE[1] - EDGE[0]);
  if (!rc || !rgba) return;
  const [cx, cy] = obj.center;
  const sample = (nx, ny, out, o) => {
    const px = clamp(Math.round(nx * AW), 0, AW - 1), py = clamp(Math.round(ny * AH), 0, AH - 1);
    const q = (py * AW + px) * 4;
    out[o] = rgba[q] / 255; out[o + 1] = rgba[q + 1] / 255; out[o + 2] = rgba[q + 2] / 255;
  };
  for (let j = 0; j < rc.length; j++) {
    T.edge[2 * j] = rc[j][0]; T.edge[2 * j + 1] = rc[j][1];
    sample(rc[j][0] + (cx - rc[j][0]) * 0.06, rc[j][1] + (cy - rc[j][1]) * 0.06, T.edgeCol, 3 * j); // just inside the edge
  }
  const [x0, y0, x1, y1] = obj.box;
  for (let j = 0; j < T.fillOK.length; j++) {
    const px = Math.floor(x0 + T.fillU[j] * (x1 - x0)), py = Math.floor(y0 + T.fillV[j] * (y1 - y0));
    const inside = px >= 0 && py >= 0 && px < W && py < H && lab[py * W + px] === 1;
    T.fillOK[j] = inside ? 1 : 0;
    if (inside) {
      T.fill[2 * j] = (px + 0.5) / W; T.fill[2 * j + 1] = (py + 0.5) / H;
      sample(T.fill[2 * j], T.fill[2 * j + 1], T.fillCol, 3 * j);
    }
  }
  T.box = obj.boxN;
  T.ready = true;
}

const lift = c => Math.min(1, c * 1.1 + 0.14);
// object points: the object's own colour, lifted so it reads as light
const tint = c => Math.min(1, c * 0.72 + 0.3);

function formCamera(now) {
  const t = now / 1000;
  const sc = S.scan;
  const m = coverMap();
  const showObj = T.ready && (S.locked || S.phase === "scanning" || S.phase === "saving" || now < S.retargetUntil);
  if (showObj) {
    // a scan plane drifts up and down the object, lighting the points it passes
    const top = T.box[1], ht = T.box[3] - T.box[1];
    const sweepY = top + (0.5 + 0.5 * Math.sin(t * (S.phase === "scanning" ? 1.6 : 0.9))) * ht;
    const band = ht * 0.06;
    for (let j = 0, i = EDGE[0]; i < EDGE[1]; i++, j++) {
      const ny = T.edge[2 * j + 1];
      const lit = Math.max(0, 1 - Math.abs(ny - sweepY) / band);
      const x = m.ox + T.edge[2 * j] * m.dw + Math.sin(t * 2.3 + j * 1.7) * 0.6;
      const y = m.oy + ny * m.dh + Math.cos(t * 2.1 + j * 1.3) * 0.6;
      // the edge glows in the ambient palette, flowing slowly around the object; it settles (stops
      // shimmering) once the precise outline has landed, and the scan plane whitens it as it passes
      const c = amb(j / (EDGE[1] - EDGE[0]) + t * 0.06);
      const w = lit * 0.7;
      const a = S.precise ? 1 : 0.7 + 0.3 * Math.sin(t * 5 + j * 0.3);
      P.attract(i, x, y, 4.2 + lit * 2.4, c[0] + (1 - c[0]) * w, c[1] + (1 - c[1]) * w, c[2] + (1 - c[2]) * w, a);
    }
    // the body fills in as coverage grows: you are literally building the point cloud
    const prog = sc ? progressOf(sc.coverage) : 0;
    const share = S.phase === "scanning" || S.phase === "saving" ? 0.3 + 0.7 * prog : 0.42;
    const active = Math.floor((FILL[1] - FILL[0]) * share);
    for (let j = 0, i = FILL[0]; i < FILL[1]; i++, j++) {
      if (j < active && T.fillOK[j]) {
        const r = T.fillCol[3 * j], g = T.fillCol[3 * j + 1], b = T.fillCol[3 * j + 2];
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        const ny = T.fill[2 * j + 1];
        const lit = Math.max(0, 1 - Math.abs(ny - sweepY) / band);
        const twinkle = 0.82 + 0.18 * Math.sin(t * 3.1 + P.seed[i] * 40);
        const x = m.ox + T.fill[2 * j] * m.dw + Math.sin(t * 1.7 + j) * 0.7;
        const y = m.oy + ny * m.dh + Math.cos(t * 1.9 + j * 0.7) * 0.7;
        const c = amb(ny * 0.6 + t * 0.06); // the object's own colours; the scan plane lights them in the ambient palette
        P.attract(i, x, y, 2.8 + lum * 1.4 + lit * 2.2, Math.min(1, tint(r) + lit * 0.45 * c[0]), Math.min(1, tint(g) + lit * 0.45 * c[1]), Math.min(1, tint(b) + lit * 0.45 * c[2]), Math.min(1, (0.72 + lum * 0.28) * twinkle + lit));
      } else dust(i);
    }
  } else {
    for (let i = EDGE[0]; i < FILL[1]; i++) dust(i);
  }

  // coverage rings around the object
  if (showObj && sc && (S.phase === "scanning" || S.phase === "saving")) formRings(now, m);
  else for (let i = RING[0]; i < RING[1]; i++) dust(i);

  // searching reticle: in the middle of the view while looking for an object, or where it was last seen
  if (!S.locked && (S.phase === "live" || S.phase === "scanning") && (S.phase === "live" || S.lastObj)) {
    const at = S.lastObj ? S.lastObj.center : [0.5, 0.5];
    const sx = m.ox + at[0] * m.dw, sy = m.oy + at[1] * m.dh;
    const loading = !outliner.ready;
    const n = SEEK[1] - SEEK[0];
    const R = loading ? 46 : 30 + Math.sin(t * 2.4) * 3;
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + t * (loading ? 1.6 : 0.6);
      const wob = loading ? Math.sin(a * 3 + t * 3) * 6 : 0;
      const c = amb(j / n + t * 0.1);
      P.attract(SEEK[0] + j, sx + Math.cos(a) * (R + wob), sy + Math.sin(a) * (R + wob), 2.2, c[0], c[1], c[2], 0.55 + 0.35 * Math.sin(a * 2 + t * 4));
    }
  } else for (let i = SEEK[0]; i < SEEK[1]; i++) dust(i);

  for (let i = SEEK[1]; i < COUNT; i++) dust(i);
}

const BAND_COL = [[0.56, 0.89, 1], [0.76, 0.63, 1]]; // the loop in ice cyan, the top pass in violet
const ringFront = [[0, 0], [0, 0], [0, 0]];

function formRings(now, m) {
  for (let i = RING[0] + RING_COUNTS.reduce((a, b) => a + b, 0); i < RING[1]; i++) dust(i);
  const sc = S.scan;
  const cov = sc ? sc.coverage : null;
  const rot = sc?.lastAngle ?? 0;
  const tb = sc ? goalBand(sc) : 0;
  const [bx0, by0, bx1, by1] = T.box;
  const X0 = m.ox + bx0 * m.dw, X1 = m.ox + bx1 * m.dw, Y0 = m.oy + by0 * m.dh, Y1 = m.oy + by1 * m.dh;
  const cx = (X0 + X1) / 2, cy = (Y0 + Y1) / 2;
  const R = Math.max(X1 - X0, Y1 - Y0) / 2 * 1.16;
  let i = RING[0];
  for (let b = 0; b < BANDS.length; b++) {
    const lat = (RING_LAT[b] * Math.PI) / 180;
    const rr = R * Math.cos(lat), ry = rr * 0.3, yc = cy + R * 0.12 - R * Math.sin(lat) * 0.95;
    const n = RING_COUNTS[b];
    ringFront[b][0] = cx; ringFront[b][1] = yc + ry;
    for (let k = 0; k < n; k++, i++) {
      const a = (k / n) * 360;
      const rad = (a * Math.PI) / 180;
      const front = (Math.cos(rad) + 1) / 2;
      const x = cx + rr * Math.sin(rad), y = yc + ry * Math.cos(rad);
      const theta = (((rot - a) % 360) + 360) % 360;
      const covered = cov && cov[b][sectorFor(b, theta)];
      const [cr, cg, cb] = BAND_COL[b];
      if (covered) P.attract(i, x, y, 2.4 + 2.6 * front, cr, cg, cb, 0.6 + 0.4 * front);
      else {
        const here = b === Math.max(0, tb) && (a < 5 || a > 355);
        if (here) P.attract(i, x, y, 5.5, 1, 1, 1, 1); // you are here: the one pure-white point
        else P.attract(i, x, y, 1.4 + 1.1 * front, 1, 1, 1, (b === tb ? 0.22 : 0.1) + 0.16 * front);
      }
    }
  }
}

// A handful of dust particles flare up from the ring and fall into the object: a new angle was captured.
function sparks(band, count = 12) {
  const [fx, fy] = ringFront[band];
  const box = T.box, m = coverMap();
  const tx = m.ox + ((box[0] + box[2]) / 2) * m.dw, ty = m.oy + ((box[1] + box[3]) / 2) * m.dh;
  for (let k = 0; k < count; k++) {
    const i = SEEK[1] + (S.dustCursor++ % (VISIBLE_DUST_END - SEEK[1]));
    P.x[i] = fx + (Math.random() - 0.5) * 30; P.y[i] = fy + (Math.random() - 0.5) * 8;
    P.vx[i] = 0; P.vy[i] = 0;
    P.kick(i, (tx - P.x[i]) * 1.6 + (Math.random() - 0.5) * 120, (ty - P.y[i]) * 1.6 - 60 - Math.random() * 80, 650);
    P.r[i] = P.g[i] = P.b[i] = 1; P.a[i] = 1; P.size[i] = 3;
  }
}

// Review layout of the particle budget: the 3D preview, its coverage rings, then a pool the info sheet is
// drawn with (score ring, coverage dial, quality meters, the mini model on the file card).
const REVIEW_CLOUD = 6000;
const REVIEW_RINGS = [6000, 6440];
const REVIEW_UI = [6440, 6960];

function formReview(now, dt) {
  const rec = S.reviewing;
  const r = $("cloudAnchor").getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.5;
  const scale = Math.min(r.width * 0.3, r.height * 0.34);
  if (!S.dragging) {
    S.cloudYaw += S.cloudSpin * dt;
    S.cloudSpin += (Math.sign(S.cloudSpin || 1) * 0.25 - S.cloudSpin) * Math.min(1, dt * 1.5);
  }
  const yaw = S.cloudYaw, pitch = S.cloudPitch;
  const cloud = rec?.cloud;
  const o = [0, 0, 0];
  const n = cloud ? Math.min(cloud.n, REVIEW_CLOUD) : 0;
  const t = now / 1000;
  // the particle canvas sits above the sheet here, so the preview fades out where the sheet begins
  const sheetTop = $("review").querySelector(".sheet").getBoundingClientRect().top;
  const clip = y => clamp((sheetTop - 8 - y) / 28, 0, 1);
  let i = 0;
  if (cloud) {
    for (; i < n; i++) {
      project(cloud.pts[3 * i], cloud.pts[3 * i + 1], cloud.pts[3 * i + 2], yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1.2) / 2.4, 0, 1);
      const cr = cloud.cols[3 * i] / 255, cg = cloud.cols[3 * i + 1] / 255, cb = cloud.cols[3 * i + 2] / 255;
      const k = 0.9 + 0.35 * d; // true colours, nudged brighter only where they face you
      P.attract(i, o[0], o[1], 1.3 + 1.7 * d, Math.min(1, cr * k + 0.04), Math.min(1, cg * k + 0.04), Math.min(1, cb * k + 0.04), (0.5 + 0.5 * d) * clip(o[1]));
    }
  } else {
    for (; i < 900; i++) { // no shape preview: a neutral sphere of points stands in
      const y = 1 - (2 * (i + 0.5)) / 900, rad = Math.sqrt(1 - y * y), a = i * 2.39996 + t * 0.1;
      project(Math.cos(a) * rad * 0.8, y * 0.8, Math.sin(a) * rad * 0.8, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1) / 2, 0, 1);
      P.attract(i, o[0], o[1], 1.2 + 1.6 * d, 0.8, 0.88, 1, (0.2 + 0.5 * d) * clip(o[1]));
    }
  }
  for (; i < REVIEW_RINGS[0]; i++) P.free(i, 1.5, 1, 1, 1, 0);
  // coverage rings in 3D around the preview: covered directions glow
  const A = cloud?.halfWidth ?? 0.8;
  const R = Math.max(1.05, A * 1.3);
  const cov = rec?.coverage;
  let k = REVIEW_RINGS[0];
  for (let b = 0; b < BANDS.length; b++) {
    const lat = (RING_LAT[b] * Math.PI) / 180;
    const cnt = RING_COUNTS[b];
    for (let q = 0; q < cnt && k < REVIEW_RINGS[1]; q++, k++) {
      const a = (q / cnt) * Math.PI * 2;
      project(Math.sin(a) * R * Math.cos(lat), -0.15 + Math.sin(lat) * R * 0.95, Math.cos(a) * R * Math.cos(lat), yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1.4) / 2.8, 0, 1);
      const covered = cov && cov[b][sectorFor(b, (a * 180) / Math.PI)];
      const bc = BAND_COL[b];
      if (covered) P.attract(k, o[0], o[1], 1.4 + 1.8 * d, bc[0], bc[1], bc[2], (0.3 + 0.6 * d) * clip(o[1]));
      else P.attract(k, o[0], o[1], 0.9 + 0.8 * d, 1, 1, 1, (0.05 + 0.12 * d) * clip(o[1]));
    }
  }
  for (; k < REVIEW_RINGS[1]; k++) P.free(k, 1.5, 1, 1, 1, 0);
  formReviewInfo(now);
  for (let j = REVIEW_UI[1]; j < COUNT; j++) P.free(j, 1.5, 1, 1, 1, 0);
}

// The info sheet, drawn with particles that flow from one tab's layout into the next.
function formReviewInfo(now) {
  const rec = S.reviewing;
  if (!rec) return;
  let i = REVIEW_UI[0];
  const end = REVIEW_UI[1];
  const since = (now - Math.max(S.reviewOpenedAt || 0, S.tabAt || 0)) / 1000;
  const ramp = (delay, dur) => (reduceMotion ? 1 : clamp((since - delay) / dur, 0, 1));
  const ease = x => 1 - Math.pow(1 - x, 3);
  const t = now / 1000;
  const box = el => {
    const b = el && el.getBoundingClientRect();
    return b && b.width > 0 && b.bottom > -60 && b.top < innerHeight + 60 ? b : null;
  };
  // the particles are drawn above the sheet, so they fade out where the Share button floats over it
  const act = $("review").querySelector(".sheet-actions").getBoundingClientRect(), btnTop = $("shareBtn").getBoundingClientRect().top - 4;
  const clip = y => clamp((btnTop - y) / Math.max(8, btnTop - act.top), 0, 1);
  // lit particles glow in the ambient palette (hue = where along it) and carry a slow shimmer (glow = 0..1),
  // whitening as it passes; unlit ones are a faint track
  const dot = (x, y, on, big = 4, small = 2.2, glow = 0, hue = 0) => {
    if (i >= end) return;
    if (on) {
      const c = amb(hue), w = 0.12 + 0.5 * glow;
      P.attract(i++, x, y, big * (1 + 0.18 * glow), c[0] + (1 - c[0]) * w, c[1] + (1 - c[1]) * w, c[2] + (1 - c[2]) * w, (0.82 + 0.18 * glow) * clip(y));
    } else P.attract(i++, x, y, small, 1, 1, 1, 0.2 * clip(y));
  };
  const wave = (f, speed, width) => Math.pow(0.5 + 0.5 * Math.cos((f - t * speed) * Math.PI * 2), width);

  if (currentTab === "overview") {
    // score: a ring of 60 particles, lighting up in order to the score
    const sr = box($("scoreDots"));
    if (sr) {
      const n = 60, c = [sr.left + sr.width / 2, sr.top + sr.height / 2], R = sr.width * 0.46;
      const upto = ((rec.score ?? 0) / 100) * n * ease(ramp(0.25, 1.4));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 - Math.PI / 2, breathe = 1 + 0.012 * Math.sin(t * 1.6 + k * 0.4);
        const head = k === Math.ceil(upto) - 1; // the newest particle leads, a little larger
        dot(c[0] + Math.cos(a) * R * breathe, c[1] + Math.sin(a) * R * breathe, k < upto, head ? 5.6 : 4.2, 2.2, head ? 1 : wave(k / n, 0.18, 6), (k / n) * 0.75 + t * 0.02);
      }
      // stardust drifting just outside the ring, only along the part the score has lit
      const dust = 120, reach = upto / n;
      for (let k = 0; k < dust && i < end; k++) {
        const h1 = fract(Math.sin(k * 12.9898) * 43758.55), h2 = fract(Math.sin(k * 78.233) * 12345.67);
        const f = fract(h1 + t * (0.006 + 0.012 * h2)), a = f * Math.PI * 2 - Math.PI / 2;
        const rr = R * (1.07 + 0.2 * h2 + 0.03 * Math.sin(t * 0.7 + k)), y = c[1] + Math.sin(a) * rr;
        const on = f < reach ? Math.min(1, (reach - f) * 12) : 0;
        const dc = amb(f * 0.75 + t * 0.02);
        P.attract(i++, c[0] + Math.cos(a) * rr, y, 1.1 + 1.4 * h1, dc[0], dc[1], dc[2], on * (0.12 + 0.3 * h2 * h2) * clip(y));
      }
    }
    // coverage, seen from above: the loop on the outer ring, views from above on the inner ring
    const dr = box($("coverDial"));
    if (dr) {
      const c = [dr.left + dr.width / 2, dr.top + dr.height / 2];
      const reveal = ease(ramp(0.5, 1.3));
      for (const [b, R, per] of [[0, dr.width * 0.45, 3], [1, dr.width * 0.3, 3]]) {
        const sec = BANDS[b].sectors;
        for (let s = 0; s < sec; s++) for (let q = 0; q < per; q++) {
          const f = (s + (q + 0.5) / per) / sec, a = f * Math.PI * 2 - Math.PI / 2;
          // a slow sweep, like a radar, passes over the directions you covered
          dot(c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R, rec.coverage[b][s] && f <= reveal, b ? 3.2 : 3.8, 1.9, wave(f, 0.12, 10), b ? 0.5 + f * 0.25 : f * 0.5);
        }
      }
    }
  } else if (currentTab === "quality") {
    // each measure as a short meter of particles
    const rows = $("meters").querySelectorAll(".meter-dots");
    rows.forEach((el, m) => {
      const b = box(el);
      if (!b) return;
      const v = S.meterValues?.[m] ?? 0, upto = v * 10 * ease(ramp(0.1 + m * 0.06, 0.7));
      for (let k = 0; k < 10; k++) dot(b.left + 4 + (k * (b.width - 8)) / 9, b.top + b.height / 2, k < upto, 4, 2.2, wave(k / 10 - m * 0.07, 0.35, 8), k * 0.05 + m * 0.08);
    });
  } else if (currentTab === "export") {
    // the file carries a tiny, turning copy of the object
    const fb = box($("fileModel"));
    const cloud = rec.cloud;
    if (fb) {
      const o = [0, 0, 0], n = Math.min(end - i, 300), step = cloud ? Math.max(1, Math.floor(cloud.n / n)) : 1;
      const sc = fb.height * 0.4, yaw = t * 0.7;
      for (let k = 0; k < n; k++) {
        const p = k * step;
        let r = 0.85, g = 0.9, b = 1;
        if (cloud) {
          project(cloud.pts[3 * p], cloud.pts[3 * p + 1], cloud.pts[3 * p + 2], yaw, 0.3, fb.left + fb.width / 2, fb.top + fb.height / 2, sc, o);
          r = cloud.cols[3 * p] / 255 * 0.9 + 0.1; g = cloud.cols[3 * p + 1] / 255 * 0.9 + 0.1; b = cloud.cols[3 * p + 2] / 255 * 0.9 + 0.1;
        } else { // older scans without a shape preview: a turning sphere of points
          const y = 1 - (2 * (k + 0.5)) / n, rad = Math.sqrt(1 - y * y), a = k * 2.39996;
          project(Math.cos(a) * rad * 0.75, y * 0.75, Math.sin(a) * rad * 0.75, yaw, 0.3, fb.left + fb.width / 2, fb.top + fb.height / 2, sc, o);
        }
        const d = clamp((o[2] + 1.2) / 2.4, 0, 1);
        P.attract(i++, o[0], o[1], 1 + 1.2 * d, r, g, b, (0.5 + 0.5 * d) * clip(o[1]));
      }
    }
  }
  for (; i < end; i++) P.free(i, 1.5, 1, 1, 1, 0); // the rest wait, invisible, for the next tab
}

// A soft ambient light for each scan, taken from the object's own colours.
function ambientFor(rec) {
  const cols = rec.cloud?.cols;
  let base = [58, 74, 94], accent = [74, 64, 56];
  if (cols && cols.length >= 30) {
    let br = 0, bg = 0, bb = 0, ar = 0, ag = 0, ab = 0, aw = 0, n = 0;
    for (let k = 0; k < cols.length; k += 9) {
      const r0 = cols[k], g0 = cols[k + 1], b0 = cols[k + 2];
      br += r0; bg += g0; bb += b0; n++;
      const sat = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
      const w = sat * sat;
      ar += r0 * w; ag += g0 * w; ab += b0 * w; aw += w;
    }
    base = [br / n, bg / n, bb / n];
    accent = aw ? [ar / aw, ag / aw, ab / aw] : base;
  }
  // lift into a glow: brighter and a little more saturated, never neon
  const glow = c => { const m = (c[0] + c[1] + c[2]) / 3; return c.map(v => Math.round(clamp(m + (v - m) * 1.35, 0, 255) * 0.9 + 18)); };
  const a = glow(accent), b = glow(base);
  const el = $("review");
  el.style.setProperty("--amb-a", `rgb(${a.join(",")})`);
  el.style.setProperty("--amb-b", `rgb(${b.join(",")})`);
}

// Library and settings: the particles drift quietly behind; an empty library shows a small turning vase.
function formPanel(now) {
  let i = 0;
  const ea = S.panel === "library" ? $("emptyAnchor").getBoundingClientRect() : null;
  if (ea && ea.width) {
    const sh = SHAPES[0], [lo, hi] = sh.palette, o = [0, 0, 0], n = 800, step = Math.floor(INTRO_N / n);
    for (let k = 0; k < n; k++, i++) {
      const p = k * step, x = sh.pts[3 * p], y = sh.pts[3 * p + 1], z = sh.pts[3 * p + 2];
      project(x, y, z, now / 1000 * 0.5, 0.3, ea.left + ea.width / 2, ea.top + ea.height / 2, ea.height * 0.42, o);
      const d = clamp((o[2] + 0.8) / 1.6, 0, 1), h = (y + 1) / 2, lum = 0.6 + 0.4 * d;
      P.attract(i, o[0], o[1], 0.9 + 1.4 * d, (lo[0] + (hi[0] - lo[0]) * h) * lum, (lo[1] + (hi[1] - lo[1]) * h) * lum, (lo[2] + (hi[2] - lo[2]) * h) * lum, 0.3 + 0.65 * d);
    }
  }
  for (; i < COUNT; i++) dust(i, 0.7);
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  // one bad frame (a missing element, a value out of range) must not stop the particles for good
  try {
    if (S.panel) formPanel(now);
    else if (S.phase === "intro") formIntro(now, dt);
    else if (S.phase === "review") formReview(now, dt);
    else formCamera(now);
  } catch (e) { logError("frame", e); }
  try { P.step(dt, now / 1000); P.render(); } catch (e) { logError("render", e); }
}
requestAnimationFrame(frame);

/* ======================================================================
   Camera
   ====================================================================== */
async function startStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // the more pixels each keyframe has, the finer the final model's detail and texture
    video: settings.maxDetail
      ? { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  });
  S.stream = stream;
  S.track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play();
  const caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
  $("torchBtn").hidden = !caps.torch;
  S.torch = false;
  $("torchBtn").classList.remove("on");
}

function cameraError(e) {
  if (!window.isSecureContext) return "The camera only works over a secure https link.";
  if (e?.name === "NotAllowedError") return "Camera access is blocked. In Settings, open Safari, set Camera to Allow, then reload this page.";
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") return "No usable camera was found on this device.";
  return `The camera didn't start (${e?.message || e}).`;
}

async function keepAwake() { try { S.wakeLock = await navigator.wakeLock?.request("screen"); } catch {} }
async function recoverCamera() { try { await startStream(); } catch (e) { toast(cameraError(e), 5000); } }

$("openCam").addEventListener("click", async () => {
  $("introErr").textContent = "";
  unlockAudio();
  haptic("tap");
  const motionP = requestMotion().then(() => true, () => false); // must start inside the tap on iOS
  if (!navigator.mediaDevices?.getUserMedia) {
    $("introErr").textContent = window.isSecureContext ? "This browser can't use the camera. Open the link in Safari." : cameraError();
    return;
  }
  $("openCam").disabled = true;
  $("openCam").classList.add("busy");
  try {
    await startStream();
  } catch (e) {
    $("introErr").textContent = cameraError(e);
    $("openCam").disabled = false;
    $("openCam").classList.remove("busy");
    return;
  }
  const motionOK = await Promise.race([motionP, sleep(8000).then(() => false)]);
  const r = $("introAnchor").getBoundingClientRect();
  P.burst(r.left + r.width / 2, r.top + r.height / 2, 760); // the sample object scatters into the room
  $("intro").classList.remove("open");
  setPhase("live");
  placeSegThumb();
  chime("start");
  haptic("go");
  keepAwake();
  store.persist();
  if (!motionOK) toast("Motion access is off, so walk-around coverage is estimated.", 5200);
  loadModels();
  setInterval(analyzeTick, TICK_MS);
});

// The two models are loaded one after the other, never together (together they were the memory peak right
// after the camera opens), and each load is marked for the crash guard, so one that kills the page is not
// repeated the same way.
async function loadModels() {
  const around = async (name, fn) => { guard.begin(name); try { return await fn(); } finally { guard.end(name); } };
  // 1. the live tracker: GPU first, CPU if the GPU one has killed the page before; none after two deaths
  if (guard.struck("outliner-CPU", 2)) {
    outliner.failed = true;
    toast("Object detection is off on this device. Scanning still works without it.", 5200);
  } else {
    try { await outliner.load({ delegates: guard.struck("outliner-GPU") ? ["CPU"] : ["GPU", "CPU"], around }); }
    catch (err) {
      outliner.failed = true;
      logError("outliner", err);
      toast("Object detection couldn't load. Scanning still works without it.", 4200);
    }
  }
  // 2. precise outlines, a moment later, only if they are on and the device can run them
  await sleep(1500);
  if (!settings.precise) return;
  await loadRefiner(around);
}

async function loadRefiner(around = async (n, fn) => fn()) {
  if (refiner.ready || refiner.loading) return;
  refiner.loading = true;
  refiner.failed = false;
  try { await refiner.load(p => { S.refineLoad = p; }, { around }); }
  catch (err) {
    refiner.failed = true;
    logError("refiner", err);
    console.warn("precise outlines unavailable", err);
  }
  refiner.loading = false;
  syncStability();
}

// Precise outlines turned themselves off because the device couldn't run them.
function disableRefiner(why) {
  if (refiner.failed) return;
  refiner.failed = true;
  refiner.unload();
  settings.precise = false;
  saveSettings();
  syncStability();
  toast(why, 5200);
}

/* ---------- object tracking ---------- */
function updateObject(obj, fromRefiner = false) {
  let ok = obj && obj.frac > 0.008 && obj.frac < 0.8 && obj.edges < 3;
  // Before scanning, the outline must stay one plausible object: not most of the view (the table, the wall),
  // and following a real edge nearly all the way round. A new guess must also be where the camera points.
  // (Once locked the bar is a little lower, so a moment of blur doesn't drop a good object.)
  if (ok && S.phase === "live" && (obj.frac > 0.62 || edgeSupport(obj) < (S.locked ? 0.66 : 0.78) ||
    (!S.locked && !nearCentre(obj, 0.08)))) ok = false;
  // Same object? Its colour make-up must match what you chose. Stops the tracker sliding onto the table,
  // the wall or a neighbouring object, the main way a live outline "picks up the wrong thing".
  if (ok && S.refHist && !fromRefiner && analyzer.rgba) {
    const sim = histSimilarity(S.refHist, colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj));
    if (sim < (S.locked ? 0.45 : 0.6)) ok = false;
  }
  // A single odd frame (a reflection, a hand passing) shouldn't replace a good outline: ignore sudden jumps
  // in size or position unless they persist.
  if (ok && S.locked && S.obj && S.fracEMA) {
    const jump = obj.frac > S.fracEMA * 1.9 || obj.frac < S.fracEMA * 0.45 ||
      Math.hypot(obj.center[0] - S.obj.center[0], obj.center[1] - S.obj.center[1]) > 0.22;
    if (jump && ++S.glitch < 4) return;
  }
  S.glitch = 0;
  if (ok) {
    S.fracEMA = S.fracEMA ? S.fracEMA * 0.8 + obj.frac * 0.2 : obj.frac;
    S.obj = obj;
    S.lastObj = obj;
    if (!fromRefiner) S.precise = false;
    S.lost = 0;
    S.lastLockedAt = performance.now();
    S.valid++;
    S.seed = obj.seed;
    rebuildTargets(obj);
    if (!S.locked && (S.valid >= 2 || fromRefiner)) {
      S.locked = true;
      S.userSeed = null; // from here on, follow the object itself
      S.lockedAt = performance.now();
      if (S.phase === "live") { haptic("tap"); click(0.15); } // found it
    }
  } else {
    S.valid = 0;
    S.lost++;
    if (S.lost > 7 && S.locked) {
      // keep the selection: the tracker keeps looking where the object was, and re-finds it by colour
      S.locked = false;
      S.obj = null;
      S.fracEMA = 0;
    }
  }
}

/* ---------- automatic object detection ---------- */
// Nothing to tap: the object in the middle of the view is found and outlined on its own. A guess is kept only
// once it settles into one plausible whole object, and it is let go when you point at something else.
// Recording never starts by itself: only the shutter starts it.
const PROBES = [[0.5, 0.5], [0.5, 0.57], [0.5, 0.43], [0.44, 0.5], [0.56, 0.5]];

function nearCentre(o, margin) {
  const [x0, y0, x1, y1] = o.boxN;
  return 0.5 > x0 - margin && 0.5 < x1 + margin && 0.5 > y0 - margin && 0.5 < y1 + margin;
}

// How much of an outline sits on a real edge: the share of its length with a clear colour step across it.
// A real object's outline follows its edge almost all the way round; a patch of floor or wall that the
// segmenter cut out only follows real edges in places (tested: the bottle 0.94, a false patch beside it 0.57).
function edgeSupport(obj) {
  const rgba = analyzer.rgba, AW = analyzer.W, AH = analyzer.H;
  const rc = rgba && resampleContour(obj.contour, 72);
  if (!rc) return 0;
  const px = rc.map(([x, y]) => [x * AW, y * AH]);
  const cx = obj.center[0] * AW, cy = obj.center[1] * AH;
  const at = (x, y) => (clamp(Math.round(y), 0, AH - 1) * AW + clamp(Math.round(x), 0, AW - 1)) * 4;
  let on = 0;
  for (let i = 0; i < px.length; i++) {
    const p = px[i], a = px[(i + px.length - 1) % px.length], b = px[(i + 1) % px.length];
    let nx = a[1] - b[1], ny = b[0] - a[0];
    const L = Math.hypot(nx, ny) || 1;
    nx /= L; ny /= L;
    if (nx * (p[0] - cx) + ny * (p[1] - cy) < 0) { nx = -nx; ny = -ny; } // point it outwards
    let step = 0;
    for (const e of [2, 3, 4]) { // the outline may sit a pixel or two off the true edge
      const u = at(p[0] - nx * e, p[1] - ny * e), v = at(p[0] + nx * e, p[1] + ny * e);
      step = Math.max(step, Math.hypot(rgba[u] - rgba[v], rgba[u + 1] - rgba[v + 1], rgba[u + 2] - rgba[v + 2]));
    }
    if (step >= 14) on++;
  }
  return on / px.length;
}

function autoDetect(now) {
  if (S.phase !== "live" || !outliner.ready) return;
  if (!S.selected) {
    // let the view settle for a moment so it doesn't grab whatever swings past
    if (motion.available && motion.shake > 90) S.steadySince = now;
    if (now - S.steadySince < 300 || now - S.probeAt < 250) return;
    const [x, y] = PROBES[S.probe++ % PROBES.length];
    S.probeAt = now;
    selectAt(x, y);
    return;
  }
  if (S.locked) S.seenAt = now;
  // a guess that never settled into an object, or an object that was lost: look again
  else if (now - Math.max(S.probeAt, S.seenAt) > 1600) { clearSelection(); return; }
  // pointed at something else: once the middle of the view has been off the object for a moment, let it go
  if (S.locked && S.obj) {
    if (nearCentre(S.obj, 0.1)) S.offCentreSince = 0;
    else if (!S.offCentreSince) S.offCentreSince = now;
    else if (now - S.offCentreSince > 1200) { S.probe = 0; clearSelection(); }
  }
}

function selectAt(nx, ny) {
  Object.assign(S, {
    selected: true, obj: null, lastObj: null, locked: false, valid: 1, lost: 0, glitch: 0, fracEMA: 0,
    seed: [nx, ny], userSeed: [nx, ny], precise: false, refHist: null, offCentreSince: 0,
    edit: { pos: [[nx, ny]] }, pendingSelect: { at: performance.now() }, retargetUntil: performance.now() + 1500,
  });
  outliner.prev = null;
  syncCanScan();
}

function clearSelection() {
  Object.assign(S, {
    selected: false, obj: null, lastObj: null, locked: false, valid: 0, lost: 0, precise: false, refHist: null,
    pendingSelect: null, edit: { pos: [] }, userSeed: null, offCentreSince: 0,
  });
  T.ready = false;
  outliner.prev = null;
  syncCanScan();
}

/* ---------- precise outlines (EdgeTAM) ---------- */
// Prompt for the precise model, in video pixels: a box around the object plus points on it.
function promptFor(kind) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const ref = S.obj || S.lastObj;
  const px = p => [p[0] * vw, p[1] * vh];
  if (!ref) return { pos: [px(S.edit.pos[0] || S.seed)] }; // no outline to take a box from: the point alone
  // A snug box: a loose one lets the edge bleed into busy backgrounds (tested: 3% padding 0.988 IoU,
  // 8% padding 0.969). Corner points just outside the object's box are marked "not this".
  let [x0, y0, x1, y1] = ref.boxN;
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let pos = ref.guides.slice(0, 3);
  const neg = cornerPoints(x0, y0, x1, y1, pad);
  if (kind === "select") pos = [S.edit.pos[0] || ref.seed];
  const c = v => Math.min(1, Math.max(0, v));
  return { box: [c(x0) * vw, c(y0) * vh, c(x1) * vw, c(y1) * vh], pos: pos.map(px), neg: neg.map(px) };
}

// Points just inside the padded box's corners: always outside the object's own box, so background.
function cornerPoints(x0, y0, x1, y1, pad) {
  const k = pad * 0.25, out = [];
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
    const x = cx + sx * k, y = cy + sy * k;
    if (x > 0 && x < 1 && y > 0 && y < 1) out.push([x, y]);
  }
  return out;
}

let refineFails = 0;
async function runRefine(reason, prompt) {
  if (!refiner.ready || !settings.precise) return;
  if (refiner.busy) { if (reason !== "track") S.refineQueued = { reason, prompt }; return; }
  S.lastRefineAt = performance.now();
  S.refining = reason;
  let r = null;
  try { r = await refiner.segment(video, video.videoWidth, video.videoHeight, prompt); refineFails = 0; }
  catch (e) {
    console.warn("refine failed", e);
    logError("refine", e);
    // a device that can't run it (GPU lost, out of memory) would otherwise fail on every frame, for ever
    if (++refineFails >= 3) disableRefiner("This device couldn't run precise outlines, so they're off. Scanning works as before.");
  }
  S.refining = null;
  if (r) applyRefined(r, reason);
  if (S.refineQueued) { const q = S.refineQueued; S.refineQueued = null; runRefine(q.reason, q.prompt); }
}

function applyRefined(r, reason) {
  if (!S.selected || (S.phase !== "live" && S.phase !== "scanning")) return;
  if (r.score < (reason === "track" || reason === "reacquire" ? 0.6 : 0.3)) return;
  const W = outliner.canvas.width || 288, H = outliner.canvas.height || 512;
  const small = resampleMask(r.mask, r.W, r.H, W, H);
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < small.length; i++) if (small[i]) { n++; sx += i % W; sy += (i / W) | 0; }
  if (n < 40) return;
  const cx = sx / n, cy = sy / n;
  let best = -1, bd = Infinity;
  for (let i = 0; i < small.length; i++) if (small[i]) { const d = (i % W - cx) ** 2 + (((i / W) | 0) - cy) ** 2; if (d < bd) { bd = d; best = i; } }
  const conf = Float32Array.from(small);
  const obj = findObject(conf, W, H, [(best % W + 0.5) / W, (((best / W) | 0) + 0.5) / H]);
  if (!obj) return;
  const cur = S.obj;
  if (reason === "track" && cur) {
    // a periodic correction must agree with what is being tracked; otherwise keep tracking
    const ratio = obj.frac / cur.frac;
    if (ratio < 0.5 || ratio > 2 || Math.hypot(obj.center[0] - cur.center[0], obj.center[1] - cur.center[1]) > 0.15) return;
  }
  if (reason === "reacquire" && analyzer.rgba && S.refHist &&
      histSimilarity(S.refHist, colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj)) < 0.6) return;
  S.glitch = 0;
  updateObject(obj, true);
  if (S.obj !== obj) return; // not accepted
  S.precise = true;
  outliner.prev = conf; // pulls the fast tracker onto the precise edge
  const h = analyzer.rgba ? colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj) : null;
  if (h) {
    if (!S.refHist || reason === "select") S.refHist = h;
    else for (let i = 0; i < 64; i++) S.refHist[i] = S.refHist[i] * 0.9 + h[i] * 0.1;
  }
  if (reason === "select") {
    S.pendingSelect = null;
    haptic("lock");
    chime("lock");
    syncCanScan();
  }
}

// Called every analysis tick: the first precise outline once an object is found, then regular corrections.
function scheduleRefine(now) {
  if (!refiner.ready || refiner.busy || !S.selected || !settings.precise) return;
  if (S.phase !== "live" && S.phase !== "scanning") return;
  // (the precise model only runs on an object the fast tracker has found: running it on every passing guess
  // would heat the phone and stall the live view)
  if (S.pendingSelect) {
    if (S.locked && S.obj) runRefine("select", promptFor("select"));
    return;
  }
  // corrections as often as the device comfortably allows (leave the main thread room for the live view)
  // (never more than about a third of the time, so the phone has room to stay cool and the live view smooth)
  const gap = S.phase === "scanning" ? Math.max(900, refiner.ms * 3) : Math.max(1500, refiner.ms * 3);
  if (now - S.lastRefineAt < gap) return;
  if (S.locked && S.obj) runRefine("track", promptFor("track"));
  else if (S.lastObj && S.phase === "scanning") runRefine("reacquire", promptFor("track")); // before a scan, detection just looks again
}

// The shutter is live once there is an object to scan (or, if detection couldn't load, the whole view).
function syncCanScan() {
  body.classList.toggle("can-scan", (S.selected && S.locked) || !!outliner.failed);
}

/* ---------- analysis tick ---------- */
function analyzeTick() {
  try { analyzeStep(); } catch (e) { logError("tick", e); }
}
function analyzeStep() {
  if (S.phase === "intro" || S.phase === "review" || S.panel || document.hidden) return;
  if (video.readyState < 2 || !video.videoWidth) return;
  const now = performance.now();
  const dt = Math.min(0.3, (now - (S.lastTick || now)) / 1000);
  S.lastTick = now;

  analyzer.grab(video);
  if (outliner.ready && S.selected) {
    S.segSkip = (S.segSkip + 1) % (outliner.ms > 70 ? 3 : outliner.ms > 35 ? 2 : 1);
    if (S.segSkip === 0) {
      const canvas = outliner.frame(video);
      // guide with points spread over the object (or its last known place) so the whole thing stays selected
      const ref = S.locked ? S.obj : S.lastObj;
      const guides = ref && !S.userSeed ? ref.guides : [S.seed];
      const conf = outliner.run(canvas, guides, S.locked ? 0.35 : 0);
      updateObject(conf ? findObject(conf, canvas.width, canvas.height, S.seed) : null);
    }
  }
  const st = analyzer.stats(S.locked ? S.obj : null);
  S.lastStats = st;
  S.sharpEMA = S.sharpEMA ? S.sharpEMA * 0.94 + st.sharp * 0.06 : st.sharp;

  if (S.phase === "scanning") scanStep(st, dt, now);
  autoDetect(now);
  scheduleRefine(now);
  updateGuidance(st, now);
  updateHints();
  updateCaption();
  syncCanScan();
}

/* ======================================================================
   Scanning
   ====================================================================== */
// The band the scan is working on now (-1 when done). After the loop, "Add top views" targets the top.
function goalBand(sc) {
  const tb = targetBand(sc.coverage);
  if (tb !== -1) return tb;
  if (sc.goal === "top" && bandFill(sc.coverage, 1) < BANDS[1].need) return 1;
  return -1;
}
function newScan() {
  S.scanCount++;
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: `Scan ${S.scanCount}`, createdAt: Date.now(), mode: S.mode, status: "capturing",
    coverage: emptyCoverage(), frames: [], bins: new Map(), binWait: new Map(), views: [], goal: "loop",
    heading0: null, spinAngle: 0, spinIdle: 0, lastAngle: null, elapsed: 0,
    ticks: 0, sharpTicks: 0, lightTicks: 0, steadyTicks: 0,
    ringsDone: BANDS.map(() => false), completeAt: 0, savedAt: 0,
    recorder: null, videoPart: 0, hasVideo: false,
    thumbBest: -1, thumbCanvas: null, thumb: null, heightM: null, imageSize: null, cloud: null,
  };
}

function recordOf(sc, result) {
  const res = result || sc.result;
  return {
    id: sc.id, version: VERSION, name: sc.name, createdAt: sc.createdAt, status: sc.status, mode: sc.mode,
    heightM: sc.heightM ?? null, imageSize: sc.imageSize, frames: sc.frames,
    coverage: sc.coverage.map(a => Array.from(a)),
    score: res?.score ?? null, word: res?.word ?? null, tips: res?.tips ?? [], stats: res?.stats ?? null,
    thumb: sc.thumb, hasVideo: sc.hasVideo, cloud: sc.cloud,
  };
}

function scanStep(st, dt, now) {
  const sc = S.scan;
  sc.elapsed += dt;
  sc.ticks++;
  const lightOK = st.lum > LIGHT.dark && st.lum < LIGHT.bright;
  const steady = motion.shake < 100 && motion.pace < 50;
  const sharpOK = st.sharp > Math.max(14, 0.55 * S.sharpEMA) && motion.shake < 130;
  if (lightOK) sc.lightTicks++;
  if (steady) sc.steadyTicks++;
  if (sharpOK) sc.sharpTicks++;
  // forgiving: a brief loss of the outline (someone walks past, a reflection) doesn't stop the scan
  const inFrame = !outliner.ready || S.locked || now - S.lastLockedAt < 1500;

  let angle;
  if (S.mode === "walk" && motion.available && motion.heading != null) {
    if (sc.heading0 == null) sc.heading0 = motion.heading;
    angle = (motion.heading - sc.heading0 + 360) % 360;
  } else {
    // turntable (or no motion sensors): advance while the object turns and the background holds still
    const good = S.mode === "spin"
      ? st.objMotion > 1.4 && st.objMotion < 30 && st.bgMotion < 7
      : st.bgMotion > 1.2 && st.bgMotion < 30;
    if (good && inFrame) { sc.spinAngle += dt * 360 / SPIN_REV_SECONDS; sc.spinIdle = 0; } else sc.spinIdle += dt;
    angle = ((sc.spinAngle % 360) + 360) % 360;
  }
  const band = motion.available ? bandFor(motion.elev) : Math.max(0, targetBand(sc.coverage));
  sc.lastAngle = angle;

  if (inFrame && motion.shake < 220) {
    const s = sectorFor(band, angle);
    if (!sc.coverage[band][s]) {
      sc.coverage[band][s] = 1;
      haptic("tick");
      click(band / 2);
      sparks(band);
      checkRings(sc, now);
    }
    // One keyframe per small slice of angle. Take the first good frame there, then swap in a clearly
    // sharper one if it comes along; if nothing sharp turns up within half a second, take the best we have.
    const step = settings.dense ? 4 : 7.5;
    const key = `${band}:${Math.floor(angle / step)}`;
    const bin = sc.bins.get(key);
    if (!S.kfBusy) {
      if (!bin) {
        const waited = (sc.binWait.get(key) || 0) + dt;
        sc.binWait.set(key, waited);
        if ((sharpOK || waited > 0.5) && sc.frames.length < MAX_FRAMES) captureKeyframe(sc, angle, band, st, null, key);
      } else if (st.sharp > bin.sharp * 1.35 && now - bin.at > 500 && sharpOK) {
        captureKeyframe(sc, angle, band, st, bin.idx, key);
      }
    }
  }

  const prog = progressOf(sc.coverage);
  $("pct").textContent = Math.round(prog * 100);
  $("meterArc").style.strokeDashoffset = 119.4 * (1 - prog);
  if (now - sc.savedAt > 4000) { sc.savedAt = now; store.putScan(recordOf(sc)).catch(() => {}); }
}

function checkRings(sc, now) {
  BANDS.forEach((b, i) => {
    if (!sc.ringsDone[i] && bandFill(sc.coverage, i) >= b.need) {
      sc.ringsDone[i] = true;
      if (goalBand(sc) !== -1) { haptic("ring"); chime("ring"); sparks(i, 40); }
    }
  });
  if (goalBand(sc) === -1 && !sc.completeAt) {
    sc.completeAt = now;
    haptic("success");
    chime("success");
    for (let b = 0; b < BANDS.length; b++) sparks(b, 30);
    say(settings.autoFinish ? "Every angle is covered. Finishing." : "Every angle is covered. Tap the shutter to finish.", { force: true });
    if (settings.autoFinish) setTimeout(() => { if (S.phase === "scanning" && S.scan === sc) finishScan(); }, 1500);
  }
}

async function captureKeyframe(sc, angle, band, st, replaceIdx, key) {
  S.kfBusy = true;
  try {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (cap.width !== vw || cap.height !== vh) { cap.width = vw; cap.height = vh; }
    capCtx.drawImage(video, 0, 0, vw, vh);
    const obj = S.locked ? S.obj : null;
    const idx = replaceIdx ?? sc.frames.length;
    const name = `kf_${String(idx).padStart(3, "0")}.jpg`;
    const elev = motion.available ? motion.elev : 0;
    const meta = {
      file: `images/${name}`,
      mask: obj ? `masks/${name}.png` : null,
      t: +sc.elapsed.toFixed(2),
      azimuth: +angle.toFixed(1),
      elevation: +elev.toFixed(1),
      band,
      sharpness: Math.round(st.sharp),
      bbox: obj ? obj.boxN.map(v => +v.toFixed(4)) : null,
      guides: obj ? obj.guides.map(g => g.map(v => +v.toFixed(4))) : null,
      maskSource: obj ? "live" : null,
    };
    sc.frames[idx] = meta;
    sc.bins.set(key, { idx, sharp: st.sharp, at: performance.now() });
    sc.imageSize = [vw, vh];
    // keep the outline and a small colour frame for the instant 3D preview
    if (obj && obj.edges === 0 && elev < 55 && analyzer.rgba && (sc.views.length < MAX_VIEWS || sc.views.some(v => v.idx === idx))) {
      // stored at the analysis size (the outline is downsampled to match the colour frame)
      const AW = analyzer.W, AH = analyzer.H, src = analyzer.rgba;
      const rgb = new Uint8Array(AW * AH * 3), lab = new Uint8Array(AW * AH);
      for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) { rgb[p] = src[q]; rgb[p + 1] = src[q + 1]; rgb[p + 2] = src[q + 2]; }
      const sx = obj.W / AW, sy = obj.H / AH;
      for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) lab[y * AW + x] = obj.lab[((y * sy) | 0) * obj.W + ((x * sx) | 0)];
      const b = obj.boxN;
      const view = { idx, lab, W: AW, H: AH, box: [b[0] * AW, b[1] * AH, b[2] * AW, b[3] * AH], azimuth: angle, elevation: elev, rgb };
      const at = sc.views.findIndex(v => v.idx === idx);
      if (at >= 0) sc.views[at] = view; else sc.views.push(view);
    }
    if (obj && (band === 0 || sc.thumbBest < 0) && st.sharp > sc.thumbBest) { sc.thumbBest = st.sharp; drawThumb(sc, obj.boxN); }
    P.flash = replaceIdx == null ? 1 : 0.5;
    $("frames").textContent = `${sc.frames.length} frames`;
    const maskP = obj ? maskToBlob(obj) : null;
    const jpg = await toBlob(cap, "image/jpeg", 0.9);
    await store.putFile(sc.id, meta.file, jpg);
    if (maskP) await store.putFile(sc.id, meta.mask, await maskP);
  } catch (e) {
    console.warn("keyframe failed", e);
  } finally {
    S.kfBusy = false;
  }
}

function drawThumb(sc, box) {
  const t = sc.thumbCanvas || (sc.thumbCanvas = Object.assign(document.createElement("canvas"), { width: 360, height: 360 }));
  const vw = cap.width, vh = cap.height;
  const bw = (box[2] - box[0]) * vw, bh = (box[3] - box[1]) * vh;
  const s = Math.min(vw, vh, Math.max(bw, bh) * 1.4);
  const cx = (box[0] + box[2]) / 2 * vw, cy = (box[1] + box[3]) / 2 * vh;
  const sx = Math.min(vw - s, Math.max(0, cx - s / 2)), sy = Math.min(vh - s, Math.max(0, cy - s / 2));
  t.getContext("2d").drawImage(cap, sx, sy, s, s, 0, 0, 360, 360);
}

function startVideo(sc) {
  if (!window.MediaRecorder || !settings.video) return;
  const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm"].find(t => MediaRecorder.isTypeSupported(t)) || "";
  try {
    const rec = new MediaRecorder(S.stream, { ...(type && { mimeType: type }), videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start(1000);
    sc.recorder = { rec, chunks };
  } catch (e) { console.warn("video recording unavailable", e); }
}

function stopVideo(sc) {
  const r = sc.recorder;
  sc.recorder = null;
  if (!r) return Promise.resolve();
  return new Promise(resolve => {
    r.rec.onstop = async () => {
      const blob = new Blob(r.chunks, { type: r.rec.mimeType || "video/mp4" });
      const ext = blob.type.includes("webm") ? "webm" : "mp4";
      sc.videoPart++;
      try { await store.putFile(sc.id, sc.videoPart > 1 ? `video_${sc.videoPart}.${ext}` : `video.${ext}`, blob); sc.hasVideo = true; } catch {}
      resolve();
    };
    r.rec.stop();
  });
}

/* ---------- shutter, finish ---------- */
$("shutter").addEventListener("click", () => {
  if (S.phase === "live") {
    unlockAudio();
    if (!S.locked && !outliner.failed) { haptic("warn"); toast("Point the camera at the object you want to scan first."); return; }
    beginScanning(false);
  } else if (S.phase === "scanning") finishScan();
  else if (S.phase === "saving" && S.refiningKeyframes) { S.skipRefine = true; haptic("tap"); }
});

function beginScanning(resume, goal = "loop") {
  if (!resume || !S.scan) S.scan = newScan();
  const sc = S.scan;
  sc.mode = S.mode;
  sc.status = "capturing";
  sc.goal = goal;
  sc.completeAt = 0;
  setPhase("scanning");
  haptic("go");
  chime("start");
  const prog = progressOf(sc.coverage);
  $("frames").textContent = `${sc.frames.length} frames`;
  $("pct").textContent = Math.round(prog * 100);
  $("meterArc").style.strokeDashoffset = 119.4 * (1 - prog);
  startVideo(sc);
  store.putScan(recordOf(sc)).catch(() => {});
  guard.begin("scan"); // cleared when the scan has been finished and saved
}

async function finishScan(reason = "done") {
  const sc = S.scan;
  if (!sc || S.phase !== "scanning") return;
  setPhase("saving");
  haptic("tap");
  chime("stop");
  for (let i = 0; i < 20 && S.kfBusy; i++) await sleep(50);
  await stopVideo(sc);
  if (!sc.frames.length) {
    await store.deleteScan(sc.id).catch(() => {});
    S.scan = null;
    S.scanCount--;
    guard.end("scan");
    setPhase("live");
    toast("No sharp views were captured. Keep the object in view and move slowly.", 4200);
    return;
  }
  sc.status = reason === "interrupted" ? "interrupted" : "complete";
  sc.result = scoreScan(sc);
  if (reason !== "interrupted") {
    if (refiner.ready && settings.precise) await refineKeyframes(sc);
    setStatus("Building the 3D preview", "info");
    guard.begin("hull");
    try { sc.cloud = await carveHull(sc.views); } catch (e) { console.warn("preview failed", e); logError("hull", e); sc.cloud = null; }
    guard.end("hull");
  }
  if (sc.thumbCanvas) sc.thumb = await toBlob(sc.thumbCanvas, "image/jpeg", 0.86);
  const rec = recordOf(sc, sc.result);
  await store.putScan(rec).catch(e => toast(`Couldn't save the scan: ${e?.message || e}`, 5000));
  setLastThumb(rec);
  refreshCount();
  guard.end("scan");
  if (reason === "interrupted") { setPhase("live"); return; }
  openReview(rec, { live: true });
}

// Re-outline every keyframe with the precise model, from the full-resolution photo. These outlines are
// what the 3D preview and the exported masks are built from, so this is where accuracy matters most.
async function refineKeyframes(sc) {
  for (let i = 0; i < 100 && refiner.busy; i++) await sleep(50);
  S.refiningKeyframes = true;
  S.skipRefine = false;
  $("shutter").setAttribute("aria-label", "Skip outline refinement");
  const total = sc.frames.length;
  let done = 0, improved = 0;
  let fails = 0;
  for (let idx = 0; idx < total && !S.skipRefine; idx++) {
    const fr = sc.frames[idx];
    setStatus(`Refining outlines ${idx + 1} of ${total}`, "info");
    $("meterArc").style.strokeDashoffset = 119.4 * (1 - idx / total);
    $("pct").textContent = Math.round((idx / total) * 100);
    if (!fr?.bbox) continue;
    try {
      const file = await store.getFile(sc.id, fr.file);
      if (!file) continue;
      const [x0, y0, x1, y1] = fr.bbox, pad = 0.03 * Math.max(x1 - x0, y1 - y0);
      const c = v => Math.min(1, Math.max(0, v));
      const pts = (fr.guides || [[(x0 + x1) / 2, (y0 + y1) / 2]]).slice(0, 3);
      let r;
      const bmp = await createImageBitmap(file.blob); // a full-resolution frame is ~33 MB decoded: let go of it at once
      try {
        const vw = bmp.width, vh = bmp.height;
        r = await refiner.segment(bmp, vw, vh, {
          box: [c(x0 - pad) * vw, c(y0 - pad) * vh, c(x1 + pad) * vw, c(y1 + pad) * vh],
          pos: pts.map(p => [p[0] * vw, p[1] * vh]),
          neg: cornerPoints(x0 - pad, y0 - pad, x1 + pad, y1 + pad, pad).map(p => [p[0] * vw, p[1] * vh]),
        });
      } finally { bmp.close?.(); }
      fails = 0;
      if (!r || r.score < 0.4) continue;
      // keep the largest piece and check it agrees with the tracked outline before trusting it
      const obj = findObject(Float32Array.from(r.mask), r.W, r.H, pts[0]);
      if (!obj) continue;
      const bx = obj.boxN, ix = Math.max(0, Math.min(bx[2], x1) - Math.max(bx[0], x0)), iy = Math.max(0, Math.min(bx[3], y1) - Math.max(bx[1], y0));
      const inter = ix * iy, uni = (bx[2] - bx[0]) * (bx[3] - bx[1]) + (x1 - x0) * (y1 - y0) - inter;
      if (inter / uni < 0.55) continue;
      const name = fr.file.split("/").pop();
      fr.mask = `masks/${name}.png`;
      fr.maskSource = "precise";
      fr.bbox = obj.boxN.map(v => +v.toFixed(4));
      await store.putFile(sc.id, fr.mask, await maskToBlob(obj));
      const view = sc.views.find(v => v.idx === idx);
      if (view) {
        view.lab = resampleMask(obj.lab, obj.W, obj.H, view.W, view.H);
        view.box = [obj.boxN[0] * view.W, obj.boxN[1] * view.H, obj.boxN[2] * view.W, obj.boxN[3] * view.H];
      }
      improved++;
    } catch (e) {
      console.warn("keyframe refine failed", idx, e);
      logError("keyframe-refine", e);
      if (++fails >= 3) { S.skipRefine = true; toast("Precise outlines stopped early. The scan keeps the live outlines.", 4200); } // don't grind through the rest
    }
    done++;
  }
  S.refiningKeyframes = false;
  sc.refined = { improved, of: total, skipped: S.skipRefine };
}

function scoreScan(sc) {
  const t = Math.max(1, sc.ticks);
  const cov = progressOf(sc.coverage);
  const sharp = sc.sharpTicks / t, light = sc.lightTicks / t, steady = sc.steadyTicks / t;
  const n = sc.frames.length;
  const top = topBonus(sc.coverage);
  const score = Math.round(100 * (0.55 * cov + 0.1 * top + 0.15 * sharp + 0.07 * light + 0.05 * steady + 0.08 * Math.min(1, n / 45)));
  const word = score >= 88 ? "Excellent" : score >= 72 ? "Good" : score >= 55 ? "Usable" : "Needs another pass";
  const f = BANDS.map((_, i) => bandFill(sc.coverage, i));
  const walk = sc.mode === "walk";
  const tips = [];
  if (f[0] < BANDS[0].need) tips.push(walk ? "The loop has gaps. Fill gaps picks up where you stopped." : "The turn has gaps. Fill gaps lets you finish it.");
  else if (top < 1) tips.push("For the best model, add a few views from above. It takes about ten seconds.");
  if (sharp < 0.75) tips.push("Many views were soft. Move slower, or find brighter light.");
  if (light < 0.8) tips.push("The light was too dim or too harsh for part of the scan.");
  if (n < 30) tips.push(`Only ${n} frames were kept. A slower loop gives the 3D step more to work with.`);
  return {
    score, word,
    tips: tips.length ? tips.map(text => ({ text })) : [{ text: "Every angle is covered and sharp. This one is ready for 3D.", good: true }],
    stats: { coverage: +cov.toFixed(3), top: +top.toFixed(3), sharp: +sharp.toFixed(3), light: +light.toFixed(3), steady: +steady.toFixed(3), frames: n, seconds: +sc.elapsed.toFixed(1) },
  };
}

/* ======================================================================
   Guidance
   ====================================================================== */
function wanted(st) {
  const scanning = S.phase === "scanning";
  const sc = S.scan;
  if (st.lum < LIGHT.dark) return ["bad", "Too dark. Find more light", "It's too dark. Find more light."];
  if (st.lum > LIGHT.bright) return ["warn", "Too much glare", "There's too much glare."];
  if (!outliner.ready && !outliner.failed) return ["info", "Loading object detection"];
  if (outliner.ready && !S.locked) return scanning
    ? ["warn", "Point back at the object", "Point back at the object."]
    : ["info", S.lastObj ? "Finding its edges" : "Looking for an object"];
  if (S.locked && S.obj) {
    if (S.obj.frac < 0.035) return ["warn", "Move closer", "Move closer."];
    if (S.obj.edges >= 2 || S.obj.frac > 0.6) return ["warn", "Step back a little", "Step back a little."];
    const [cx, cy] = S.obj.center;
    if (Math.abs(cx - 0.5) > 0.27 || Math.abs(cy - 0.5) > 0.3) return ["warn", "Keep it centered", "Keep it in the middle."];
  }
  if (scanning) {
    if (S.mode === "walk") {
      if (motion.pace > 55) return ["warn", "Slow down", "Slow down."];
      if (motion.shake > 150) return ["warn", "Steady your hands", "Steady your hands."];
    } else {
      if (st.bgMotion > 9) return ["warn", "Keep the phone still", "Keep the phone still."];
      if (st.objMotion > 30) return ["warn", "Turn it slower", "Turn it slower."];
      if (sc.spinIdle > 1.8) return ["warn", "Keep turning the object", "Keep turning."];
    }
    if (st.sharp < Math.max(14, 0.45 * S.sharpEMA)) return ["warn", "Hold steady", "Hold steady."];
    if (sc.completeAt) return ["ok", "Every angle covered"];
    if (S.mode === "walk" && motion.available && motion.elev < 6 && goalBand(sc) === 0) return ["ok", "Tip: hold the phone a little higher"];
    return ["ok", "Looking good"];
  }
  if (S.refining === "select" && !S.precise) return ["info", "Finding its edges"];
  if (!refiner.ready && !refiner.failed) return ["info", `Loading precise outlines ${Math.round((S.refineLoad || 0) * 100)}%`];
  return ["ok", "Ready. Tap the shutter"];
}

function setStatus(text, level) {
  if (text === S.status && level === S.level) return;
  S.status = text;
  S.level = level;
  body.dataset.level = level;
  const el = $("statusText");
  el.classList.add("swap");
  setTimeout(() => { el.textContent = text; el.classList.remove("swap"); }, reduceMotion ? 0 : 160);
}

function updateGuidance(st, now) {
  if (S.phase === "saving") return;
  const [level, text, spoken] = wanted(st);
  if (!S.cand || S.cand.text !== text) { S.cand = { level, text, spoken }; S.candSince = now; }
  const hold = level === "ok" || level === "info" ? 250 : 450;
  if (text === S.status || now - S.candSince < hold) return;
  const worse = (level === "warn" || level === "bad") && S.phase === "scanning";
  setStatus(text, level);
  $("torchBtn").classList.toggle("pulse", level === "bad" && !S.torch);
  if (worse && now - S.lastWarnFx > 3000) {
    S.lastWarnFx = now;
    haptic("warn");
    chime("warn");
    say(spoken);
  }
}

function captionFor(sc) {
  const gb = goalBand(sc);
  if (gb === -1) return settings.autoFinish ? "Done" : "All around. Tap to finish";
  if (gb === 1) return "Raise the phone and look down at it";
  const p = progressOf(sc.coverage);
  const walk = S.mode === "walk";
  if (p < 0.08) return walk ? "Walk slowly around it" : "Turn it slowly";
  if (p < 0.75) return walk ? "Keep going around" : "Keep turning";
  return "Almost there";
}

function updateCaption() {
  let text = "";
  if (S.phase === "scanning" && S.scan) text = captionFor(S.scan);
  else if (S.phase === "live" && !S.locked && !outliner.failed) text = "Point at what you want to scan";
  if (text === S.caption) return;
  S.caption = text;
  const el = $("caption");
  el.classList.remove("show");
  if (!text) return;
  setTimeout(() => { el.textContent = text; el.classList.add("show"); }, reduceMotion ? 0 : 200);
  if (S.phase === "scanning" && text !== S.lastSpoken) { S.lastSpoken = text; say(text + "."); }
}
$("caption").style.transition = "opacity .45s cubic-bezier(.25,.9,.3,1), transform .5s cubic-bezier(.25,.9,.3,1)";

function updateHints() {
  const sc = S.scan;
  let hint = null, elev = false;
  if (S.phase === "scanning" && sc && motion.available) {
    const tb = goalBand(sc);
    if (tb >= 0) {
      const cur = bandFor(motion.elev);
      if (cur !== tb) {
        elev = true;
        hint = tb > cur ? ["up", "Raise the phone and look down"] : ["up", "Lower the phone a little"];
        const toPct = e => `${(1 - clamp(e, 0, 80) / 80) * 100}%`;
        const g = $("elev");
        g.querySelector(".elev-zone").style.top = toPct(BANDS[tb].elevMax);
        g.querySelector(".elev-zone").style.height = `${((BANDS[tb].elevMax - BANDS[tb].elevMin) / 80) * 100}%`;
        g.querySelector(".elev-knob").style.top = toPct(motion.elev);
      } else if (S.mode === "walk" && sc.lastAngle != null) {
        const n = BANDS[tb].sectors;
        let best = null;
        for (let s = 0; s < n; s++) {
          if (sc.coverage[tb][s]) continue;
          const d = angleDiff((s + 0.5) / n * 360, sc.lastAngle);
          if (best === null || Math.abs(d) < Math.abs(best)) best = d;
        }
        // walking left turns the camera clockwise (heading increases)
        if (best !== null && Math.abs(best) > 20) hint = best > 0 ? ["left", "Keep walking left"] : ["right", "Keep walking right"];
      }
    }
  }
  const el = $("hint");
  if (hint) {
    const key = hint.join();
    if (S.hint !== key) {
      S.hint = key;
      $("hintIcon").setAttribute("href", `#i-${hint[0]}`);
      $("hintText").textContent = hint[1];
      el.className = `glass hint hud show ${hint[0]}`;
    }
  } else if (S.hint) { S.hint = null; el.classList.remove("show"); }
  $("elev").classList.toggle("show", elev);
}

/* ---------- mode & torch ---------- */
function placeSegThumb() {
  const b = document.querySelector('.segmented button[aria-checked="true"]');
  const th = $("segThumb");
  th.style.left = `${b.offsetLeft}px`;
  th.style.width = `${b.offsetWidth}px`;
}
window.addEventListener("resize", placeSegThumb);
placeSegThumb();

document.querySelectorAll(".segmented button").forEach(b => b.addEventListener("click", () => {
  if (S.phase !== "live") return;
  S.mode = b.dataset.mode;
  body.dataset.mode = S.mode;
  document.querySelectorAll(".segmented button").forEach(x => x.setAttribute("aria-checked", String(x === b)));
  placeSegThumb();
  haptic("tap");
  click(0.4);
  toast(S.mode === "walk" ? "Walk slowly around the object with the phone." : "Rest the phone on something steady and turn the object.", 2800);
}));

$("torchBtn").addEventListener("click", async () => {
  S.torch = !S.torch;
  try { await S.track.applyConstraints({ advanced: [{ torch: S.torch }] }); }
  catch { S.torch = false; toast("The light isn't available right now."); }
  $("torchBtn").classList.toggle("on", S.torch);
  haptic("tap");
});

/* ======================================================================
   Review
   ====================================================================== */
function setLastThumb(rec) {
  const img = $("lastThumb");
  if (rec?.thumb) {
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(rec.thumb);
    img.src = img.dataset.url;
    img.hidden = false;
  } else img.hidden = true;
}
async function refreshCount() {
  const scans = await store.listScans().catch(() => []);
  $("libCount").textContent = scans.length;
  $("libCount").hidden = !scans.length;
  return scans;
}

function openReview(rec, { live = false } = {}) {
  S.reviewing = rec;
  S.preparedZip = null;
  S.panel && $(S.panel).classList.remove("open");
  S.panel = null;
  S.cloudYaw = 0.5;
  S.cloudSpin = reduceMotion ? 0.25 : 2.2;
  setPhase("review");
  const rv = $("review");
  rv.scrollTop = 0;
  rv.classList.remove("open"); void rv.offsetWidth; rv.classList.add("open");

  $("scanName").value = rec.name;
  $("rvSub").textContent = `${rec.mode === "spin" ? "Turntable" : "Walk-around"} scan, ${when(rec.createdAt)}`;
  document.querySelector(".cloud-note").textContent = rec.cloud
    ? `Shape preview from ${rec.cloud.views} outlines. Drag to turn it.`
    : "Not enough outlines for a shape preview.";

  const hasScore = rec.score != null;
  const st = rec.stats;
  selectTab("overview", false);
  S.reviewOpenedAt = performance.now();
  ambientFor(rec);

  // Overview: the score as a ring of dots, lit one by one
  animateNumber($("scoreNum"), hasScore ? rec.score : null);
  $("scoreWord").textContent = hasScore ? rec.word : "Stopped early";
  $("scoreLine").textContent = summaryLine(rec);
  const facts = [
    [`${rec.frames.length}`, "keyframes"],
    [st ? fmtTime(st.seconds) : "–", "scan time"],
    [rec.cloud ? rec.cloud.n.toLocaleString() : "–", "3D points"],
  ];
  $("facts").replaceChildren(...facts.map(([v, k]) => {
    const d = document.createElement("div");
    d.append(Object.assign(document.createElement("dd"), { textContent: v }), Object.assign(document.createElement("dt"), { textContent: k }));
    return d;
  }));
  $("legAround").textContent = `${Math.round(bandFill(rec.coverage, 0) * 100)}%`;
  $("legAbove").textContent = `${Math.round(bandFill(rec.coverage, 1) * 100)}%`;
  const dt = $("dialThumb");
  if (dt.dataset.url) URL.revokeObjectURL(dt.dataset.url);
  if (rec.thumb) { dt.dataset.url = URL.createObjectURL(rec.thumb); dt.src = dt.dataset.url; } else dt.removeAttribute("src");

  // Quality: each measure as a short meter of dots
  const precise = rec.frames.filter(f => f.maskSource === "precise").length;
  const meters = st ? [
    ["Loop around", "every direction at the side", st.coverage],
    ["Views from above", "optional, improves the top", st.top ?? 0],
    ["Sharp views", "time without motion blur", st.sharp],
    ["Steady hands", "time without shake", st.steady],
    ["Good light", "time in usable light", st.light],
    ["Precise outlines", `${precise} of ${rec.frames.length} keyframes`, rec.frames.length ? precise / rec.frames.length : 0],
  ] : [["Precise outlines", `${precise} of ${rec.frames.length} keyframes`, rec.frames.length ? precise / rec.frames.length : 0]];
  S.meterValues = meters.map(m => clamp(m[2], 0, 1));
  $("meters").replaceChildren(...meters.map(([k, sub, v]) => {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.append(Object.assign(document.createElement("b"), { textContent: k }), Object.assign(document.createElement("small"), { textContent: sub }));
    const dots = Object.assign(document.createElement("span"), { className: "meter-dots" }); // drawn with particles
    li.append(label, dots, Object.assign(document.createElement("span"), { className: "val", textContent: `${Math.round(clamp(v, 0, 1) * 100)}%` }));
    return li;
  }));
  const tips = hasScore ? [...rec.tips] : [{ text: "This scan stopped before it finished, but every frame it captured is saved and can be shared." }];
  if (rec.heightM == null) tips.push({ text: "Add the real height on the Overview tab so the 3D model comes out at true size.", cls: "height-tip" });
  $("tips").replaceChildren(...tips.map(t => {
    const li = document.createElement("li");
    if (t.good) li.className = "good";
    if (t.cls) li.classList.add(t.cls);
    li.textContent = t.text;
    return li;
  }));

  // Export: what's in the zip
  $("zipName").textContent = `${slug(rec.name)}.zip`;
  $("zipSize").textContent = "Calculating size";
  const masks = rec.frames.filter(f => f.mask).length;
  const res = rec.imageSize ? `${Math.max(...rec.imageSize)} px` : "";
  $("zipContents").replaceChildren(...[
    [`${rec.frames.length} keyframes`, res],
    [`${masks} object outlines`, precise ? `${precise} precise` : ""],
    ["3D preview", rec.cloud ? `${rec.cloud.n.toLocaleString()} points, PLY` : "not available"],
    ["Scan details", "angles, coverage, height"],
  ].map(([a, b]) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { textContent: a }), Object.assign(document.createElement("span"), { textContent: b }));
    return li;
  }));
  store.getFiles(rec.id).then(files => {
    if (S.reviewing !== rec) return;
    const bytes = files.reduce((n, f) => n + (f.blob?.size || 0), 0);
    $("zipSize").textContent = bytes ? `About ${(bytes / 1e6).toFixed(bytes > 1e7 ? 0 : 1)} MB` : "Size shown when packed";
  }).catch(() => {});

  showHeight(rec.heightM);
  const canResume = live && S.scan && S.scan.id === rec.id && S.stream;
  const loopDone = canResume && targetBand(S.scan.coverage) === -1;
  $("fillBtn").hidden = !canResume || (loopDone && topBonus(S.scan.coverage) >= 1);
  $("fillLabel").textContent = loopDone ? "Add top views" : "Fill gaps";
  resetShare();
  if (live) haptic(hasScore && rec.score >= 72 ? "ring" : "tap");
}

function summaryLine(rec) {
  if (rec.score == null) return "This scan stopped early. Its frames are saved.";
  const st = rec.stats || {};
  if (st.coverage >= 0.99 && (st.top ?? 0) >= 0.5) return "Every angle covered, from the side and above.";
  if (st.coverage >= 0.99) return "All the way around. Views from above would make it even better.";
  return `${Math.round(st.coverage * 100)}% of the way around. Fill the gaps for a complete model.`;
}

const TABS = ["overview", "quality", "export"];
let currentTab = "overview";
function selectTab(name, feedback = true) {
  const from = TABS.indexOf(currentTab), to = TABS.indexOf(name);
  currentTab = name;
  S.tabAt = performance.now();
  document.querySelectorAll(".tabs [role=tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tabThumb").style.transform = `translateX(${to * 100}%)`;
  document.querySelectorAll(".pane").forEach(p => {
    const on = p.id === `pane-${name}`;
    p.classList.toggle("from-left", on && to < from);
    p.classList.toggle("active", on);
  });
  if (feedback) { haptic("tick"); click(0.5); }
}
document.querySelectorAll(".tabs [role=tab]").forEach(b => b.addEventListener("click", () => { if (b.dataset.tab !== currentTab) selectTab(b.dataset.tab); }));
// the particles drawing the preview and the sheet ride along with the scroll instead of chasing it
{
  const rv = $("review");
  let last = 0;
  rv.addEventListener("scroll", () => {
    const dy = last - rv.scrollTop;
    last = rv.scrollTop;
    if (dy && S.phase === "review" && !S.panel) P.shift(0, REVIEW_UI[1], 0, dy);
  }, { passive: true });
}

// swipe between tabs
{
  let sx = 0, sy = 0, tracking = false;
  const panes = $("panes");
  panes.addEventListener("pointerdown", e => { if (e.target.closest("input, button")) return; sx = e.clientX; sy = e.clientY; tracking = true; });
  panes.addEventListener("pointerup", e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = TABS.indexOf(currentTab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) selectTab(TABS[i]);
  });
  panes.addEventListener("pointercancel", () => { tracking = false; });
}

function animateNumber(el, target) {
  if (target == null) { el.textContent = "–"; return; }
  if (reduceMotion) { el.textContent = target; return; }
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / 1300);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), 350);
}

function showHeight(m) {
  document.querySelectorAll(".mini-seg button").forEach(b => b.classList.toggle("on", b.dataset.unit === unit));
  $("scanHeight").value = m == null ? "" : unit === "cm" ? +(m * 100).toFixed(1) : +(m / 0.0254).toFixed(1);
}

function closeReview({ resume = false } = {}) {
  $("review").classList.remove("open");
  S.reviewing = null;
  if (!resume) clearSelection(); // back in the camera, look for whatever it is pointed at now
  setPhase(S.stream ? "live" : "intro");
}

function resetShare() {
  S.preparedZip = null;
  $("shareLabel").textContent = "Share scan";
  $("shareMeta").textContent = "";
  $("shareBtn").classList.remove("busy");
  $("shareBtn").disabled = false;
}

async function updateRecord(patch) {
  const rec = S.reviewing;
  if (!rec) return;
  Object.assign(rec, patch);
  if (S.scan && S.scan.id === rec.id) Object.assign(S.scan, patch);
  resetShare();
  await store.putScan(rec).catch(() => {});
}

$("scanName").addEventListener("change", e => updateRecord({ name: e.target.value.trim() || S.reviewing.name }));
$("scanName").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("scanHeight").addEventListener("change", e => {
  const v = parseFloat(e.target.value);
  updateRecord({ heightM: v > 0 ? (unit === "cm" ? v / 100 : v * 0.0254) : null });
  document.querySelector(".tips .height-tip")?.toggleAttribute("hidden", v > 0);
});
document.querySelectorAll(".mini-seg button").forEach(b => b.addEventListener("click", () => {
  unit = b.dataset.unit;
  try { localStorage.setItem("orbit.unit", unit); } catch {}
  showHeight(S.reviewing?.heightM ?? null);
  haptic("tap");
}));

// drag to turn the 3D preview
{
  const a = $("cloudAnchor");
  let lx = 0, ly = 0, lt = 0, v = 0;
  a.addEventListener("pointerdown", e => { S.dragging = true; lx = e.clientX; ly = e.clientY; lt = e.timeStamp; v = 0; a.setPointerCapture(e.pointerId); haptic("tap"); });
  a.addEventListener("pointermove", e => {
    if (!S.dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    S.cloudYaw += dx * 0.011;
    S.cloudPitch = clamp(S.cloudPitch + dy * 0.006, -0.3, 1.1);
    v = (dx * 0.011) / Math.max(1, e.timeStamp - lt) * 1000;
    lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
  });
  const end = () => { if (!S.dragging) return; S.dragging = false; S.cloudSpin = clamp(v, -4, 4) || 0.25; };
  a.addEventListener("pointerup", end);
  a.addEventListener("pointercancel", end);
}

document.querySelectorAll("[data-close=review]").forEach(b => b.addEventListener("click", () => { haptic("tap"); closeReview(); }));
$("againBtn").addEventListener("click", () => { haptic("tap"); S.scan = null; closeReview(); });
$("fillBtn").addEventListener("click", () => {
  haptic("tap");
  const top = S.scan && targetBand(S.scan.coverage) === -1;
  closeReview({ resume: true });
  beginScanning(true, top ? "top" : "loop");
  toast(top ? "Raise the phone and look down at it, then walk around." : "Walk to the gaps to fill them.", 3000);
});
$("deleteBtn").addEventListener("click", async () => {
  const rec = S.reviewing;
  if (!rec || !confirm(`Delete "${rec.name}" and all its frames? This can't be undone.`)) return;
  await store.deleteScan(rec.id);
  if (S.scan?.id === rec.id) S.scan = null;
  haptic("warn");
  closeReview();
  const scans = await refreshCount();
  setLastThumb(scans[0]);
  toast("Scan deleted.");
});

/* ---------- share (zip) ---------- */
function scanJson(rec) {
  return {
    app: `Orbit web ${VERSION}`,
    name: rec.name,
    created: new Date(rec.createdAt).toISOString(),
    mode: rec.mode === "spin" ? "turntable" : "walk-around",
    height_m: rec.heightM,
    image_size: rec.imageSize,
    frame_count: rec.frames.length,
    masks: "masks/<image name>.png: white = object, black = background (COLMAP --ImageReader.mask_path layout). Masks are low-res; prepare_scan.py upscales them.",
    angles: "azimuth is degrees around the object relative to the first frame; elevation is degrees the camera looked down.",
    preview: rec.cloud ? "preview.ply: rough silhouette point cloud (visual hull) built on the phone" : null,
    score: rec.score,
    stats: rec.stats,
    coverage: BANDS.map((b, i) => ({ band: b.label, elevation_deg: [b.elevMin, b.elevMax], sectors: b.sectors, covered: rec.coverage[i] })),
    frames: rec.frames,
  };
}

const README = rec => `${rec.name}, captured with Orbit.

images/      sharp keyframes picked automatically while scanning
masks/       object masks for each keyframe (white = object)
preview.ply  rough 3D point cloud built on the phone from the outlines (opens in Blender, MeshLab, CloudCompare)
scan.json    angles, sharpness, object boxes, coverage, real height

For a high-quality, photo-textured model: save this zip to Google Drive in 3d-scanner/scans/,
open colab_scanner.ipynb in Colab and choose Runtime > Run all. The model (USDZ for iPhone AR,
GLB, OBJ) appears in 3d-scanner/models/${slug(rec.name)}/.
`;

function download(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function shareFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      haptic("lock");
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
      if (e.name === "NotAllowedError") return "needs-tap";
    }
  }
  download(file);
  return "downloaded";
}

$("shareBtn").addEventListener("click", async () => {
  const rec = S.reviewing;
  if (!rec) return;
  const btn = $("shareBtn");
  haptic("tap");
  if (S.preparedZip?.id === rec.id) {
    const r = await shareFile(S.preparedZip.file);
    if (r === "needs-tap") toast("Tap once more to send it.");
    return;
  }
  btn.classList.add("busy");
  $("shareLabel").textContent = "Packing";
  try {
    const files = (await store.getFiles(rec.id)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const list = files.map(f => ({ name: f.name, data: f.blob }));
    if (rec.cloud) list.push({ name: "preview.ply", data: toPly(rec.cloud, rec.heightM) });
    list.push({ name: "scan.json", data: JSON.stringify(scanJson(rec), null, 2) });
    list.push({ name: "README.txt", data: README(rec) });
    guard.begin("pack");
    const zip = await makeZip(list, p => { $("shareMeta").textContent = `${Math.round(p * 100)}%`; });
    guard.end("pack");
    const file = new File([zip], `${slug(rec.name)}.zip`, { type: "application/zip" });
    S.preparedZip = { id: rec.id, file };
    btn.classList.remove("busy");
    $("shareLabel").textContent = "Send zip";
    $("shareMeta").textContent = `${(zip.size / 1e6).toFixed(1)} MB`;
    const r = await shareFile(file);
    if (r === "needs-tap") toast("Packed. Tap Send zip to share it.");
  } catch (e) {
    guard.end("pack");
    logError("pack", e);
    resetShare();
    toast(`Couldn't pack the scan: ${e?.message || e}`, 5000);
  }
});

/* ======================================================================
   Library & settings
   ====================================================================== */
function openPanel(name) {
  S.panel = name;
  const el = $(name);
  el.scrollTop = 0;
  el.querySelectorAll(".list li, .row").forEach((r, i) => r.style.setProperty("--i", i));
  el.classList.remove("open"); void el.offsetWidth; el.classList.add("open");
  syncDim();
}
function closePanels() {
  if (!S.panel) return;
  $(S.panel).classList.remove("open");
  S.panel = null;
  syncDim();
}
document.querySelectorAll("[data-close=library],[data-close=settings]").forEach(b => b.addEventListener("click", () => { haptic("tap"); closePanels(); }));

const libUrls = [];
$("libraryBtn").addEventListener("click", async () => {
  if (S.phase !== "live") return;
  haptic("tap");
  libUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const scans = await refreshCount();
  $("scanList").replaceChildren(...scans.map(rec => {
    const li = document.createElement("li");
    const btn = Object.assign(document.createElement("button"), { className: "scan-row" });
    const th = Object.assign(document.createElement("span"), { className: "th" });
    if (rec.thumb) {
      const img = document.createElement("img");
      const u = URL.createObjectURL(rec.thumb);
      libUrls.push(u);
      img.src = u;
      img.alt = "";
      th.append(img);
    } else th.innerHTML = '<svg class="ic"><use href="#i-stack"/></svg>';
    const text = document.createElement("span");
    text.append(
      Object.assign(document.createElement("b"), { textContent: rec.name }),
      Object.assign(document.createElement("small"), { textContent: `${shortWhen(rec.createdAt)}, ${rec.frames.length} frames${rec.status === "complete" ? "" : ", stopped early"}` }),
    );
    const score = Object.assign(document.createElement("span"), { className: "pill", textContent: rec.score ?? "–" });
    const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chev.setAttribute("class", "ic chev");
    chev.innerHTML = '<use href="#i-chev"/>';
    btn.append(th, text, score, chev);
    btn.addEventListener("click", () => { haptic("tap"); openReview(rec, { live: S.scan?.id === rec.id }); });
    li.append(btn);
    return li;
  }));
  openPanel("library");
});

// The Stability rows: what precise outlines are doing, and a report to send if the app keeps restarting.
function syncStability() {
  const sw = $("preciseSwitch"), note = $("preciseNote");
  if (!sw) return;
  sw.checked = !!settings.precise;
  const gpu = !!navigator.gpu;
  sw.disabled = !gpu;
  note.textContent = !gpu ? "Needs WebGPU, which this device doesn't have"
    : refiner.loading ? "Loading"
    : refiner.ready ? "On. Sharper object edges, uses more memory"
    : !settings.precise && guard.struck("refiner") ? "Off after the app restarted. Turn on to try again"
    : !settings.precise ? "Off"
    : "Sharper object edges, uses more memory";
  const last = guard.last;
  $("diagNote").textContent = last ? `Last restart: ${last.name}, ${shortWhen(last.at)}` : "Send this if the app keeps restarting";
}
function onPreciseToggle(on) {
  if (on) {
    guard.forgive("refiner");
    refiner.failed = false;
    if (S.stream) loadRefiner();
  } else refiner.unload(); // give the memory back
  syncStability();
}
$("diagBtn").addEventListener("click", async () => {
  haptic("tap");
  const text = report({ settings, phase: S.phase, refiner: { ready: refiner.ready, device: refiner.device, ms: Math.round(refiner.ms) }, outliner: { ready: outliner.ready, delegate: outliner.delegate, failed: outliner.failed } });
  try { await navigator.clipboard.writeText(text); toast("Diagnostics copied.", 2200); }
  catch { const box = $("diagOut"); box.value = text; box.hidden = false; box.select(); toast("Select the text and copy it.", 3000); }
});

document.querySelectorAll("[data-setting]").forEach(input => {
  const key = input.dataset.setting;
  input.checked = !!settings[key];
  input.addEventListener("change", () => {
    settings[key] = input.checked;
    saveSettings();
    applySettings();
    if (key === "precise") onPreciseToggle(input.checked);
    haptic(input.checked ? "lock" : "tap");
    if (key === "sound" && input.checked) { unlockAudio(); chime("lock"); }
    if (key === "voice" && input.checked) { unlockAudio(); say("Spoken guidance is on.", { force: true }); }
  });
});

$("settingsBtn").addEventListener("click", async () => {
  if (S.phase !== "live") return;
  haptic("tap");
  openPanel("settings");
  try {
    const { usage } = await navigator.storage.estimate();
    $("storageNote").textContent = `Scans use ${(usage / 1e6).toFixed(0)} MB on this phone.`;
  } catch { $("storageNote").textContent = ""; }
});

/* ---------- lifecycle ---------- */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (S.phase === "scanning") finishScan("interrupted");
  } else if (S.phase !== "intro") {
    keepAwake();
    if (!S.track || S.track.readyState === "ended") recoverCamera();
  }
});

syncStability();
if (crashNotice) setTimeout(() => toast(crashNotice, 7000), 1200);

refreshCount().then(scans => {
  S.scanCount = scans.length;
  setLastThumb(scans[0]);
});

// Expose internals for debugging from the console.
window.orbit = { S, T, P, motion, outliner, refiner, analyzer, settings, frame, openReview, guard };

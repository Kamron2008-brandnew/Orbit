// The intro: a turntable gallery of point-cloud shapes, each scanned in by a ring that sweeps down it.

import { haptic } from "../haptics.js";
import { introShapes, project } from "../particles.js";
import { COUNT, INTRO_FLOOR, INTRO_N, INTRO_SCAN, INTRO_STARS, MORPH_SECONDS, SHAPE_SECONDS } from "../config.js";
import { paletteAt } from "./palette.js";
import { $, particles, reduceMotion, state } from "../state.js";
import { clamp, easeInOut, hash } from "../util.js";

export const SHAPES = introShapes(INTRO_N);
// each shape's width at every height, so the scanning ring hugs the object as it passes
for (const sh of SHAPES) {
  const prof = new Float32Array(33);
  for (let i = 0; i < INTRO_N; i++) {
    const k = Math.round((sh.pts[3 * i + 1] + 1) * 16);
    if (k >= 0 && k <= 32) prof[k] = Math.max(prof[k], Math.hypot(sh.pts[3 * i], sh.pts[3 * i + 2]));
  }
  sh.prof = prof.map((v, k) => Math.max(v, prof[k - 1] || 0, prof[k + 1] || 0));
}
const SHAPE_NAMES = {
  vase: "Vase",
  knot: "Trefoil knot",
  planet: "Ringed planet",
  helix: "Double helix",
  gem: "Cut gem",
  heart: "Heart",
  torus: "Torus",
};
// intro state: which shape is shown, the pass that scans in the next, and the turntable you can spin
const gallery = {
  cur: -1,
  shownAt: 0,
  morph: null,
  side: new Uint8Array(INTRO_N),
  yaw: 0.6,
  spin: 0.42,
  tilt: 0,
  dragging: false,
  par: 0,
  parT: 0,
  snap: true,
};

// Start the scanning ring's pass that builds the next shape (from loose dust, the first time).
function nextShape(now) {
  const to = (gallery.cur + 1) % SHAPES.length;
  gallery.morph = { from: gallery.cur, to, at: now };
  gallery.side.fill(0);
  const sh = SHAPES[to],
    [lo, hi] = sh.palette;
  const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
  const intro = $("intro");
  intro.style.setProperty("--amb-a", css(hi));
  intro.style.setProperty("--amb-b", css(lo));
  const label = $("specimen");
  label.classList.remove("show");
  setTimeout(
    () => {
      $("specName").textContent = SHAPE_NAMES[sh.name] || sh.name;
      $("specMeta").textContent = `${INTRO_N.toLocaleString()} points`;
      label.classList.add("show");
    },
    reduceMotion ? 0 : 380,
  );
}

export function formIntro(now, dt) {
  const r = $("introAnchor").getBoundingClientRect();
  const cx = r.left + r.width / 2,
    cy = r.top + r.height * 0.47;
  const scale = Math.min(r.width * 0.36, r.height * 0.38);
  const t = now / 1000;
  const o = [0, 0, 0];
  // the turntable: turns on its own, or with your finger, then eases back to its own pace
  if (!gallery.dragging) {
    gallery.yaw += gallery.spin * dt;
    gallery.spin += (0.42 - gallery.spin) * Math.min(1, dt * 0.9);
    gallery.tilt *= 1 - Math.min(1, dt * 1.5);
  }
  gallery.par += (gallery.parT - gallery.par) * Math.min(1, dt * 3);
  const yaw = gallery.yaw,
    pitch = 0.28 + gallery.tilt;
  const cyw = Math.cos(yaw),
    syw = Math.sin(yaw);

  if (!gallery.morph) {
    if (gallery.cur < 0)
      nextShape(now + 400); // the very first pass starts a moment after the nebula appears
    else if (now - gallery.shownAt > SHAPE_SECONDS * 1000) nextShape(now);
  }
  const M = gallery.morph;
  // the pass: the ring rises to the top, then sweeps down; points below it are still the old shape
  let planeY = 2,
    prog = 1;
  if (M) {
    const age = Math.max(0, now - M.at) / 1000,
      rise = reduceMotion ? 0 : 0.35;
    prog = clamp((age - rise) / (reduceMotion ? 0.01 : MORPH_SECONDS), 0, 1);
    planeY = 1.22 - 2.44 * easeInOut(prog);
    if (prog >= 1 && age > rise + MORPH_SECONDS + 0.05) {
      gallery.cur = M.to;
      gallery.morph = null;
      gallery.shownAt = now;
    }
  }
  const showIdx = M ? M.to : gallery.cur;
  const B = SHAPES[showIdx],
    A = M && M.from >= 0 ? SHAPES[M.from] : null;
  // light from the upper left, a little in front: soft shading plus a moving glint, so the cloud reads as solid
  const Lx = -0.52,
    Ly = 0.5,
    Lz = 0.69,
    Hx = Lx / 1.84,
    Hy = Ly / 1.84,
    Hz = (Lz + 1) / 1.84;

  for (let i = 0; i < INTRO_N; i++) {
    const yB = B.pts[3 * i + 1];
    let S2 = B,
      pass = true;
    if (M && planeY > yB) {
      pass = false;
      S2 = A;
    }
    if (M && pass && !gallery.side[i]) {
      gallery.side[i] = 1;
      particles.kick(i, (Math.random() - 0.5) * 24, -12 - Math.random() * 16, 140);
    } // scanned: a brief flash
    if (!S2) {
      // the first pass condenses the shape out of a faint, slowly turning nebula at the same heights
      const a = hash(i) * Math.PI * 2 + t * (0.1 + 0.1 * hash(i + 0.3)),
        rr = 1.25 + hash(i + 0.5) * 1.1;
      project(Math.cos(a) * rr, yB + (hash(i + 0.9) - 0.5) * 0.08, Math.sin(a) * rr, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 2) / 4, 0, 1),
        c = paletteAt(hash(i + 0.2) * 0.8);
      (gallery.snap ? particles.place : particles.attract).call(
        particles,
        i,
        o[0],
        o[1],
        0.9 + 1.2 * d,
        c[0],
        c[1],
        c[2],
        0.06 + 0.16 * d,
      ); // first frame: already there
      continue;
    }
    const x = S2.pts[3 * i],
      y = S2.pts[3 * i + 1],
      z = S2.pts[3 * i + 2];
    project(x, y, z, yaw, pitch, cx, cy, scale, o);
    const d = clamp((o[2] + 0.8) / 1.6, 0, 1);
    // a rough surface normal (out from the axis), turned with the shape
    const xr = x * cyw + z * syw,
      zr = -x * syw + z * cyw;
    const nl = Math.hypot(xr, y * 0.35, zr) || 1,
      nx = xr / nl,
      ny = (y * 0.35) / nl,
      nz = zr / nl;
    const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
    const spec = Math.pow(Math.max(0, nx * Hx + ny * Hy + nz * Hz), 22);
    const [lo, hi] = S2.palette,
      h = (y + 1) / 2;
    const near = M ? Math.max(0, 1 - Math.abs(yB - planeY) / 0.1) : 0; // just scanned: white hot
    const lum = 0.5 + 0.3 * diff + 0.25 * d;
    const w = Math.min(1, spec * 0.85 + near * 0.8);
    const cr = (lo[0] + (hi[0] - lo[0]) * h) * lum,
      cg = (lo[1] + (hi[1] - lo[1]) * h) * lum,
      cb = (lo[2] + (hi[2] - lo[2]) * h) * lum;
    particles.attract(
      i,
      o[0],
      o[1],
      1.3 + 2.1 * d + spec * 1.6 + near * 1.5,
      Math.min(1, cr + (1 - cr) * w),
      Math.min(1, cg + (1 - cg) * w),
      Math.min(1, cb + (1 - cb) * w),
      Math.min(1, 0.26 + 0.7 * d + near),
    );
  }

  // the turntable ring under the shape, in the ambient palette
  const fN = INTRO_FLOOR[1] - INTRO_FLOOR[0];
  for (let j = 0; j < fN; j++) {
    const a = (j / fN) * Math.PI * 2 + t * 0.12;
    project(Math.cos(a) * 0.95, -1.1, Math.sin(a) * 0.95, yaw, pitch, cx, cy, scale, o);
    const d = clamp((o[2] + 1) / 2, 0, 1),
      c = paletteAt(j / fN + t * 0.03);
    (gallery.snap ? particles.place : particles.attract).call(
      particles,
      INTRO_FLOOR[0] + j,
      o[0],
      o[1],
      1 + 1.5 * d,
      c[0],
      c[1],
      c[2],
      0.08 + 0.42 * d,
    );
  }

  // the scanning ring: rests in the floor ring, rises to the top for a pass, and hugs the shape on the way down
  const sN = INTRO_SCAN[1] - INTRO_SCAN[0];
  const prof = (sh) => {
    const k = clamp((planeY + 1) * 16, 0, 32),
      k0 = Math.floor(k),
      k1 = Math.min(32, k0 + 1);
    return sh.prof[k0] + (sh.prof[k1] - sh.prof[k0]) * (k - k0);
  };
  const ringR = M ? Math.max(0.3, Math.max(prof(B), A ? prof(A) : 0) + 0.14) : 0.95;
  const [blo, bhi] = B.palette;
  for (let j = 0; j < sN; j++) {
    const i = INTRO_SCAN[0] + j;
    const a = (j / sN) * Math.PI * 2 - t * 0.9;
    if (M && prog > 0 && prog < 1) {
      project(Math.cos(a) * ringR, planeY, Math.sin(a) * ringR, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1.2) / 2.4, 0, 1),
        h = clamp((planeY + 1) / 2, 0, 1);
      const cr = blo[0] + (bhi[0] - blo[0]) * h,
        cg = blo[1] + (bhi[1] - blo[1]) * h,
        cb = blo[2] + (bhi[2] - blo[2]) * h;
      particles.place(i, o[0], o[1], 2.2 + 3 * d, 0.6 + 0.4 * cr, 0.6 + 0.4 * cg, 0.6 + 0.4 * cb, 0.5 + 0.5 * d);
    } else if (M && prog === 0) {
      // rising
      project(Math.cos(a) * ringR, 1.22, Math.sin(a) * ringR, yaw, pitch, cx, cy, scale, o);
      particles.attract(i, o[0], o[1], 2.2, 1, 1, 1, 0.8);
    } else {
      // resting among the floor ring
      const fa = ((j + 0.5) / sN) * Math.PI * 2 + t * 0.12;
      project(Math.cos(fa) * 0.95, -1.1, Math.sin(fa) * 0.95, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1) / 2, 0, 1),
        c = paletteAt(j / sN + t * 0.03);
      (gallery.snap ? particles.place : particles.attract).call(
        particles,
        i,
        o[0],
        o[1],
        1 + 1.5 * d,
        c[0],
        c[1],
        c[2],
        0.08 + 0.42 * d,
      );
    }
  }
  gallery.snap = false;

  // stars at three depths, drifting slowly and shifting with the turntable (parallax)
  const W = innerWidth,
    H = innerHeight;
  for (let i = INTRO_STARS[0]; i < INTRO_STARS[1]; i++) {
    const k = i - INTRO_STARS[0],
      layer = k % 3,
      h1 = hash(k),
      h2 = hash(k + 0.37),
      h3 = hash(k + 0.71);
    const depth = [0.25, 0.55, 1][layer];
    const x =
      ((((h1 * (W + 80) + t * 2.2 * depth + (yaw - t * 0.42) * 26 * depth + gallery.par * depth) % (W + 80)) +
        (W + 80)) %
        (W + 80)) -
      40;
    const y = h2 * (H + 40) - 20 + Math.sin(t * 0.07 + h3 * 6) * 6 * depth;
    const bright = h3 > 0.975; // a few brighter stars
    const tw = 0.55 + 0.45 * Math.sin(t * (0.6 + h3 * 1.6) + h1 * 40);
    const c = paletteAt(h2 * 0.8);
    const mix = bright ? 0.5 : 0.25;
    const size = bright ? 2.6 : [0.9, 1.3, 1.8][layer];
    const alpha = (bright ? 0.75 : [0.16, 0.26, 0.38][layer]) * tw;
    particles.place(i, x, y, size, 1 - mix + mix * c[0], 1 - mix + mix * c[1], 1 - mix + mix * c[2], alpha);
  }
  for (let i = INTRO_STARS[1]; i < COUNT; i++) particles.free(i, 1, 1, 1, 1, 0);
}

// The intro shape is a turntable: drag to spin or tilt it, tap it for the next one.
{
  const intro = $("intro");
  let sx = 0,
    sy = 0,
    lx = 0,
    ly = 0,
    lt = 0,
    v = 0,
    moved = false,
    down = false;
  intro.addEventListener("pointerdown", (e) => {
    if (state.phase !== "intro" || e.target.closest(".intro-copy")) return;
    down = true;
    moved = false;
    sx = lx = e.clientX;
    sy = ly = e.clientY;
    lt = e.timeStamp;
    v = 0;
    gallery.dragging = true;
    intro.setPointerCapture(e.pointerId);
  });
  intro.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - lx,
      dy = e.clientY - ly,
      dtm = Math.max(1, e.timeStamp - lt);
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 6) moved = true;
    gallery.yaw += dx * 0.009;
    gallery.tilt = clamp(gallery.tilt + dy * 0.004, -0.45, 0.45);
    gallery.parT = clamp(gallery.parT + dx * 0.4, -60, 60);
    v = v * 0.6 + ((dx * 0.009) / (dtm / 1000)) * 0.4;
    lx = e.clientX;
    ly = e.clientY;
    lt = e.timeStamp;
  });
  const end = () => {
    if (!down) return;
    down = false;
    gallery.dragging = false;
    gallery.parT = 0;
    if (moved) {
      gallery.spin = clamp(v, -6, 6);
      return;
    }
    if (!gallery.morph) {
      haptic("tap");
      nextShape(performance.now());
    } // a tap scans in the next shape
  };
  intro.addEventListener("pointerup", end);
  intro.addEventListener("pointercancel", end);
}

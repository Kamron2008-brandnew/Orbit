// The camera view: the object drawn as particles, the coverage rings, and the searching reticle.

import { BANDS, progressOf, sectorFor } from "../geometry.js";
import { resampleContour } from "../vision.js";
import { COUNT, EDGE, FILL, RING, RING_COUNTS, RING_LAT, SEEK, VISIBLE_DUST_END } from "../config.js";
import { goalBand } from "../scan.js";
import { dust, paletteAt } from "./palette.js";
import { analyzer, outliner, particles, state, targets, video } from "../state.js";
import { clamp } from "../util.js";

function coverMap() {
  const vw = video.videoWidth || 1080,
    vh = video.videoHeight || 1920;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const dw = vw * s,
    dh = vh * s;
  return { ox: (innerWidth - dw) / 2, oy: (innerHeight - dh) / 2, dw, dh };
}

export function rebuildTargets(obj) {
  const { W, H, lab } = obj;
  const rgba = analyzer.rgba,
    AW = analyzer.W,
    AH = analyzer.H;
  const rc = resampleContour(obj.contour, EDGE[1] - EDGE[0]);
  if (!rc || !rgba) return;
  const [cx, cy] = obj.center;
  const sample = (nx, ny, out, o) => {
    const px = clamp(Math.round(nx * AW), 0, AW - 1),
      py = clamp(Math.round(ny * AH), 0, AH - 1);
    const q = (py * AW + px) * 4;
    out[o] = rgba[q] / 255;
    out[o + 1] = rgba[q + 1] / 255;
    out[o + 2] = rgba[q + 2] / 255;
  };
  for (let j = 0; j < rc.length; j++) {
    targets.edge[2 * j] = rc[j][0];
    targets.edge[2 * j + 1] = rc[j][1];
    sample(rc[j][0] + (cx - rc[j][0]) * 0.06, rc[j][1] + (cy - rc[j][1]) * 0.06, targets.edgeCol, 3 * j); // just inside the edge
  }
  const [x0, y0, x1, y1] = obj.box;
  for (let j = 0; j < targets.fillOK.length; j++) {
    const px = Math.floor(x0 + targets.fillU[j] * (x1 - x0)),
      py = Math.floor(y0 + targets.fillV[j] * (y1 - y0));
    const inside = px >= 0 && py >= 0 && px < W && py < H && lab[py * W + px] === 1;
    targets.fillOK[j] = inside ? 1 : 0;
    if (inside) {
      targets.fill[2 * j] = (px + 0.5) / W;
      targets.fill[2 * j + 1] = (py + 0.5) / H;
      sample(targets.fill[2 * j], targets.fill[2 * j + 1], targets.fillCol, 3 * j);
    }
  }
  targets.box = obj.boxN;
  targets.ready = true;
}

// object points: the object's own colour, lifted so it reads as light
const tint = (c) => Math.min(1, c * 0.72 + 0.3);

export function formCamera(now) {
  const t = now / 1000;
  const sc = state.scan;
  const m = coverMap();
  const showObj =
    targets.ready &&
    (state.locked || state.phase === "scanning" || state.phase === "saving" || now < state.retargetUntil);
  if (showObj) {
    // a scan plane drifts up and down the object, lighting the points it passes
    const top = targets.box[1],
      ht = targets.box[3] - targets.box[1];
    const sweepY = top + (0.5 + 0.5 * Math.sin(t * (state.phase === "scanning" ? 1.6 : 0.9))) * ht;
    const band = ht * 0.06;
    for (let j = 0, i = EDGE[0]; i < EDGE[1]; i++, j++) {
      const ny = targets.edge[2 * j + 1];
      const lit = Math.max(0, 1 - Math.abs(ny - sweepY) / band);
      const x = m.ox + targets.edge[2 * j] * m.dw + Math.sin(t * 2.3 + j * 1.7) * 0.6;
      const y = m.oy + ny * m.dh + Math.cos(t * 2.1 + j * 1.3) * 0.6;
      // the edge glows in the ambient palette, flowing slowly around the object; it settles (stops
      // shimmering) once the precise outline has landed, and the scan plane whitens it as it passes
      const c = paletteAt(j / (EDGE[1] - EDGE[0]) + t * 0.06);
      const w = lit * 0.7;
      const a = state.precise ? 1 : 0.7 + 0.3 * Math.sin(t * 5 + j * 0.3);
      particles.attract(
        i,
        x,
        y,
        4.2 + lit * 2.4,
        c[0] + (1 - c[0]) * w,
        c[1] + (1 - c[1]) * w,
        c[2] + (1 - c[2]) * w,
        a,
      );
    }
    // the body fills in as coverage grows: you are literally building the point cloud
    const prog = sc ? progressOf(sc.coverage) : 0;
    const share = state.phase === "scanning" || state.phase === "saving" ? 0.3 + 0.7 * prog : 0.42;
    const active = Math.floor((FILL[1] - FILL[0]) * share);
    for (let j = 0, i = FILL[0]; i < FILL[1]; i++, j++) {
      if (j < active && targets.fillOK[j]) {
        const r = targets.fillCol[3 * j],
          g = targets.fillCol[3 * j + 1],
          b = targets.fillCol[3 * j + 2];
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        const ny = targets.fill[2 * j + 1];
        const lit = Math.max(0, 1 - Math.abs(ny - sweepY) / band);
        const twinkle = 0.82 + 0.18 * Math.sin(t * 3.1 + particles.seed[i] * 40);
        const x = m.ox + targets.fill[2 * j] * m.dw + Math.sin(t * 1.7 + j) * 0.7;
        const y = m.oy + ny * m.dh + Math.cos(t * 1.9 + j * 0.7) * 0.7;
        const c = paletteAt(ny * 0.6 + t * 0.06); // the object's own colours; the scan plane lights them in the ambient palette
        particles.attract(
          i,
          x,
          y,
          2.8 + lum * 1.4 + lit * 2.2,
          Math.min(1, tint(r) + lit * 0.45 * c[0]),
          Math.min(1, tint(g) + lit * 0.45 * c[1]),
          Math.min(1, tint(b) + lit * 0.45 * c[2]),
          Math.min(1, (0.72 + lum * 0.28) * twinkle + lit),
        );
      } else dust(i);
    }
  } else {
    for (let i = EDGE[0]; i < FILL[1]; i++) dust(i);
  }

  // coverage rings around the object
  if (showObj && sc && (state.phase === "scanning" || state.phase === "saving")) formRings(now, m);
  else for (let i = RING[0]; i < RING[1]; i++) dust(i);

  // searching reticle: in the middle of the view while looking for an object, or where it was last seen
  if (
    !state.locked &&
    (state.phase === "live" || state.phase === "scanning") &&
    (state.phase === "live" || state.lastObj)
  ) {
    const at = state.lastObj ? state.lastObj.center : [0.5, 0.5];
    const sx = m.ox + at[0] * m.dw,
      sy = m.oy + at[1] * m.dh;
    const loading = !outliner.ready;
    const n = SEEK[1] - SEEK[0];
    const R = loading ? 46 : 30 + Math.sin(t * 2.4) * 3;
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + t * (loading ? 1.6 : 0.6);
      const wob = loading ? Math.sin(a * 3 + t * 3) * 6 : 0;
      const c = paletteAt(j / n + t * 0.1);
      particles.attract(
        SEEK[0] + j,
        sx + Math.cos(a) * (R + wob),
        sy + Math.sin(a) * (R + wob),
        2.2,
        c[0],
        c[1],
        c[2],
        0.55 + 0.35 * Math.sin(a * 2 + t * 4),
      );
    }
  } else for (let i = SEEK[0]; i < SEEK[1]; i++) dust(i);

  for (let i = SEEK[1]; i < COUNT; i++) dust(i);
}

export const BAND_COL = [
  [0.56, 0.89, 1],
  [0.76, 0.63, 1],
]; // the loop in ice cyan, the top pass in violet
const ringFront = [
  [0, 0],
  [0, 0],
  [0, 0],
];

function formRings(now, m) {
  for (let i = RING[0] + RING_COUNTS.reduce((a, b) => a + b, 0); i < RING[1]; i++) dust(i);
  const sc = state.scan;
  const cov = sc ? sc.coverage : null;
  const rot = sc?.lastAngle ?? 0;
  const tb = sc ? goalBand(sc) : 0;
  const [bx0, by0, bx1, by1] = targets.box;
  const X0 = m.ox + bx0 * m.dw,
    X1 = m.ox + bx1 * m.dw,
    Y0 = m.oy + by0 * m.dh,
    Y1 = m.oy + by1 * m.dh;
  const cx = (X0 + X1) / 2,
    cy = (Y0 + Y1) / 2;
  const R = (Math.max(X1 - X0, Y1 - Y0) / 2) * 1.16;
  let i = RING[0];
  for (let b = 0; b < BANDS.length; b++) {
    const lat = (RING_LAT[b] * Math.PI) / 180;
    const rr = R * Math.cos(lat),
      ry = rr * 0.3,
      yc = cy + R * 0.12 - R * Math.sin(lat) * 0.95;
    const n = RING_COUNTS[b];
    ringFront[b][0] = cx;
    ringFront[b][1] = yc + ry;
    for (let k = 0; k < n; k++, i++) {
      const a = (k / n) * 360;
      const rad = (a * Math.PI) / 180;
      const front = (Math.cos(rad) + 1) / 2;
      const x = cx + rr * Math.sin(rad),
        y = yc + ry * Math.cos(rad);
      const theta = (((rot - a) % 360) + 360) % 360;
      const covered = cov && cov[b][sectorFor(b, theta)];
      const [cr, cg, cb] = BAND_COL[b];
      if (covered) particles.attract(i, x, y, 2.4 + 2.6 * front, cr, cg, cb, 0.6 + 0.4 * front);
      else {
        const here = b === Math.max(0, tb) && (a < 5 || a > 355);
        if (here)
          particles.attract(i, x, y, 5.5, 1, 1, 1, 1); // you are here: the one pure-white point
        else particles.attract(i, x, y, 1.4 + 1.1 * front, 1, 1, 1, (b === tb ? 0.22 : 0.1) + 0.16 * front);
      }
    }
  }
}

// A handful of dust particles flare up from the ring and fall into the object: a new angle was captured.
export function sparks(band, count = 12) {
  const [fx, fy] = ringFront[band];
  const box = targets.box,
    m = coverMap();
  const tx = m.ox + ((box[0] + box[2]) / 2) * m.dw,
    ty = m.oy + ((box[1] + box[3]) / 2) * m.dh;
  for (let k = 0; k < count; k++) {
    const i = SEEK[1] + (state.dustCursor++ % (VISIBLE_DUST_END - SEEK[1]));
    particles.x[i] = fx + (Math.random() - 0.5) * 30;
    particles.y[i] = fy + (Math.random() - 0.5) * 8;
    particles.vx[i] = 0;
    particles.vy[i] = 0;
    particles.kick(
      i,
      (tx - particles.x[i]) * 1.6 + (Math.random() - 0.5) * 120,
      (ty - particles.y[i]) * 1.6 - 60 - Math.random() * 80,
      650,
    );
    particles.r[i] = particles.g[i] = particles.b[i] = 1;
    particles.a[i] = 1;
    particles.size[i] = 3;
  }
}

// The result screen: the 3D preview and the particles that draw the info sheet.

import { BANDS, sectorFor } from "../geometry.js";
import { haptic } from "../haptics.js";
import { project } from "../particles.js";
import { COUNT, REVIEW_CLOUD, REVIEW_RINGS, REVIEW_UI, RING_COUNTS, RING_LAT } from "../config.js";
import { currentTab } from "../review.js";
import { BAND_COL } from "./camera.js";
import { paletteAt } from "./palette.js";
import { $, particles, reduceMotion, state } from "../state.js";
import { clamp, fract } from "../util.js";

export function formReview(now, dt) {
  const rec = state.reviewing;
  const r = $("cloudAnchor").getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.5;
  const scale = Math.min(r.width * 0.3, r.height * 0.34);
  if (!state.dragging) {
    state.cloudYaw += state.cloudSpin * dt;
    state.cloudSpin += (Math.sign(state.cloudSpin || 1) * 0.25 - state.cloudSpin) * Math.min(1, dt * 1.5);
  }
  const yaw = state.cloudYaw, pitch = state.cloudPitch;
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
      particles.attract(i, o[0], o[1], 1.3 + 1.7 * d, Math.min(1, cr * k + 0.04), Math.min(1, cg * k + 0.04), Math.min(1, cb * k + 0.04), (0.5 + 0.5 * d) * clip(o[1]));
    }
  } else {
    for (; i < 900; i++) { // no shape preview: a neutral sphere of points stands in
      const y = 1 - (2 * (i + 0.5)) / 900, rad = Math.sqrt(1 - y * y), a = i * 2.39996 + t * 0.1;
      project(Math.cos(a) * rad * 0.8, y * 0.8, Math.sin(a) * rad * 0.8, yaw, pitch, cx, cy, scale, o);
      const d = clamp((o[2] + 1) / 2, 0, 1);
      particles.attract(i, o[0], o[1], 1.2 + 1.6 * d, 0.8, 0.88, 1, (0.2 + 0.5 * d) * clip(o[1]));
    }
  }
  for (; i < REVIEW_RINGS[0]; i++) particles.free(i, 1.5, 1, 1, 1, 0);
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
      if (covered) particles.attract(k, o[0], o[1], 1.4 + 1.8 * d, bc[0], bc[1], bc[2], (0.3 + 0.6 * d) * clip(o[1]));
      else particles.attract(k, o[0], o[1], 0.9 + 0.8 * d, 1, 1, 1, (0.05 + 0.12 * d) * clip(o[1]));
    }
  }
  for (; k < REVIEW_RINGS[1]; k++) particles.free(k, 1.5, 1, 1, 1, 0);
  formReviewInfo(now);
  for (let j = REVIEW_UI[1]; j < COUNT; j++) particles.free(j, 1.5, 1, 1, 1, 0);
}

// The info sheet, drawn with particles that flow from one tab's layout into the next.
function formReviewInfo(now) {
  const rec = state.reviewing;
  if (!rec) return;
  let i = REVIEW_UI[0];
  const end = REVIEW_UI[1];
  const since = (now - Math.max(state.reviewOpenedAt || 0, state.tabAt || 0)) / 1000;
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
      const c = paletteAt(hue), w = 0.12 + 0.5 * glow;
      particles.attract(i++, x, y, big * (1 + 0.18 * glow), c[0] + (1 - c[0]) * w, c[1] + (1 - c[1]) * w, c[2] + (1 - c[2]) * w, (0.82 + 0.18 * glow) * clip(y));
    } else particles.attract(i++, x, y, small, 1, 1, 1, 0.2 * clip(y));
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
        const dc = paletteAt(f * 0.75 + t * 0.02);
        particles.attract(i++, c[0] + Math.cos(a) * rr, y, 1.1 + 1.4 * h1, dc[0], dc[1], dc[2], on * (0.12 + 0.3 * h2 * h2) * clip(y));
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
      const v = state.meterValues?.[m] ?? 0, upto = v * 10 * ease(ramp(0.1 + m * 0.06, 0.7));
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
        particles.attract(i++, o[0], o[1], 1 + 1.2 * d, r, g, b, (0.5 + 0.5 * d) * clip(o[1]));
      }
    }
  }
  for (; i < end; i++) particles.free(i, 1.5, 1, 1, 1, 0); // the rest wait, invisible, for the next tab
}

// A soft ambient light for each scan, taken from the object's own colours.
export function ambientFor(rec) {
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

// the particles drawing the preview and the sheet ride along with the scroll instead of chasing it
{
  const rv = $("review");
  let last = 0;
  rv.addEventListener("scroll", () => {
    const dy = last - rv.scrollTop;
    last = rv.scrollTop;
    if (dy && state.phase === "review" && !state.panel) particles.shift(0, REVIEW_UI[1], 0, dy);
  }, { passive: true });
}

// drag to turn the 3D preview
{
  const a = $("cloudAnchor");
  let lx = 0, ly = 0, lt = 0, v = 0;
  a.addEventListener("pointerdown", e => { state.dragging = true; lx = e.clientX; ly = e.clientY; lt = e.timeStamp; v = 0; a.setPointerCapture(e.pointerId); haptic("tap"); });
  a.addEventListener("pointermove", e => {
    if (!state.dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly;
    state.cloudYaw += dx * 0.011;
    state.cloudPitch = clamp(state.cloudPitch + dy * 0.006, -0.3, 1.1);
    v = (dx * 0.011) / Math.max(1, e.timeStamp - lt) * 1000;
    lx = e.clientX; ly = e.clientY; lt = e.timeStamp;
  });
  const end = () => { if (!state.dragging) return; state.dragging = false; state.cloudSpin = clamp(v, -4, 4) || 0.25; };
  a.addEventListener("pointerup", end);
  a.addEventListener("pointercancel", end);
}

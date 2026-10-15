// Precise outlines: asking the segmentation model for an exact edge, live and on every keyframe.

import * as store from "./store.js";
import { logError } from "./guard.js";
import { haptic } from "./haptics.js";
import { chime } from "./sound.js";
import { colorHist, findObject, histSimilarity, maskToBlob, resampleMask } from "./vision.js";
import { setStatus } from "./guidance.js";
import { disableRefiner } from "./models.js";
import { settings } from "./settings.js";
import { $, analyzer, outliner, refiner, state, video } from "./state.js";
import { updateObject } from "./tracking.js";
import { syncCanScan, toast } from "./ui.js";
import { sleep } from "./util.js";

// Prompt for the precise model, in video pixels: a box around the object plus points on it.
function promptFor(kind) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const ref = state.obj || state.lastObj;
  const px = p => [p[0] * vw, p[1] * vh];
  if (!ref) return { pos: [px(state.edit.pos[0] || state.seed)] }; // no outline to take a box from: the point alone
  // A snug box: a loose one lets the edge bleed into busy backgrounds (tested: 3% padding 0.988 IoU,
  // 8% padding 0.969). Corner points just outside the object's box are marked "not this".
  let [x0, y0, x1, y1] = ref.boxN;
  const pad = 0.03 * Math.max(x1 - x0, y1 - y0);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  let pos = ref.guides.slice(0, 3);
  const neg = cornerPoints(x0, y0, x1, y1, pad);
  if (kind === "select") pos = [state.edit.pos[0] || ref.seed];
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
  if (refiner.busy) { if (reason !== "track") state.refineQueued = { reason, prompt }; return; }
  state.lastRefineAt = performance.now();
  state.refining = reason;
  let r = null;
  try { r = await refiner.segment(video, video.videoWidth, video.videoHeight, prompt); refineFails = 0; }
  catch (e) {
    console.warn("refine failed", e);
    logError("refine", e);
    // a device that can't run it (GPU lost, out of memory) would otherwise fail on every frame, for ever
    if (++refineFails >= 3) disableRefiner("This device couldn't run precise outlines, so they're off. Scanning works as before.");
  }
  state.refining = null;
  if (r) applyRefined(r, reason);
  if (state.refineQueued) { const q = state.refineQueued; state.refineQueued = null; runRefine(q.reason, q.prompt); }
}

function applyRefined(r, reason) {
  if (!state.selected || (state.phase !== "live" && state.phase !== "scanning")) return;
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
  const cur = state.obj;
  if (reason === "track" && cur) {
    // a periodic correction must agree with what is being tracked; otherwise keep tracking
    const ratio = obj.frac / cur.frac;
    if (ratio < 0.5 || ratio > 2 || Math.hypot(obj.center[0] - cur.center[0], obj.center[1] - cur.center[1]) > 0.15) return;
  }
  if (reason === "reacquire" && analyzer.rgba && state.refHist &&
      histSimilarity(state.refHist, colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj)) < 0.6) return;
  state.glitch = 0;
  updateObject(obj, true);
  if (state.obj !== obj) return; // not accepted
  state.precise = true;
  outliner.prev = conf; // pulls the fast tracker onto the precise edge
  const h = analyzer.rgba ? colorHist(analyzer.rgba, analyzer.W, analyzer.H, obj) : null;
  if (h) {
    if (!state.refHist || reason === "select") state.refHist = h;
    else for (let i = 0; i < 64; i++) state.refHist[i] = state.refHist[i] * 0.9 + h[i] * 0.1;
  }
  if (reason === "select") {
    state.pendingSelect = null;
    haptic("lock");
    chime("lock");
    syncCanScan();
  }
}

// Called every analysis tick: the first precise outline once an object is found, then regular corrections.
export function scheduleRefine(now) {
  if (!refiner.ready || refiner.busy || !state.selected || !settings.precise) return;
  if (state.phase !== "live" && state.phase !== "scanning") return;
  // (the precise model only runs on an object the fast tracker has found: running it on every passing guess
  // would heat the phone and stall the live view)
  if (state.pendingSelect) {
    if (state.locked && state.obj) runRefine("select", promptFor("select"));
    return;
  }
  // corrections as often as the device comfortably allows (leave the main thread room for the live view)
  // (never more than about a third of the time, so the phone has room to stay cool and the live view smooth)
  const gap = state.phase === "scanning" ? Math.max(900, refiner.ms * 3) : Math.max(1500, refiner.ms * 3);
  if (now - state.lastRefineAt < gap) return;
  if (state.locked && state.obj) runRefine("track", promptFor("track"));
  else if (state.lastObj && state.phase === "scanning") runRefine("reacquire", promptFor("track")); // before a scan, detection just looks again
}

// Re-outline every keyframe with the precise model, from the full-resolution photo. These outlines are
// what the 3D preview and the exported masks are built from, so this is where accuracy matters most.
export async function refineKeyframes(sc) {
  for (let i = 0; i < 100 && refiner.busy; i++) await sleep(50);
  state.refiningKeyframes = true;
  state.skipRefine = false;
  $("shutter").setAttribute("aria-label", "Skip outline refinement");
  const total = sc.frames.length;
  let done = 0, improved = 0;
  let fails = 0;
  for (let idx = 0; idx < total && !state.skipRefine; idx++) {
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
      if (++fails >= 3) { state.skipRefine = true; toast("Precise outlines stopped early. The scan keeps the live outlines.", 4200); } // don't grind through the rest
    }
    done++;
  }
  state.refiningKeyframes = false;
  sc.refined = { improved, of: total, skipped: state.skipRefine };
}

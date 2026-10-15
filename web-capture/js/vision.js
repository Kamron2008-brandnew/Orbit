// Frame analysis (light, sharpness, motion) and live object outlining.

const MP_VERSION = "0.10.35"; // 1.1.0 (Oct 2026) fails to create the interactive segmenter; keep pinned
const MP = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";

/* ---------- low-res frame analysis ---------- */

export class FrameAnalyzer {
  constructor(longSide = 256) {
    this.longSide = longSide;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.W = 0; this.H = 0; this.gray = null; this.prev = null;
  }

  fit(vw, vh) {
    const s = this.longSide / Math.max(vw, vh);
    const W = Math.max(16, Math.round(vw * s)), H = Math.max(16, Math.round(vh * s));
    if (W === this.W && H === this.H) return;
    this.W = this.canvas.width = W;
    this.H = this.canvas.height = H;
    this.gray = new Float32Array(W * H);
    this.prev = null;
  }

  grab(video) {
    this.fit(video.videoWidth, video.videoHeight);
    const { W, H } = this;
    this.ctx.drawImage(video, 0, 0, W, H);
    const px = this.ctx.getImageData(0, 0, W, H).data;
    this.rgba = px; // kept for colouring particles and the 3D preview
    const swap = this.prev;
    this.prev = this.gray;
    this.gray = swap && swap.length === W * H ? swap : new Float32Array(W * H);
    const g = this.gray;
    for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    return g;
  }

  // obj: result of findObject() or null.
  stats(obj) {
    const { W, H, gray: g, prev } = this;
    let lum = 0;
    for (let i = 0; i < g.length; i += 3) lum += g[i];
    lum /= g.length / 3;

    // Laplacian variance over the object's box (or the centre) = sharpness.
    let x0 = W * 0.2 | 0, x1 = W * 0.8 | 0, y0 = H * 0.2 | 0, y1 = H * 0.8 | 0;
    if (obj) {
      x0 = Math.max(1, Math.floor(obj.boxN[0] * W)); y0 = Math.max(1, Math.floor(obj.boxN[1] * H));
      x1 = Math.min(W - 1, Math.ceil(obj.boxN[2] * W)); y1 = Math.min(H - 1, Math.ceil(obj.boxN[3] * H));
    }
    let n = 0, s = 0, s2 = 0;
    for (let y = Math.max(1, y0); y < Math.min(H - 1, y1); y++) {
      for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) {
        const i = y * W + x;
        const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
        s += l; s2 += l * l; n++;
      }
    }
    const sharp = n ? s2 / n - (s / n) ** 2 : 0;

    // Mean frame difference on the object vs the background (turntable: object should move, background not).
    let objMotion = 0, bgMotion = 0;
    if (prev && prev.length === g.length) {
      let os = 0, on = 0, bs = 0, bn = 0;
      const lab = obj?.lab, sx = obj ? obj.W / W : 1, sy = obj ? obj.H / H : 1;
      for (let i = 0; i < g.length; i += 2) {
        const d = Math.abs(g[i] - prev[i]);
        const x = i % W, y = (i / W) | 0;
        const inObj = lab ? lab[((y * sy) | 0) * obj.W + ((x * sx) | 0)] : (x > W * .3 && x < W * .7 && y > H * .3 && y < H * .7);
        if (inObj) { os += d; on++; } else { bs += d; bn++; }
      }
      objMotion = on ? os / on : 0;
      bgMotion = bn ? bs / bn : 0;
    }
    return { lum, sharp, objMotion, bgMotion };
  }
}

/* ---------- segmentation ---------- */

export class Outliner {
  // Segments at a long side of 512 px (the model's own working size), four times the detail of the
  // analysis frame, so thin parts and edges survive.
  constructor(longSide = 512) {
    this.ready = false; this.failed = false; this.ms = 0; this.seg = null; this.delegate = null; this.errors = 0;
    this.longSide = longSide;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.prev = null;
  }

  frame(video) {
    const s = this.longSide / Math.max(video.videoWidth, video.videoHeight);
    const W = Math.round(video.videoWidth * s), H = Math.round(video.videoHeight * s);
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.prev = null; }
    this.ctx.drawImage(video, 0, 0, W, H);
    return this.canvas;
  }

  // delegates: which to try, in order. around(name, fn): wraps each attempt so the crash guard can tell which
  // one was in progress if the page dies.
  async load({ delegates = ["GPU", "CPU"], around = (name, fn) => fn() } = {}) {
    const { InteractiveSegmenter, FilesetResolver } = await import(`${MP}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    let lastErr;
    for (const delegate of delegates) {
      try {
        await around(`outliner-${delegate}`, async () => {
          this.seg = await InteractiveSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL, delegate },
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          });
          this.delegate = delegate;
          // Warm up (the first GPU run compiles shaders and can take seconds).
          const c = document.createElement("canvas");
          c.width = 64; c.height = 112;
          const x = c.getContext("2d");
          x.fillStyle = "#777"; x.fillRect(0, 0, 64, 112); x.fillStyle = "#c33"; x.fillRect(20, 40, 24, 30);
          this.run(c, [[0.5, 0.5]]);
        });
        break;
      } catch (e) { lastErr = e; try { this.seg?.close?.(); } catch {} this.seg = null; }
    }
    if (!this.seg) throw lastErr || new Error("segmenter unavailable");
    this.prev = null;
    this.errors = 0;
    this.ready = true;
  }

  // points: normalized [x, y] guides on the object. One point picks "the thing here"; several spread over the
  // object (a scribble) make the model take the whole object rather than one part of it, like a label.
  // blend: how much of the previous mask to keep, which steadies the outline between frames.
  // Returns a Float32Array confidence mask the size of `canvas`, or null.
  run(canvas, points, blend = 0) {
    if (!this.seg) return null;
    const t0 = performance.now();
    let out = null;
    const roi = points.length > 1 ? { scribble: points.map(([x, y]) => ({ x, y })) } : { keypoint: { x: points[0][0], y: points[0][1] } };
    try {
      this.seg.segment(canvas, roi, result => {
        const m = result.confidenceMasks && result.confidenceMasks[0];
        if (m) out = new Float32Array(m.getAsFloat32Array());
      });
      this.errors = 0;
    } catch (e) {
      // e.g. the GPU context was lost while the app was in the background. A few misses are fine; if it keeps
      // failing, stop using the segmenter rather than throwing on every frame.
      this.lastError = e;
      if (++this.errors >= 8) { this.ready = false; this.failed = true; try { this.seg.close(); } catch {} this.seg = null; }
      return null;
    }
    if (out && blend > 0 && this.prev && this.prev.length === out.length) {
      for (let i = 0; i < out.length; i++) out[i] = out[i] * (1 - blend) + this.prev[i] * blend;
    }
    if (out) this.prev = out;
    const dt = performance.now() - t0;
    this.ms = this.ms ? this.ms * 0.8 + dt * 0.2 : dt;
    return out;
  }
}

/* ---------- mask -> object (component, box, contour) ---------- */

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]; // clockwise, y down
const DIR_INDEX = new Int8Array(9).fill(-1);
DIRS.forEach(([dx, dy], i) => { DIR_INDEX[(dx + 1) * 3 + (dy + 1)] = i; });

export function findObject(conf, W, H, seed) {
  if (!conf || conf.length !== W * H) return null;
  const N = W * H;
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = conf[i] > 0.5 ? 1 : 0;

  // Seed pixel, or the nearest object pixel within a small radius.
  let sx = Math.min(W - 1, Math.max(0, Math.round(seed[0] * W)));
  let sy = Math.min(H - 1, Math.max(0, Math.round(seed[1] * H)));
  if (!bin[sy * W + sx]) {
    let best = -1, bd = Infinity;
    const R = Math.round(Math.max(W, H) * 0.06);
    for (let y = Math.max(0, sy - R); y <= Math.min(H - 1, sy + R); y++)
      for (let x = Math.max(0, sx - R); x <= Math.min(W - 1, sx + R); x++) {
        if (!bin[y * W + x]) continue;
        const d = (x - sx) ** 2 + (y - sy) ** 2;
        if (d < bd) { bd = d; best = y * W + x; }
      }
    if (best < 0) return null;
    sx = best % W; sy = (best / W) | 0;
  }

  // Flood fill the seed's component.
  const lab = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0, area = 0, sumX = 0, sumY = 0, minX = W, minY = H, maxX = 0, maxY = 0;
  stack[sp++] = sy * W + sx;
  lab[sy * W + sx] = 1;
  while (sp) {
    const i = stack[--sp];
    const x = i % W, y = (i / W) | 0;
    area++; sumX += x; sumY += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x > 0 && bin[i - 1] && !lab[i - 1]) { lab[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < W - 1 && bin[i + 1] && !lab[i + 1]) { lab[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && bin[i - W] && !lab[i - W]) { lab[i - W] = 1; stack[sp++] = i - W; }
    if (y < H - 1 && bin[i + W] && !lab[i + W]) { lab[i + W] = 1; stack[sp++] = i + W; }
  }
  // Fill holes: background that can't reach the frame border is inside the object (a cup's dark interior,
  // a shadowed fold). Without this, holes punch through the 3D preview and the exported masks.
  {
    const out = new Uint8Array(N);
    let sp2 = 0;
    const push = i => { if (!lab[i] && !out[i]) { out[i] = 1; stack[sp2++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (sp2) {
      const i = stack[--sp2], x = i % W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (i >= W) push(i - W);
      if (i < N - W) push(i + W);
    }
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const i = y * W + x;
      if (!lab[i] && !out[i]) { lab[i] = 1; area++; sumX += x; sumY += y; }
    }
  }
  const cx = sumX / area, cy = sumY / area;

  // Next seed: the component pixel nearest the centroid (centroid itself can fall outside concave shapes).
  let nx = sx, ny = sy, nd = Infinity;
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      if (!lab[y * W + x]) continue;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < nd) { nd = d; nx = x; ny = y; }
    }

  // Guides for the next frame: the centre plus interior points toward each side.
  const guides = [[(nx + 0.5) / W, (ny + 0.5) / H]];
  const bw = maxX - minX, bh = maxY - minY;
  for (const [fx, fy] of [[0, -0.3], [0, 0.3], [-0.25, 0], [0.25, 0]]) {
    const gx = Math.round(cx + fx * bw), gy = Math.round(cy + fy * bh);
    if (gx >= 0 && gy >= 0 && gx < W && gy < H && lab[gy * W + gx]) guides.push([(gx + 0.5) / W, (gy + 0.5) / H]);
  }

  const edges = (minX === 0) + (minY === 0) + (maxX === W - 1) + (maxY === H - 1);
  return {
    guides,
    lab, area, frac: area / N, W, H,
    box: [minX, minY, maxX + 1, maxY + 1],
    boxN: [minX / W, minY / H, (maxX + 1) / W, (maxY + 1) / H],
    center: [cx / W, cy / H],
    seed: [(nx + 0.5) / W, (ny + 0.5) / H],
    edges,
    contour: traceContour(lab, W, H, minX, minY, maxX, maxY),
  };
}

// Moore-neighbour boundary trace of the labelled component. Returns normalized [x, y] points.
function traceContour(lab, W, H, minX, minY, maxX, maxY) {
  let start = -1;
  for (let y = minY; y <= maxY && start < 0; y++)
    for (let x = minX; x <= maxX; x++) if (lab[y * W + x]) { start = y * W + x; break; }
  if (start < 0) return [];
  const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && lab[y * W + x] === 1;
  let x = start % W, y = (start / W) | 0;
  const sx = x, sy = y;
  let back = 4; // the pixel to the west of the first raster pixel is background
  const startBack = back;
  const pts = [[x, y]];
  const limit = 4 * (W + H) * 4;
  for (let iter = 0; iter < limit; iter++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inside(x + DIRS[d][0], y + DIRS[d][1])) { found = d; break; }
    }
    if (found < 0) break; // single pixel
    const pd = (found + 7) % 8;
    const bx = x + DIRS[pd][0], by = y + DIRS[pd][1];
    x += DIRS[found][0]; y += DIRS[found][1];
    back = DIR_INDEX[(bx - x + 1) * 3 + (by - y + 1)];
    if (back < 0) back = (found + 4) % 8;
    if (x === sx && y === sy && back === startBack) break;
    if (x === sx && y === sy && pts.length > 2) break;
    pts.push([x, y]);
  }
  return pts.map(([px, py]) => [(px + 0.5) / W, (py + 0.5) / H]);
}

// Resample a closed polyline to n points by arc length, smooth it, and start at the point straight above
// the centre, going clockwise, so successive outlines line up point-to-point without twisting.
export function resampleContour(pts, n = 160) {
  if (pts.length < 4) return null;
  const L = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    L.push(L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = L[L.length - 1];
  if (total <= 0) return null;
  const out = new Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = (k / n) * total;
    while (L[j + 1] < t) j++;
    const a = pts[j], b = pts[(j + 1) % pts.length];
    const f = (t - L[j]) / ((L[j + 1] - L[j]) || 1);
    out[k] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  // circular moving average
  const sm = new Array(n);
  const w = 3;
  for (let k = 0; k < n; k++) {
    let ax = 0, ay = 0;
    for (let d = -w; d <= w; d++) { const p = out[(k + d + n) % n]; ax += p[0]; ay += p[1]; }
    sm[k] = [ax / (2 * w + 1), ay / (2 * w + 1)];
  }
  let cx = 0, cy = 0;
  for (const p of sm) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  // orientation: make the loop run clockwise on screen (y down => positive signed area)
  let area = 0;
  for (let k = 0; k < n; k++) { const a = sm[k], b = sm[(k + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  if (area < 0) sm.reverse();
  let top = 0, best = Infinity;
  for (let k = 0; k < n; k++) {
    const dx = sm[k][0] - cx, dy = sm[k][1] - cy;
    if (dy >= 0) continue;
    const off = Math.abs(dx) / (-dy); // tan of the angle away from straight up
    if (off < best) { best = off; top = k; }
  }
  return sm.slice(top).concat(sm.slice(0, top));
}

// White-on-black PNG of the object mask (COLMAP mask convention: black = ignore).
export function maskToBlob(obj) {
  const { W, H, lab } = obj;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const img = x.createImageData(W, H);
  for (let i = 0; i < lab.length; i++) {
    const v = lab[i] ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return new Promise(r => c.toBlob(r, "image/png"));
}

/* ---------- appearance model ---------- */

// 64-bin colour histogram (4 levels per channel) of the object, read from the analysis frame. Used to
// check that the tracker is still on the object you chose and hasn't slid onto the table or a neighbour.
export function colorHist(rgba, AW, AH, obj) {
  const h = new Float32Array(64);
  const { lab, W, H } = obj;
  const sx = W / AW, sy = H / AH;
  let n = 0;
  for (let y = 0; y < AH; y += 2) for (let x = 0; x < AW; x += 2) {
    if (!lab[((y * sy) | 0) * W + ((x * sx) | 0)]) continue;
    const q = (y * AW + x) * 4;
    h[((rgba[q] >> 6) << 4) | ((rgba[q + 1] >> 6) << 2) | (rgba[q + 2] >> 6)]++;
    n++;
  }
  if (n) for (let i = 0; i < 64; i++) h[i] /= n;
  return n ? h : null;
}

// Bhattacharyya coefficient: 1 = identical colour make-up, 0 = nothing in common.
export function histSimilarity(a, b) {
  if (!a || !b) return 1;
  let s = 0;
  for (let i = 0; i < 64; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}

// Downsample a binary mask (nearest) to another size.
export function resampleMask(mask, W, H, W2, H2) {
  const out = new Uint8Array(W2 * H2);
  const sx = W / W2, sy = H / H2;
  for (let y = 0; y < H2; y++) {
    const row = ((y + 0.5) * sy | 0) * W;
    for (let x = 0; x < W2; x++) out[y * W2 + x] = mask[row + ((x + 0.5) * sx | 0)];
  }
  return out;
}

// Precise outlines with EdgeTAM (Meta's on-device Segment Anything 2, via transformers.js).
// It is slower than the live tracker, so it runs alongside it: when you tap an object, every so often
// while you scan (to pull the live outline back onto the true edge), and on every keyframe at the end.
//
// Prompting: a box around the object plus "keep" points. A single tap is ambiguous (a bottle's label
// or the whole bottle?); with a box the whole object is chosen reliably. "Remove" points cut parts out.

const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
const MODEL = "onnx-community/EdgeTAM-ONNX";
export const REFINE_SIZE = 1024; // the model's own input size (long side)

export class Refiner {
  constructor() {
    this.ready = false;
    this.failed = false;
    this.busy = false;
    this.device = null;
    this.ms = 0;
    this.progress = 0;
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  // around(name, fn): wraps the heavy part so the crash guard can tell if the page died inside it.
  // Without WebGPU the model would run on the CPU on the main thread, a few seconds per frame with the whole
  // page frozen meanwhile, so it is not used at all unless allowWasm is set.
  async load(onProgress, { around = (name, fn) => fn(), allowWasm = false } = {}) {
    let gpu = false;
    try {
      gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
    } catch {}
    if (!gpu && !allowWasm) throw new Error("WebGPU is not available on this device");
    const T = await import(TJS);
    this.T = T;
    this.device = gpu ? "webgpu" : "wasm";
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let l = 0,
          t = 0;
        for (const [a, b] of files.values()) {
          l += a;
          t += b;
        }
        this.progress = l / t;
        onProgress?.(this.progress);
      }
    };
    await around("refiner", async () => {
      this.model = await T.EdgeTamModel.from_pretrained(MODEL, {
        dtype: gpu ? "fp16" : "q8",
        device: this.device,
        progress_callback,
      });
      this.processor = await T.AutoProcessor.from_pretrained(MODEL);
      // warm up (the first GPU run compiles shaders)
      const c = document.createElement("canvas");
      c.width = 64;
      c.height = 64;
      await this.segmentCanvas(c, { box: [8, 8, 56, 56] });
    });
    this.ready = true;
  }

  // Give back what a run held (GPU buffers in particular). Safe to call on anything.
  free(...things) {
    for (const t of things) {
      if (!t) continue;
      try {
        if (typeof t.dispose === "function") t.dispose();
        else if (typeof t === "object")
          for (const v of Object.values(t)) if (v && typeof v.dispose === "function") v.dispose();
      } catch {
        /* already released */
      }
    }
  }

  // Stop using the model and release it (the device could not run it).
  async unload() {
    this.ready = false;
    try {
      await this.model?.dispose?.();
    } catch {}
    this.model = null;
    this.processor = null;
  }

  // Draw a source (video, image, canvas) into the working canvas at the model's size.
  frame(src, sw, sh) {
    const s = REFINE_SIZE / Math.max(sw, sh);
    const W = Math.round(sw * s),
      H = Math.round(sh * s);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    this.ctx.drawImage(src, 0, 0, W, H);
    return this.canvas;
  }

  // box: [x0, y0, x1, y1] and points in canvas pixels. Returns { mask: Uint8Array(W*H), W, H, score }.
  // Always takes the candidate the model rates highest; a box in the prompt makes that the whole object.
  async segmentCanvas(canvas, { box, pos = [], neg = [] }) {
    const { T, processor, model } = this;
    const t0 = performance.now();
    const image = await T.RawImage.fromCanvas(canvas);
    const opts = {};
    if (box) opts.input_boxes = [[box.map((v) => Math.round(v))]];
    const pts = [...pos.map((p) => [p, 1]), ...neg.map((p) => [p, 0])];
    if (pts.length) {
      opts.input_points = [[pts.map(([p]) => p.map((v) => Math.round(v)))]];
      opts.input_labels = [[pts.map(([, l]) => l)]];
    }
    const inputs = await processor(image, opts);
    const emb = await model.get_image_embeddings(inputs);
    const prompt = {};
    for (const k of ["input_points", "input_labels", "input_boxes"]) if (inputs[k]) prompt[k] = inputs[k];
    const out = await model({ ...emb, ...prompt });
    // choose the candidate on the low-res logits, then upscale only that one (a third of the work)
    const scores = out.iou_scores.data;
    let best = 0;
    for (let k = 1; k < scores.length; k++) if (scores[k] > scores[best]) best = k;
    const one = out.pred_masks.slice(null, null, [best, best + 1]);
    const m = (await processor.post_process_masks(one, inputs.original_sizes, inputs.reshaped_input_sizes))[0];
    const W = m.dims[m.dims.length - 1],
      H = m.dims[m.dims.length - 2],
      per = W * H;
    const mask = new Uint8Array(per);
    const data = m.data;
    for (let i = 0; i < per; i++) mask[i] = data[i] ? 1 : 0;
    const score = scores[best];
    this.free(inputs, emb, out, one, m); // every run makes tens of MB of tensors; don't wait for the garbage collector
    const dt = performance.now() - t0;
    this.ms = this.ms ? this.ms * 0.7 + dt * 0.3 : dt;
    return { mask, W, H, score };
  }

  async segment(src, sw, sh, prompt) {
    if (!this.ready || this.busy) return null;
    this.busy = true;
    try {
      const canvas = this.frame(src, sw, sh);
      const s = canvas.width / sw;
      const scale = (p) => [p[0] * s, p[1] * s];
      const r = await this.segmentCanvas(canvas, {
        box: prompt.box && [prompt.box[0] * s, prompt.box[1] * s, prompt.box[2] * s, prompt.box[3] * s],
        pos: (prompt.pos || []).map(scale),
        neg: (prompt.neg || []).map(scale),
      });
      return r;
    } finally {
      this.busy = false;
    }
  }
}

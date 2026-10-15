// Particle field: thousands of glowing points rendered in one WebGL draw call.
// Each particle is either free (drifting on a slow flow field) or attracted to a target with a spring.
// The app sets targets every frame; particles get their own stiffness, so formations assemble organically.

const VS = `
attribute vec2 aPos;
attribute float aSize;
attribute vec4 aCol;
uniform vec2 uView;
uniform float uDpr;
varying vec4 vCol;
void main() {
  vec2 c = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  gl_PointSize = aSize * uDpr;
  vCol = aCol;
}`;

const FS = `
precision mediump float;
varying vec4 vCol;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = dot(p, p) * 4.0;
  if (d > 1.0) discard;
  // a crisp round point with a soft glow, plus a faint dark halo so it reads on bright surfaces
  float disc = 1.0 - smoothstep(0.16, 0.3, d);
  float light = (disc + exp(-d * 3.2) * 0.32) * vCol.a;
  float shade = smoothstep(0.3, 0.7, d) * (1.0 - d) * 0.55 * vCol.a;
  gl_FragColor = vec4(vCol.rgb * light, clamp(light + shade, 0.0, 1.0));
}`;

const STRIDE = 7; // x, y, size, r, g, b, a

export class Particles {
  constructor(canvas, count) {
    this.c = canvas;
    this.n = count;
    const F = () => new Float32Array(count);
    Object.assign(this, {
      x: F(), y: F(), vx: F(), vy: F(), tx: F(), ty: F(),
      size: F(), sizeT: F(), r: F(), g: F(), b: F(), a: F(), rT: F(), gT: F(), bT: F(), aT: F(),
      k: F(), seed: F(), seed2: F(), boost: F(),
    });
    this.mode = new Uint8Array(count);
    this.buf = new Float32Array(count * STRIDE);
    this.flash = 0;
    this.W = innerWidth; this.H = innerHeight; this.dpr = 1;
    for (let i = 0; i < count; i++) {
      this.x[i] = Math.random() * this.W;
      this.y[i] = Math.random() * this.H;
      this.k[i] = 0.55 + Math.random() * 0.9;     // per-particle stiffness: staggered, organic arrival
      this.seed[i] = Math.random();
      this.seed2[i] = Math.random();
      this.size[i] = 1;
      this.r[i] = this.g[i] = this.b[i] = 1;
    }
    this.lost = false;
    this.initGL();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.watchContext();
  }

  // iOS drops the GL context when memory is tight or the page comes back from the background. Without this the
  // particles would stay blank for good; with it they come back as soon as the context is restored.
  watchContext() {
    this.c.addEventListener("webglcontextlost", e => { e.preventDefault(); this.lost = true; });
    this.c.addEventListener("webglcontextrestored", () => {
      try { this.initGL(); this.resize(); this.lost = false; } catch (err) { console.warn("particles: could not restore", err); this.fallback2d(); }
    });
  }

  // A canvas that has given out a GL context can't give out a 2D one, so swap in a fresh canvas.
  fallback2d() {
    const c2 = this.c.cloneNode(false);
    this.c.replaceWith(c2);
    this.c = c2;
    this.gl = null; this.lost = false;
    this.ctx2d = c2.getContext("2d");
    this.resize();
  }

  initGL() {
    const gl = this.c.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    this.gl = gl;
    if (!gl) { this.ctx2d = this.c.getContext("2d"); return; }
    try { this.setupGL(gl); } catch (err) { console.warn("particles: WebGL setup failed, drawing without it", err); this.fallback2d(); }
  }

  setupGL(gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link failed");
    gl.useProgram(prog);
    this.prog = prog;
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
    const attr = (name, size, offset) => {
      const loc = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    };
    attr("aPos", 2, 0);
    attr("aSize", 1, 2);
    attr("aCol", 4, 3);
    this.uView = gl.getUniformLocation(prog, "uView");
    this.uDpr = gl.getUniformLocation(prog, "uDpr");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied: glow on top, soft shade beneath
    gl.disable(gl.DEPTH_TEST);
  }

  resize() {
    this.W = innerWidth; this.H = innerHeight;
    this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.c.width = Math.round(this.W * this.dpr);
    this.c.height = Math.round(this.H * this.dpr);
    if (this.gl) this.gl.viewport(0, 0, this.c.width, this.c.height);
  }

  // Appearance targets (colors 0..1).
  look(i, size, r, g, b, a) { this.sizeT[i] = size; this.rT[i] = r; this.gT[i] = g; this.bT[i] = b; this.aT[i] = a; }
  attract(i, x, y, size, r, g, b, a) { this.mode[i] = 1; this.tx[i] = x; this.ty[i] = y; this.look(i, size, r, g, b, a); }
  // Put a particle exactly at a point this frame (no spring lag), e.g. for something that must track a moving line.
  place(i, x, y, size, r, g, b, a) { this.attract(i, x, y, size, r, g, b, a); this.x[i] = x; this.y[i] = y; this.vx[i] = 0; this.vy[i] = 0; }
  free(i, size, r, g, b, a) { this.mode[i] = 0; this.look(i, size, r, g, b, a); }
  // Move a range of particles rigidly (with their targets), e.g. along with scrolled content.
  shift(from, to, dx, dy) {
    for (let i = from; i < to; i++) { this.x[i] += dx; this.y[i] += dy; this.tx[i] += dx; this.ty[i] += dy; }
  }
  kick(i, vx, vy, boostMs = 0) { this.vx[i] += vx; this.vy[i] += vy; if (boostMs) this.boost[i] = boostMs; }

  // Push every particle away from a point (used when the intro bursts into the camera).
  burst(cx, cy, strength = 900) {
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - cx, dy = this.y[i] - cy;
      const d = Math.hypot(dx, dy) || 1;
      const s = strength * (0.4 + this.seed[i] * 0.9);
      this.vx[i] += (dx / d) * s;
      this.vy[i] += (dy / d) * s;
      this.mode[i] = 0;
    }
  }

  step(dt, t) {
    const { n, x, y, vx, vy, tx, ty, mode, k, W, H } = this;
    const K = 64, C = 10.5, Cf = 1.6;
    const blend = Math.min(1, dt * 7);
    for (let i = 0; i < n; i++) {
      let ax, ay;
      if (mode[i]) {
        const kk = K * k[i];
        ax = (tx[i] - x[i]) * kk - vx[i] * C;
        ay = (ty[i] - y[i]) * kk - vy[i] * C;
      } else {
        // slow incompressible-looking flow from layered sines
        const px = x[i] * 0.006, py = y[i] * 0.006, s = this.seed[i] * 6.283;
        ax = (Math.sin(py * 1.7 + t * 0.21 + s) + Math.sin((px + py) * 0.9 - t * 0.13)) * 9 - vx[i] * Cf;
        ay = (Math.cos(px * 1.5 - t * 0.17 + s) + Math.cos((px - py) * 1.1 + t * 0.11)) * 9 - vy[i] * Cf - 1.2;
      }
      vx[i] += ax * dt;
      vy[i] += ay * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      if (!mode[i]) {
        if (x[i] < -20) x[i] += W + 40; else if (x[i] > W + 20) x[i] -= W + 40;
        if (y[i] < -20) y[i] += H + 40; else if (y[i] > H + 20) y[i] -= H + 40;
      }
      this.size[i] += (this.sizeT[i] - this.size[i]) * blend;
      this.r[i] += (this.rT[i] - this.r[i]) * blend;
      this.g[i] += (this.gT[i] - this.g[i]) * blend;
      this.b[i] += (this.bT[i] - this.b[i]) * blend;
      this.a[i] += (this.aT[i] - this.a[i]) * blend;
      if (this.boost[i] > 0) this.boost[i] = Math.max(0, this.boost[i] - dt * 1000);
    }
    this.flash = Math.max(0, this.flash - dt * 4);
  }

  render() {
    if (this.lost) return;
    const { n, buf, gl } = this;
    for (let i = 0, o = 0; i < n; i++, o += STRIDE) {
      const bo = this.boost[i] > 0 ? Math.min(1, this.boost[i] / 400) : 0;
      const fl = this.mode[i] ? this.flash : 0;
      buf[o] = this.x[i];
      buf[o + 1] = this.y[i];
      buf[o + 2] = this.size[i] * (1 + bo * 1.4 + fl * 0.5);
      buf[o + 3] = Math.min(1, this.r[i] + bo * 0.6 + fl * 0.3);
      buf[o + 4] = Math.min(1, this.g[i] + bo * 0.6 + fl * 0.3);
      buf[o + 5] = Math.min(1, this.b[i] + bo * 0.6 + fl * 0.3);
      buf[o + 6] = Math.min(1, this.a[i] + bo * 0.8 + fl * 0.25);
    }
    if (!gl) return this.render2d();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uView, this.W, this.H);
    gl.uniform1f(this.uDpr, this.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf);
    gl.drawArrays(gl.POINTS, 0, n);
  }

  render2d() {
    const ctx = this.ctx2d;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0, o = 0; i < this.n; i++, o += STRIDE) {
      const a = this.buf[o + 6];
      if (a < 0.02) continue;
      const s = this.buf[o + 2] * 0.7;
      ctx.fillStyle = `rgba(${this.buf[o + 3] * 255 | 0},${this.buf[o + 4] * 255 | 0},${this.buf[o + 5] * 255 | 0},${a})`;
      ctx.fillRect(this.buf[o] - s / 2, this.buf[o + 1] - s / 2, s, s);
    }
  }
}

/* ---------- 3D helpers for point-cloud formations ---------- */

// Project a normalized 3D point (y up) to the screen with a gentle perspective. Returns [sx, sy, depth -1..1].
export function project(px, py, pz, yaw, pitch, cx, cy, scale, out) {
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = px * cyw + pz * syw, z1 = -px * syw + pz * cyw;
  const y2 = py * cp - z1 * sp, z2 = py * sp + z1 * cp;
  const f = 3.4 / (3.4 - z2);
  out[0] = cx + x1 * scale * f;
  out[1] = cy - y2 * scale * f;
  out[2] = z2;
  return out;
}

// Points spread over the surface of a vase-like lathe (the intro's sample object).
export function vaseCloud(count) {
  const pts = new Float32Array(count * 3);
  const prof = y => 0.2 + 0.42 * Math.exp(-(((y + 0.28) / 0.42) ** 2)) + 0.06 * Math.exp(-(((y - 0.86) / 0.1) ** 2)) + 0.05;
  for (let i = 0; i < count; i++) {
    const y = -1 + (2 * (i + 0.5)) / count; // even steps up the height
    const a = i * 2.39996;                  // golden angle around it: a Fibonacci lattice, no visible strands
    const r = prof(y) * (0.98 + Math.random() * 0.04);
    pts[3 * i] = Math.cos(a) * r;
    pts[3 * i + 1] = y;
    pts[3 * i + 2] = Math.sin(a) * r;
  }
  return pts;
}

/* ---------- intro gallery: shapes the dots flow between ---------- */

// Centre a point set, scale it to height 2 (y in -1..1, no wider than 2.2), and sort by height so that
// particle i lands at a similar height in every shape: morphs travel short, graceful paths.
function normalize(list) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, y, z] of list) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const s = Math.min(2 / (y1 - y0 || 1), 2.2 / Math.max(x1 - x0, z1 - z0, 1e-6));
  list.sort((a, b) => a[1] - b[1]);
  const out = new Float32Array(list.length * 3);
  list.forEach(([x, y, z], i) => { out[3 * i] = (x - cx) * s; out[3 * i + 1] = (y - cy) * s; out[3 * i + 2] = (z - cz) * s; });
  return out;
}

const fib = (i, n) => [(i + 0.5) / n, i * 2.39996]; // even spread: fraction along, golden-angle turn

export function introShapes(n) {
  const shapes = [];
  const vase = vaseCloud(n);
  shapes.push({ name: "vase", pts: vase, palette: [[0.56, 0.89, 1], [0.71, 0.61, 1]] });

  // trefoil knot as a tube
  {
    const L = [];
    for (let i = 0; i < n; i++) {
      const [u, a] = fib(i, n);
      const t = u * Math.PI * 2;
      const P = tt => { const r = Math.cos(3 * tt) + 2.2; return [r * Math.cos(2 * tt), r * Math.sin(2 * tt), -Math.sin(3 * tt) * 1.2]; };
      const p = P(t), q = P(t + 0.001);
      let tx = q[0] - p[0], ty = q[1] - p[1], tz = q[2] - p[2];
      const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
      // a frame around the tangent
      let nx = -ty, ny = tx, nz = 0; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
      const bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;
      const R = 0.5;
      L.push([p[0] + (nx * Math.cos(a) + bx * Math.sin(a)) * R, p[1] + (ny * Math.cos(a) + by * Math.sin(a)) * R, p[2] + (nz * Math.cos(a) + bz * Math.sin(a)) * R]);
    }
    shapes.push({ name: "knot", pts: normalize(L), palette: [[0.45, 0.95, 0.85], [0.6, 0.8, 1]] });
  }

  // ringed planet
  {
    const L = [], ns = Math.floor(n * 0.62);
    for (let i = 0; i < ns; i++) {
      const y = 1 - (2 * (i + 0.5)) / ns, r = Math.sqrt(1 - y * y), a = i * 2.39996;
      L.push([Math.cos(a) * r * 0.62, y * 0.62, Math.sin(a) * r * 0.62]);
    }
    // the ring leans toward the viewer so it reads as a ring, not a line
    const tilt = -0.62, lean = 0.32;
    for (let i = ns; i < n; i++) {
      const [u, a] = fib(i - ns, n - ns);
      const r = 0.9 + u * 0.45;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y1 = z * Math.sin(tilt), z1 = z * Math.cos(tilt);
      L.push([x * Math.cos(lean) - y1 * Math.sin(lean), x * Math.sin(lean) + y1 * Math.cos(lean), z1]);
    }
    shapes.push({ name: "planet", pts: normalize(L), palette: [[1, 0.7, 0.82], [0.74, 0.64, 1]] });
  }

  // double helix with rungs
  {
    const L = [], strand = Math.floor(n * 0.36);
    for (let s = 0; s < 2; s++) for (let i = 0; i < strand; i++) {
      const u = i / strand, a = u * Math.PI * 5 + s * Math.PI, j = (i * 7 % 13) / 13 - 0.5;
      L.push([Math.cos(a) * 0.5 + j * 0.05, -1 + 2 * u, Math.sin(a) * 0.5 + j * 0.05]);
    }
    const rungs = n - 2 * strand, perRung = 14, count = Math.floor(rungs / perRung);
    for (let k = 0; k < count; k++) for (let m = 0; m < perRung; m++) {
      const u = (k + 0.5) / count, a = u * Math.PI * 5, f = m / (perRung - 1) * 2 - 1;
      L.push([Math.cos(a) * 0.5 * f, -1 + 2 * u, Math.sin(a) * 0.5 * f]);
    }
    while (L.length < n) L.push(L[L.length % (2 * strand)].slice());
    shapes.push({ name: "helix", pts: normalize(L), palette: [[0.5, 0.85, 1], [0.55, 0.6, 1]] });
  }

  // cut gem: an eight-sided crown above a deep pavilion
  {
    const L = [], sides = 8;
    const poly = a => { const seg = (Math.PI * 2) / sides; const m = ((a % seg) + seg) % seg - seg / 2; return Math.cos(seg / 2) / Math.cos(m); };
    for (let i = 0; i < n; i++) {
      const [u, a] = fib(i, n);
      const y = -1 + 2 * u;
      let r;
      if (y > 0.98) r = 0.5 * Math.sqrt((1 - y) / 0.02 * 0.5 + 0.5) * ((i % 3) / 3 + 0.34); // the flat table
      else if (y > 0.55) r = 1 - (y - 0.55) / 0.45 * 0.5;    // crown, sloping in to the table
      else if (y > 0.45) r = 1;                              // girdle
      else r = Math.max(0.02, (y + 1) / 1.45);               // pavilion down to the point
      r = Math.min(r, 1) * poly(a);
      L.push([Math.cos(a) * r, y, Math.sin(a) * r]);
    }
    shapes.push({ name: "gem", pts: normalize(L), palette: [[0.78, 0.66, 1], [1, 0.62, 0.86]] });
  }

  // puffy heart
  {
    const L = [];
    for (let i = 0; i < n; i++) {
      const [u, a] = fib(i, n);
      const z = Math.cos(Math.PI * u) * 0.38, s = Math.sin(Math.PI * u);
      const t = a;
      const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      L.push([x / 17 * (0.25 + 0.75 * s), y / 17 * (0.25 + 0.75 * s), z]);
    }
    shapes.push({ name: "heart", pts: normalize(L), palette: [[1, 0.55, 0.66], [1, 0.72, 0.58]] });
  }

  // torus, tipped toward the viewer
  {
    const L = [], tip = 0.75;
    for (let i = 0; i < n; i++) {
      const [u, a] = fib(i, n);
      const t = u * Math.PI * 2, R = 0.72, r = 0.3 + 0.03 * Math.sin(t * 6);
      const x = (R + r * Math.cos(a)) * Math.cos(t), z = (R + r * Math.cos(a)) * Math.sin(t), y = r * Math.sin(a);
      L.push([x, y * Math.cos(tip) - z * Math.sin(tip), y * Math.sin(tip) + z * Math.cos(tip)]);
    }
    shapes.push({ name: "torus", pts: normalize(L), palette: [[0.55, 1, 0.82], [0.5, 0.8, 1]] });
  }
  return shapes;
}

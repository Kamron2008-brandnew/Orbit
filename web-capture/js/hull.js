// Instant 3D preview from silhouettes (a "visual hull").
// Every keyframe gives the object's outline from a known angle around it. Start with a block of voxels and
// remove any voxel that falls outside the outline in too many views; what survives is the object's shape
// as seen from all sides (no concavities). Surface voxels become a colored point cloud.
//
// Model: orthographic views on a circle around the object, y up, object height normalized to 2.
// Each outline is aligned by its bounding-box centre and scaled by its height, so walking closer or
// further away between frames doesn't matter.

// views: [{ lab: Uint8Array(W*H), W, H, box: [x0,y0,x1,y1] px, azimuth, elevation, rgb?: Uint8Array(W*H*3) }]
export async function carveHull(views, { res = 60, tolerance = 0.07, points = 6000 } = {}) {
  const usable = views.filter((v) => v.elevation < 55 && v.box[3] - v.box[1] > 8);
  if (usable.length < 8) return null;

  // half-width of the object in height units: widest outline relative to its height
  let A = 0;
  for (const v of usable) A = Math.max(A, (v.box[2] - v.box[0]) / (v.box[3] - v.box[1]));
  A = Math.min(1.6, Math.max(0.25, A * 1.08));

  const nx = res,
    nz = res,
    ny = Math.round(res * Math.min(1.6, 1 / A));
  // spread consecutive views around the circle so early checks remove empty space fastest
  const sorted = [...usable].sort((a, b) => a.azimuth - b.azimuth);
  const order = [];
  for (let stride = 7, q = 0; order.length < sorted.length; q++) {
    const idx = (q * stride) % sorted.length;
    if (!order.includes(idx)) order.push(idx);
    else stride++;
  }
  const pre = order
    .map((q) => sorted[q])
    .map((v) => {
      const th = (v.azimuth * Math.PI) / 180,
        ph = (v.elevation * Math.PI) / 180;
      return {
        v,
        cos: Math.cos(th),
        sin: Math.sin(th),
        cph: Math.cos(ph),
        sph: Math.sin(ph),
        cx: (v.box[0] + v.box[2]) / 2,
        cy: (v.box[1] + v.box[3]) / 2,
        s: (v.box[3] - v.box[1]) / (2 * Math.cos(ph) + 2 * A * Math.sin(ph)),
      };
    });
  const allowed = Math.max(1, Math.floor(usable.length * tolerance));
  const solid = new Uint8Array(nx * ny * nz);
  const X = (i) => -A + (2 * A * (i + 0.5)) / nx;
  const Y = (j) => -1 + (2 * (j + 0.5)) / ny;
  const Z = (k) => -A + (2 * A * (k + 0.5)) / nz;

  const inside = (p, x, y, z) => {
    const u = x * p.cos - z * p.sin;
    const zr = x * p.sin + z * p.cos;
    const vv = -y * p.cph + zr * p.sph;
    const px = Math.round(p.cx + u * p.s),
      py = Math.round(p.cy + vv * p.s);
    const { W, H, lab } = p.v;
    return px >= 0 && py >= 0 && px < W && py < H && lab[py * W + px] === 1;
  };

  for (let i = 0; i < nx; i++) {
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0)); // stay responsive while carving
    const x = X(i);
    for (let k = 0; k < nz; k++) {
      const z = Z(k);
      for (let j = 0; j < ny; j++) {
        const y = Y(j);
        let miss = 0;
        for (let q = 0; q < pre.length && miss <= allowed; q++) if (!inside(pre[q], x, y, z)) miss++;
        if (miss <= allowed) solid[(i * ny + j) * nz + k] = 1;
      }
    }
  }

  // surface voxels: solid with an empty (or out-of-grid) neighbour
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : solid[(i * ny + j) * nz + k]);
  const surf = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      for (let k = 0; k < nz; k++) {
        if (!at(i, j, k)) continue;
        if (
          !at(i - 1, j, k) ||
          !at(i + 1, j, k) ||
          !at(i, j - 1, k) ||
          !at(i, j + 1, k) ||
          !at(i, j, k - 1) ||
          !at(i, j, k + 1)
        )
          surf.push(i, j, k);
      }
  const count = surf.length / 3;
  if (count < 30) return null;

  // a fixed, dense number of points: an even subset when there are more surface cells than points, and
  // several jittered points per cell when there are fewer, so small objects look as solid as big ones
  const take = points;
  const pts = new Float32Array(take * 3);
  const cols = new Uint8Array(take * 3);
  const colorViews = pre.filter((p) => p.v.rgb);
  const step = count / take;
  const vx = (2 * A) / nx,
    vy = 2 / ny;
  for (let m = 0; m < take; m++) {
    const s = Math.floor(m * step) * 3;
    const x = X(surf[s]) + (Math.random() - 0.5) * vx;
    const y = Y(surf[s + 1]) + (Math.random() - 0.5) * vy;
    const z = Z(surf[s + 2]) + (Math.random() - 0.5) * vx;
    pts[3 * m] = x;
    pts[3 * m + 1] = y;
    pts[3 * m + 2] = z;
    // colour from the view that faces this point most directly
    let best = null,
      bestF = -2;
    const rl = Math.hypot(x, z) || 1;
    for (const p of colorViews) {
      const f = (x * p.sin + z * p.cos) / rl;
      if (f > bestF) {
        bestF = f;
        best = p;
      }
    }
    if (best) {
      const u = x * best.cos - z * best.sin,
        zr = x * best.sin + z * best.cos;
      const vv = -y * best.cph + zr * best.sph;
      const { W, H, rgb } = best.v;
      const px = Math.min(W - 1, Math.max(0, Math.round(best.cx + u * best.s)));
      const py = Math.min(H - 1, Math.max(0, Math.round(best.cy + vv * best.s)));
      const o = (py * W + px) * 3;
      cols[3 * m] = rgb[o];
      cols[3 * m + 1] = rgb[o + 1];
      cols[3 * m + 2] = rgb[o + 2];
    } else {
      cols[3 * m] = cols[3 * m + 1] = cols[3 * m + 2] = 220;
    }
  }
  return { n: take, pts, cols, halfWidth: A, views: usable.length };
}

// ASCII PLY point cloud, scaled to metres when the real height is known.
export function toPly(cloud, heightM) {
  const scale = heightM ? heightM / 2 : 1;
  const lines = [
    "ply",
    "format ascii 1.0",
    `comment Orbit silhouette preview (visual hull). Units: ${heightM ? "metres" : "object height = 2"}`,
    `element vertex ${cloud.n}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header",
  ];
  for (let i = 0; i < cloud.n; i++) {
    lines.push(
      `${(cloud.pts[3 * i] * scale).toFixed(5)} ${(cloud.pts[3 * i + 1] * scale).toFixed(5)} ${(cloud.pts[3 * i + 2] * scale).toFixed(5)} ${cloud.cols[3 * i]} ${cloud.cols[3 * i + 1]} ${cloud.cols[3 * i + 2]}`,
    );
  }
  return lines.join("\n") + "\n";
}

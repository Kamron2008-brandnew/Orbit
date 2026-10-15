import test from "node:test";
import assert from "node:assert/strict";
import { carveHull, toPly } from "../web-capture/js/hull.js";

// Side-on silhouettes of an upright cylinder (radius 0.5, height 2): the same rectangle from every angle.
function cylinderViews(count) {
  const W = 100,
    H = 100;
  const lab = new Uint8Array(W * H);
  for (let y = 10; y < 90; y++) for (let x = 30; x < 70; x++) lab[y * W + x] = 1; // 40 x 80 px: width 1 unit, height 2
  const rgb = new Uint8Array(W * H * 3).fill(180);
  return Array.from({ length: count }, (_, i) => ({
    lab,
    W,
    H,
    box: [30, 10, 70, 90],
    azimuth: (360 * i) / count,
    elevation: 0,
    rgb,
  }));
}

test("carving a cylinder's silhouettes gives back a cylinder", async () => {
  const cloud = await carveHull(cylinderViews(24));
  assert.equal(cloud.n, 6000);
  assert.equal(cloud.pts.length, 6000 * 3);
  assert.equal(cloud.cols.length, 6000 * 3);
  let maxRadius = 0,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < cloud.n; i++) {
    maxRadius = Math.max(maxRadius, Math.hypot(cloud.pts[3 * i], cloud.pts[3 * i + 2]));
    minY = Math.min(minY, cloud.pts[3 * i + 1]);
    maxY = Math.max(maxY, cloud.pts[3 * i + 1]);
  }
  assert.ok(maxRadius > 0.45 && maxRadius < 0.62, `radius ${maxRadius.toFixed(3)} is about 0.5`);
  assert.ok(
    minY < -0.95 && maxY > 0.95 && minY > -1.1 && maxY < 1.1,
    `height ${minY.toFixed(2)}..${maxY.toFixed(2)} is about -1..1`,
  );
  assert.equal(cloud.views, 24);
});

test("too few views is not enough to carve a shape", async () => {
  assert.equal(await carveHull(cylinderViews(5)), null);
});

test("views from steeply above are left out of the side-on carve", async () => {
  const views = cylinderViews(24).map((v) => ({ ...v, elevation: 70 }));
  assert.equal(await carveHull(views), null);
});

test("toPly writes a header that matches the points, scaled to the real height", async () => {
  const cloud = await carveHull(cylinderViews(24));
  const ply = toPly(cloud, 0.3).split("\n");
  assert.equal(ply[0], "ply");
  assert.ok(ply.includes("element vertex 6000"));
  const body = ply.slice(ply.indexOf("end_header") + 1).filter(Boolean);
  assert.equal(body.length, 6000);
  const ys = body.map((line) => +line.split(" ")[1]);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 0.31 && Math.max(...ys) - Math.min(...ys) > 0.28, "30 cm tall");
});

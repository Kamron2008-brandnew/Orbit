import test from "node:test";
import assert from "node:assert/strict";
import { introShapes, project, vaseCloud } from "../web-capture/js/particles.js";

test("project puts the origin at the centre of the view, however it is turned", () => {
  const out = [0, 0, 0];
  project(0, 0, 0, 1.3, 0.4, 200, 300, 100, out);
  assert.deepEqual([out[0], out[1], out[2]], [200, 300, 0]);
});

test("project turns a point a quarter turn around the vertical axis", () => {
  const out = [0, 0, 0];
  project(1, 0, 0, Math.PI / 2, 0, 0, 0, 100, out);
  // the point that was to the right is now straight ahead or behind: no sideways offset
  assert.ok(Math.abs(out[0]) < 1e-9);
  assert.ok(Math.abs(Math.abs(out[2]) - 1) < 1e-9);
});

test("project makes nearer points bigger (perspective)", () => {
  const near = project(1, 0, 1, 0, 0, 0, 0, 100, [0, 0, 0]);
  const far = project(1, 0, -1, 0, 0, 0, 0, 100, [0, 0, 0]);
  assert.ok(Math.abs(near[0]) > Math.abs(far[0]));
});

test("the vase has the number of points asked for, all finite and within its height", () => {
  const n = 1000,
    pts = vaseCloud(n);
  assert.equal(pts.length, n * 3);
  for (let i = 0; i < pts.length; i++) assert.ok(Number.isFinite(pts[i]));
  for (let i = 0; i < n; i++) assert.ok(pts[3 * i + 1] >= -1 && pts[3 * i + 1] <= 1);
});

test("every intro shape has the same number of points, is centred, and fits the view", () => {
  const n = 600,
    shapes = introShapes(n);
  assert.ok(shapes.length >= 7);
  for (const shape of shapes) {
    assert.equal(shape.pts.length, n * 3, shape.name);
    assert.equal(shape.palette.length, 2, shape.name);
    let minY = Infinity,
      maxY = -Infinity,
      maxXZ = 0;
    for (let i = 0; i < n; i++) {
      assert.ok(
        Number.isFinite(shape.pts[3 * i]) &&
          Number.isFinite(shape.pts[3 * i + 1]) &&
          Number.isFinite(shape.pts[3 * i + 2]),
        shape.name,
      );
      minY = Math.min(minY, shape.pts[3 * i + 1]);
      maxY = Math.max(maxY, shape.pts[3 * i + 1]);
      maxXZ = Math.max(maxXZ, Math.abs(shape.pts[3 * i]), Math.abs(shape.pts[3 * i + 2]));
    }
    assert.ok(
      maxY - minY <= 2.0001 && maxXZ <= 1.1001,
      `${shape.name} fits (height ${(maxY - minY).toFixed(2)}, reach ${maxXZ.toFixed(2)})`,
    );
  }
});

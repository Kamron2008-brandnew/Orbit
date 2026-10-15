import test from "node:test";
import assert from "node:assert/strict";
import { colorHist, findObject, histSimilarity, resampleContour, resampleMask } from "../web-capture/js/vision.js";

const W = 100,
  H = 100;

// A confidence mask with filled rectangles [x0, y0, x1, y1) set to 1.
function mask(...rects) {
  const m = new Float32Array(W * H);
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
  return m;
}

test("findObject measures a single blob", () => {
  const obj = findObject(mask([30, 20, 50, 60]), W, H, [0.4, 0.4]);
  assert.equal(obj.area, 20 * 40);
  assert.equal(obj.frac, (20 * 40) / (W * H));
  assert.deepEqual(obj.box, [30, 20, 50, 60]);
  assert.deepEqual(obj.boxN, [0.3, 0.2, 0.5, 0.6]);
  assert.ok(Math.abs(obj.center[0] - 0.395) < 0.01 && Math.abs(obj.center[1] - 0.395) < 0.01);
  assert.equal(obj.edges, 0);
  assert.ok(obj.contour.length > 50, "an outline was traced");
});

test("findObject keeps only the blob under the seed", () => {
  const m = mask([10, 10, 30, 30], [60, 60, 90, 90]);
  assert.equal(findObject(m, W, H, [0.2, 0.2]).area, 400);
  assert.equal(findObject(m, W, H, [0.75, 0.75]).area, 900);
});

test("findObject moves a seed that just misses the object onto it, but not far", () => {
  const m = mask([40, 40, 60, 60]);
  assert.ok(findObject(m, W, H, [0.36, 0.5]), "4 pixels away is close enough");
  assert.equal(findObject(m, W, H, [0.1, 0.1]), null, "far from anything");
});

test("findObject returns null for an empty or wrongly sized mask", () => {
  assert.equal(findObject(new Float32Array(W * H), W, H, [0.5, 0.5]), null);
  assert.equal(findObject(new Float32Array(10), W, H, [0.5, 0.5]), null);
  assert.equal(findObject(null, W, H, [0.5, 0.5]), null);
});

test("findObject counts how many sides of the frame the object touches", () => {
  assert.equal(findObject(mask([0, 0, 40, 40]), W, H, [0.2, 0.2]).edges, 2);
  assert.equal(findObject(mask([0, 0, 100, 40]), W, H, [0.5, 0.2]).edges, 3);
});

test("findObject fills holes inside the object", () => {
  // a ring: a 40x40 square with a 10x10 hole in the middle
  const m = mask([30, 30, 70, 70]);
  for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) m[y * W + x] = 0;
  const obj = findObject(m, W, H, [0.35, 0.35]);
  assert.equal(obj.lab[50 * W + 50], 1, "the hole is part of the object");
  assert.equal(obj.lab[10 * W + 10], 0, "the background is not");
});

test("resampleContour gives n points, clockwise, starting straight above the middle", () => {
  const obj = findObject(mask([30, 30, 70, 70]), W, H, [0.5, 0.5]);
  const ring = resampleContour(obj.contour, 80);
  assert.equal(ring.length, 80);
  assert.ok(Math.abs(ring[0][0] - 0.5) < 0.05 && ring[0][1] < 0.35, "starts at the top");
  // clockwise on screen (y down): the second quarter of the loop is on the right-hand side
  assert.ok(ring[20][0] > 0.5);
  assert.ok(ring[60][0] < 0.5);
});

test("resampleContour refuses a degenerate outline", () => {
  assert.equal(
    resampleContour([
      [0.1, 0.1],
      [0.2, 0.2],
    ]),
    null,
  );
});

test("colour histograms tell similar objects from different ones", () => {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[4 * i] = 200;
    rgba[4 * i + 1] = 30;
    rgba[4 * i + 2] = 30;
    rgba[4 * i + 3] = 255;
  } // red
  for (let y = 60; y < 90; y++)
    for (let x = 60; x < 90; x++) {
      const q = 4 * (y * W + x);
      rgba[q] = 20;
      rgba[q + 1] = 40;
      rgba[q + 2] = 220;
    } // a blue patch
  const red = findObject(mask([10, 10, 40, 40]), W, H, [0.25, 0.25]);
  const blue = findObject(mask([60, 60, 90, 90]), W, H, [0.75, 0.75]);
  const hRed = colorHist(rgba, W, H, red),
    hBlue = colorHist(rgba, W, H, blue);
  assert.ok(Math.abs(histSimilarity(hRed, hRed) - 1) < 1e-6);
  assert.ok(histSimilarity(hRed, hBlue) < 0.1);
  assert.equal(histSimilarity(null, hRed), 1, "nothing to compare against means no objection");
});

test("resampleMask picks the nearest source pixel", () => {
  const src = Uint8Array.from([1, 0, 0, 1]); // 2x2
  assert.deepEqual([...resampleMask(src, 2, 2, 4, 4)], [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
});

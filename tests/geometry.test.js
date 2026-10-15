import test from "node:test";
import assert from "node:assert/strict";
import {
  BANDS,
  bandFill,
  bandFor,
  emptyCoverage,
  progressOf,
  sectorFor,
  targetBand,
  topBonus,
} from "../web-capture/js/geometry.js";

const fill = (cov, band, count) => {
  for (let i = 0; i < count; i++) cov[band][i] = 1;
};

test("sectorFor divides the circle into equal sectors and wraps around", () => {
  const n = BANDS[0].sectors;
  assert.equal(sectorFor(0, 0), 0);
  assert.equal(sectorFor(0, 359.9), n - 1);
  assert.equal(sectorFor(0, 360), 0);
  assert.equal(sectorFor(0, -1), n - 1);
  assert.equal(sectorFor(0, 15), 1); // 24 sectors of 15 degrees
  assert.equal(sectorFor(1, 30), 1); // 12 sectors of 30 degrees
});

test("bandFor puts steep views in the top band", () => {
  assert.equal(bandFor(0), 0);
  assert.equal(bandFor(49.9), 0);
  assert.equal(bandFor(50), 1);
  assert.equal(bandFor(80), 1);
});

test("an empty scan has no progress and still needs the loop", () => {
  const cov = emptyCoverage();
  assert.equal(bandFill(cov, 0), 0);
  assert.equal(progressOf(cov), 0);
  assert.equal(targetBand(cov), 0);
});

test("the loop is done at 92% and progress stops at 1", () => {
  const cov = emptyCoverage();
  fill(cov, 0, 22); // 22 of 24 = 91.7%: not quite
  assert.ok(progressOf(cov) < 1);
  assert.equal(targetBand(cov), 0);
  fill(cov, 0, 23); // 23 of 24 = 95.8%
  assert.equal(progressOf(cov), 1);
  assert.equal(targetBand(cov), -1);
});

test("the top band is optional: it never keeps a scan from completing", () => {
  const cov = emptyCoverage();
  fill(cov, 0, 24);
  assert.equal(targetBand(cov), -1);
  assert.equal(topBonus(cov), 0);
  fill(cov, 1, 6); // half of 12 is what the top band needs
  assert.equal(topBonus(cov), 1);
});

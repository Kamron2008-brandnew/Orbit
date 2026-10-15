import test from "node:test";
import assert from "node:assert/strict";
import { clamp, easeInOut, fmtTime, fract, hash, slug } from "../web-capture/js/util.js";

test("clamp keeps a value inside its range", () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.3, 0, 1), 0.3);
});

test("fract is the part after the decimal point, also for negatives", () => {
  assert.ok(Math.abs(fract(3.25) - 0.25) < 1e-12);
  assert.ok(Math.abs(fract(-0.25) - 0.75) < 1e-12);
});

test("fmtTime shows minutes and zero-padded seconds", () => {
  assert.equal(fmtTime(0), "0:00");
  assert.equal(fmtTime(52.4), "0:52");
  assert.equal(fmtTime(65), "1:05");
  assert.equal(fmtTime(600), "10:00");
});

test("slug makes a safe file name", () => {
  assert.equal(slug("Olive Bottle!"), "olive-bottle");
  assert.equal(slug("  --Mug 2--  "), "mug-2");
  assert.equal(slug(""), "scan");
  assert.equal(slug(undefined), "scan");
  assert.equal(slug("ü"), "scan");
});

test("easeInOut runs from 0 to 1 and is symmetrical", () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(easeInOut(0.25) + easeInOut(0.75) - 1) < 1e-12);
});

test("hash is repeatable and stays in [0, 1)", () => {
  assert.equal(hash(7), hash(7));
  for (let k = 0; k < 500; k++) {
    const h = hash(k + 0.37);
    assert.ok(h >= 0 && h < 1);
  }
});

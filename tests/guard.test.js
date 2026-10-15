import test from "node:test";
import assert from "node:assert/strict";

// guard.js reads the page's storage and listens for it being hidden, so give it a small stand-in for both.
function pageWith(stored) {
  const store = new Map(Object.entries(stored));
  const listeners = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
  };
  globalThis.addEventListener = (type, fn) => {
    listeners[`window:${type}`] = fn;
  };
  globalThis.screen = { width: 390, height: 844 };
  globalThis.devicePixelRatio = 3;
  globalThis.self = globalThis;
  return { store, listeners };
}
let run = 0;
const load = () => import(`../web-capture/js/guard.js?run=${++run}`); // a fresh copy, like a fresh page load
const saved = (store) => JSON.parse(store.get("orbit.guard"));

test("a clean start has nothing to report", async () => {
  pageWith({});
  const { guard } = await load();
  assert.deepEqual(guard.crashed, []);
  assert.equal(guard.struck("refiner"), false);
});

test("a step still marked when the page starts again counts as a crash in that step", async () => {
  const { store } = pageWith({ "orbit.guard": JSON.stringify({ pending: { refiner: 1 }, strikes: {}, last: null }) });
  const { guard } = await load();
  assert.deepEqual(guard.crashed, ["refiner"]);
  assert.equal(guard.struck("refiner"), true);
  assert.equal(guard.last.name, "refiner");
  assert.deepEqual(saved(store).pending, {}, "the marker is cleared once it has been counted");
});

test("begin leaves a marker and end removes it", async () => {
  const { store } = pageWith({});
  const { guard } = await load();
  guard.begin("scan");
  assert.ok("scan" in saved(store).pending);
  guard.end("scan");
  assert.deepEqual(saved(store).pending, {});
});

test("strikes build up across restarts and can be forgiven", async () => {
  const { store } = pageWith({
    "orbit.guard": JSON.stringify({ pending: { "outliner-CPU": 1 }, strikes: { "outliner-CPU": 1 }, last: null }),
  });
  const { guard } = await load();
  assert.equal(guard.struck("outliner-CPU", 2), true);
  guard.forgive("outliner-CPU");
  assert.equal(guard.struck("outliner-CPU"), false);
  assert.deepEqual(saved(store).strikes, {});
});

test("leaving the page on purpose does not count as a crash", async () => {
  const { store, listeners } = pageWith({});
  const { guard } = await load();
  guard.begin("pack");
  globalThis.document.hidden = true;
  listeners.visibilitychange();
  assert.deepEqual(saved(store).pending, {});
  const next = await load();
  assert.deepEqual(next.guard.crashed, []);
});

test("the error log merges repeats and keeps only the latest few", async () => {
  const { store } = pageWith({});
  const { logError } = await load();
  logError("refine", new Error("device lost"));
  logError("refine", new Error("device lost"));
  const log = () => JSON.parse(store.get("orbit.errors"));
  assert.equal(log().length, 1);
  assert.equal(log()[0].n, 2);
  for (let i = 0; i < 30; i++) logError("tick", new Error(`problem ${i}`));
  assert.equal(log().length, 12);
  assert.equal(log().at(-1).msg, "problem 29");
});

test("the diagnostics report carries the strikes and errors", async () => {
  pageWith({ "orbit.guard": JSON.stringify({ pending: { scan: 1 }, strikes: {}, last: null }) });
  const { report, logError } = await load();
  logError("frame", new Error("oops"));
  const r = JSON.parse(report({ phase: "live" }));
  assert.equal(r.strikes.scan, 1);
  assert.equal(r.phase, "live");
  assert.equal(r.errors.at(-1).msg, "oops");
});

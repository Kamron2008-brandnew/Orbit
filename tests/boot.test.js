import test from "node:test";
import assert from "node:assert/strict";

// boot.js notes how far the page got and, if the last run died early, shows that. Give it a stand-in page.
function pageWith(stored) {
  const store = new Map(stored ? [["orbit.boot", JSON.stringify(stored)]] : []);
  const appended = [];
  const listeners = {};
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.location = { search: "?nogl" };
  globalThis.document = {
    hidden: false,
    body: { append: (el) => appended.push(el) },
    createElement: () => ({ style: {}, addEventListener() {}, remove() {} }),
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  globalThis.addEventListener = (type, fn) => (listeners[`window:${type}`] = fn);
  return { store, appended, listeners };
}
let run = 0;
const load = () => import(`../web-capture/js/boot.js?run=${++run}`);

test("a run that ended early is reported on the next start", async () => {
  const { appended } = pageWith({ lasted: 2300, frames: 140, ok: false, flags: "?nogl" });
  await load();
  assert.equal(appended.length, 1);
  assert.match(appended[0].textContent, /ended after 2\.3s, 140 frames drawn \(\?nogl\)/);
});

test("a run that was left on purpose, or survived, is not reported", async () => {
  const { appended } = pageWith({ lasted: 90000, frames: 5000, ok: true, flags: "" });
  await load();
  assert.equal(appended.length, 0);
});

test("the first ever start has nothing to report", async () => {
  const { appended } = pageWith(null);
  await load();
  assert.equal(appended.length, 0);
});

test("leaving the page marks the run as fine", async () => {
  const { store, listeners } = pageWith(null);
  await load();
  assert.equal(JSON.parse(store.get("orbit.boot")).ok, false);
  listeners["window:pagehide"]();
  assert.equal(JSON.parse(store.get("orbit.boot")).ok, true);
});

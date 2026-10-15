// Things every screen uses: toasts, the current phase, what the shutter can do.

import { $, body, outliner, state } from "./state.js";

let toastTimer = 0;
export function toast(msg, ms = 3000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
export function setPhase(p) {
  state.phase = p;
  body.dataset.phase = p;
  $("shutter").setAttribute("aria-label", p === "scanning" ? "Finish scan" : "Start scan");
  syncDim();
  syncCanScan();
}
export const syncDim = () => body.classList.toggle("dim", state.phase === "review" || !!state.panel);

// The shutter is live once there is an object to scan (or, if detection couldn't load, the whole view).
export function syncCanScan() {
  body.classList.toggle("can-scan", (state.selected && state.locked) || !!outliner.failed);
}

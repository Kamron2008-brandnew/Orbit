// Starts the app: the particle frame loop and the page lifecycle.

import { guard, logError, setPhaseReader } from "./guard.js";
import { motion } from "./motion.js";
import { keepAwake, recoverCamera } from "./camera.js";
import { refreshCount, setLastThumb, syncStability } from "./library.js";
import { openReview } from "./review.js";
import { finishScan } from "./scan.js";
import { formCamera } from "./scenes/camera.js";
import { formIntro } from "./scenes/intro.js";
import { formPanel } from "./scenes/panel.js";
import { formReview } from "./scenes/review.js";
import { crashNotice, settings } from "./settings.js";
import { analyzer, outliner, particles, refiner, state, targets } from "./state.js";
import { toast } from "./ui.js";
import "./share.js"; // nothing else needs it: it wires up the Share button when it loads

// Opening the app with ?lite switches off the large blurred layers, to find out whether they are what
// crashes a phone's browser. Nothing changes without it.
if (new URLSearchParams(location.search).has("lite")) document.documentElement.classList.add("lite");

if (!("switch" in HTMLInputElement.prototype)) document.documentElement.classList.add("no-switch");

setPhaseReader(() => state.phase);

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  // one bad frame (a missing element, a value out of range) must not stop the particles for good
  try {
    if (state.panel) formPanel(now);
    else if (state.phase === "intro") formIntro(now, dt);
    else if (state.phase === "review") formReview(now, dt);
    else formCamera(now);
  } catch (e) {
    logError("frame", e);
  }
  try {
    particles.step(dt, now / 1000);
    particles.render();
  } catch (e) {
    logError("render", e);
  }
}
requestAnimationFrame(frame);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (state.phase === "scanning") finishScan("interrupted");
  } else if (state.phase !== "intro") {
    keepAwake();
    if (!state.track || state.track.readyState === "ended") recoverCamera();
  }
});

syncStability();
if (crashNotice) setTimeout(() => toast(crashNotice, 7000), 1200);

refreshCount().then((scans) => {
  state.scanCount = scans.length;
  setLastThumb(scans[0]);
});

// Expose internals for debugging from the console.
window.orbit = { state, targets, particles, motion, outliner, refiner, analyzer, settings, frame, openReview, guard };

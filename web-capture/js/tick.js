// The analysis loop that runs while the camera is on.

import { logError } from "./guard.js";
import { findObject } from "./vision.js";
import { updateCaption, updateGuidance, updateHints } from "./guidance.js";
import { scheduleRefine } from "./precise.js";
import { scanStep } from "./scan.js";
import { analyzer, outliner, state, video } from "./state.js";
import { autoDetect, updateObject } from "./tracking.js";
import { syncCanScan } from "./ui.js";

export function analyzeTick() {
  try { analyzeStep(); } catch (e) { logError("tick", e); }
}
function analyzeStep() {
  if (state.phase === "intro" || state.phase === "review" || state.panel || document.hidden) return;
  if (video.readyState < 2 || !video.videoWidth) return;
  const now = performance.now();
  const dt = Math.min(0.3, (now - (state.lastTick || now)) / 1000);
  state.lastTick = now;

  analyzer.grab(video);
  if (outliner.ready && state.selected) {
    state.segSkip = (state.segSkip + 1) % (outliner.ms > 70 ? 3 : outliner.ms > 35 ? 2 : 1);
    if (state.segSkip === 0) {
      const canvas = outliner.frame(video);
      // guide with points spread over the object (or its last known place) so the whole thing stays selected
      const ref = state.locked ? state.obj : state.lastObj;
      const guides = ref && !state.userSeed ? ref.guides : [state.seed];
      const conf = outliner.run(canvas, guides, state.locked ? 0.35 : 0);
      updateObject(conf ? findObject(conf, canvas.width, canvas.height, state.seed) : null);
    }
  }
  const st = analyzer.stats(state.locked ? state.obj : null);
  state.lastStats = st;
  state.sharpEMA = state.sharpEMA ? state.sharpEMA * 0.94 + st.sharp * 0.06 : st.sharp;

  if (state.phase === "scanning") scanStep(st, dt, now);
  autoDetect(now);
  scheduleRefine(now);
  updateGuidance(st, now);
  updateHints();
  updateCaption();
  syncCanScan();
}

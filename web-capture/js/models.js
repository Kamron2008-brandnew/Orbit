// Loading the two models, one after the other, under the crash guard.

import { guard, logError } from "./guard.js";
import { syncStability } from "./library.js";
import { saveSettings, settings } from "./settings.js";
import { outliner, refiner, state } from "./state.js";
import { toast } from "./ui.js";
import { sleep } from "./util.js";

// The two models are loaded one after the other, never together (together they were the memory peak right
// after the camera opens), and each load is marked for the crash guard, so one that kills the page is not
// repeated the same way.
export async function loadModels() {
  const around = async (name, fn) => { guard.begin(name); try { return await fn(); } finally { guard.end(name); } };
  // 1. the live tracker: GPU first, CPU if the GPU one has killed the page before; none after two deaths
  if (guard.struck("outliner-CPU", 2)) {
    outliner.failed = true;
    toast("Object detection is off on this device. Scanning still works without it.", 5200);
  } else {
    try { await outliner.load({ delegates: guard.struck("outliner-GPU") ? ["CPU"] : ["GPU", "CPU"], around }); }
    catch (err) {
      outliner.failed = true;
      logError("outliner", err);
      toast("Object detection couldn't load. Scanning still works without it.", 4200);
    }
  }
  // 2. precise outlines, a moment later, only if they are on and the device can run them
  await sleep(1500);
  if (!settings.precise) return;
  await loadRefiner(around);
}

export async function loadRefiner(around = async (n, fn) => fn()) {
  if (refiner.ready || refiner.loading) return;
  refiner.loading = true;
  refiner.failed = false;
  try { await refiner.load(p => { state.refineLoad = p; }, { around }); }
  catch (err) {
    refiner.failed = true;
    logError("refiner", err);
    console.warn("precise outlines unavailable", err);
  }
  refiner.loading = false;
  syncStability();
}

// Precise outlines turned themselves off because the device couldn't run them.
export function disableRefiner(why) {
  if (refiner.failed) return;
  refiner.failed = true;
  refiner.unload();
  settings.precise = false;
  saveSettings();
  syncStability();
  toast(why, 5200);
}

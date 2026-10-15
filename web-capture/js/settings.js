// Settings saved on the phone, and what happens to them after a crash.

import { guard } from "./guard.js";
import { setHaptics } from "./haptics.js";
import { configureSound } from "./sound.js";

const DEFAULTS = {
  haptics: true,
  sound: true,
  voice: false,
  autoFinish: true,
  maxDetail: true,
  dense: false,
  video: false,
  precise: true,
};
export const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("orbit.settings") || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
})();
export const saveSettings = () => {
  try {
    localStorage.setItem("orbit.settings", JSON.stringify(settings));
  } catch {}
};
export const applySettings = () => {
  setHaptics(settings.haptics);
  configureSound(settings);
};
applySettings();
// If the last run died in the middle of something heavy, don't do that the same way again, and say so.
// (Everything stays switchable in Settings: this only steps down, it never locks anything.)
export const crashNotice = (() => {
  const died = guard.crashed;
  if (!died.length) return null;
  const has = (n) => died.some((d) => d === n || d.startsWith(n));
  let msg;
  if (has("scan")) {
    Object.assign(settings, { maxDetail: false, dense: false, video: false });
    msg =
      "Orbit restarted during a scan, so it switched to standard detail to use less memory. Maximum detail is in Settings.";
  } else if (has("refiner")) {
    settings.precise = false;
    msg = "Orbit restarted while loading precise outlines, so they're off for now. You can try them again in Settings.";
  } else if (has("outliner")) {
    msg = "Orbit restarted while loading object detection, so it's using the safer mode now.";
  } else if (has("pack")) {
    msg = "Orbit restarted while packing the zip. If scans are large, turn off video and extra frames in Settings.";
  } else msg = "Orbit restarted unexpectedly. Details are in Settings, under Stability.";
  try {
    localStorage.setItem("orbit.settings", JSON.stringify(settings));
  } catch {}
  return msg;
})();

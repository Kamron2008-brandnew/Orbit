// What the app tells you while you scan: status, caption and direction hints.

import { BANDS, bandFor, progressOf } from "./geometry.js";
import { haptic } from "./haptics.js";
import { angleDiff, motion } from "./motion.js";
import { chime, say } from "./sound.js";
import { LIGHT } from "./config.js";
import { goalBand } from "./scan.js";
import { settings } from "./settings.js";
import { $, body, outliner, reduceMotion, refiner, state } from "./state.js";
import { clamp } from "./util.js";

function wanted(st) {
  const scanning = state.phase === "scanning";
  const sc = state.scan;
  if (st.lum < LIGHT.dark) return ["bad", "Too dark. Find more light", "It's too dark. Find more light."];
  if (st.lum > LIGHT.bright) return ["warn", "Too much glare", "There's too much glare."];
  if (!outliner.ready && !outliner.failed) return ["info", "Loading object detection"];
  if (outliner.ready && !state.locked)
    return scanning
      ? ["warn", "Point back at the object", "Point back at the object."]
      : ["info", state.lastObj ? "Finding its edges" : "Looking for an object"];
  if (state.locked && state.obj) {
    if (state.obj.frac < 0.035) return ["warn", "Move closer", "Move closer."];
    if (state.obj.edges >= 2 || state.obj.frac > 0.6) return ["warn", "Step back a little", "Step back a little."];
    const [cx, cy] = state.obj.center;
    if (Math.abs(cx - 0.5) > 0.27 || Math.abs(cy - 0.5) > 0.3)
      return ["warn", "Keep it centered", "Keep it in the middle."];
  }
  if (scanning) {
    if (state.mode === "walk") {
      if (motion.pace > 55) return ["warn", "Slow down", "Slow down."];
      if (motion.shake > 150) return ["warn", "Steady your hands", "Steady your hands."];
    } else {
      if (st.bgMotion > 9) return ["warn", "Keep the phone still", "Keep the phone still."];
      if (st.objMotion > 30) return ["warn", "Turn it slower", "Turn it slower."];
      if (sc.spinIdle > 1.8) return ["warn", "Keep turning the object", "Keep turning."];
    }
    if (st.sharp < Math.max(14, 0.45 * state.sharpEMA)) return ["warn", "Hold steady", "Hold steady."];
    if (sc.completeAt) return ["ok", "Every angle covered"];
    if (state.mode === "walk" && motion.available && motion.elev < 6 && goalBand(sc) === 0)
      return ["ok", "Tip: hold the phone a little higher"];
    return ["ok", "Looking good"];
  }
  if (state.refining === "select" && !state.precise) return ["info", "Finding its edges"];
  if (!refiner.ready && !refiner.failed)
    return ["info", `Loading precise outlines ${Math.round((state.refineLoad || 0) * 100)}%`];
  return ["ok", "Ready. Tap the shutter"];
}

export function setStatus(text, level) {
  if (text === state.status && level === state.level) return;
  state.status = text;
  state.level = level;
  body.dataset.level = level;
  const el = $("statusText");
  el.classList.add("swap");
  setTimeout(
    () => {
      el.textContent = text;
      el.classList.remove("swap");
    },
    reduceMotion ? 0 : 160,
  );
}

export function updateGuidance(st, now) {
  if (state.phase === "saving") return;
  const [level, text, spoken] = wanted(st);
  if (!state.cand || state.cand.text !== text) {
    state.cand = { level, text, spoken };
    state.candSince = now;
  }
  const hold = level === "ok" || level === "info" ? 250 : 450;
  if (text === state.status || now - state.candSince < hold) return;
  const worse = (level === "warn" || level === "bad") && state.phase === "scanning";
  setStatus(text, level);
  $("torchBtn").classList.toggle("pulse", level === "bad" && !state.torch);
  if (worse && now - state.lastWarnFx > 3000) {
    state.lastWarnFx = now;
    haptic("warn");
    chime("warn");
    say(spoken);
  }
}

function captionFor(sc) {
  const gb = goalBand(sc);
  if (gb === -1) return settings.autoFinish ? "Done" : "All around. Tap to finish";
  if (gb === 1) return "Raise the phone and look down at it";
  const p = progressOf(sc.coverage);
  const walk = state.mode === "walk";
  if (p < 0.08) return walk ? "Walk slowly around it" : "Turn it slowly";
  if (p < 0.75) return walk ? "Keep going around" : "Keep turning";
  return "Almost there";
}

export function updateCaption() {
  let text = "";
  if (state.phase === "scanning" && state.scan) text = captionFor(state.scan);
  else if (state.phase === "live" && !state.locked && !outliner.failed) text = "Point at what you want to scan";
  if (text === state.caption) return;
  state.caption = text;
  const el = $("caption");
  el.classList.remove("show");
  if (!text) return;
  setTimeout(
    () => {
      el.textContent = text;
      el.classList.add("show");
    },
    reduceMotion ? 0 : 200,
  );
  if (state.phase === "scanning" && text !== state.lastSpoken) {
    state.lastSpoken = text;
    say(text + ".");
  }
}
$("caption").style.transition = "opacity .45s cubic-bezier(.25,.9,.3,1), transform .5s cubic-bezier(.25,.9,.3,1)";

export function updateHints() {
  const sc = state.scan;
  let hint = null,
    elev = false;
  if (state.phase === "scanning" && sc && motion.available) {
    const tb = goalBand(sc);
    if (tb >= 0) {
      const cur = bandFor(motion.elev);
      if (cur !== tb) {
        elev = true;
        hint = tb > cur ? ["up", "Raise the phone and look down"] : ["up", "Lower the phone a little"];
        const toPct = (e) => `${(1 - clamp(e, 0, 80) / 80) * 100}%`;
        const g = $("elev");
        g.querySelector(".elev-zone").style.top = toPct(BANDS[tb].elevMax);
        g.querySelector(".elev-zone").style.height = `${((BANDS[tb].elevMax - BANDS[tb].elevMin) / 80) * 100}%`;
        g.querySelector(".elev-knob").style.top = toPct(motion.elev);
      } else if (state.mode === "walk" && sc.lastAngle != null) {
        const n = BANDS[tb].sectors;
        let best = null;
        for (let s = 0; s < n; s++) {
          if (sc.coverage[tb][s]) continue;
          const d = angleDiff(((s + 0.5) / n) * 360, sc.lastAngle);
          if (best === null || Math.abs(d) < Math.abs(best)) best = d;
        }
        // walking left turns the camera clockwise (heading increases)
        if (best !== null && Math.abs(best) > 20)
          hint = best > 0 ? ["left", "Keep walking left"] : ["right", "Keep walking right"];
      }
    }
  }
  const el = $("hint");
  if (hint) {
    const key = hint.join();
    if (state.hint !== key) {
      state.hint = key;
      $("hintIcon").setAttribute("href", `#i-${hint[0]}`);
      $("hintText").textContent = hint[1];
      el.className = `glass hint hud show ${hint[0]}`;
    }
  } else if (state.hint) {
    state.hint = null;
    el.classList.remove("show");
  }
  $("elev").classList.toggle("show", elev);
}

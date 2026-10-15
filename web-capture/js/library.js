// The scan library, the settings page, and the Stability rows.

import * as store from "./store.js";
import { guard, report } from "./guard.js";
import { haptic } from "./haptics.js";
import { chime, say, unlockAudio } from "./sound.js";
import { loadRefiner } from "./models.js";
import { openReview } from "./review.js";
import { applySettings, saveSettings, settings } from "./settings.js";
import { $, outliner, refiner, state } from "./state.js";
import { syncDim, toast } from "./ui.js";
import { shortWhen } from "./util.js";

export function setLastThumb(rec) {
  const img = $("lastThumb");
  if (rec?.thumb) {
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = URL.createObjectURL(rec.thumb);
    img.src = img.dataset.url;
    img.hidden = false;
  } else img.hidden = true;
}
export async function refreshCount() {
  const scans = await store.listScans().catch(() => []);
  $("libCount").textContent = scans.length;
  $("libCount").hidden = !scans.length;
  return scans;
}

function openPanel(name) {
  state.panel = name;
  const el = $(name);
  el.scrollTop = 0;
  el.querySelectorAll(".list li, .row").forEach((r, i) => r.style.setProperty("--i", i));
  el.classList.remove("open");
  void el.offsetWidth;
  el.classList.add("open");
  syncDim();
}
function closePanels() {
  if (!state.panel) return;
  $(state.panel).classList.remove("open");
  state.panel = null;
  syncDim();
}
document.querySelectorAll("[data-close=library],[data-close=settings]").forEach((b) =>
  b.addEventListener("click", () => {
    haptic("tap");
    closePanels();
  }),
);

const libUrls = [];
$("libraryBtn").addEventListener("click", async () => {
  if (state.phase !== "live") return;
  haptic("tap");
  libUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const scans = await refreshCount();
  $("scanList").replaceChildren(
    ...scans.map((rec) => {
      const li = document.createElement("li");
      const btn = Object.assign(document.createElement("button"), { className: "scan-row" });
      const th = Object.assign(document.createElement("span"), { className: "th" });
      if (rec.thumb) {
        const img = document.createElement("img");
        const u = URL.createObjectURL(rec.thumb);
        libUrls.push(u);
        img.src = u;
        img.alt = "";
        th.append(img);
      } else th.innerHTML = '<svg class="ic"><use href="#i-stack"/></svg>';
      const text = document.createElement("span");
      text.append(
        Object.assign(document.createElement("b"), { textContent: rec.name }),
        Object.assign(document.createElement("small"), {
          textContent: `${shortWhen(rec.createdAt)}, ${rec.frames.length} frames${rec.status === "complete" ? "" : ", stopped early"}`,
        }),
      );
      const score = Object.assign(document.createElement("span"), { className: "pill", textContent: rec.score ?? "–" });
      const chev = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      chev.setAttribute("class", "ic chev");
      chev.innerHTML = '<use href="#i-chev"/>';
      btn.append(th, text, score, chev);
      btn.addEventListener("click", () => {
        haptic("tap");
        openReview(rec, { live: state.scan?.id === rec.id });
      });
      li.append(btn);
      return li;
    }),
  );
  openPanel("library");
});

// The Stability rows: what precise outlines are doing, and a report to send if the app keeps restarting.
export function syncStability() {
  const sw = $("preciseSwitch"),
    note = $("preciseNote");
  if (!sw) return;
  sw.checked = !!settings.precise;
  const gpu = !!navigator.gpu;
  sw.disabled = !gpu;
  note.textContent = !gpu
    ? "Needs WebGPU, which this device doesn't have"
    : refiner.loading
      ? "Loading"
      : refiner.ready
        ? "On. Sharper object edges, uses more memory"
        : !settings.precise && guard.struck("refiner")
          ? "Off after the app restarted. Turn on to try again"
          : !settings.precise
            ? "Off"
            : "Sharper object edges, uses more memory";
  const last = guard.last;
  $("diagNote").textContent = last
    ? `Last restart: ${last.name}, ${shortWhen(last.at)}`
    : "Send this if the app keeps restarting";
}
function onPreciseToggle(on) {
  if (on) {
    guard.forgive("refiner");
    refiner.failed = false;
    if (state.stream) loadRefiner();
  } else refiner.unload(); // give the memory back
  syncStability();
}
$("diagBtn").addEventListener("click", async () => {
  haptic("tap");
  const text = report({
    settings,
    phase: state.phase,
    refiner: { ready: refiner.ready, device: refiner.device, ms: Math.round(refiner.ms) },
    outliner: { ready: outliner.ready, delegate: outliner.delegate, failed: outliner.failed },
  });
  try {
    await navigator.clipboard.writeText(text);
    toast("Diagnostics copied.", 2200);
  } catch {
    const box = $("diagOut");
    box.value = text;
    box.hidden = false;
    box.select();
    toast("Select the text and copy it.", 3000);
  }
});

document.querySelectorAll("[data-setting]").forEach((input) => {
  const key = input.dataset.setting;
  input.checked = !!settings[key];
  input.addEventListener("change", () => {
    settings[key] = input.checked;
    saveSettings();
    applySettings();
    if (key === "precise") onPreciseToggle(input.checked);
    haptic(input.checked ? "lock" : "tap");
    if (key === "sound" && input.checked) {
      unlockAudio();
      chime("lock");
    }
    if (key === "voice" && input.checked) {
      unlockAudio();
      say("Spoken guidance is on.", { force: true });
    }
  });
});

$("settingsBtn").addEventListener("click", async () => {
  if (state.phase !== "live") return;
  haptic("tap");
  openPanel("settings");
  try {
    const { usage } = await navigator.storage.estimate();
    $("storageNote").textContent = `Scans use ${(usage / 1e6).toFixed(0)} MB on this phone.`;
  } catch {
    $("storageNote").textContent = "";
  }
});

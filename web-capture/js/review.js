// The result screen: tabs, numbers, name and height, and its buttons.

import * as store from "./store.js";
import { bandFill, targetBand, topBonus } from "./geometry.js";
import { haptic } from "./haptics.js";
import { click } from "./sound.js";
import { refreshCount, setLastThumb } from "./library.js";
import { beginScanning } from "./scan.js";
import { ambientFor } from "./scenes/review.js";
import { $, reduceMotion, state } from "./state.js";
import { clearSelection } from "./tracking.js";
import { setPhase, toast } from "./ui.js";
import { clamp, fmtTime, slug, when } from "./util.js";

let unit = (() => {
  try {
    return localStorage.getItem("orbit.unit") || "cm";
  } catch {
    return "cm";
  }
})();

export function openReview(rec, { live = false } = {}) {
  state.reviewing = rec;
  state.preparedZip = null;
  state.panel && $(state.panel).classList.remove("open");
  state.panel = null;
  state.cloudYaw = 0.5;
  state.cloudSpin = reduceMotion ? 0.25 : 2.2;
  setPhase("review");
  const rv = $("review");
  rv.scrollTop = 0;
  rv.classList.remove("open");
  void rv.offsetWidth;
  rv.classList.add("open");

  $("scanName").value = rec.name;
  $("rvSub").textContent = `${rec.mode === "spin" ? "Turntable" : "Walk-around"} scan, ${when(rec.createdAt)}`;
  document.querySelector(".cloud-note").textContent = rec.cloud
    ? `Shape preview from ${rec.cloud.views} outlines. Drag to turn it.`
    : "Not enough outlines for a shape preview.";

  const hasScore = rec.score != null;
  const st = rec.stats;
  selectTab("overview", false);
  state.reviewOpenedAt = performance.now();
  ambientFor(rec);

  // Overview: the score as a ring of dots, lit one by one
  animateNumber($("scoreNum"), hasScore ? rec.score : null);
  $("scoreWord").textContent = hasScore ? rec.word : "Stopped early";
  $("scoreLine").textContent = summaryLine(rec);
  const facts = [
    [`${rec.frames.length}`, "keyframes"],
    [st ? fmtTime(st.seconds) : "–", "scan time"],
    [rec.cloud ? rec.cloud.n.toLocaleString() : "–", "3D points"],
  ];
  $("facts").replaceChildren(
    ...facts.map(([v, k]) => {
      const d = document.createElement("div");
      d.append(
        Object.assign(document.createElement("dd"), { textContent: v }),
        Object.assign(document.createElement("dt"), { textContent: k }),
      );
      return d;
    }),
  );
  $("legAround").textContent = `${Math.round(bandFill(rec.coverage, 0) * 100)}%`;
  $("legAbove").textContent = `${Math.round(bandFill(rec.coverage, 1) * 100)}%`;
  const dt = $("dialThumb");
  if (dt.dataset.url) URL.revokeObjectURL(dt.dataset.url);
  if (rec.thumb) {
    dt.dataset.url = URL.createObjectURL(rec.thumb);
    dt.src = dt.dataset.url;
  } else dt.removeAttribute("src");

  // Quality: each measure as a short meter of dots
  const precise = rec.frames.filter((f) => f.maskSource === "precise").length;
  const meters = st
    ? [
        ["Loop around", "every direction at the side", st.coverage],
        ["Views from above", "optional, improves the top", st.top ?? 0],
        ["Sharp views", "time without motion blur", st.sharp],
        ["Steady hands", "time without shake", st.steady],
        ["Good light", "time in usable light", st.light],
        [
          "Precise outlines",
          `${precise} of ${rec.frames.length} keyframes`,
          rec.frames.length ? precise / rec.frames.length : 0,
        ],
      ]
    : [
        [
          "Precise outlines",
          `${precise} of ${rec.frames.length} keyframes`,
          rec.frames.length ? precise / rec.frames.length : 0,
        ],
      ];
  state.meterValues = meters.map((m) => clamp(m[2], 0, 1));
  $("meters").replaceChildren(
    ...meters.map(([k, sub, v]) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.append(
        Object.assign(document.createElement("b"), { textContent: k }),
        Object.assign(document.createElement("small"), { textContent: sub }),
      );
      const dots = Object.assign(document.createElement("span"), { className: "meter-dots" }); // drawn with particles
      li.append(
        label,
        dots,
        Object.assign(document.createElement("span"), {
          className: "val",
          textContent: `${Math.round(clamp(v, 0, 1) * 100)}%`,
        }),
      );
      return li;
    }),
  );
  const tips = hasScore
    ? [...rec.tips]
    : [{ text: "This scan stopped before it finished, but every frame it captured is saved and can be shared." }];
  if (rec.heightM == null)
    tips.push({
      text: "Add the real height on the Overview tab so the 3D model comes out at true size.",
      cls: "height-tip",
    });
  $("tips").replaceChildren(
    ...tips.map((t) => {
      const li = document.createElement("li");
      if (t.good) li.className = "good";
      if (t.cls) li.classList.add(t.cls);
      li.textContent = t.text;
      return li;
    }),
  );

  // Export: what's in the zip
  $("zipName").textContent = `${slug(rec.name)}.zip`;
  $("zipSize").textContent = "Calculating size";
  const masks = rec.frames.filter((f) => f.mask).length;
  const res = rec.imageSize ? `${Math.max(...rec.imageSize)} px` : "";
  $("zipContents").replaceChildren(
    ...[
      [`${rec.frames.length} keyframes`, res],
      [`${masks} object outlines`, precise ? `${precise} precise` : ""],
      ["3D preview", rec.cloud ? `${rec.cloud.n.toLocaleString()} points, PLY` : "not available"],
      ["Scan details", "angles, coverage, height"],
    ].map(([a, b]) => {
      const li = document.createElement("li");
      li.append(
        Object.assign(document.createElement("span"), { textContent: a }),
        Object.assign(document.createElement("span"), { textContent: b }),
      );
      return li;
    }),
  );
  store
    .getFiles(rec.id)
    .then((files) => {
      if (state.reviewing !== rec) return;
      const bytes = files.reduce((n, f) => n + (f.blob?.size || 0), 0);
      $("zipSize").textContent = bytes
        ? `About ${(bytes / 1e6).toFixed(bytes > 1e7 ? 0 : 1)} MB`
        : "Size shown when packed";
    })
    .catch(() => {});

  showHeight(rec.heightM);
  const canResume = live && state.scan && state.scan.id === rec.id && state.stream;
  const loopDone = canResume && targetBand(state.scan.coverage) === -1;
  $("fillBtn").hidden = !canResume || (loopDone && topBonus(state.scan.coverage) >= 1);
  $("fillLabel").textContent = loopDone ? "Add top views" : "Fill gaps";
  resetShare();
  if (live) haptic(hasScore && rec.score >= 72 ? "ring" : "tap");
}

function summaryLine(rec) {
  if (rec.score == null) return "This scan stopped early. Its frames are saved.";
  const st = rec.stats || {};
  if (st.coverage >= 0.99 && (st.top ?? 0) >= 0.5) return "Every angle covered, from the side and above.";
  if (st.coverage >= 0.99) return "All the way around. Views from above would make it even better.";
  return `${Math.round(st.coverage * 100)}% of the way around. Fill the gaps for a complete model.`;
}

const TABS = ["overview", "quality", "export"];
export let currentTab = "overview";
function selectTab(name, feedback = true) {
  const from = TABS.indexOf(currentTab),
    to = TABS.indexOf(name);
  currentTab = name;
  state.tabAt = performance.now();
  document
    .querySelectorAll(".tabs [role=tab]")
    .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $("tabThumb").style.transform = `translateX(${to * 100}%)`;
  document.querySelectorAll(".pane").forEach((p) => {
    const on = p.id === `pane-${name}`;
    p.classList.toggle("from-left", on && to < from);
    p.classList.toggle("active", on);
  });
  if (feedback) {
    haptic("tick");
    click(0.5);
  }
}
document.querySelectorAll(".tabs [role=tab]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.tab !== currentTab) selectTab(b.dataset.tab);
  }),
);

// swipe between tabs
{
  let sx = 0,
    sy = 0,
    tracking = false;
  const panes = $("panes");
  panes.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input, button")) return;
    sx = e.clientX;
    sy = e.clientY;
    tracking = true;
  });
  panes.addEventListener("pointerup", (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx,
      dy = e.clientY - sy;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const i = TABS.indexOf(currentTab) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < TABS.length) selectTab(TABS[i]);
  });
  panes.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

function animateNumber(el, target) {
  if (target == null) {
    el.textContent = "–";
    return;
  }
  if (reduceMotion) {
    el.textContent = target;
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 1300);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(step);
  };
  setTimeout(() => requestAnimationFrame(step), 350);
}

function showHeight(m) {
  document.querySelectorAll(".mini-seg button").forEach((b) => b.classList.toggle("on", b.dataset.unit === unit));
  $("scanHeight").value = m == null ? "" : unit === "cm" ? +(m * 100).toFixed(1) : +(m / 0.0254).toFixed(1);
}

function closeReview({ resume = false } = {}) {
  $("review").classList.remove("open");
  state.reviewing = null;
  if (!resume) clearSelection(); // back in the camera, look for whatever it is pointed at now
  setPhase(state.stream ? "live" : "intro");
}

export function resetShare() {
  state.preparedZip = null;
  $("shareLabel").textContent = "Share scan";
  $("shareMeta").textContent = "";
  $("shareBtn").classList.remove("busy");
  $("shareBtn").disabled = false;
}

async function updateRecord(patch) {
  const rec = state.reviewing;
  if (!rec) return;
  Object.assign(rec, patch);
  if (state.scan && state.scan.id === rec.id) Object.assign(state.scan, patch);
  resetShare();
  await store.putScan(rec).catch(() => {});
}

$("scanName").addEventListener("change", (e) => updateRecord({ name: e.target.value.trim() || state.reviewing.name }));
$("scanName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});
$("scanHeight").addEventListener("change", (e) => {
  const v = parseFloat(e.target.value);
  updateRecord({ heightM: v > 0 ? (unit === "cm" ? v / 100 : v * 0.0254) : null });
  document.querySelector(".tips .height-tip")?.toggleAttribute("hidden", v > 0);
});
document.querySelectorAll(".mini-seg button").forEach((b) =>
  b.addEventListener("click", () => {
    unit = b.dataset.unit;
    try {
      localStorage.setItem("orbit.unit", unit);
    } catch {}
    showHeight(state.reviewing?.heightM ?? null);
    haptic("tap");
  }),
);

document.querySelectorAll("[data-close=review]").forEach((b) =>
  b.addEventListener("click", () => {
    haptic("tap");
    closeReview();
  }),
);
$("againBtn").addEventListener("click", () => {
  haptic("tap");
  state.scan = null;
  closeReview();
});
$("fillBtn").addEventListener("click", () => {
  haptic("tap");
  const top = state.scan && targetBand(state.scan.coverage) === -1;
  closeReview({ resume: true });
  beginScanning(true, top ? "top" : "loop");
  toast(top ? "Raise the phone and look down at it, then walk around." : "Walk to the gaps to fill them.", 3000);
});
$("deleteBtn").addEventListener("click", async () => {
  const rec = state.reviewing;
  if (!rec || !confirm(`Delete "${rec.name}" and all its frames? This can't be undone.`)) return;
  await store.deleteScan(rec.id);
  if (state.scan?.id === rec.id) state.scan = null;
  haptic("warn");
  closeReview();
  const scans = await refreshCount();
  setLastThumb(scans[0]);
  toast("Scan deleted.");
});

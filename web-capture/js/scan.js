// Scanning: coverage, keyframes, finishing, and the score.

import * as store from "./store.js";
import { BANDS, bandFill, bandFor, emptyCoverage, progressOf, sectorFor, targetBand, topBonus } from "./geometry.js";
import { guard, logError } from "./guard.js";
import { haptic } from "./haptics.js";
import { carveHull } from "./hull.js";
import { motion } from "./motion.js";
import { chime, click, say, unlockAudio } from "./sound.js";
import { maskToBlob } from "./vision.js";
import { LIGHT, MAX_FRAMES, MAX_VIEWS, SPIN_REV_SECONDS, VERSION } from "./config.js";
import { setStatus } from "./guidance.js";
import { refreshCount, setLastThumb } from "./library.js";
import { refineKeyframes } from "./precise.js";
import { openReview } from "./review.js";
import { sparks } from "./scenes/camera.js";
import { settings } from "./settings.js";
import { $, analyzer, frameCanvas, frameCtx, outliner, particles, refiner, state, video } from "./state.js";
import { setPhase, toast } from "./ui.js";
import { sleep, toBlob } from "./util.js";

// The band the scan is working on now (-1 when done). After the loop, "Add top views" targets the top.
export function goalBand(sc) {
  const tb = targetBand(sc.coverage);
  if (tb !== -1) return tb;
  if (sc.goal === "top" && bandFill(sc.coverage, 1) < BANDS[1].need) return 1;
  return -1;
}
function newScan() {
  state.scanCount++;
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: `Scan ${state.scanCount}`,
    createdAt: Date.now(),
    mode: state.mode,
    status: "capturing",
    coverage: emptyCoverage(),
    frames: [],
    bins: new Map(),
    binWait: new Map(),
    views: [],
    goal: "loop",
    heading0: null,
    spinAngle: 0,
    spinIdle: 0,
    lastAngle: null,
    elapsed: 0,
    ticks: 0,
    sharpTicks: 0,
    lightTicks: 0,
    steadyTicks: 0,
    ringsDone: BANDS.map(() => false),
    completeAt: 0,
    savedAt: 0,
    recorder: null,
    videoPart: 0,
    hasVideo: false,
    thumbBest: -1,
    thumbCanvas: null,
    thumb: null,
    heightM: null,
    imageSize: null,
    cloud: null,
  };
}

function recordOf(sc, result) {
  const res = result || sc.result;
  return {
    id: sc.id,
    version: VERSION,
    name: sc.name,
    createdAt: sc.createdAt,
    status: sc.status,
    mode: sc.mode,
    heightM: sc.heightM ?? null,
    imageSize: sc.imageSize,
    frames: sc.frames,
    coverage: sc.coverage.map((a) => Array.from(a)),
    score: res?.score ?? null,
    word: res?.word ?? null,
    tips: res?.tips ?? [],
    stats: res?.stats ?? null,
    thumb: sc.thumb,
    hasVideo: sc.hasVideo,
    cloud: sc.cloud,
  };
}

export function scanStep(st, dt, now) {
  const sc = state.scan;
  sc.elapsed += dt;
  sc.ticks++;
  const lightOK = st.lum > LIGHT.dark && st.lum < LIGHT.bright;
  const steady = motion.shake < 100 && motion.pace < 50;
  const sharpOK = st.sharp > Math.max(14, 0.55 * state.sharpEMA) && motion.shake < 130;
  if (lightOK) sc.lightTicks++;
  if (steady) sc.steadyTicks++;
  if (sharpOK) sc.sharpTicks++;
  // forgiving: a brief loss of the outline (someone walks past, a reflection) doesn't stop the scan
  const inFrame = !outliner.ready || state.locked || now - state.lastLockedAt < 1500;

  let angle;
  if (state.mode === "walk" && motion.available && motion.heading != null) {
    if (sc.heading0 == null) sc.heading0 = motion.heading;
    angle = (motion.heading - sc.heading0 + 360) % 360;
  } else {
    // turntable (or no motion sensors): advance while the object turns and the background holds still
    const good =
      state.mode === "spin"
        ? st.objMotion > 1.4 && st.objMotion < 30 && st.bgMotion < 7
        : st.bgMotion > 1.2 && st.bgMotion < 30;
    if (good && inFrame) {
      sc.spinAngle += (dt * 360) / SPIN_REV_SECONDS;
      sc.spinIdle = 0;
    } else sc.spinIdle += dt;
    angle = ((sc.spinAngle % 360) + 360) % 360;
  }
  const band = motion.available ? bandFor(motion.elev) : Math.max(0, targetBand(sc.coverage));
  sc.lastAngle = angle;

  if (inFrame && motion.shake < 220) {
    const s = sectorFor(band, angle);
    if (!sc.coverage[band][s]) {
      sc.coverage[band][s] = 1;
      haptic("tick");
      click(band / 2);
      sparks(band);
      checkRings(sc, now);
    }
    // One keyframe per small slice of angle. Take the first good frame there, then swap in a clearly
    // sharper one if it comes along; if nothing sharp turns up within half a second, take the best we have.
    const step = settings.dense ? 4 : 7.5;
    const key = `${band}:${Math.floor(angle / step)}`;
    const bin = sc.bins.get(key);
    if (!state.kfBusy) {
      if (!bin) {
        const waited = (sc.binWait.get(key) || 0) + dt;
        sc.binWait.set(key, waited);
        if ((sharpOK || waited > 0.5) && sc.frames.length < MAX_FRAMES) captureKeyframe(sc, angle, band, st, null, key);
      } else if (st.sharp > bin.sharp * 1.35 && now - bin.at > 500 && sharpOK) {
        captureKeyframe(sc, angle, band, st, bin.idx, key);
      }
    }
  }

  const prog = progressOf(sc.coverage);
  $("pct").textContent = Math.round(prog * 100);
  $("meterArc").style.strokeDashoffset = 119.4 * (1 - prog);
  if (now - sc.savedAt > 4000) {
    sc.savedAt = now;
    store.putScan(recordOf(sc)).catch(() => {});
  }
}

function checkRings(sc, now) {
  BANDS.forEach((b, i) => {
    if (!sc.ringsDone[i] && bandFill(sc.coverage, i) >= b.need) {
      sc.ringsDone[i] = true;
      if (goalBand(sc) !== -1) {
        haptic("ring");
        chime("ring");
        sparks(i, 40);
      }
    }
  });
  if (goalBand(sc) === -1 && !sc.completeAt) {
    sc.completeAt = now;
    haptic("success");
    chime("success");
    for (let b = 0; b < BANDS.length; b++) sparks(b, 30);
    say(
      settings.autoFinish ? "Every angle is covered. Finishing." : "Every angle is covered. Tap the shutter to finish.",
      { force: true },
    );
    if (settings.autoFinish)
      setTimeout(() => {
        if (state.phase === "scanning" && state.scan === sc) finishScan();
      }, 1500);
  }
}

async function captureKeyframe(sc, angle, band, st, replaceIdx, key) {
  state.kfBusy = true;
  try {
    const vw = video.videoWidth,
      vh = video.videoHeight;
    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
      frameCanvas.width = vw;
      frameCanvas.height = vh;
    }
    frameCtx.drawImage(video, 0, 0, vw, vh);
    const obj = state.locked ? state.obj : null;
    const idx = replaceIdx ?? sc.frames.length;
    const name = `kf_${String(idx).padStart(3, "0")}.jpg`;
    const elev = motion.available ? motion.elev : 0;
    const meta = {
      file: `images/${name}`,
      mask: obj ? `masks/${name}.png` : null,
      t: +sc.elapsed.toFixed(2),
      azimuth: +angle.toFixed(1),
      elevation: +elev.toFixed(1),
      band,
      sharpness: Math.round(st.sharp),
      bbox: obj ? obj.boxN.map((v) => +v.toFixed(4)) : null,
      guides: obj ? obj.guides.map((g) => g.map((v) => +v.toFixed(4))) : null,
      maskSource: obj ? "live" : null,
    };
    sc.frames[idx] = meta;
    sc.bins.set(key, { idx, sharp: st.sharp, at: performance.now() });
    sc.imageSize = [vw, vh];
    // keep the outline and a small colour frame for the instant 3D preview
    if (
      obj &&
      obj.edges === 0 &&
      elev < 55 &&
      analyzer.rgba &&
      (sc.views.length < MAX_VIEWS || sc.views.some((v) => v.idx === idx))
    ) {
      // stored at the analysis size (the outline is downsampled to match the colour frame)
      const AW = analyzer.W,
        AH = analyzer.H,
        src = analyzer.rgba;
      const rgb = new Uint8Array(AW * AH * 3),
        lab = new Uint8Array(AW * AH);
      for (let p = 0, q = 0; p < rgb.length; p += 3, q += 4) {
        rgb[p] = src[q];
        rgb[p + 1] = src[q + 1];
        rgb[p + 2] = src[q + 2];
      }
      const sx = obj.W / AW,
        sy = obj.H / AH;
      for (let y = 0; y < AH; y++)
        for (let x = 0; x < AW; x++) lab[y * AW + x] = obj.lab[((y * sy) | 0) * obj.W + ((x * sx) | 0)];
      const b = obj.boxN;
      const view = {
        idx,
        lab,
        W: AW,
        H: AH,
        box: [b[0] * AW, b[1] * AH, b[2] * AW, b[3] * AH],
        azimuth: angle,
        elevation: elev,
        rgb,
      };
      const at = sc.views.findIndex((v) => v.idx === idx);
      if (at >= 0) sc.views[at] = view;
      else sc.views.push(view);
    }
    if (obj && (band === 0 || sc.thumbBest < 0) && st.sharp > sc.thumbBest) {
      sc.thumbBest = st.sharp;
      drawThumb(sc, obj.boxN);
    }
    particles.flash = replaceIdx == null ? 1 : 0.5;
    $("frames").textContent = `${sc.frames.length} frames`;
    const maskP = obj ? maskToBlob(obj) : null;
    const jpg = await toBlob(frameCanvas, "image/jpeg", 0.9);
    await store.putFile(sc.id, meta.file, jpg);
    if (maskP) await store.putFile(sc.id, meta.mask, await maskP);
  } catch (e) {
    console.warn("keyframe failed", e);
  } finally {
    state.kfBusy = false;
  }
}

function drawThumb(sc, box) {
  const t =
    sc.thumbCanvas || (sc.thumbCanvas = Object.assign(document.createElement("canvas"), { width: 360, height: 360 }));
  const vw = frameCanvas.width,
    vh = frameCanvas.height;
  const bw = (box[2] - box[0]) * vw,
    bh = (box[3] - box[1]) * vh;
  const s = Math.min(vw, vh, Math.max(bw, bh) * 1.4);
  const cx = ((box[0] + box[2]) / 2) * vw,
    cy = ((box[1] + box[3]) / 2) * vh;
  const sx = Math.min(vw - s, Math.max(0, cx - s / 2)),
    sy = Math.min(vh - s, Math.max(0, cy - s / 2));
  t.getContext("2d").drawImage(frameCanvas, sx, sy, s, s, 0, 0, 360, 360);
}

function startVideo(sc) {
  if (!window.MediaRecorder || !settings.video) return;
  const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  try {
    const rec = new MediaRecorder(state.stream, { ...(type && { mimeType: type }), videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start(1000);
    sc.recorder = { rec, chunks };
  } catch (e) {
    console.warn("video recording unavailable", e);
  }
}

function stopVideo(sc) {
  const r = sc.recorder;
  sc.recorder = null;
  if (!r) return Promise.resolve();
  return new Promise((resolve) => {
    r.rec.onstop = async () => {
      const blob = new Blob(r.chunks, { type: r.rec.mimeType || "video/mp4" });
      const ext = blob.type.includes("webm") ? "webm" : "mp4";
      sc.videoPart++;
      try {
        await store.putFile(sc.id, sc.videoPart > 1 ? `video_${sc.videoPart}.${ext}` : `video.${ext}`, blob);
        sc.hasVideo = true;
      } catch {}
      resolve();
    };
    r.rec.stop();
  });
}

$("shutter").addEventListener("click", () => {
  if (state.phase === "live") {
    unlockAudio();
    if (!state.locked && !outliner.failed) {
      haptic("warn");
      toast("Point the camera at the object you want to scan first.");
      return;
    }
    beginScanning(false);
  } else if (state.phase === "scanning") finishScan();
  else if (state.phase === "saving" && state.refiningKeyframes) {
    state.skipRefine = true;
    haptic("tap");
  }
});

export function beginScanning(resume, goal = "loop") {
  if (!resume || !state.scan) state.scan = newScan();
  const sc = state.scan;
  sc.mode = state.mode;
  sc.status = "capturing";
  sc.goal = goal;
  sc.completeAt = 0;
  setPhase("scanning");
  haptic("go");
  chime("start");
  const prog = progressOf(sc.coverage);
  $("frames").textContent = `${sc.frames.length} frames`;
  $("pct").textContent = Math.round(prog * 100);
  $("meterArc").style.strokeDashoffset = 119.4 * (1 - prog);
  startVideo(sc);
  store.putScan(recordOf(sc)).catch(() => {});
  guard.begin("scan"); // cleared when the scan has been finished and saved
}

export async function finishScan(reason = "done") {
  const sc = state.scan;
  if (!sc || state.phase !== "scanning") return;
  setPhase("saving");
  haptic("tap");
  chime("stop");
  for (let i = 0; i < 20 && state.kfBusy; i++) await sleep(50);
  await stopVideo(sc);
  if (!sc.frames.length) {
    await store.deleteScan(sc.id).catch(() => {});
    state.scan = null;
    state.scanCount--;
    guard.end("scan");
    setPhase("live");
    toast("No sharp views were captured. Keep the object in view and move slowly.", 4200);
    return;
  }
  sc.status = reason === "interrupted" ? "interrupted" : "complete";
  sc.result = scoreScan(sc);
  if (reason !== "interrupted") {
    if (refiner.ready && settings.precise) await refineKeyframes(sc);
    setStatus("Building the 3D preview", "info");
    guard.begin("hull");
    try {
      sc.cloud = await carveHull(sc.views);
    } catch (e) {
      console.warn("preview failed", e);
      logError("hull", e);
      sc.cloud = null;
    }
    guard.end("hull");
  }
  if (sc.thumbCanvas) sc.thumb = await toBlob(sc.thumbCanvas, "image/jpeg", 0.86);
  const rec = recordOf(sc, sc.result);
  await store.putScan(rec).catch((e) => toast(`Couldn't save the scan: ${e?.message || e}`, 5000));
  setLastThumb(rec);
  refreshCount();
  guard.end("scan");
  if (reason === "interrupted") {
    setPhase("live");
    return;
  }
  openReview(rec, { live: true });
}

function scoreScan(sc) {
  const t = Math.max(1, sc.ticks);
  const cov = progressOf(sc.coverage);
  const sharp = sc.sharpTicks / t,
    light = sc.lightTicks / t,
    steady = sc.steadyTicks / t;
  const n = sc.frames.length;
  const top = topBonus(sc.coverage);
  const score = Math.round(
    100 * (0.55 * cov + 0.1 * top + 0.15 * sharp + 0.07 * light + 0.05 * steady + 0.08 * Math.min(1, n / 45)),
  );
  const word = score >= 88 ? "Excellent" : score >= 72 ? "Good" : score >= 55 ? "Usable" : "Needs another pass";
  const f = BANDS.map((_, i) => bandFill(sc.coverage, i));
  const walk = sc.mode === "walk";
  const tips = [];
  if (f[0] < BANDS[0].need)
    tips.push(
      walk
        ? "The loop has gaps. Fill gaps picks up where you stopped."
        : "The turn has gaps. Fill gaps lets you finish it.",
    );
  else if (top < 1) tips.push("For the best model, add a few views from above. It takes about ten seconds.");
  if (sharp < 0.75) tips.push("Many views were soft. Move slower, or find brighter light.");
  if (light < 0.8) tips.push("The light was too dim or too harsh for part of the scan.");
  if (n < 30) tips.push(`Only ${n} frames were kept. A slower loop gives the 3D step more to work with.`);
  return {
    score,
    word,
    tips: tips.length
      ? tips.map((text) => ({ text }))
      : [{ text: "Every angle is covered and sharp. This one is ready for 3D.", good: true }],
    stats: {
      coverage: +cov.toFixed(3),
      top: +top.toFixed(3),
      sharp: +sharp.toFixed(3),
      light: +light.toFixed(3),
      steady: +steady.toFixed(3),
      frames: n,
      seconds: +sc.elapsed.toFixed(1),
    },
  };
}

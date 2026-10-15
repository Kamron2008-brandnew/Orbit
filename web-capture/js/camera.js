// The camera stream, the Open camera button, mode and light controls.

import * as store from "./store.js";
import { haptic } from "./haptics.js";
import { requestMotion } from "./motion.js";
import { chime, click, unlockAudio } from "./sound.js";
import { TICK_MS } from "./config.js";
import { loadModels } from "./models.js";
import { settings } from "./settings.js";
import { $, body, particles, state, video } from "./state.js";
import { analyzeTick } from "./tick.js";
import { setPhase, toast } from "./ui.js";
import { sleep } from "./util.js";

async function startStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // the more pixels each keyframe has, the finer the final model's detail and texture
    video: settings.maxDetail
      ? {
          facingMode: { ideal: "environment" },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
        }
      : {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
  });
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play();
  const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
  $("torchBtn").hidden = !caps.torch;
  state.torch = false;
  $("torchBtn").classList.remove("on");
}

function cameraError(e) {
  if (!window.isSecureContext) return "The camera only works over a secure https link.";
  if (e?.name === "NotAllowedError")
    return "Camera access is blocked. In Settings, open Safari, set Camera to Allow, then reload this page.";
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError")
    return "No usable camera was found on this device.";
  return `The camera didn't start (${e?.message || e}).`;
}

export async function keepAwake() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
export async function recoverCamera() {
  try {
    await startStream();
  } catch (e) {
    toast(cameraError(e), 5000);
  }
}

$("openCam").addEventListener("click", async () => {
  $("introErr").textContent = "";
  unlockAudio();
  haptic("tap");
  const motionP = requestMotion().then(
    () => true,
    () => false,
  ); // must start inside the tap on iOS
  if (!navigator.mediaDevices?.getUserMedia) {
    $("introErr").textContent = window.isSecureContext
      ? "This browser can't use the camera. Open the link in Safari."
      : cameraError();
    return;
  }
  $("openCam").disabled = true;
  $("openCam").classList.add("busy");
  try {
    await startStream();
  } catch (e) {
    $("introErr").textContent = cameraError(e);
    $("openCam").disabled = false;
    $("openCam").classList.remove("busy");
    return;
  }
  const motionOK = await Promise.race([motionP, sleep(8000).then(() => false)]);
  const r = $("introAnchor").getBoundingClientRect();
  particles.burst(r.left + r.width / 2, r.top + r.height / 2, 760); // the sample object scatters into the room
  $("intro").classList.remove("open");
  setPhase("live");
  placeSegThumb();
  chime("start");
  haptic("go");
  keepAwake();
  store.persist();
  if (!motionOK) toast("Motion access is off, so walk-around coverage is estimated.", 5200);
  loadModels();
  setInterval(analyzeTick, TICK_MS);
});

function placeSegThumb() {
  const b = document.querySelector('.segmented button[aria-checked="true"]');
  const th = $("segThumb");
  th.style.left = `${b.offsetLeft}px`;
  th.style.width = `${b.offsetWidth}px`;
}
window.addEventListener("resize", placeSegThumb);
placeSegThumb();

document.querySelectorAll(".segmented button").forEach((b) =>
  b.addEventListener("click", () => {
    if (state.phase !== "live") return;
    state.mode = b.dataset.mode;
    body.dataset.mode = state.mode;
    document.querySelectorAll(".segmented button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    placeSegThumb();
    haptic("tap");
    click(0.4);
    toast(
      state.mode === "walk"
        ? "Walk slowly around the object with the phone."
        : "Rest the phone on something steady and turn the object.",
      2800,
    );
  }),
);

$("torchBtn").addEventListener("click", async () => {
  state.torch = !state.torch;
  try {
    await state.track.applyConstraints({ advanced: [{ torch: state.torch }] });
  } catch {
    state.torch = false;
    toast("The light isn't available right now.");
  }
  $("torchBtn").classList.toggle("on", state.torch);
  haptic("tap");
});

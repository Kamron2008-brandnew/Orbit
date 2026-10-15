// Phone orientation -> where the back camera points.
// heading: degrees clockwise around the vertical axis (relative; iOS alpha has an arbitrary zero, which is fine
//          because we only care how far you have gone around the object).
// elev:    degrees the camera looks below the horizon (0 = level, 90 = straight down).
// pace:    smoothed |d heading / dt| in deg/s.  shake: device rotation rate in deg/s.
// roll:    side-to-side tilt in degrees (for keeping the horizon line level).

export const motion = { available: false, heading: null, elev: 0, roll: 0, pace: 0, shake: 0, updatedAt: 0 };

const RAD = Math.PI / 180;
let lastHeading = null;
let lastT = 0;

function angDiff(a, b) { return ((a - b + 540) % 360) - 180; }

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const a = e.alpha * RAD, b = e.beta * RAD, g = e.gamma * RAD;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  // Device -Z axis (out of the back camera) in Earth frame (x east, y north, z up), from R = Rz(a)Rx(b)Ry(g).
  const x = -(cG * sA * sB + cA * sG);
  const y = -(sA * sG - cA * cG * sB);
  const z = -cB * cG;
  const elev = Math.asin(Math.max(-1, Math.min(1, -z))) / RAD;
  motion.elev = elev;
  motion.roll = motion.roll * 0.7 + Math.max(-35, Math.min(35, e.gamma)) * 0.3;
  motion.available = true;
  const t = performance.now();
  // Heading is undefined when looking straight down; hold the last value.
  if (Math.hypot(x, y) > 0.12) {
    const h = (Math.atan2(x, y) / RAD + 360) % 360;
    if (lastHeading != null && t > lastT) {
      const rate = Math.abs(angDiff(h, lastHeading)) / ((t - lastT) / 1000);
      if (rate < 720) motion.pace = motion.pace * 0.85 + rate * 0.15;
    }
    lastHeading = h;
    motion.heading = h;
  }
  lastT = t;
  motion.updatedAt = t;
}

function onMotion(e) {
  const r = e.rotationRate;
  if (!r) return;
  const mag = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
  motion.shake = motion.shake * 0.8 + mag * 0.2;
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener("deviceorientation", onOrientation);
  window.addEventListener("devicemotion", onMotion);
}

// Call synchronously from a tap: iOS only shows the permission prompt inside a user gesture.
export function requestMotion() {
  const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
  const asks = [];
  if (DOE && typeof DOE.requestPermission === "function") asks.push(DOE.requestPermission());
  if (DME && typeof DME.requestPermission === "function") asks.push(DME.requestPermission());
  // Listen if anything was granted: orientation alone is enough for coverage; motion only adds shake detection.
  return Promise.allSettled(asks).then(results => {
    const granted = results.filter(r => r.status === "fulfilled" && r.value === "granted").length;
    if (asks.length && !granted) throw new Error("motion-denied");
    listen();
  });
}

export function angleDiff(a, b) { return angDiff(a, b); }

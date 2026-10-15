// Haptics.
// Android/Chrome: the Vibration API. iOS Safari has no Vibration API, but since iOS 17.4/18 toggling an
// <input type="checkbox" switch> plays the system switch "tick", so we click a throwaway one.
// Whether iOS plays it outside a direct tap (e.g. from a timer) is not guaranteed; taps always work.

const canVibrate = typeof navigator.vibrate === "function";
let enabled = true;
let lastTick = 0;

export function setHaptics(on) {
  enabled = !!on;
}

function iosTick() {
  try {
    const label = document.createElement("label");
    label.ariaHidden = "true";
    label.style.display = "none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch {
    /* unsupported: stay silent */
  }
}

// Offsets (ms) of each tick for iOS, and equivalent vibrate() patterns for Android.
const PATTERNS = {
  tick: { ios: [0], vib: [8] },
  tap: { ios: [0], vib: [12] },
  lock: { ios: [0, 90], vib: [14, 70, 14] },
  count: { ios: [0], vib: [18] },
  go: { ios: [0, 70], vib: [30, 50, 30] },
  ring: { ios: [0, 80, 160], vib: [16, 60, 16, 60, 30] },
  warn: { ios: [0, 60, 120], vib: [40, 40, 40] },
  success: { ios: [0, 90, 180, 330], vib: [16, 70, 16, 70, 16, 140, 60] },
};

export function haptic(kind = "tick") {
  if (!enabled) return;
  const now = performance.now();
  if (kind === "tick") {
    if (now - lastTick < 55) return; // keep rapid ticks crisp instead of a buzz
    lastTick = now;
  }
  const p = PATTERNS[kind] || PATTERNS.tick;
  if (canVibrate) {
    try {
      navigator.vibrate(p.vib);
    } catch {}
    return;
  }
  for (const delay of p.ios) delay ? setTimeout(iosTick, delay) : iosTick();
}

// Synthesized UI sounds (no audio files) and optional spoken guidance.

let ctx = null;
let master = null;
let soundOn = true;
let voiceOn = false;
let lastSpoken = { text: "", at: 0 };

export function configureSound({ sound, voice }) {
  soundOn = !!sound;
  voiceOn = !!voice;
  if (!voiceOn && "speechSynthesis" in window) speechSynthesis.cancel();
}

// Must run inside a user gesture on iOS.
export function unlockAudio() {
  try {
    // "ambient" mixes with music and respects the ring/silent switch (Safari 17+).
    if (navigator.audioSession) navigator.audioSession.type = "ambient";
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    // iOS unlocks speech only after an utterance inside a gesture.
    if ("speechSynthesis" in window && voiceOn) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  } catch {}
}

function ready() {
  return soundOn && ctx && ctx.state === "running";
}

// A short filtered noise burst: sounds like a watch bezel click.
export function click(bright = 1) {
  if (!ready()) return;
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * 0.018);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 2600 + 1400 * bright;
  bp.Q.value = 3.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22, t);
  src.connect(bp).connect(g).connect(master);
  src.start(t);
}

function tone(freq, start, dur, vol = 0.07, type = "sine") {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(master);
  o.start(start);
  o.stop(start + dur + 0.05);
}

export function chime(kind) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.01;
  const seq = {
    lock: [[1318.5, 0, 0.18]],
    ring: [
      [987.8, 0, 0.5],
      [1480, 0.09, 0.6],
    ],
    success: [
      [784, 0, 0.7],
      [987.8, 0.1, 0.7],
      [1318.5, 0.2, 0.8],
      [1975.5, 0.32, 1.0],
    ],
    warn: [
      [392, 0, 0.22],
      [329.6, 0.11, 0.3],
    ],
    start: [
      [659.3, 0, 0.25],
      [1318.5, 0.06, 0.35],
    ],
    stop: [
      [1318.5, 0, 0.2],
      [659.3, 0.07, 0.35],
    ],
  }[kind];
  if (!seq) return;
  for (const [f, at, dur] of seq)
    tone(f, t + at, dur, kind === "warn" ? 0.05 : 0.065, kind === "warn" ? "triangle" : "sine");
}

export function say(text, { force = false } = {}) {
  if (!voiceOn || !("speechSynthesis" in window) || !text) return;
  const now = performance.now();
  if (!force && text === lastSpoken.text && now - lastSpoken.at < 8000) return;
  lastSpoken = { text, at: now };
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.04;
  u.pitch = 1;
  speechSynthesis.speak(u);
}

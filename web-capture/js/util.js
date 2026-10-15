// Small pure helpers.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toBlob = (c, type, q) => new Promise((r) => c.toBlob(r, type, q));
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const slug = (s) =>
  (s || "scan")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "scan";
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const fract = (x) => x - Math.floor(x);

export const when = (ts) =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export function shortWhen(ts) {
  const d = new Date(ts),
    now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const hash = (k) => fract(Math.sin(k * 12.9898 + 78.233) * 43758.5453);

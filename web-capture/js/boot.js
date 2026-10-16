// For a page that dies in its first seconds, when nothing else gets a chance to say why. While the page is up
// it notes how far it has got; if the last run did not survive, the next one shows that on screen.

const KEY = "orbit.boot";
const SURVIVED_MS = 10000;

export const boot = { frames: 0 };

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
};
const write = (value) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: no trace */
  }
};

const previous = read();
const started = Date.now();
let ok = false;
const save = () => write({ lasted: Date.now() - started, frames: boot.frames, ok, flags: location.search });
save();
const timer = setInterval(() => {
  if (Date.now() - started > SURVIVED_MS) {
    ok = true;
    clearInterval(timer);
  }
  save();
}, 250);
// leaving on purpose is not a crash
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    ok = true;
    save();
  }
});
addEventListener("pagehide", () => {
  ok = true;
  save();
});

if (previous && !previous.ok) {
  const show = () => {
    const note = document.createElement("div");
    note.style.cssText =
      "position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 8px);z-index:9999;padding:12px 14px;" +
      "border-radius:12px;background:rgba(40,40,44,.95);color:#fff;font:13px/1.4 -apple-system,sans-serif";
    const secs = (previous.lasted / 1000).toFixed(1);
    note.textContent = `The last start ended after ${secs}s, ${previous.frames} frames drawn${previous.flags ? ` (${previous.flags})` : ""}. Tap to hide.`;
    note.addEventListener("click", () => note.remove());
    document.body.append(note);
  };
  if (document.body) show();
  else addEventListener("DOMContentLoaded", show);
}

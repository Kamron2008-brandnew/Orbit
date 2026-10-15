// Crash guard. When iOS kills a page for using too much memory, nothing runs afterwards, so the page can't say
// what went wrong. Instead, before each risky step we leave a marker; if the marker is still there on the next
// start, the page died during that step. A step that died is not repeated the same way: the app steps down to
// something lighter (CPU instead of GPU, no precise outlines, standard detail) and says so.
//
// A marker is cleared when the page is hidden or closed on purpose (user switches app, closes the tab), so
// only a death while the page was on screen counts.

const KEY = "orbit.guard";
const ERR_KEY = "orbit.errors";

const read = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: run without the guard */ } };

const state = read(KEY) || { pending: {}, strikes: {}, last: null };
state.pending ||= {}; state.strikes ||= {};

// Whatever was still pending at startup is what the previous run died in.
const crashed = Object.keys(state.pending);
for (const name of crashed) {
  state.strikes[name] = (state.strikes[name] || 0) + 1;
  state.last = { name, at: Date.now(), ua: navigator.userAgent.slice(0, 120) };
}
state.pending = {};
write(KEY, state);

const save = () => write(KEY, state);

export const guard = {
  crashed,                                 // names of the steps the last run died in (empty after a clean run)
  strikes: state.strikes,
  get last() { return state.last; },
  // Mark a step as in progress. Always pair with end().
  begin(name) { state.pending[name] = Date.now(); save(); },
  end(name) { delete state.pending[name]; save(); },
  // Forget earlier deaths of a step (the user turned a feature back on).
  forgive(name) { delete state.strikes[name]; save(); },
  struck(name, n = 1) { return (state.strikes[name] || 0) >= n; },
};

// A step left on purpose (app switched away, tab closed) is not a crash.
const clearAll = () => { if (Object.keys(state.pending).length) { state.pending = {}; save(); } };
document.addEventListener("visibilitychange", () => { if (document.hidden) clearAll(); });
addEventListener("pagehide", clearAll);

/* ---------- error log ---------- */
// The last few errors with when and where they happened, kept for the diagnostics report.
const errors = read(ERR_KEY) || [];
let phaseOf = () => "";
export const setPhaseReader = fn => { phaseOf = fn; };

export function logError(kind, err) {
  const msg = String(err?.message || err || "unknown").slice(0, 200);
  const prev = errors[errors.length - 1];
  if (prev && prev.msg === msg && prev.kind === kind) { prev.n = (prev.n || 1) + 1; prev.at = Date.now(); }
  else errors.push({ kind, msg, at: Date.now(), phase: phaseOf(), stack: String(err?.stack || "").split("\n").slice(0, 3).join(" | ").slice(0, 300) });
  while (errors.length > 12) errors.shift();
  write(ERR_KEY, errors);
}

addEventListener("error", e => logError("error", e.error || e.message));
addEventListener("unhandledrejection", e => logError("rejection", e.reason));

export function report(extra = {}) {
  return JSON.stringify({
    when: new Date().toISOString(),
    ua: navigator.userAgent,
    screen: [screen.width, screen.height, devicePixelRatio],
    webgpu: !!navigator.gpu,
    isolated: !!self.crossOriginIsolated,
    cores: navigator.hardwareConcurrency,
    memoryGB: navigator.deviceMemory ?? null,
    strikes: state.strikes,
    lastDeath: state.last,
    errors,
    ...extra,
  }, null, 2);
}

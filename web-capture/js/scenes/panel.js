// Library and settings: quiet particles behind the page.

import { project } from "../particles.js";
import { COUNT, INTRO_N } from "../config.js";
import { SHAPES } from "./intro.js";
import { dust } from "./palette.js";
import { $, particles, state } from "../state.js";
import { clamp } from "../util.js";

// Library and settings: the particles drift quietly behind; an empty library shows a small turning vase.
export function formPanel(now) {
  let i = 0;
  const ea = state.panel === "library" ? $("emptyAnchor").getBoundingClientRect() : null;
  if (ea && ea.width) {
    const sh = SHAPES[0],
      [lo, hi] = sh.palette,
      o = [0, 0, 0],
      n = 800,
      step = Math.floor(INTRO_N / n);
    for (let k = 0; k < n; k++, i++) {
      const p = k * step,
        x = sh.pts[3 * p],
        y = sh.pts[3 * p + 1],
        z = sh.pts[3 * p + 2];
      project(x, y, z, (now / 1000) * 0.5, 0.3, ea.left + ea.width / 2, ea.top + ea.height / 2, ea.height * 0.42, o);
      const d = clamp((o[2] + 0.8) / 1.6, 0, 1),
        h = (y + 1) / 2,
        lum = 0.6 + 0.4 * d;
      particles.attract(
        i,
        o[0],
        o[1],
        0.9 + 1.4 * d,
        (lo[0] + (hi[0] - lo[0]) * h) * lum,
        (lo[1] + (hi[1] - lo[1]) * h) * lum,
        (lo[2] + (hi[2] - lo[2]) * h) * lum,
        0.3 + 0.65 * d,
      );
    }
  }
  for (; i < COUNT; i++) dust(i, 0.7);
}

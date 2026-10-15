// The colours the particles glow in, and idle particles.

import { VISIBLE_DUST_END } from "../config.js";
import { particles } from "../state.js";
import { fract } from "../util.js";

// The ambient palette the particles glow in: ice cyan, periwinkle, violet, rose, and round again.
const AMB = [
  [0.56, 0.89, 1],
  [0.62, 0.74, 1],
  [0.76, 0.63, 1],
  [1, 0.66, 0.84],
  [0.56, 0.89, 1],
];
const ambC = [0, 0, 0];
export function paletteAt(f, out = ambC) {
  const u = fract(f) * 4,
    k = Math.floor(u),
    w = u - k,
    a = AMB[k],
    b = AMB[k + 1];
  out[0] = a[0] + (b[0] - a[0]) * w;
  out[1] = a[1] + (b[1] - a[1]) * w;
  out[2] = a[2] + (b[2] - a[2]) * w;
  return out;
}

export function dust(i, dim = 1) {
  const s = particles.seed[i],
    s2 = particles.seed2[i];
  const c = paletteAt(s2 * 0.75); // each mote has its own tint from the ambient palette
  particles.free(
    i,
    1 + s * 1.7,
    0.35 + 0.65 * c[0],
    0.35 + 0.65 * c[1],
    0.35 + 0.65 * c[2],
    i < VISIBLE_DUST_END ? (0.08 + s2 * 0.2) * dim : 0,
  );
}

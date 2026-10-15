// Coverage layout. One loop around the object is all that's required: any height from level to about
// 50 degrees looking down counts. Views from above are an optional bonus that improves the model.
export const BANDS = [
  { label: "around", sectors: 24, elevMin: -30, elevMax: 50, need: 0.92 },
  { label: "top", sectors: 12, elevMin: 50, elevMax: 90, need: 0.5, optional: true },
];

export const bandFor = elev => (elev < 50 ? 0 : 1);
export const sectorFor = (band, angle) => Math.floor(((((angle % 360) + 360) % 360) / 360) * BANDS[band].sectors) % BANDS[band].sectors;

export const emptyCoverage = () => BANDS.map(b => new Uint8Array(b.sectors));

export function bandFill(cov, b) {
  let n = 0;
  for (const v of cov[b]) n += v;
  return n / cov[b].length;
}

// Progress toward a complete scan: the loop around the object.
export const progressOf = cov => Math.min(1, bandFill(cov, 0) / BANDS[0].need);

// The band still needed (-1 when the scan is complete). Optional bands never block completion.
export function targetBand(cov) {
  for (let i = 0; i < BANDS.length; i++) if (!BANDS[i].optional && bandFill(cov, i) < BANDS[i].need) return i;
  return -1;
}

export const topBonus = cov => Math.min(1, bandFill(cov, 1) / BANDS[1].need);

// Numbers the app is tuned with, in one place.

export const VERSION = "4.0";
export const MAX_FRAMES = 220;
export const MAX_VIEWS = 96; // silhouettes kept in memory for the 3D preview
export const SPIN_REV_SECONDS = 26; // turntable: seconds of steady turning counted as one revolution
export const LIGHT = { dark: 48, bright: 224 };
export const TICK_MS = 85;

// particle budget
export const COUNT = 7200;
export const VISIBLE_DUST_END = 2600; // particles past this are a reserve: hidden until the dense 3D model needs them
export const EDGE = [0, 600]; // outline of the object
export const FILL = [600, 1500]; // body of the object
export const RING = [1500, 2000]; // coverage rings
export const SEEK = [2000, 2160]; // searching reticle
export const RING_COUNTS = [300, 140];
export const RING_LAT = [8, 58]; // degrees: the loop around, the optional top pass
export const SHAPE_SECONDS = 4.6; // intro: how long each shape holds before the next is scanned in
export const MORPH_SECONDS = 1.9; // intro: the scanning ring's pass, top to bottom
export const INTRO_N = 2400; // intro: points in each gallery shape
export const INTRO_FLOOR = [2400, 2700]; // intro: the turntable ring under the shape
export const INTRO_SCAN = [2700, 2900]; // intro: the scanning ring, resting in the floor ring between passes
export const INTRO_STARS = [2900, 4300]; // intro: the starfield, at three depths

// Review layout of the particle budget: the 3D preview, its coverage rings, then a pool the info sheet is
// drawn with (score ring, coverage dial, quality meters, the mini model on the file card).
export const REVIEW_CLOUD = 6000;
export const REVIEW_RINGS = [6000, 6440];
export const REVIEW_UI = [6440, 6960];

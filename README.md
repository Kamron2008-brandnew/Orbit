# Orbit

Scan a real object into 3D with a phone. Orbit is a web app that runs in Safari and captures the object, and a
pipeline that turns the capture into a textured model. See [PLAN.md](PLAN.md) for the original plan.

| Folder | What it is |
| --- | --- |
| `web-capture/` | The capture app: HTML, CSS and plain ES modules, no build step. |
| `pipeline/` | Python and shell scripts that turn a capture (or a LiDAR scan from another app) into a model. |
| `ios-prototype/` | A native LiDAR prototype. Never built: it needs Xcode 26. |
| `tests/` | Unit tests for the parts of the app that don't need a browser. |

## The capture app

Open it on the phone and point the camera at an object. It finds and outlines the object by itself. Tap the
shutter (recording never starts on its own) and walk once around it. The app keeps the sharpest photo for every
7.5 degrees, at 4K where the camera allows, each with the object's outline. When the loop is complete it builds a
3D preview and shows a score, and the scan can be shared as a zip.

### How it works

- **Finding the object** (`tracking.js`, `vision.js`). A few points around the middle of the view are tried in
  turn with MediaPipe's interactive segmenter. A guess is kept only if it is one plausible object: not most of
  the frame, near the middle, and with its outline on a real colour edge nearly all the way round.
- **Precise outlines** (`precise.js`, `refine.js`). EdgeTAM, an on-device Segment Anything 2, re-outlines the
  object from a snug box plus a few points: once when it is found, now and then while scanning, and on every
  keyframe from the full-resolution photo afterwards. It needs WebGPU.
- **Coverage and keyframes** (`scan.js`, `geometry.js`). Walking is followed with the phone's compass, a
  turntable by how the picture moves. The loop around the object is split into 24 sectors, 92% of which must be
  covered; views from above are an optional extra.
- **3D preview** (`hull.js`). The outlines from every angle carve a block of voxels down to the object's shape
  (a visual hull), and the surface becomes a 6,000-point coloured cloud.
- **Look** (`particles.js`, `scenes/`). Everything on screen that isn't text is one WebGL particle system: the
  intro, the object's outline, the coverage rings and the result screen.
- **Staying alive** (`guard.js`). iOS kills a page that uses too much memory without a word, so before each heavy
  step the app leaves a marker. A marker still there on the next start means the page died in that step, and the
  app steps down (CPU instead of GPU, no precise outlines, standard detail) and says so. Settings, under
  Stability, shows this and has "Copy diagnostics".

### Layout of `web-capture/js/`

| Module | Responsibility |
| --- | --- |
| `main.js` | Entry point: the frame loop and the page lifecycle. |
| `state.js`, `settings.js`, `config.js`, `ui.js`, `util.js` | Shared state, saved settings, tuning numbers, toasts and phases, small helpers. |
| `camera.js`, `models.js`, `tick.js` | The camera stream, loading the two models, the analysis loop. |
| `tracking.js`, `precise.js`, `scan.js`, `guidance.js` | Following the object, precise outlines, scanning, what the status line says. |
| `review.js`, `share.js`, `library.js` | The result screen, packing and sharing the zip, the scan library and settings page. |
| `scenes/` | How each screen is drawn with particles. |
| `vision.js`, `hull.js`, `geometry.js`, `zip.js`, `store.js`, `particles.js` | Image analysis, the visual hull, coverage maths, the zip writer, IndexedDB, the particle system. |
| `guard.js`, `motion.js`, `haptics.js`, `sound.js`, `refine.js` | Crash markers and the error log, phone sensors, haptics, sounds, the EdgeTAM wrapper. |

### Running it

The camera needs HTTPS, so it is hosted on Netlify: drag the `web-capture` folder onto the site's Deploys page,
then fully reopen the tab in Safari. To try it on a computer:

```bash
npm run serve        # http://localhost:8790
```

### Checks

```bash
npm install
npm test             # unit tests
npm run lint
npm run format       # Prettier
```

### What has and hasn't been tested

Tested in desktop Chrome with a synthetic camera: the full scan, review, share, library, delete and fill-gaps
flows, the crash recovery, and the precise outlines (0.996 IoU on a labelled test bottle). **Not yet tested on a
real iPhone**: real-object accuracy and speed, 4K capture, haptics, the share sheet. The unit tests cover the
outline finder, the visual hull, coverage, the zip writer, the particle maths and the crash guard.

## The pipeline

**High quality, photo-textured.** `colab_scanner.ipynb` on free Colab (a T4 GPU). Put Orbit zips in
`MyDrive/3d-scanner/scans/`, open the notebook and choose Runtime, then Run all. For each new scan it runs
`prepare_scan.py` (unpack, upscale the masks), `run_hq.sh` (COLMAP for camera positions, then OpenMVS for the dense
surface, mesh and texture) and `finish_model.py` (stand it upright from the camera orbit, crop to the object, cut
away the table, scale to the real height, write GLB, USDZ and OBJ). Models appear in
`MyDrive/3d-scanner/models/<name>/`. The first run builds COLMAP and OpenMVS, which takes about 40 minutes, and
caches them in Drive. **The notebook and `run_hq.sh` have not been run yet.** `finish_model.py` was tested on a
synthetic scene (tilted, shifted, with a floor and a stray fragment) and came out exactly 0.30 x 0.60 x 0.30 m,
upright, with the floor and fragment gone.

```bash
cd pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python prepare_scan.py my-object.zip workspace/                   # an Orbit zip, ready for COLMAP
.venv/bin/python clean_mesh.py scan.ply out --name chair --height 0.85      # clean any raw mesh
.venv/bin/python make_test_scan.py /tmp/test_scan.ply                       # a synthetic bad scan to try it on
```

**LiDAR scans from other apps.** To try the iPhone's LiDAR before building a native app, scan with Scaniverse or
Polycam, export the mesh as GLB (or OBJ, PLY), and run:

```bash
.venv/bin/python import_lidar.py scan.glb out --name mug
```

It works out which way is up, removes the floor or table the object stood on (and its legs, and a wall if one was
caught), keeps the piece in the middle together with loose parts of it (a handle, a lid), stands it at y = 0, and
writes `out/mug/mug.glb`, `.obj` and `.usdz` with the texture. LiDAR scans are already at real scale. Tested on
synthetic scans (a mug on a table beside a wall, y-up GLB and z-up PLY, and an object-only scan); not yet run on a
real export.

`blender_cleanup.py` is an alternative cleanup that also writes USDZ. It is untested.

Not done: texture baking, retopology, background removal.

## ios-prototype/

A SwiftUI and RealityKit app that shows the live LiDAR mesh and exports USDZ, OBJ, PLY or STL. It needs a LiDAR
device (iPhone 12 Pro or later), has never been built, and an iPhone on iOS 26 needs Xcode 26, which needs a newer
Mac than a 2017 MacBook.

```bash
brew install xcodegen
cd ios-prototype && xcodegen generate && open Scanner.xcodeproj
```

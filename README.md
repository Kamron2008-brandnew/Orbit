# 3D Scanner App

See [PLAN.md](PLAN.md) for the full plan. This repo currently covers the first two "Immediate Next Steps".

## ios-prototype/ — ARKit LiDAR live mesh + export

SwiftUI + RealityKit app: shows the live LiDAR mesh, then exports USDZ / OBJ / PLY / STL via ModelIO and the share sheet.
Needs a LiDAR device (iPhone 12 Pro or later, iPad Pro); the simulator has no LiDAR.
**Not yet built or run** (written without Xcode installed).

```bash
brew install xcodegen
cd ios-prototype && xcodegen generate && open Scanner.xcodeproj
```

Set your signing team in Xcode, run on device. Export format support depends on ModelIO;
the app reports an error if a format is unavailable.

## web-capture/: Orbit, the capture app (runs in Safari, no Xcode)

A web app you open on the iPhone. Point the camera at the object: it is found and outlined automatically.
Then tap the shutter (recording never starts by itself) and walk one loop around it. Keyframes are picked automatically, the
sharpest per 7.5 degrees, in 4K when the camera allows, each with an object outline.

**Object accuracy** (the main focus):
- Automatic detection probes the middle of the view and only accepts a guess that is one plausible object:
  not most of the frame, where the camera points, and with its outline on a real colour edge nearly all the
  way round (a cut-out patch of floor or wall fails this: 0.57 versus 0.94 for a real object). Point
  somewhere else and it lets go and looks again.
- A fast tracker (MediaPipe interactive segmenter, `js/vision.js`) follows the object live at 512 px, guided
  by points spread over it, with a colour check so it can't slide onto the table or a neighbour.
- A precise model (EdgeTAM, Meta's on-device Segment Anything 2, `js/refine.js`, WebGPU when available)
  re-outlines it from a snug box plus points: on your tap, several times a second while scanning, and on every
  keyframe from the full-resolution photo after the scan. Tested on a synthetic labelled bottle: 0.994 to
  0.996 IoU (576x1024) versus 0.991 for the fast tracker (288x512); found automatically at 0.995.

**Look and feel:** a WebGL particle system (`js/particles.js`) is the signature, glowing in an ambient
iridescent palette (ice cyan, periwinkle, violet, rose). The intro is a gallery on a turntable: a scanning
ring sweeps down each shape and rebuilds it layer by layer (the first one condenses out of a nebula), the
points are lit like a solid with a moving glint, an aurora behind takes each shape's colours, and a starfield
drifts at three depths. Drag to spin it, tap for the next shape. In the camera, the object's
outline flows through the palette, the shutter ring turns iridescent once there is an object to scan, its body is a cloud of its own colours, rings show coverage, and the result is a 6,000-point 3D
preview carved from the outlines (`js/hull.js`). The result screen is drawn with the same particles: over a
frosted sheet lit by an ambient glow taken from the object's own colours, the Overview score is a ring of particles
with drifting stardust, coverage is a top-down particle dial with a slow radar sweep, Quality is particle meters,
and Export shows a tiny turning copy of the object on the file. Particles flow from one tab's layout to the next
and ride along with the scroll. Instrument Sans, one accent colour (ice cyan), native switches.

**Stability** (`js/guard.js`): iOS kills a page that uses too much memory without any warning, so before each
heavy step (loading each model, scanning, building the preview, packing the zip) the app leaves a marker. If a
marker is still there on the next start, the page died during that step and the app steps down: object detection
falls back from GPU to CPU, precise outlines switch off, a scan crash drops to standard detail. Nothing is
locked, it is all in Settings under Stability, which also has "Copy diagnostics". Other protections: the two
models load one after the other (never together), precise outlines need WebGPU (without it the model would
run on the main thread and freeze the page), they switch themselves off after three failed runs, the zip is
built from the stored files without loading them all into memory, the particle canvas recovers from a lost
WebGL context, and closed screens no longer animate hidden blurred layers in the background.

Hosting: needs HTTPS for the camera. Drag the `web-capture` folder onto your Netlify site's Deploys page.

Tested in desktop Chrome/Chromium with synthetic camera scenes and simulated phone orientation.
**Not yet tested on an iPhone**: real-camera accuracy and speed (EdgeTAM takes about 3 s per frame on a
2017 MacBook's GPU; an iPhone 16 Pro should be far faster, unmeasured), 4K capture, haptics, share sheet.

## pipeline/: scans to high-quality models

**High quality (photo-textured):** `colab_scanner.ipynb` on free Colab (T4 GPU). Save Orbit zips to
`MyDrive/3d-scanner/scans/`, open the notebook, Runtime > Run all. For every new scan it runs:
`prepare_scan.py` (unpack, upscale masks) then `run_hq.sh`, which does COLMAP for camera positions, then OpenMVS for
dense surface, mesh, refinement and texture, then `finish_model.py` (stand upright from the camera orbit,
crop to the object, cut away the table, scale to the real height, export GLB + USDZ + OBJ). Models land
in `MyDrive/3d-scanner/models/<name>/`. The first run builds COLMAP and OpenMVS (about 40 minutes) and
caches them in Drive. **The notebook and run_hq.sh have not been run yet.** `finish_model.py` was tested on a
synthetic scene (tilted, shifted, with a floor and a stray fragment): it came out exactly 0.30 x 0.60 x 0.30 m,
upright, floor and fragment removed, textured GLB and USDZ.

```bash
cd pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# clean any raw mesh (e.g. LiDAR export, COLMAP output)
.venv/bin/python clean_mesh.py scan.ply out --name chair --height 0.85 --low-faces 20000

# smoke test with a synthetic bad scan
.venv/bin/python make_test_scan.py /tmp/test_scan.ply
.venv/bin/python clean_mesh.py /tmp/test_scan.ply /tmp/out --height 1.0

# Orbit zip -> COLMAP-ready folder (keyframes, upscaled masks, saved height)
.venv/bin/python prepare_scan.py my-object.zip workspace/

# photos or Orbit zips -> mesh: colab_scanner.ipynb on free Colab (T4 GPU). It builds COLMAP with CUDA once,
# caches it to Drive, then runs prepare_scan.py (for zips), run_colmap.sh and clean_mesh.py.
# Untested so far (needs a real Colab run).
```

**LiDAR scans from other apps** (`import_lidar.py`): to try the iPhone's LiDAR before building a native app,
scan with an app such as Scaniverse or Polycam, export the mesh as GLB (or OBJ/PLY), and run:

```bash
.venv/bin/python import_lidar.py scan.glb out --name mug
```

It keeps only the object: finds which way is up, removes the floor or table it stood on (and the table legs,
and a wall if one was caught), keeps the piece in the middle with any loose bits of it (a handle, a lid), stands
it at y = 0, and writes `out/mug/mug.glb`, `.obj` and `.usdz` with the texture. LiDAR scans are already at real
scale, so no height is needed. Tested on synthetic scans (a mug on a table on a floor beside a wall, y-up GLB and
z-up PLY, and an object-only scan): it kept exactly the mug and its separate handle. Not yet run on a real export.

`blender_cleanup.py` is an alternative cleanup that also writes USDZ
(`blender --background --python blender_cleanup.py -- in.ply out_dir`).
It is untested; Blender isn't installed here.

Gaps vs. the plan: no texture baking, no retopology, no background removal yet.

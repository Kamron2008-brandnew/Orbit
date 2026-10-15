// Packing a scan into a zip and sharing it.

import * as store from "./store.js";
import { BANDS } from "./geometry.js";
import { guard, logError } from "./guard.js";
import { haptic } from "./haptics.js";
import { toPly } from "./hull.js";
import { makeZip } from "./zip.js";
import { VERSION } from "./config.js";
import { resetShare } from "./review.js";
import { $, state } from "./state.js";
import { toast } from "./ui.js";
import { slug } from "./util.js";

function scanJson(rec) {
  return {
    app: `Orbit web ${VERSION}`,
    name: rec.name,
    created: new Date(rec.createdAt).toISOString(),
    mode: rec.mode === "spin" ? "turntable" : "walk-around",
    height_m: rec.heightM,
    image_size: rec.imageSize,
    frame_count: rec.frames.length,
    masks: "masks/<image name>.png: white = object, black = background (COLMAP --ImageReader.mask_path layout). Masks are low-res; prepare_scan.py upscales them.",
    angles: "azimuth is degrees around the object relative to the first frame; elevation is degrees the camera looked down.",
    preview: rec.cloud ? "preview.ply: rough silhouette point cloud (visual hull) built on the phone" : null,
    score: rec.score,
    stats: rec.stats,
    coverage: BANDS.map((b, i) => ({ band: b.label, elevation_deg: [b.elevMin, b.elevMax], sectors: b.sectors, covered: rec.coverage[i] })),
    frames: rec.frames,
  };
}

const README = rec => `${rec.name}, captured with Orbit.

images/      sharp keyframes picked automatically while scanning
masks/       object masks for each keyframe (white = object)
preview.ply  rough 3D point cloud built on the phone from the outlines (opens in Blender, MeshLab, CloudCompare)
scan.json    angles, sharpness, object boxes, coverage, real height

For a high-quality, photo-textured model: save this zip to Google Drive in 3d-scanner/scans/,
open colab_scanner.ipynb in Colab and choose Runtime > Run all. The model (USDZ for iPhone AR,
GLB, OBJ) appears in 3d-scanner/models/${slug(rec.name)}/.
`;

function download(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function shareFile(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      haptic("lock");
      return "shared";
    } catch (e) {
      if (e.name === "AbortError") return "cancelled";
      if (e.name === "NotAllowedError") return "needs-tap";
    }
  }
  download(file);
  return "downloaded";
}

$("shareBtn").addEventListener("click", async () => {
  const rec = state.reviewing;
  if (!rec) return;
  const btn = $("shareBtn");
  haptic("tap");
  if (state.preparedZip?.id === rec.id) {
    const r = await shareFile(state.preparedZip.file);
    if (r === "needs-tap") toast("Tap once more to send it.");
    return;
  }
  btn.classList.add("busy");
  $("shareLabel").textContent = "Packing";
  try {
    const files = (await store.getFiles(rec.id)).sort((a, b) => (a.name < b.name ? -1 : 1));
    const list = files.map(f => ({ name: f.name, data: f.blob }));
    if (rec.cloud) list.push({ name: "preview.ply", data: toPly(rec.cloud, rec.heightM) });
    list.push({ name: "scan.json", data: JSON.stringify(scanJson(rec), null, 2) });
    list.push({ name: "README.txt", data: README(rec) });
    guard.begin("pack");
    const zip = await makeZip(list, p => { $("shareMeta").textContent = `${Math.round(p * 100)}%`; });
    guard.end("pack");
    const file = new File([zip], `${slug(rec.name)}.zip`, { type: "application/zip" });
    state.preparedZip = { id: rec.id, file };
    btn.classList.remove("busy");
    $("shareLabel").textContent = "Send zip";
    $("shareMeta").textContent = `${(zip.size / 1e6).toFixed(1)} MB`;
    const r = await shareFile(file);
    if (r === "needs-tap") toast("Packed. Tap Send zip to share it.");
  } catch (e) {
    guard.end("pack");
    logError("pack", e);
    resetShare();
    toast(`Couldn't pack the scan: ${e?.message || e}`, 5000);
  }
});

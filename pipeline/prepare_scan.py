#!/usr/bin/env python3
"""Unpack an Orbit scan zip (from the web capture app) into a COLMAP-ready folder.

Writes:
  <out>/images/kf_000.jpg ...           the keyframes
  <out>/masks/kf_000.jpg.png ...        object masks, upscaled to image size and slightly grown
                                        (COLMAP --ImageReader.mask_path layout: black = ignore)
  <out>/scan.json                       the capture metadata
  <out>/colmap.env                      MASK_PATH / MATCHER / HEIGHT_M for run_colmap.sh

Masks are used by default only for turntable scans, where the background stays still while the object
turns and would otherwise confuse COLMAP. Walk-around scans keep the background: it helps registration.

Usage:
    python prepare_scan.py my-scan.zip workspace/ [--masks auto|on|off] [--grow 2]
"""
import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageFilter


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--masks", choices=["auto", "on", "off"], default="auto")
    ap.add_argument("--grow", type=int, default=2, help="grow masks by this many low-res pixels (~8 px each at full size)")
    args = ap.parse_args()

    img_dir, mask_dir = args.out / "images", args.out / "masks"
    for d in (img_dir, mask_dir):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)

    with zipfile.ZipFile(args.zip) as z:
        if "scan.json" not in z.namelist():
            sys.exit(f"{args.zip} has no scan.json; is it an Orbit scan?")
        meta = json.loads(z.read("scan.json"))
        n_masks = 0
        for frame in meta["frames"]:
            name = Path(frame["file"]).name
            with z.open(frame["file"]) as src, open(img_dir / name, "wb") as dst:
                shutil.copyfileobj(src, dst)
            if not frame.get("mask") or frame["mask"] not in z.namelist():
                continue
            size = Image.open(img_dir / name).size
            with z.open(frame["mask"]) as f:
                m = Image.open(f).convert("L")
                m.load()
            if args.grow > 0:
                m = m.filter(ImageFilter.MaxFilter(2 * args.grow + 1))
            m = m.resize(size, Image.BILINEAR).point(lambda v: 255 if v >= 128 else 0)
            m.save(mask_dir / f"{name}.png")
            n_masks += 1

    (args.out / "scan.json").write_text(json.dumps(meta, indent=2))

    turntable = meta.get("mode") == "turntable"
    use_masks = n_masks > 0 and (args.masks == "on" or (args.masks == "auto" and turntable))
    if use_masks and n_masks < len(meta["frames"]):
        # COLMAP needs a mask for every image once mask_path is set; give unmasked frames a full-white one.
        for frame in meta["frames"]:
            name = Path(frame["file"]).name
            if not (mask_dir / f"{name}.png").exists():
                Image.new("L", Image.open(img_dir / name).size, 255).save(mask_dir / f"{name}.png")

    height = meta.get("height_m")
    env = [
        f"MASK_PATH={mask_dir.resolve() if use_masks else ''}",
        # keyframes are taken in order around the object, so neighbours overlap most
        "MATCHER=sequential" if len(meta["frames"]) > 150 else "MATCHER=exhaustive",
        f"HEIGHT_M={height if height else ''}",
    ]
    (args.out / "colmap.env").write_text("\n".join(env) + "\n")

    print(f"{meta.get('name', args.zip.stem)}: {len(meta['frames'])} images, {n_masks} masks "
          f"({'used' if use_masks else 'not used'}), mode={meta.get('mode')}, height_m={height}")
    print(f"images: {img_dir}")
    if use_masks:
        print(f"masks:  {mask_dir}")


if __name__ == "__main__":
    main()

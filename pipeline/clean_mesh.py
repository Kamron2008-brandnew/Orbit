#!/usr/bin/env python3
"""Clean a raw scan mesh and export high/low-detail versions in several formats.

Steps: load -> weld/dedupe -> drop floating fragments -> fill holes -> optional
rescale -> decimate -> export. Works on anything trimesh can read (obj, ply, stl,
glb, off). USDZ is not written here; convert the GLB/OBJ with Blender or Apple's
`usdzconvert`/Reality Converter.

Usage:
    python clean_mesh.py scan.ply out_dir --name chair --height 0.85 --low-faces 20000
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh


def load_mesh(path: Path) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh", process=False)
    if isinstance(loaded, trimesh.Scene):
        loaded = loaded.dump(concatenate=True)
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        sys.exit(f"{path} has no triangle geometry")
    return loaded


def remove_floaters(mesh: trimesh.Trimesh, min_fraction: float) -> trimesh.Trimesh:
    """Keep components with at least min_fraction of the largest component's faces."""
    parts = mesh.split(only_watertight=False)
    if len(parts) <= 1:
        return mesh
    largest = max(len(p.faces) for p in parts)
    kept = [p for p in parts if len(p.faces) >= largest * min_fraction]
    return trimesh.util.concatenate(kept)


def clean(mesh: trimesh.Trimesh, floater_fraction: float) -> trimesh.Trimesh:
    mesh = mesh.copy()
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    mesh.remove_unreferenced_vertices()
    mesh = remove_floaters(mesh, floater_fraction)
    trimesh.repair.fix_inversion(mesh)
    trimesh.repair.fix_normals(mesh)
    trimesh.repair.fill_holes(mesh)  # only closes simple, small holes
    return mesh


def rescale(mesh: trimesh.Trimesh, height: float | None, scale: float | None) -> None:
    """Height is measured along Y (ARKit and glTF are Y-up)."""
    if height is not None:
        extent = mesh.bounds[1][1] - mesh.bounds[0][1]
        if extent <= 0:
            sys.exit("mesh has zero height; cannot rescale")
        scale = height / extent
    if scale is not None:
        mesh.apply_scale(scale)


def recenter_on_floor(mesh: trimesh.Trimesh) -> None:
    """Move origin to the bottom-center of the bounding box."""
    lo, hi = mesh.bounds
    mesh.apply_translation(-np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]))


def decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    if len(mesh.faces) <= target_faces:
        return mesh
    return mesh.simplify_quadric_decimation(face_count=target_faces)


def export_all(mesh: trimesh.Trimesh, out_dir: Path, stem: str, formats: list[str]) -> list[Path]:
    written = []
    for fmt in formats:
        path = out_dir / f"{stem}.{fmt}"
        mesh.export(path)
        written.append(path)
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--name", default=None, help="output base name (default: input stem)")
    ap.add_argument("--height", type=float, help="real-world height in meters (Y axis); rescales the mesh")
    ap.add_argument("--scale", type=float, help="explicit scale factor (ignored if --height given)")
    ap.add_argument("--flip-colmap-axes", action="store_true",
                    help="rotate 180 deg about X (COLMAP is Y-down) so the mesh is Y-up")
    ap.add_argument("--floater-fraction", type=float, default=0.05,
                    help="drop fragments smaller than this fraction of the largest piece")
    ap.add_argument("--low-faces", type=int, default=20000, help="face budget for the low-poly version")
    ap.add_argument("--formats", nargs="+", default=["glb", "obj", "stl"])
    args = ap.parse_args()

    name = args.name or args.input.stem
    args.out_dir.mkdir(parents=True, exist_ok=True)

    raw = load_mesh(args.input)
    print(f"loaded    {len(raw.vertices):>9,} verts {len(raw.faces):>9,} faces")

    mesh = clean(raw, args.floater_fraction)
    if args.flip_colmap_axes:
        mesh.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    rescale(mesh, args.height, args.scale)
    recenter_on_floor(mesh)
    print(f"cleaned   {len(mesh.vertices):>9,} verts {len(mesh.faces):>9,} faces  "
          f"watertight={mesh.is_watertight}  size(m)={np.round(mesh.extents, 3).tolist()}")

    low = decimate(mesh, args.low_faces)
    print(f"low-poly  {len(low.vertices):>9,} verts {len(low.faces):>9,} faces")

    files = export_all(mesh, args.out_dir, f"{name}_high", args.formats)
    files += export_all(low, args.out_dir, f"{name}_low", args.formats)
    for f in files:
        print("wrote", f)


if __name__ == "__main__":
    main()

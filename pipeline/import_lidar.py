#!/usr/bin/env python3
"""Turn a LiDAR scan app's export into a clean model of just the object.

Apps like Scaniverse, Polycam and 3d Scanner App capture with the iPhone's LiDAR and export a textured mesh
(GLB, glTF, OBJ or PLY). Their scans are already at real-world scale, but they usually include the floor or
table the object stood on, and sometimes a wall. This keeps only the object, stands it upright with its base
at y = 0, centres it, and exports GLB + OBJ + USDZ into out_dir/<name>/, keeping the texture.

How it finds the object:
  - up: ARKit scans are y-up; if a file is z-up instead (some PLY/OBJ exports), the large flat surface the
    object stood on gives it away: the face area pointing along each axis decides.
  - support: the biggest horizontal surface with the object on it (floor or table top). Everything at or
    below it goes, which also removes table legs. Then, if what is left is a table with the object on it,
    once more for the table top. A second surface only counts if it is much bigger than what stands on it,
    so an object's own flat parts (a lamp's base, a cup's inside) are never cut off.
  - the object: of what is left, the piece nearest the middle of that surface (you walked around the
    object, so it is in the middle of what you scanned), with any loose bits of it (a handle, a lid);
    walls and other things at the edges go.

Usage:
    python import_lidar.py scan.glb out_dir [--name mug] [--height 0.11] [--keep-support]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

from finish_model import export_usdz

AXES = {"+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1], "+x": [1, 0, 0], "-x": [-1, 0, 0]}


def load(path: Path) -> trimesh.Trimesh:
    if path.suffix.lower() in (".usdz", ".usda", ".usdc", ".usd", ".fbx"):
        sys.exit(f"{path.suffix} can't be read here. Export the scan as GLB (or OBJ) from the app instead.")
    loaded = trimesh.load(path)
    if isinstance(loaded, trimesh.Scene):
        geoms = [g for g in loaded.dump() if isinstance(g, trimesh.Trimesh) and len(g.faces)]
        if not geoms:
            sys.exit(f"{path} has no triangle mesh in it (a point cloud or splat export?). Export a mesh.")
        loaded = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)  # textures are packed together
    if not isinstance(loaded, trimesh.Trimesh) or not len(loaded.faces):
        sys.exit(f"{path} has no triangle mesh in it (a point cloud or splat export?). Export a mesh.")
    return loaded


def find_up(mesh: trimesh.Trimesh) -> str:
    """The axis most of the flat area faces: the floor or table points up. y wins ties (ARKit is y-up)."""
    n, a = mesh.face_normals, mesh.area_faces
    score = {k: float(a[n @ np.array(v) > 0.95].sum()) for k, v in AXES.items()}
    best = max(score, key=score.get)
    return "+y" if score["+y"] >= 0.6 * score[best] else best


def to_y_up(mesh: trimesh.Trimesh, up: str) -> None:
    src = np.array(AXES[up], float)
    if np.allclose(src, [0, 1, 0]):
        return
    axis = np.cross(src, [0, 1, 0])
    angle = np.arccos(np.clip(src @ [0, 1, 0], -1, 1))
    if np.linalg.norm(axis) < 1e-9:  # upside down
        axis, angle = np.array([1.0, 0, 0]), np.pi
    mesh.apply_transform(trimesh.transformations.rotation_matrix(angle, axis))


def support_plane(mesh: trimesh.Trimesh):
    """The biggest upward-facing flat surface with something on it: (height, cut height, its faces, its area,
    the area above it). None if there isn't a convincing one."""
    up = mesh.face_normals[:, 1] > 0.95
    if not up.any():
        return None
    y = mesh.triangles_center[:, 1]
    a = mesh.area_faces
    lo, hi = y.min(), y.max()
    tol = float(np.clip((hi - lo) * 0.004, 0.003, 0.008))  # LiDAR surfaces are flat to a few mm
    bins = np.arange(lo, hi + tol, tol)
    hist, edges = np.histogram(y[up], bins=bins, weights=a[up])
    if not len(hist) or hist.max() <= 0:
        return None
    k = int(np.argmax(hist))
    h = (edges[k] + edges[k + 1]) / 2
    share = hist[k] / a[up].sum()
    above = a[y > h + 1.5 * tol].sum()
    if share < 0.25 or above < 0.01 * a.sum():  # most of the flat area, and something standing on it
        return None
    on = up & (np.abs(y - h) < 1.5 * tol)
    # cut just above the surface's own noise, so as little as possible of the object's base goes with it
    dev = np.abs(y[on] - np.median(y[on]))
    cut = float(np.median(y[on]) + max(0.002, 3 * 1.4826 * np.median(dev)))
    return h, cut, on, a[on].sum(), above


def footprint(p):
    lo, hi = p.bounds
    return (hi[0] - lo[0]) * (hi[2] - lo[2])


def pick_object(mesh: trimesh.Trimesh, centre_xz: np.ndarray) -> trimesh.Trimesh:
    parts = mesh.split(only_watertight=False)
    if len(parts) <= 1:
        return mesh
    # specks the cut left behind (a few faces of floor noise) are not candidates
    biggest = max(footprint(p) for p in parts)
    cands = [p for p in parts if footprint(p) >= 0.01 * biggest and p.extents[1] > 0.01]
    def away(p):  # horizontal distance from the middle to the piece (0 when the middle is over it)
        lo, hi = p.bounds
        return float(np.linalg.norm(np.maximum(0, np.maximum(lo[[0, 2]] - centre_xz, centre_xz - hi[[0, 2]]))))
    main = min(cands or parts, key=lambda p: (round(away(p), 3), -footprint(p)))
    # keep loose bits of the same object (a handle, a lid): smaller pieces, standing up off the support,
    # that overlap its footprint
    lo, hi = main.bounds
    pad = 0.15 * (hi - lo)
    def belongs(p):
        plo, phi = p.bounds
        over = np.all(plo[[0, 2]] <= (hi + pad)[[0, 2]]) and np.all(phi[[0, 2]] >= (lo - pad)[[0, 2]])
        return over and footprint(p) <= footprint(main) and p.extents[1] > 0.01
    keep = [p for p in parts if p is main or belongs(p)]
    return keep[0] if len(keep) == 1 else trimesh.util.concatenate(keep)


def save_texture(mesh: trimesh.Trimesh, out_dir: Path, stem: str):
    mat = getattr(mesh.visual, "material", None)
    img = getattr(mat, "baseColorTexture", None) or getattr(mat, "image", None)
    if img is None or getattr(mesh.visual, "uv", None) is None:
        return None
    path = out_dir / f"{stem}_texture.png"
    img.convert("RGB").save(path)
    return path


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scan", type=Path, help="GLB, glTF, OBJ or PLY exported from the scanning app")
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--name", default=None)
    ap.add_argument("--up", choices=["auto", *AXES], default="auto", help="which way is up in the file (default: work it out)")
    ap.add_argument("--keep-support", action="store_true", help="keep the floor or table under the object")
    ap.add_argument("--height", type=float, help="rescale to this real height in metres (LiDAR scans are already to scale)")
    args = ap.parse_args()

    name = args.name or args.scan.stem
    out = args.out_dir / name  # one folder per scan: an OBJ's texture files have generic names
    out.mkdir(parents=True, exist_ok=True)
    mesh = load(args.scan)
    print(f"loaded     {len(mesh.vertices):>9,} verts {len(mesh.faces):>9,} faces  size(m)={np.round(mesh.extents, 3).tolist()}")

    up = find_up(mesh) if args.up == "auto" else args.up
    to_y_up(mesh, up)
    print(f"up axis    {up}")

    if not args.keep_support:
        peeled = 0
        for _ in range(2):  # the floor, then possibly a table top
            sp = support_plane(mesh)
            if not sp:
                break
            h, cut, on, area, above = sp
            if peeled and area < 4 * above:  # a table is much bigger than what is on it; an object's own flat part isn't
                break
            centre = mesh.triangles_center[on][:, [0, 2]].mean(axis=0)
            y = mesh.vertices[:, 1]
            # drop every face that lies entirely at or below the support (floor, table top, table legs)
            mesh.update_faces(~np.all(y[mesh.faces] <= cut, axis=1))
            mesh.remove_unreferenced_vertices()
            mesh = pick_object(mesh, centre)
            peeled += 1
            print(f"support    removed the surface at y={h:.3f} m and everything under it")
        if not peeled:
            print("support    none found (the scan is already just the object)")
            mesh = pick_object(mesh, mesh.bounding_box.centroid[[0, 2]])

    if args.height:
        mesh.apply_scale(args.height / mesh.extents[1])
    lo, hi = mesh.bounds
    mesh.apply_translation(-np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]))
    print(f"object     {len(mesh.vertices):>9,} verts {len(mesh.faces):>9,} faces  size(m)={np.round(mesh.extents, 3).tolist()}")

    mesh.export(out / f"{name}.glb")
    mesh.export(out / f"{name}.obj")
    tex = save_texture(mesh, out, name)
    usdz = export_usdz(mesh, out / f"{name}.usdz", tex)
    for p in [out / f"{name}.glb", out / f"{name}.obj", usdz]:
        if p:
            print("wrote", p)


if __name__ == "__main__":
    main()

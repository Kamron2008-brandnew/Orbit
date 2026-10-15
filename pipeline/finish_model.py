#!/usr/bin/env python3
"""Turn a raw photogrammetry mesh into a ready-to-use model of just the object.

Input: the textured mesh from OpenMVS (OBJ + MTL + texture), the COLMAP camera model it was built from
(TXT format), and Orbit's scan.json. Output in out_dir: <name>.glb (web, Blender, games), <name>.usdz
(opens in AR on iPhone), and <name>.obj with its texture.

What it fixes:
  - orientation: COLMAP's frame is arbitrary. The cameras circled the object, so the normal of the plane
    they lie in is "up" (signed using the cameras' own up direction).
  - background: keeps only geometry inside a cylinder around the point every camera looked at, sized
    from the object's outline in the keyframes, and cuts away the table or floor it stood on.
  - scale: real height from scan.json (height_m), bottom resting at y = 0, centred.

Usage:
    python finish_model.py textured.obj colmap_txt_dir scan.json out_dir [--name vase]
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import trimesh


# ---------- COLMAP cameras ----------

def qvec_to_rot(q):
    w, x, y, z = q
    return np.array([
        [1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y],
        [2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x],
        [2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y],
    ])


def read_cameras(txt_dir: Path):
    """Returns {image_name: dict(center, axis, up, f, width)} in world coordinates."""
    intr = {}
    for line in (txt_dir / "cameras.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        p = line.split()
        cam_id, model, w = int(p[0]), p[1], float(p[2])
        params = list(map(float, p[4:]))
        intr[cam_id] = (params[0], w)  # first param is the focal length for every COLMAP model
    cams = {}
    # each image takes two lines: its pose, then its 2D points (which can be an empty line), so keep blanks
    lines = [l for l in (txt_dir / "images.txt").read_text().splitlines() if not l.startswith("#")]
    for line in lines[::2]:
        p = line.split()
        if len(p) < 10:
            continue
        q = np.array(list(map(float, p[1:5])))
        t = np.array(list(map(float, p[5:8])))
        R = qvec_to_rot(q)                      # world -> camera
        f, w = intr[int(p[8])]
        cams[p[9]] = dict(center=-R.T @ t, axis=R.T @ np.array([0, 0, 1.0]), up=R.T @ np.array([0, -1.0, 0]), f=f, width=w)
    return cams


def up_vector(cams):
    C = np.array([c["center"] for c in cams.values()])
    C0 = C - C.mean(axis=0)
    _, _, vt = np.linalg.svd(C0, full_matrices=False)
    n = vt[2]                                   # least-variance direction: normal of the orbit plane
    if n @ np.mean([c["up"] for c in cams.values()], axis=0) < 0:
        n = -n
    return n / np.linalg.norm(n)


def look_at_point(cams):
    """Least-squares point closest to every camera's optical axis."""
    A = np.zeros((3, 3)); b = np.zeros(3)
    for c in cams.values():
        d = c["axis"] / np.linalg.norm(c["axis"])
        M = np.eye(3) - np.outer(d, d)
        A += M; b += M @ c["center"]
    return np.linalg.solve(A, b)


def rotation_to(a, b):
    """Rotation matrix taking unit vector a onto unit vector b."""
    v = np.cross(a, b); s = np.linalg.norm(v); c = a @ b
    if s < 1e-9:
        return np.eye(3) if c > 0 else np.diag([1, -1, -1.0])
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / s ** 2)


# ---------- cleanup ----------

def object_radius(cams, meta, center):
    """Half-width of the object from its outline in each keyframe: distance * (box width / 2) / focal."""
    est = []
    for fr in meta.get("frames", []):
        name = Path(fr["file"]).name
        if name not in cams or not fr.get("bbox"):
            continue
        c = cams[name]
        dist = np.linalg.norm(c["center"] - center)
        bw = (fr["bbox"][2] - fr["bbox"][0]) * c["width"]
        est.append(dist * (bw / 2) / c["f"])
    return float(np.median(est)) if est else None


def floor_height(vertices, rng=np.random.default_rng(0)):
    """RANSAC for a horizontal plane (y = const) below the object's middle; returns its height or None."""
    y = vertices[:, 1]
    lower = y[y < np.median(y)]
    if len(lower) < 50:
        return None
    best, best_h = 0, None
    tol = (y.max() - y.min()) * 0.006
    for _ in range(200):
        h = rng.choice(lower)
        n = np.count_nonzero(np.abs(lower - h) < tol)
        if n > best:
            best, best_h = n, h
    # only a real floor if a good share of the lower half lies on it
    return best_h if best > 0.12 * len(lower) else None


def keep_main_pieces(mesh, min_share=0.05):
    parts = mesh.split(only_watertight=False)
    if len(parts) <= 1:
        return mesh
    big = max(len(p.faces) for p in parts)
    return trimesh.util.concatenate([p for p in parts if len(p.faces) >= big * min_share])


# ---------- export ----------

def export_usdz(mesh, path: Path, texture_png: Path | None):
    try:
        from pxr import Usd, UsdGeom, UsdShade, Sdf, UsdUtils, Gf, Vt
    except ImportError:
        print("usd-core is not installed; skipping USDZ (pip install usd-core)")
        return None
    usda = path.with_suffix(".usda")
    stage = Usd.Stage.CreateNew(str(usda))
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    root = UsdGeom.Xform.Define(stage, "/Model")
    stage.SetDefaultPrim(root.GetPrim())
    m = UsdGeom.Mesh.Define(stage, "/Model/Mesh")
    m.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*map(float, v)) for v in mesh.vertices]))
    m.CreateFaceVertexCountsAttr(Vt.IntArray([3] * len(mesh.faces)))
    m.CreateFaceVertexIndicesAttr(Vt.IntArray(mesh.faces.flatten().tolist()))
    m.CreateNormalsAttr(Vt.Vec3fArray([Gf.Vec3f(*map(float, n)) for n in mesh.vertex_normals]))
    m.SetNormalsInterpolation(UsdGeom.Tokens.vertex)
    m.CreateSubdivisionSchemeAttr(UsdGeom.Tokens.none)
    uv = getattr(mesh.visual, "uv", None)
    mat = UsdShade.Material.Define(stage, "/Model/Material")
    shader = UsdShade.Shader.Define(stage, "/Model/Material/Surface")
    shader.CreateIdAttr("UsdPreviewSurface")
    shader.CreateInput("roughness", Sdf.ValueTypeNames.Float).Set(0.8)
    if uv is not None and texture_png is not None:
        st = UsdGeom.PrimvarsAPI(m).CreatePrimvar("st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.vertex)
        st.Set(Vt.Vec2fArray([Gf.Vec2f(float(a), float(b)) for a, b in uv]))
        reader = UsdShade.Shader.Define(stage, "/Model/Material/stReader")
        reader.CreateIdAttr("UsdPrimvarReader_float2")
        reader.CreateInput("varname", Sdf.ValueTypeNames.Token).Set("st")
        tex = UsdShade.Shader.Define(stage, "/Model/Material/Texture")
        tex.CreateIdAttr("UsdUVTexture")
        tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set(texture_png.name)
        tex.CreateInput("st", Sdf.ValueTypeNames.Float2).ConnectToSource(reader.ConnectableAPI(), "result")
        tex.CreateOutput("rgb", Sdf.ValueTypeNames.Float3)
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(tex.ConnectableAPI(), "rgb")
    else:
        shader.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).Set(Gf.Vec3f(0.8, 0.8, 0.8))
    mat.CreateSurfaceOutput().ConnectToSource(shader.ConnectableAPI(), "surface")
    UsdShade.MaterialBindingAPI.Apply(m.GetPrim()).Bind(mat)
    stage.GetRootLayer().Save()
    ok = UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(str(usda)), str(path))
    usda.unlink(missing_ok=True)
    return path if ok else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mesh", type=Path)
    ap.add_argument("colmap_txt", type=Path, help="folder with cameras.txt and images.txt")
    ap.add_argument("scan_json", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--name", default=None)
    ap.add_argument("--crop", type=float, default=1.35, help="crop radius as a multiple of the object's half-width")
    args = ap.parse_args()

    meta = json.loads(args.scan_json.read_text()) if args.scan_json.exists() else {}
    name = args.name or meta.get("name", "model").lower().replace(" ", "-")
    mesh = trimesh.load(args.mesh, force="mesh", process=False)
    if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
        sys.exit(f"{args.mesh} has no triangles")
    cams = read_cameras(args.colmap_txt)
    if len(cams) < 3:
        sys.exit("need at least 3 registered cameras")
    print(f"loaded {len(mesh.faces):,} faces, {len(cams)} cameras")

    # 1. stand it up
    up = up_vector(cams)
    center = look_at_point(cams)
    R = rotation_to(up, np.array([0, 1.0, 0]))
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = -R @ center
    mesh.apply_transform(T)
    for c in cams.values():
        c["center"] = R @ (c["center"] - center); c["axis"] = R @ c["axis"]

    # 2. crop to a cylinder around the object
    r_obj = object_radius(cams, meta, np.zeros(3))
    if r_obj:
        cen = mesh.triangles_center
        keep = np.hypot(cen[:, 0], cen[:, 2]) < r_obj * args.crop
        mesh.update_faces(keep); mesh.remove_unreferenced_vertices()
        print(f"cropped to radius {r_obj * args.crop:.3f}: {len(mesh.faces):,} faces")

    # 3. cut away the surface it stood on
    fh = floor_height(mesh.vertices)
    if fh is not None:
        # cut a thin band above the plane too: real table tops are slightly thick and uneven
        keep = mesh.triangles_center[:, 1] > fh + (mesh.bounds[1][1] - fh) * 0.025
        mesh.update_faces(keep); mesh.remove_unreferenced_vertices()
        print(f"removed the floor at y={fh:.3f}: {len(mesh.faces):,} faces")
    mesh = keep_main_pieces(mesh)

    # 4. real size, resting on y = 0, centred
    lo, hi = mesh.bounds
    height = meta.get("height_m")
    s = height / (hi[1] - lo[1]) if height else 1.0
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    mesh.apply_scale(s)
    print(f"final {len(mesh.faces):,} faces, size {np.round(mesh.extents, 3).tolist()} {'m' if height else 'units'}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    glb = args.out_dir / f"{name}.glb"
    mesh.export(glb)
    obj = args.out_dir / f"{name}.obj"
    mesh.export(obj)
    tex = None
    image = getattr(getattr(mesh.visual, "material", None), "image", None)
    if image is not None:
        tex = args.out_dir / f"{name}_texture.png"
        image.save(tex)
    usdz = export_usdz(mesh, args.out_dir / f"{name}.usdz", tex)
    for f in [glb, obj, usdz]:
        if f:
            print("wrote", f)


if __name__ == "__main__":
    main()

"""Blender alternative to clean_mesh.py, plus USDZ export (which trimesh can't write).

Usage:
    blender --background --python blender_cleanup.py -- input.ply out_dir --ratio 0.2
"""
import argparse
import sys
from pathlib import Path

import bpy


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--ratio", type=float, default=0.2, help="decimate ratio for the low-poly export")
    return ap.parse_args(argv)


def import_mesh(path: Path):
    ext = path.suffix.lower()
    ops = {".ply": bpy.ops.wm.ply_import, ".obj": bpy.ops.wm.obj_import,
           ".stl": bpy.ops.wm.stl_import}
    if ext in ops:
        ops[ext](filepath=str(path))
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        sys.exit(f"unsupported input {ext}")
    return bpy.context.selected_objects[0]


def clean(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.delete_loose()
    bpy.ops.mesh.fill_holes(sides=8)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def add_decimate(obj, ratio):
    mod = obj.modifiers.new("decimate", "DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)


def export(out_dir: Path, stem: str):
    bpy.ops.export_scene.gltf(filepath=str(out_dir / f"{stem}.glb"), export_format="GLB")
    bpy.ops.wm.obj_export(filepath=str(out_dir / f"{stem}.obj"))
    bpy.ops.wm.usd_export(filepath=str(out_dir / f"{stem}.usdz"))


def main():
    args = parse()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    obj = import_mesh(args.input)
    clean(obj)
    export(args.out_dir, f"{args.input.stem}_high")
    add_decimate(obj, args.ratio)
    export(args.out_dir, f"{args.input.stem}_low")


main()

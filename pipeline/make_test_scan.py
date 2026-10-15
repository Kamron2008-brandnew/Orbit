#!/usr/bin/env python3
"""Make a synthetic 'bad scan' to exercise clean_mesh.py: a noisy, dense, unscaled,
off-origin ellipsoid with duplicate faces, a floating fragment, and a hole."""
import sys

import numpy as np
import trimesh

out = sys.argv[1] if len(sys.argv) > 1 else "test_scan.ply"
rng = np.random.default_rng(0)

body = trimesh.creation.icosphere(subdivisions=5)  # ~20k faces
body.apply_scale([1.0, 2.0, 0.8])
body.vertices += rng.normal(scale=0.002, size=body.vertices.shape)
body.update_faces(np.arange(len(body.faces)) % 50 != 0)  # punch many tiny holes

floater = trimesh.creation.icosphere(subdivisions=2)
floater.apply_scale(0.1)
floater.apply_translation([3, 3, 3])

mesh = trimesh.util.concatenate([body, floater])
mesh.faces = np.vstack([mesh.faces, mesh.faces[:200]])  # duplicate faces
mesh.apply_scale(37.0)                                    # arbitrary units
mesh.apply_translation([10, -5, 4])
mesh.export(out)
print("wrote", out, len(mesh.faces), "faces")

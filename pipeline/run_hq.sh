#!/usr/bin/env bash
# Orbit scan -> photo-textured 3D model (GLB, USDZ, OBJ).
#   COLMAP finds where every keyframe was taken; OpenMVS builds the dense surface, the mesh and the
#   texture from the full-resolution photos; finish_model.py stands it up, crops the background,
#   scales it and exports.
# Needs a CUDA build of COLMAP and an OpenMVS build (colab_scanner.ipynb sets both up and caches them).
#
# Usage: ./run_hq.sh <prepared_dir> <workspace_dir> [--name NAME]
#   prepared_dir: output of prepare_scan.py (images/, masks/, scan.json, colmap.env)
# Env:   MAX_SIZE (default 3200: longest image side used), MVS_BIN (default /usr/local/bin/OpenMVS),
#        REFINE=0 to skip mesh refinement (faster, a little less detail)
set -euo pipefail

SRC=${1:?usage: run_hq.sh <prepared_dir> <workspace_dir> [--name NAME]}
WS=${2:?usage: run_hq.sh <prepared_dir> <workspace_dir> [--name NAME]}
shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"
MVS="${MVS_BIN:-/usr/local/bin/OpenMVS}"
MAX_SIZE="${MAX_SIZE:-3200}"
export QT_QPA_PLATFORM=offscreen

# settings written by prepare_scan.py (masks for turntable scans, matcher choice)
MASK_PATH="" MATCHER="exhaustive"
if [ -f "$SRC/colmap.env" ]; then set -a; . "$SRC/colmap.env"; set +a; fi

mkdir -p "$WS/sparse" "$WS/dense"
DB="$WS/database.db"; rm -f "$DB"
MASK_ARGS=()
if [ -n "${MASK_PATH:-}" ]; then MASK_ARGS=(--ImageReader.mask_path "$MASK_PATH"); fi

echo "== 1/6 features"
colmap feature_extractor --database_path "$DB" --image_path "$SRC/images" \
  --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV \
  --SiftExtraction.use_gpu 1 --SiftExtraction.max_image_size "$MAX_SIZE" --SiftExtraction.max_num_features 12000 \
  ${MASK_ARGS[@]+"${MASK_ARGS[@]}"}

echo "== 2/6 matching ($MATCHER)"
colmap "${MATCHER}_matcher" --database_path "$DB" --SiftMatching.use_gpu 1

echo "== 3/6 camera positions"
colmap mapper --database_path "$DB" --image_path "$SRC/images" --output_path "$WS/sparse"
[ -d "$WS/sparse/0" ] || { echo "COLMAP could not place enough photos. Rescan with slower, steadier movement." >&2; exit 1; }
colmap image_undistorter --image_path "$SRC/images" --input_path "$WS/sparse/0" --output_path "$WS/dense" \
  --output_type COLMAP --max_image_size "$MAX_SIZE"
colmap model_converter --input_path "$WS/dense/sparse" --output_path "$WS/dense/sparse" --output_type TXT

cd "$WS/dense"
echo "== 4/6 dense surface"
"$MVS/InterfaceCOLMAP" -i . -o scene.mvs --image-folder images
"$MVS/DensifyPointCloud" scene.mvs --resolution-level 1 --number-views 6

echo "== 5/6 mesh and texture"
"$MVS/ReconstructMesh" scene_dense.mvs -p scene_dense.ply --remove-spurious 30
MESH=scene_dense_mesh.ply
if [ "${REFINE:-1}" = "1" ]; then
  "$MVS/RefineMesh" scene_dense.mvs -m scene_dense_mesh.ply -o scene_dense_mesh_refine.mvs --resolution-level 1 --max-face-area 16
  MESH=scene_dense_mesh_refine.ply
fi
"$MVS/TextureMesh" scene_dense.mvs -m "$MESH" -o scene_textured.mvs --export-type obj

echo "== 6/6 finish"
"$PY" "$HERE/finish_model.py" scene_textured.obj sparse "$SRC/scan.json" "$WS/out" "$@"

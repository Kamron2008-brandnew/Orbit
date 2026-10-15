#!/usr/bin/env bash
# Photos -> sparse -> dense -> Poisson mesh with COLMAP, then clean with clean_mesh.py.
# Dense steps (patch_match_stereo) need a CUDA build of COLMAP; colab_scanner.ipynb builds one on free Colab.
#
# Usage: ./run_colmap.sh <images_dir> <workspace_dir> [clean_mesh.py args, e.g. --height 0.5]
# Env:   MATCHER=exhaustive|sequential   (sequential for video frames; default exhaustive)
#        MAX_SIZE=1600                   (longest image side used; lower if the GPU runs out of memory)
#        USE_GPU=0|1                     (default: 1 if nvidia-smi works)
#        MASK_PATH=dir                   (optional: COLMAP masks, e.g. from prepare_scan.py for turntable scans)
set -euo pipefail

IMAGES=${1:?usage: run_colmap.sh <images_dir> <workspace_dir> [clean_mesh.py args]}
WS=${2:?usage: run_colmap.sh <images_dir> <workspace_dir> [clean_mesh.py args]}
shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"
[ -x "$HERE/.venv/bin/python" ] && PY="$HERE/.venv/bin/python"

MATCHER="${MATCHER:-exhaustive}"
MAX_SIZE="${MAX_SIZE:-1600}"
if [ -z "${USE_GPU:-}" ]; then
  if nvidia-smi >/dev/null 2>&1; then USE_GPU=1; else USE_GPU=0; fi
fi
export QT_QPA_PLATFORM=offscreen

mkdir -p "$WS/sparse" "$WS/dense"
DB="$WS/database.db"
rm -f "$DB"

MASK_ARGS=()
if [ -n "${MASK_PATH:-}" ]; then MASK_ARGS=(--ImageReader.mask_path "$MASK_PATH"); fi

colmap feature_extractor \
  --database_path "$DB" --image_path "$IMAGES" \
  --ImageReader.single_camera 1 \
  --SiftExtraction.max_image_size "$MAX_SIZE" --SiftExtraction.use_gpu "$USE_GPU" \
  ${MASK_ARGS[@]+"${MASK_ARGS[@]}"}

colmap "${MATCHER}_matcher" --database_path "$DB" --SiftMatching.use_gpu "$USE_GPU"

colmap mapper --database_path "$DB" --image_path "$IMAGES" --output_path "$WS/sparse"
[ -d "$WS/sparse/0" ] || { echo "COLMAP could not register enough images (no sparse/0). Retake with more overlap." >&2; exit 1; }

if [ "$USE_GPU" != "1" ]; then
  echo "No CUDA GPU: stopping after the sparse reconstruction (dense steps need CUDA)." >&2
  exit 2
fi

colmap image_undistorter \
  --image_path "$IMAGES" --input_path "$WS/sparse/0" --output_path "$WS/dense" \
  --output_type COLMAP --max_image_size "$MAX_SIZE"

colmap patch_match_stereo --workspace_path "$WS/dense" \
  --PatchMatchStereo.geom_consistency true --PatchMatchStereo.max_image_size "$MAX_SIZE"

colmap stereo_fusion --workspace_path "$WS/dense" --output_path "$WS/dense/fused.ply"

colmap poisson_mesher --input_path "$WS/dense/fused.ply" --output_path "$WS/dense/meshed.ply"

# COLMAP's frame is arbitrary, unscaled and Y-down. Flip to Y-up; pass --height to set real-world size.
"$PY" "$HERE/clean_mesh.py" "$WS/dense/meshed.ply" "$WS/out" --flip-colmap-axes "$@"

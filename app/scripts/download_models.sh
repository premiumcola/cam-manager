#!/usr/bin/env bash
# TAM-spy › Coral model downloader
# Fetches the standard COCO SSD MobileNet v2 model (Edge TPU + CPU variants)
# and the matching labels file, placing them where config.yaml.example expects.
#
# Run once from the repo root:
#   bash app/scripts/download_models.sh
#
# Safe to re-run — existing files are kept unless --force is passed.

set -euo pipefail

FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
fi

# Resolve repo root: this script lives at <repo>/app/scripts/
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
MODELS_DIR="$REPO_ROOT/models"
CONFIG_DIR="$REPO_ROOT/app/config"

mkdir -p "$MODELS_DIR"

EDGETPU_MODEL="coco_ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite"
CPU_MODEL="coco_ssd_mobilenet_v2_coco_quant_postprocess.tflite"
LABELS="coco_labels.example.txt"

BASE="https://github.com/google-coral/test_data/raw/master"
LABELS_URL="https://raw.githubusercontent.com/google-coral/test_data/master/coco_labels.txt"

file_size() { wc -c < "$1" 2>/dev/null | tr -d ' \n' ; }

download() {
  local src="$1" dst="$2" min_bytes="$3"
  if [ -f "$dst" ] && [ "$FORCE" -ne 1 ]; then
    local cur_size
    cur_size=$(file_size "$dst")
    if [ -n "$cur_size" ] && [ "$cur_size" -ge "$min_bytes" ]; then
      echo "  [skip] $(basename "$dst") already present ($(du -h "$dst" | cut -f1))"
      return
    fi
    echo "  [warn] $(basename "$dst") exists but is too small (${cur_size} bytes) — re-downloading"
    rm -f "$dst"
  fi
  echo "  [get]  $src"
  curl --fail --location --silent --show-error -o "$dst" "$src"
  local got
  got=$(file_size "$dst")
  if [ -z "$got" ] || [ "$got" -lt "$min_bytes" ]; then
    echo "  [ERR]  $(basename "$dst") is only ${got:-0} bytes (expected >= ${min_bytes})" >&2
    rm -f "$dst"
    exit 1
  fi
  echo "         → $dst ($(du -h "$dst" | cut -f1))"
}

echo "== TAM-spy Coral model downloader =="
echo "  models:  $MODELS_DIR"
echo "  config:  $CONFIG_DIR"
echo

echo "-- Edge TPU model --"
download "$BASE/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite" \
         "$MODELS_DIR/$EDGETPU_MODEL" 4000000

echo "-- CPU fallback model --"
download "$BASE/ssd_mobilenet_v2_coco_quant_postprocess.tflite" \
         "$MODELS_DIR/$CPU_MODEL" 4000000

echo "-- COCO labels --"
if [ -f "$CONFIG_DIR/$LABELS" ] && [ "$FORCE" -ne 1 ]; then
  echo "  [skip] $LABELS already present in $CONFIG_DIR"
else
  download "$LABELS_URL" "$CONFIG_DIR/$LABELS" 500
fi

echo
echo "Done. Restart the container for detectors.py to pick up the models:"
echo "  docker restart tam-spy"

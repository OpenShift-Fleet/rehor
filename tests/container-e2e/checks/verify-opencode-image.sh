#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: verify-opencode-image.sh <container-runtime> <runner-image>" >&2
  exit 2
fi

RUNTIME="$1"
IMAGE="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$RUNTIME" run --rm -i --entrypoint node "$IMAGE" --input-type=module - \
  < "$SCRIPT_DIR/verify-opencode-image.mjs"

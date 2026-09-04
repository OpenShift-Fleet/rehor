#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
command -v buildah >/dev/null
buildah --version
command -v grype >/dev/null
grype version
'

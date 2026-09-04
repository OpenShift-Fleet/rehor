#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
command -v node >/dev/null
command -v npm >/dev/null
node --version
npm --version
'

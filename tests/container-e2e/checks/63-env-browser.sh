#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
if command -v chromium >/dev/null 2>&1; then
  chromium --headless --version
elif command -v chromium-browser >/dev/null 2>&1; then
  chromium-browser --headless --version
else
  echo "::error::chromium executable not found"
  exit 1
fi
'

#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: verify-opencode-image.sh <container-runtime> <runner-image>" >&2
  exit 2
fi

RUNTIME="$1"
IMAGE="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_ARGS=(--rm -i)
# Validate current coordinator output against an already-built image while its
# source is converging. The image's installed dependencies/CLI stay authoritative.
if [ -n "${REHOR_SMOKE_COORDINATOR_DIST:-}" ]; then
  if [[ "$REHOR_SMOKE_COORDINATOR_DIST" != /* ]] || [ ! -f "$REHOR_SMOKE_COORDINATOR_DIST/index.js" ] || [ ! -f "$REHOR_SMOKE_COORDINATOR_DIST/vertex-provider.js" ]; then
    echo "REHOR_SMOKE_COORDINATOR_DIST must name an absolute built directory containing index.js and vertex-provider.js" >&2
    exit 2
  fi
  RUN_ARGS+=(--mount "type=bind,src=$REHOR_SMOKE_COORDINATOR_DIST,dst=/home/botuser/app/coordinator/dist,readonly")
fi
if [ -n "${REHOR_SMOKE_DEPLOYMENT_CONFIG:-}" ]; then
  if [[ "$REHOR_SMOKE_DEPLOYMENT_CONFIG" != /* ]] || [ ! -f "$REHOR_SMOKE_DEPLOYMENT_CONFIG" ]; then
    echo "REHOR_SMOKE_DEPLOYMENT_CONFIG must name an existing absolute file" >&2
    exit 2
  fi
  RUN_ARGS+=(--mount "type=bind,src=$REHOR_SMOKE_DEPLOYMENT_CONFIG,dst=/home/botuser/app/coordinator/opencode-deployment.default.json,readonly")
fi

"$RUNTIME" run "${RUN_ARGS[@]}" --entrypoint node "$IMAGE" --input-type=module - \
  < "$SCRIPT_DIR/verify-opencode-image.mjs"

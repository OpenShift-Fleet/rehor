#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

TOOLS=(python3 uv git tini bwrap gh glab gpg)
for tool in "${TOOLS[@]}"; do
  if ! "$RUNTIME" exec "$CONTAINER" bash -lc "command -v $tool >/dev/null"; then
    echo "::error::missing required tool: $tool"
    exit 1
  fi
done

"$RUNTIME" exec "$CONTAINER" bash -lc "python3 --version && uv --version && git --version"

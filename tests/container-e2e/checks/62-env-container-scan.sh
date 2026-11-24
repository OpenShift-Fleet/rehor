#!/usr/bin/env bash
# $1 = CHECK_CONTAINER (alive, for binary exec checks)
# $2 = RUNTIME
# $3 = BOT_CONTAINER (may have exited; use docker cp for entrypoint.d filesystem state)
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"
BOT_CONTAINER="${3:-}"

# Binary presence — exec into check container (same image, always alive)
"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
command -v buildah >/dev/null || { echo "::error::buildah not found"; exit 1; }
buildah --version
command -v grype >/dev/null || { echo "::error::grype not found"; exit 1; }
grype version
'

# Filesystem state written by entrypoint.d/10-buildah-config.sh — use docker cp
# so this works whether BOT_CONTAINER is running or already exited.
if [ -n "$BOT_CONTAINER" ]; then
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT
  tmp_storage="$tmp_dir/storage.conf"
  tmp_registries="$tmp_dir/registries.conf"

  "$RUNTIME" cp "$BOT_CONTAINER":/home/botuser/.config/containers/storage.conf "$tmp_storage" 2>/dev/null || {
    echo "::error::buildah storage.conf missing — entrypoint.d/10-buildah-config.sh did not run"
    exit 1
  }
  grep -q "vfs" "$tmp_storage" || {
    echo "::error::storage.conf does not configure vfs driver"
    exit 1
  }

  "$RUNTIME" cp "$BOT_CONTAINER":/home/botuser/.config/containers/registries.conf "$tmp_registries" 2>/dev/null || {
    echo "::error::buildah registries.conf missing — entrypoint.d/10-buildah-config.sh did not run"
    exit 1
  }
  echo "container-scan entrypoint.d config OK (storage.conf vfs + registries.conf present)"
fi

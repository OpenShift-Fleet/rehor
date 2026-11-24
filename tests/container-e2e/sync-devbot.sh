#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

if [ "$#" -ne 2 ]; then
  die "usage: sync-devbot.sh <repo-root> <build-root>"
fi

REPO_ROOT="$1"
BUILD_ROOT="$2"

require_cmd rsync

mkdir -p "$BUILD_ROOT/dev-bot"

log "Syncing repo into temporary build context"
rsync -a --delete \
  --exclude ".git" \
  --exclude ".venv" \
  --exclude "__pycache__" \
  --exclude ".pytest_cache" \
  --exclude "node_modules" \
  "$REPO_ROOT/" "$BUILD_ROOT/dev-bot/"

log "Repo sync complete: $BUILD_ROOT/dev-bot"

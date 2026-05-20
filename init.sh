#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOS_MAP="$SCRIPT_DIR/project-repos.json"
REPOS_DIR="$SCRIPT_DIR/repos"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [init] $*"
}

# Detect container runtime: prefer docker, fall back to podman
if command -v docker &>/dev/null; then
  CONTAINER_RT="docker"
elif command -v podman &>/dev/null; then
  CONTAINER_RT="podman"
else
  log "ERROR: Neither docker nor podman found. Install one to continue."
  exit 1
fi
log "Using container runtime: $CONTAINER_RT"

log "Checking LSP dependencies..."

# TypeScript LSP
if ! command -v typescript-language-server &>/dev/null; then
  log "Installing typescript-language-server..."
  npm install -g typescript-language-server typescript
fi

log "LSP servers ready."

# Install pre-commit hooks
log "Installing pre-commit hooks..."
if ! uv run pre-commit install; then
  log "WARNING: Failed to install pre-commit hooks. You may need to run 'uv run pre-commit install' manually."
fi
log "Pre-commit hooks installed."

mkdir -p "$REPOS_DIR"
log "Repos directory ready (repos cloned on demand by the bot)."

# Download BrowserMCP extension if not present
EXTENSIONS_DIR="$SCRIPT_DIR/extensions"
BROWSERMCP_DIR="$EXTENSIONS_DIR/browsermcp"

if [ ! -d "$BROWSERMCP_DIR" ]; then
  log "Downloading BrowserMCP extension..."
  mkdir -p "$EXTENSIONS_DIR"
  CRX_FILE="$EXTENSIONS_DIR/browsermcp.crx"
  curl -L -o "$CRX_FILE" "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=131.0&acceptformat=crx2,crx3&x=id%3Dbjfgambnhccakkhmkepdoekmckoijdlc%26uc"
  mkdir -p "$BROWSERMCP_DIR"
  unzip -o "$CRX_FILE" -d "$BROWSERMCP_DIR" -x '_metadata/*'
  rm -f "$CRX_FILE"
  log "BrowserMCP extension downloaded and unpacked."
else
  log "BrowserMCP extension already present."
fi

# Start memory server
log "Starting memory server..."
cd "$SCRIPT_DIR/memory-server"
$CONTAINER_RT compose up -d --build
log "Waiting for memory server health check..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
    log "Memory server is healthy."
    break
  fi
  if [ "$i" -eq 30 ]; then
    log "WARNING: Memory server failed to start within 30s. Check $CONTAINER_RT compose logs."
  fi
  sleep 1
done
cd "$SCRIPT_DIR"

log "Ready to run."

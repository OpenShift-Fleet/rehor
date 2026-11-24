#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

logs=$("$RUNTIME" logs "$CONTAINER" 2>&1) || {
  echo "::error::could not read container logs"
  printf '%s\n' "$logs"
  exit 1
}

# Stage 1: executor socket readiness
if ! grep -qE "Executor ready\." <<<"$logs"; then
  echo "::error::entrypoint did not report executor readiness"
  printf '%s\n' "$logs"
  exit 1
fi
echo "entrypoint stage: Executor ready OK"

# Stage 2: memory-server health wait
if ! grep -qE "memory-server is ready\." <<<"$logs"; then
  echo "::error::entrypoint did not report memory-server readiness"
  printf '%s\n' "$logs"
  exit 1
fi
echo "entrypoint stage: memory-server ready OK"

# Stage 3: final startup handoff
if ! grep -qE "Credentials configured\. Starting bot with label:" <<<"$logs"; then
  echo "::error::entrypoint did not reach final startup stage"
  printf '%s\n' "$logs"
  exit 1
fi
echo "entrypoint stage: Credentials configured OK"

# Stage 4: .mcp.json URL substitution — use docker cp so this works on exited containers too
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
tmp_mcp="$tmp_dir/mcp.json"
tmp_gitconfig="$tmp_dir/gitconfig"

"$RUNTIME" cp "$CONTAINER":/home/botuser/app/.mcp.json "$tmp_mcp" 2>/dev/null || {
  echo "::error::could not copy .mcp.json from container"
  exit 1
}
if grep -q "localhost:8080/mcp" "$tmp_mcp"; then
  echo "::error::.mcp.json still contains localhost:8080/mcp — URL substitution did not run"
  exit 1
fi
echo "entrypoint stage: .mcp.json URL substitution OK"

# Stage 5: git credential helpers configured — copy global gitconfig from container
"$RUNTIME" cp "$CONTAINER":/home/botuser/.gitconfig "$tmp_gitconfig" 2>/dev/null || {
  echo "::error::could not copy .gitconfig from container"
  exit 1
}
if ! grep -q "https://github.com" "$tmp_gitconfig" || ! grep -q "gh auth git-credential" "$tmp_gitconfig"; then
  echo "::error::git credential helper for github.com not found in .gitconfig"
  exit 1
fi
echo "entrypoint stage: git credential helpers OK"

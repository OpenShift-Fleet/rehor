#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

logs=$("$RUNTIME" logs "$CONTAINER" 2>&1) || {
  echo "::error::could not read container logs"
  printf '%s\n' "$logs"
  exit 1
}

if ! grep -qE "Credentials configured\\. Starting bot with label:" <<<"$logs"; then
  echo "::error::entrypoint did not reach final startup stage"
  printf '%s\n' "$logs"
  exit 1
fi

if ! grep -qE "Executor ready\\." <<<"$logs"; then
  echo "::error::entrypoint did not report executor readiness"
  printf '%s\n' "$logs"
  exit 1
fi

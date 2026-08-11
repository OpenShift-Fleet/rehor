#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

if ! "$RUNTIME" logs "$CONTAINER" 2>&1 | grep -qE "Credentials configured\\. Starting bot with label:"; then
  echo "::error::entrypoint did not reach final startup stage"
  "$RUNTIME" logs "$CONTAINER" || true
  exit 1
fi

if ! "$RUNTIME" logs "$CONTAINER" 2>&1 | grep -qE "Executor ready\\."; then
  echo "::error::entrypoint did not report executor readiness"
  "$RUNTIME" logs "$CONTAINER" || true
  exit 1
fi

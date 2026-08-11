#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
command -v go >/dev/null
go version
command -v golangci-lint >/dev/null
golangci-lint version
'

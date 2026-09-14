#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail

# goenv itself
command -v goenv >/dev/null || { echo "::error::goenv not found"; exit 1; }
goenv --version

# GOENV_PATH_ORDER must be "front" (set by /etc/profile.d/goenv.sh)
[ "${GOENV_PATH_ORDER:-}" = "front" ] || {
  echo "::error::GOENV_PATH_ORDER not set to front (got: ${GOENV_PATH_ORDER:-unset})"
  exit 1
}
echo "GOENV_PATH_ORDER=front OK"

# At least one Go version must be installed
goenv_versions=$(goenv versions --bare 2>/dev/null)
[ -n "$goenv_versions" ] || { echo "::error::no Go versions installed via goenv"; exit 1; }
echo "goenv versions installed: $(echo "$goenv_versions" | tr "\n" " ")"

# go and golangci-lint available on PATH
command -v go >/dev/null
go version
command -v golangci-lint >/dev/null
golangci-lint version
'

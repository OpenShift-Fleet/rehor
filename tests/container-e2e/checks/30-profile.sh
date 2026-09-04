#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -e
for pf in /etc/profile.d/*.sh; do
  [ -f "$pf" ] || continue
  . "$pf"
done
echo "profile.d sourcing OK"
'

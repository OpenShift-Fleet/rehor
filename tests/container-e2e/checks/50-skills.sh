#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
test -f presets/shared/skills/auto-fork/README.md
test -f presets/shared/skills/post-pr/README.md
grep -q "shared_dir = profile_dir.parent / \"shared\" / \"agent\"" bot/run.py
echo "shared skill source + loader wiring OK"
'

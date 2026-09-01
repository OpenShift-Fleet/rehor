#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

"$RUNTIME" exec -i "$CONTAINER" python3 - <<'PY'
import bot.run  # noqa: F401
import bot.merge  # noqa: F401
import bot.costs  # noqa: F401
import bot.config  # noqa: F401
import bot.preflight  # noqa: F401

print("python imports OK")
PY

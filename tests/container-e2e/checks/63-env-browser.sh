#!/usr/bin/env bash
# $1 = CHECK_CONTAINER (alive, for binary/env exec checks — same image as bot)
# $2 = RUNTIME
# $3 = BOT_CONTAINER (may have exited; use docker logs for "Chromium ready." check)
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"
BOT_CONTAINER="${3:-}"

# PLAYWRIGHT_BROWSERS_PATH must be set (from /etc/profile.d/browser-env.sh)
"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
[ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] || {
  echo "::error::PLAYWRIGHT_BROWSERS_PATH not set — /etc/profile.d/browser-env.sh did not source"
  exit 1
}
echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH"

# Playwright Chromium binary must exist under PLAYWRIGHT_BROWSERS_PATH
CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name chrome -type f 2>/dev/null | head -1)
[ -n "$CHROME_BIN" ] || {
  echo "::error::Playwright Chromium binary not found under $PLAYWRIGHT_BROWSERS_PATH"
  exit 1
}
echo "Chromium binary: $CHROME_BIN"
'

# Chromium readiness — check bot container logs for the "Chromium ready." message
# from entrypoint.d/10-chromium.sh. Capture logs first: `docker logs | grep -q`
# with `pipefail` can miss a match when grep exits early (SIGPIPE).
if [ -n "$BOT_CONTAINER" ]; then
  bot_logs=$("$RUNTIME" logs "$BOT_CONTAINER" 2>&1) || true
  if ! grep -qF "Chromium ready." <<<"$bot_logs"; then
    echo "::error::entrypoint.d/10-chromium.sh did not report 'Chromium ready.' in bot logs"
    exit 1
  fi
  echo "Chromium ready (from entrypoint.d log) OK"
fi

#!/bin/bash
# Start headless Chromium for chrome-devtools MCP

# Skip if Chromium already running (idempotent during transition period)
if curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    echo "Chromium already running, skipping"
    exit 0
fi

CHROME_BIN=$(find "${PLAYWRIGHT_BROWSERS_PATH:-/nonexistent}" -name chrome -type f 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
    echo "Chromium not installed, skipping"
    exit 0
fi
"$CHROME_BIN" \
    --headless --no-sandbox --disable-gpu \
    --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    --ignore-certificate-errors \
    --host-resolver-rules='MAP consent.trustarc.com 127.0.0.1' \
    --proxy-server="${HTTPS_PROXY:-http://proxy:3128}" \
    --proxy-bypass-list='*.foo.redhat.com;localhost;127.0.0.1' \
    --no-first-run --disable-sync --disable-extensions --disable-popup-blocking &

until curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; do sleep 1; done
echo "Chromium ready."

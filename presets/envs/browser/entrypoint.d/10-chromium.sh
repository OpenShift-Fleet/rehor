#!/bin/bash
# Start headless Chromium for chrome-devtools MCP

# Map SSO credentials to E2E vars (used by Playwright global-setup).
# SSO_USERNAME/SSO_PASSWORD are unset by entrypoint.sh before entrypoint.d runs,
# so read from the .credentials file that entrypoint.sh writes at line 36-39.
# BEGIN CREDENTIAL MAPPING.
CRED_FILE="${CRED_FILE:-/home/botuser/app/.credentials}"
if [ -z "${E2E_USER:-}" ] && [ -f "$CRED_FILE" ]; then
    E2E_USER=$(python3 -c "import json,sys; d=json.load(open('$CRED_FILE')); print(d['sso']['username'])" 2>/dev/null)
    if [ -z "$E2E_USER" ]; then
        echo "WARNING: Could not read SSO username from $CRED_FILE"
    fi
    E2E_PASSWORD=$(python3 -c "import json,sys; d=json.load(open('$CRED_FILE')); print(d['sso']['password'])" 2>/dev/null)
    if [ -z "$E2E_PASSWORD" ]; then
        echo "WARNING: Could not read SSO password from $CRED_FILE"
    fi
    if [ -n "$E2E_USER" ]; then
        export E2E_USER E2E_PASSWORD
    fi
fi
# END CREDENTIAL MAPPING

# Load extra hosts from instance config (e.g. instance/<name>/agent/extra-hosts)
# Standard /etc/hosts format — one entry per line:
#   127.0.0.1    stage.foo.redhat.com
#   ::1          stage.foo.redhat.com
#   10.0.0.5     custom.internal
for hosts_file in instance/*/agent/extra-hosts; do
    [ -f "$hosts_file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%%#*}"
        [ -z "${line// /}" ] && continue
        echo "$line" >> /etc/hosts 2>/dev/null || true
    done < "$hosts_file"
    echo "Loaded extra hosts from ${hosts_file}"
done

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

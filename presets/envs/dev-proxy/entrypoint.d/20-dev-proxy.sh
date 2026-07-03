#!/bin/bash
# Dev proxy is started on-demand by the bot via start-dev-proxy.sh,
# not at container startup. This script just verifies availability.

if ! command -v caddy &>/dev/null; then
    echo "WARNING: caddy not found — dev-proxy will not be available"
fi

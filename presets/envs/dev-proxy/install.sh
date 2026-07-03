#!/bin/bash
# Dev-proxy env preset — custom Caddy for local UI verification against stage
set -e

# Skip if already installed (idempotent during transition period)
# During transition, Caddy is built via multi-stage Dockerfile builder
if command -v caddy &>/dev/null; then
    echo "dev-proxy preset: caddy already installed, skipping"
    exit 0
fi

# Build Caddy from source (for when multi-stage builder is removed)
if [ -d /home/botuser/app/dev-proxy ]; then
    cd /home/botuser/app/dev-proxy
    go build -o /usr/local/bin/caddy .
    cp Caddyfile /etc/caddy/Caddyfile
    cp start-proxy.sh /usr/local/bin/start-dev-proxy.sh
    chmod +x /usr/local/bin/start-dev-proxy.sh
fi

#!/bin/bash
# Dev-proxy env preset — custom Caddy for local UI verification against stage
set -e

if ! command -v go &>/dev/null; then
    echo "ERROR: dev-proxy preset requires go preset (go not found)" >&2
    exit 1
fi

# Build Caddy from source
if [ -d /home/botuser/app/dev-proxy ]; then
    cd /home/botuser/app/dev-proxy
    go build -o /usr/local/bin/caddy .
    cp Caddyfile /etc/caddy/Caddyfile
    cp start-proxy.sh /usr/local/bin/start-dev-proxy.sh
    chmod +x /usr/local/bin/start-dev-proxy.sh
fi

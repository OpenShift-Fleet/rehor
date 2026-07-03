#!/bin/bash
# Browser env preset — Chromium + Playwright + chrome-devtools MCP
set -e

# Skip if already installed (idempotent during transition period)
if command -v chrome-devtools-mcp &>/dev/null && [ -d "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" ]; then
    echo "browser preset: already installed, skipping"
    exit 0
fi

# Chromium runtime libraries
dnf install -y --nodocs \
    alsa-lib atk at-spi2-atk at-spi2-core cairo cups-libs dbus-libs \
    libdrm mesa-libgbm glib2 nspr nss pango \
    libX11 libxcb libXcomposite libXdamage libXext libXfixes \
    libxkbcommon libXrandr \
    && dnf clean all

# Headless Chromium via Playwright
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
npx playwright install chromium

# chrome-devtools MCP server
npm install -g chrome-devtools-mcp@latest

#!/bin/bash
# Browser env preset — Chromium + Playwright + chrome-devtools MCP
set -e

if ! command -v npx &>/dev/null; then
    echo "ERROR: browser preset requires node preset (npx not found)" >&2
    exit 1
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

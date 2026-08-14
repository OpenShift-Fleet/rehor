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

# Helper script: align playwright browsers with a repo's pinned version.
# Repos may pin a different playwright version than what was used at build time.
# Usage: align-playwright-browsers <repo-dir>
# Symlinks the installed browser dirs to the version the repo's playwright expects.
cat > /usr/local/bin/align-playwright-browsers << 'SCRIPT'
#!/bin/bash
set -e
REPO_DIR="${1:-.}"
PW_BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
USER_CACHE="${HOME}/.cache/ms-playwright"

WANTED=$(cd "$REPO_DIR" && npx playwright install --dry-run 2>&1 | grep -oP 'chromium-\K\d+' | head -1)
INSTALLED=$(ls -d "$PW_BROWSERS"/chromium-* 2>/dev/null | grep -oP 'chromium-\K\d+' | head -1)

if [ -z "$WANTED" ] || [ -z "$INSTALLED" ]; then
    echo "[align-pw] Could not determine versions (wanted=$WANTED installed=$INSTALLED)" >&2
    exit 1
fi

if [ "$WANTED" = "$INSTALLED" ]; then
    echo "[align-pw] Versions match (chromium-$INSTALLED), no alignment needed"
    exit 0
fi

echo "[align-pw] Aligning: repo wants chromium-$WANTED, image has chromium-$INSTALLED"
mkdir -p "$USER_CACHE"
for dir in "$PW_BROWSERS"/*/; do
    base=$(basename "$dir")
    target_name=$(echo "$base" | sed "s/-${INSTALLED}/-${WANTED}/")
    if [ "$base" != "$target_name" ]; then
        ln -sfn "$dir" "$USER_CACHE/$target_name"
        echo "[align-pw] Linked $target_name -> $dir"
    else
        ln -sfn "$dir" "$USER_CACHE/$base"
    fi
done
SCRIPT
chmod +x /usr/local/bin/align-playwright-browsers

# Persist env vars for runtime (Playwright path needed to find Chromium)
NODE_BIN_DIR="$(dirname "$(which node)")"
cat > /etc/profile.d/browser-env.sh << PROFILE
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
export PATH="${NODE_BIN_DIR}:\$PATH"
PROFILE

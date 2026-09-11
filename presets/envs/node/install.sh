#!/bin/bash
# Node.js env preset — pinned Node.js, installed through nvm.
#
# The version is pinned and shared with the Dockerfiles through NODE_VERSION.
# This script is idempotent: when the image already carries exactly the pinned
# Node it leaves it alone. That matters because the dev-bot Dockerfile installs
# the same pinned version from the official tarball before this preset runs.
# Without the check, `nvm install` plus the symlinks below would silently
# replace a pinned install with a different one (see REHOR-149).
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.23.2}"
NVM_VERSION="${NVM_VERSION:-v0.40.3}"
# sha256 of https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh
NVM_INSTALL_SHA256="2d8359a64a3cb07c02389ad88ceecd43f2fa469c06104f92f98df5b6f315275f"

if command -v node >/dev/null 2>&1 && [ "$(node --version)" = "v${NODE_VERSION}" ]; then
    echo "[node] v${NODE_VERSION} already present — leaving the existing install in place"
    exit 0
fi

export NVM_DIR="${NVM_DIR:-/usr/local/nvm}"
mkdir -p "$NVM_DIR"

# Install nvm from a tag pinned by content hash, not just by ref.
curl -fsSL -o /tmp/nvm-install.sh \
    "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"
echo "${NVM_INSTALL_SHA256}  /tmp/nvm-install.sh" | sha256sum -c -
bash /tmp/nvm-install.sh
rm -f /tmp/nvm-install.sh

# nvm verifies the downloaded Node tarball against the release SHASUMS256.txt,
# so pinning the exact version here also pins its checksum.
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use default

installed=$(node --version)
if [ "$installed" != "v${NODE_VERSION}" ]; then
    echo "[node] expected v${NODE_VERSION}, got ${installed}" >&2
    exit 1
fi

# Make node/npm available system-wide (symlink for non-interactive shells)
NODE_PATH=$(nvm which current)
NODE_DIR=$(dirname "$NODE_PATH")
ln -sf "$NODE_DIR/node" /usr/local/bin/node
ln -sf "$NODE_DIR/npm" /usr/local/bin/npm
ln -sf "$NODE_DIR/npx" /usr/local/bin/npx

# Stable path to the active version, so globally installed npm binaries stay
# reachable without hardcoding the version number.
ln -sfn "$(dirname "$NODE_DIR")" /usr/local/nvm/current

# Add nvm init to profile so interactive shells get nvm
cat > /etc/profile.d/nvm.sh << 'PROFILE'
export NVM_DIR="/usr/local/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
PROFILE

echo "[node] installed v${NODE_VERSION}"

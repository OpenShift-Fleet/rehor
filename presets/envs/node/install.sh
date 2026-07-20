#!/bin/bash
# Node.js env preset — nvm + Node.js 22 LTS
set -e

export NVM_DIR="${NVM_DIR:-/usr/local/nvm}"

# Install nvm
mkdir -p "$NVM_DIR"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Source nvm and install default Node version
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
nvm use default

# Make node/npm available system-wide (symlink for non-interactive shells)
NODE_PATH=$(nvm which current)
NODE_DIR=$(dirname "$NODE_PATH")
ln -sf "$NODE_DIR/node" /usr/local/bin/node
ln -sf "$NODE_DIR/npm" /usr/local/bin/npm
ln -sf "$NODE_DIR/npx" /usr/local/bin/npx

# Add nvm init to profile so interactive shells get nvm
cat > /etc/profile.d/nvm.sh << 'PROFILE'
export NVM_DIR="/usr/local/nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
PROFILE

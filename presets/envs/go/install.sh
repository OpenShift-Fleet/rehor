#!/bin/bash
# Go env preset — goenv (go-nv) + default Go versions + golangci-lint
set -e

export GOENV_ROOT="${GOENV_ROOT:-/usr/local/goenv}"

# Skip if already installed (idempotent during transition period)
if [ -d "$GOENV_ROOT" ] && command -v go &>/dev/null && command -v golangci-lint &>/dev/null; then
    echo "go preset: already installed ($(go version)), skipping"
    exit 0
fi

ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')

# Install goenv
if [ ! -d "$GOENV_ROOT" ]; then
    git clone --depth 1 https://github.com/go-nv/goenv.git "$GOENV_ROOT"
fi

# Add goenv to PATH for this script
export PATH="$GOENV_ROOT/bin:$PATH"
eval "$(goenv init -)"

# Pre-install default Go versions
GOVERSIONS="${GOVERSIONS:-1.24.2 1.25.7}"
DEFAULT=$(echo $GOVERSIONS | awk '{print $1}')
for v in $GOVERSIONS; do
    if goenv versions --bare 2>/dev/null | grep -q "^${v}$"; then
        echo "Go ${v} already installed, skipping"
        continue
    fi
    echo "Installing Go ${v}..."
    goenv install "${v}"
done

# Set default (global) version
goenv global "${DEFAULT}"

# Add goenv init to profile so interactive shells get goenv
cat > /etc/profile.d/goenv.sh << 'PROFILE'
export GOENV_ROOT="/usr/local/goenv"
export PATH="$GOENV_ROOT/bin:$PATH"
eval "$(goenv init -)"
PROFILE

# Symlink go to /usr/local/bin for non-interactive shells
GO_BIN="$(goenv prefix)/bin/go"
if [ -f "$GO_BIN" ]; then
    ln -sf "$GO_BIN" /usr/local/bin/go
    ln -sf "$(goenv prefix)/bin/gofmt" /usr/local/bin/gofmt
fi

# golangci-lint
if ! command -v golangci-lint &>/dev/null; then
    curl -fsSL "https://github.com/golangci/golangci-lint/releases/download/v2.1.6/golangci-lint-2.1.6-linux-${ARCH}.tar.gz" \
        | tar -xz -C /usr/local/bin --strip-components=1 --wildcards '*/golangci-lint'
fi

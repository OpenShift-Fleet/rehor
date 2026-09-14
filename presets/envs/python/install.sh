#!/bin/bash
# Python env preset — pyenv (version manager) + ruff + mypy
# System Python 3.12 (bot runtime via uv) is left untouched — no python/python3 symlinks.
set -e

export PYENV_ROOT="${PYENV_ROOT:-/usr/local/pyenv}"

if [ -d "$PYENV_ROOT" ] && [ -f /etc/profile.d/pyenv.sh ] \
    && command -v ruff &>/dev/null && command -v mypy &>/dev/null; then
    echo "python preset: already installed, skipping"
    exit 0
fi

# Build deps for pyenv to compile Python versions (readline-devel is CRB-only on RHEL;
# Python builds fine without readline support for bot/CI use)
dnf install -y --nodocs \
    patch zlib-devel bzip2-devel openssl-devel libffi-devel sqlite-devel ncurses-devel xz-devel
dnf clean all

# Install pyenv
if [ ! -d "$PYENV_ROOT" ]; then
    git clone --depth 1 https://github.com/pyenv/pyenv.git "$PYENV_ROOT"
fi

export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"

# Pre-install default Python versions (override with PYTHONVERSIONS build arg)
PYTHONVERSIONS="${PYTHONVERSIONS:-3.12.8}"
DEFAULT=$(echo $PYTHONVERSIONS | awk '{print $1}')
for v in $PYTHONVERSIONS; do
    if pyenv versions --bare 2>/dev/null | grep -q "^${v}$"; then
        echo "Python ${v} already installed, skipping"
        continue
    fi
    echo "Installing Python ${v}..."
    # ensurepip fails as root on UBI; pip is installed below
    PYTHON_CONFIGURE_OPTS="${PYTHON_CONFIGURE_OPTS:---without-ensurepip}" pyenv install "${v}"
done

pyenv global "${DEFAULT}"

cat > /etc/profile.d/pyenv.sh << 'PROFILE'
export PYENV_ROOT="/usr/local/pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
PROFILE

# Install lint/type tools into pyenv's default Python.
# --without-ensurepip leaves no pip module; bootstrap it before ruff/mypy.
PYENV_PYTHON="$(pyenv prefix)/bin/python"
if ! "$PYENV_PYTHON" -m pip --version &>/dev/null; then
    "$PYENV_PYTHON" -c "import urllib.request; urllib.request.urlretrieve('https://bootstrap.pypa.io/get-pip.py', '/tmp/get-pip.py')"
    "$PYENV_PYTHON" /tmp/get-pip.py
    rm -f /tmp/get-pip.py
fi
"$PYENV_PYTHON" -m pip install --upgrade pip
"$PYENV_PYTHON" -m pip install 'ruff>=0.8.0' 'mypy>=1.11.0'

# Symlinks for non-interactive shells (tools only — not python/python3/pip)
ln -sf "$PYENV_ROOT/bin/pyenv" /usr/local/bin/pyenv
ln -sf "$(pyenv prefix)/bin/ruff" /usr/local/bin/ruff
ln -sf "$(pyenv prefix)/bin/mypy" /usr/local/bin/mypy

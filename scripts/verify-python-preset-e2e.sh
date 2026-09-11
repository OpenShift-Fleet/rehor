#!/bin/bash
# E2E verification for presets/envs/python — run on Linux or via podman/docker.
# Usage:
#   bash scripts/verify-python-preset-e2e.sh          # local (needs root + dnf on UBI/RHEL)
#   bash scripts/verify-python-preset-e2e.sh --container  # podman/docker UBI test
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER_RT="${CONTAINER_RT:-$(command -v podman >/dev/null && echo podman || echo docker)}"

run_checks() {
    local root="$1"
    cd "$root"

    echo "=== Installing base deps (mirrors Dockerfile.runner) ==="
    dnf install -y --nodocs python3.12 python3.12-pip python3.12-devel git gcc make sqlite-devel
    ln -sf /usr/bin/python3.12 /usr/bin/python3
    ln -sf /usr/bin/python3.12 /usr/bin/python
    pip3.12 install uv
    SYSTEM_PY=$(readlink -f /usr/bin/python3.12)
    echo "System python: $SYSTEM_PY"

    echo "=== First install (python preset) ==="
    bash presets/envs/python/install.sh

    echo "=== Tooling checks ==="
    # shellcheck disable=SC1091
    . /etc/profile.d/pyenv.sh
    command -v pyenv
    pyenv --version
    command -v ruff
    ruff --version
    command -v mypy
    mypy --version
    test -f /etc/profile.d/pyenv.sh
    pyenv versions --bare | grep -q "^3.12.8$"

    echo "=== System python unchanged ==="
    test "$(readlink -f /usr/bin/python3.12)" = "$SYSTEM_PY"
    test ! -e /usr/local/bin/python
    test ! -e /usr/local/bin/python3
    /usr/bin/python3.12 -c "import sys; assert sys.version_info[:2]==(3,12)"

    echo "=== Idempotency (second install) ==="
    bash presets/envs/python/install.sh

    echo "=== install-envs selection ==="
    work=$(mktemp -d)
    mkdir -p "$work/instance/demo/agent"
    cat > "$work/instance/demo/agent/instance.yaml" <<EOF
workflow: jira-sprint
source: jira
envs:
  - python
EOF
    cp -r presets "$work/presets"
    for env in node go browser container-scan dev-proxy patternfly-mcp slack; do
        mkdir -p "$work/presets/envs/$env"
        printf '#!/bin/bash\necho "stub-%s should not run" >&2\nexit 1\n' "$env" > "$work/presets/envs/$env/install.sh"
        chmod +x "$work/presets/envs/$env/install.sh"
    done
    OUT=$(cd "$work" && bash presets/install-envs.sh 2>&1)
    echo "$OUT"
    echo "$OUT" | grep -q "Selected envs: python"
    echo "$OUT" | grep -q "Installing: python"
    echo "$OUT" | grep -q "already installed, skipping"
    rm -rf "$work"

    echo "=== ALL E2E CHECKS PASSED ==="
}

if [ "${1:-}" = "--container" ]; then
    "$CONTAINER_RT" run --rm -v "$REPO_ROOT:/src:Z" -w /src registry.access.redhat.com/ubi9/ubi:latest \
        bash /src/scripts/verify-python-preset-e2e.sh
    exit 0
fi

run_checks "$REPO_ROOT"

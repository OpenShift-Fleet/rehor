#!/bin/bash
# Selective env preset installer — reads instance.yaml envs lists and installs
# only the presets each instance needs. Unions across all instance configs so the
# single image can serve multiple instance configs (e.g. implementer + groomer).
#
# Falls back to installing ALL presets if no instance.yaml is found (local dev).
set -e

ENVS=""
FOUND_CONFIG=false
for cfg in instance/*/agent/instance.yaml; do
    [ -f "$cfg" ] || continue
    FOUND_CONFIG=true
    ENVS="$ENVS $(sed -n '/^envs:/,/^[^ ]/{ s/^  - //p }' "$cfg")"
done
ENVS=$(echo "$ENVS" | tr ' ' '\n' | sort -u | xargs)

if [ "$FOUND_CONFIG" = false ]; then
    echo "[install-envs] No instance.yaml found — installing all presets (local dev)"
    shopt -s nullglob
    for script in presets/envs/*/install.sh; do
        echo "[install-envs] Running $(basename "$(dirname "$script")")"
        bash "$script"
    done
    exit 0
fi

if [ -z "$ENVS" ]; then
    echo "[install-envs] instance.yaml found but no envs specified — skipping preset install"
    exit 0
fi

echo "[install-envs] Selected envs: $ENVS"

run_preset() {
    local env="$1"
    local script="presets/envs/$env/install.sh"
    if [ -f "$script" ]; then
        echo "[install-envs] Installing: $env"
        bash "$script"
    else
        echo "[install-envs] $env has no install.sh — skipping"
    fi
}

# Runtimes first, then tools that depend on them
ORDER="node go python browser container-scan dev-proxy patternfly-mcp slack"

for env in $ORDER; do
    echo "$ENVS" | tr ' ' '\n' | grep -qx "$env" || continue
    run_preset "$env"
done

# Run any envs not in ORDER (future custom presets)
for env in $ENVS; do
    echo "$ORDER" | tr ' ' '\n' | grep -qx "$env" && continue
    run_preset "$env"
done

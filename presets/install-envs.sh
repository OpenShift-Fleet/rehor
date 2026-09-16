#!/bin/bash
# Selective env preset installer — reads instance.yaml envs lists and installs
# only the presets each instance needs. Unions across all instance configs so the
# single image can serve multiple instance configs (e.g. implementer + groomer).
#
# Falls back to installing ALL presets if no instance.yaml is found (local dev).
set -e

ENVS=""
FOUND_CONFIG=false

CONFIG_FILES=()
if [ -n "${INSTANCE_CONFIG_PATH:-}" ]; then
    case "$INSTANCE_CONFIG_PATH" in
        /*|*..*)
            echo "[install-envs] Invalid INSTANCE_CONFIG_PATH: $INSTANCE_CONFIG_PATH" >&2
            exit 1
            ;;
    esac
    if [[ "$INSTANCE_CONFIG_PATH" == instance/* ]]; then
        CONFIG_FILES=("$INSTANCE_CONFIG_PATH/agent/instance.yaml")
    else
        CONFIG_FILES=("instance/$INSTANCE_CONFIG_PATH/agent/instance.yaml")
    fi
    if [ ! -f "${CONFIG_FILES[0]}" ]; then
        echo "[install-envs] Config not found: ${CONFIG_FILES[0]}" >&2
        exit 1
    fi
else
    shopt -s nullglob
    CONFIG_FILES=(instance/*/agent/instance.yaml)
    shopt -u nullglob
fi

for cfg in "${CONFIG_FILES[@]}"; do
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
ORDER="node go browser container-scan dev-proxy patternfly-mcp slack"

for env in $ORDER; do
    echo "$ENVS" | tr ' ' '\n' | grep -qx "$env" || continue
    run_preset "$env"
done

# Run any envs not in ORDER (future custom presets)
for env in $ENVS; do
    echo "$ORDER" | tr ' ' '\n' | grep -qx "$env" && continue
    run_preset "$env"
done

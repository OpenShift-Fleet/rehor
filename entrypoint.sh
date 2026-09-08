#!/bin/bash
# Bot container entrypoint — decode secrets, run env presets, launch bot.
set -e

# --- Verify required CLI tools ---
MISSING=""
for tool in gh glab git gpg; do
    if ! command -v "$tool" &>/dev/null; then
        MISSING="$MISSING $tool"
    fi
done
if [ -n "$MISSING" ]; then
    echo "FATAL: Missing required tools:$MISSING" >&2
    echo "Rebuild with: docker compose build --no-cache bot" >&2
    exit 1
fi

# Kubernetes secretKeyRef auto-decodes base64, so secrets arrive as raw values
# in OpenShift. Local docker-compose still passes them base64-encoded via .env.
# This helper handles both: values starting with "-----" or "{" are not valid
# base64 and are the only two raw formats we expect, so write them as-is.
# Everything else is base64-decoded.
decode_or_raw() {
    case "$1" in
        -----*|"{"*) printf '%s' "$1" ;;
        *) echo "$1" | base64 -d 2>/dev/null ;;
    esac
}

# Git credential helpers — thin clients forward to executor sidecar in proxy container
git config --global credential.https://github.com.helper '!/usr/local/bin/gh auth git-credential'
git config --global credential.https://gitlab.cee.redhat.com.helper '!/usr/local/bin/glab credential-helper'

# Optional: internal GitLab CA bundle for strict TLS in bot-side git/curl flows.
# Supports either raw PEM (GITLAB_CA_CERT_PEM) or base64 PEM (GITLAB_CA_CERT_B64).
if [ -n "${GITLAB_CA_CERT_B64:-}" ] && [ -z "${GITLAB_CA_CERT_PEM:-}" ]; then
    GITLAB_CA_CERT_PEM="$(printf '%s' "$GITLAB_CA_CERT_B64" | tr -d '[:space:]' | base64 -d 2>/dev/null || true)"
    export GITLAB_CA_CERT_PEM
fi

if [ -n "${GITLAB_CA_CERT_PEM:-}" ] && [ -z "${GITLAB_CA_CERT_FILE:-}" ]; then
    GITLAB_CA_CERT_FILE="/home/botuser/.config/gitlab-ca-cert.pem"
    mkdir -p "$(dirname "$GITLAB_CA_CERT_FILE")"
    printf '%s\n' "$GITLAB_CA_CERT_PEM" > "$GITLAB_CA_CERT_FILE"
    chmod 600 "$GITLAB_CA_CERT_FILE"
    export GITLAB_CA_CERT_FILE
fi

if [ -n "${GITLAB_CA_CERT_FILE:-}" ]; then
    export SSL_CERT_FILE="$GITLAB_CA_CERT_FILE"
    export GIT_SSL_CAINFO="$GITLAB_CA_CERT_FILE"
    export CURL_CA_BUNDLE="$GITLAB_CA_CERT_FILE"
    git config --global http."https://gitlab.cee.redhat.com/".sslCAInfo "$GITLAB_CA_CERT_FILE"
    git config --global http."https://gitlab.cee.redhat.com/".sslVerify true
fi

# Write SSO credentials file for stage auth (chrome-devtools)
if [ -n "${SSO_USERNAME:-}" ] && [ -n "${SSO_PASSWORD:-}" ]; then
    cat > /home/botuser/app/.credentials <<EOF
{"sso": {"username": "${SSO_USERNAME}", "password": "${SSO_PASSWORD}"}}
EOF
    chmod 600 /home/botuser/app/.credentials
    unset SSO_USERNAME SSO_PASSWORD
fi

# --- Wait for executor (provides gh/glab/gpg via proxy) ---
# Must be ready BEFORE GPG key lookups (gpg is a thin client to proxy)
EXECUTOR_ADDR="${EXECUTOR_ADDR:-unix:///var/run/devbot/executor.sock}"
echo "Waiting for executor at ${EXECUTOR_ADDR}..."
elapsed=0
if [[ "$EXECUTOR_ADDR" == unix://* ]]; then
    SOCK_PATH="${EXECUTOR_ADDR#unix://}"
    until [ -S "$SOCK_PATH" ]; do
        elapsed=$((elapsed + 1))
        [ "$elapsed" -ge 30 ] && { echo "FATAL: executor socket not ready after 30s" >&2; exit 1; }
        sleep 1
    done
else
    EXEC_HOST="${EXECUTOR_ADDR%%:*}"
    EXEC_PORT="${EXECUTOR_ADDR##*:}"
    until bash -c "echo > /dev/tcp/${EXEC_HOST}/${EXEC_PORT}" 2>/dev/null; do
        elapsed=$((elapsed + 1))
        [ "$elapsed" -ge 30 ] && { echo "FATAL: executor at ${EXECUTOR_ADDR} not ready after 30s" >&2; exit 1; }
        sleep 1
    done
fi
echo "Executor ready."

# Per-platform git identity via includeIf (git 2.36+)
# Each platform gets its own name, email, and GPG signing key.
GH_GPG_KEY="$(gpg --list-secret-keys --keyid-format long "${GH_USER_EMAIL}" 2>/dev/null | grep -oP '(?<=/)[A-F0-9]{16}' | head -1)"
GL_GPG_KEY="$(gpg --list-secret-keys --keyid-format long "${GL_USER_EMAIL}" 2>/dev/null | grep -oP '(?<=/)[A-F0-9]{16}' | head -1)"

# Export so run.py's setup_git() writes them into GIT_CONFIG_GLOBAL gitconfig
export GH_GPG_SIGNING_KEY="$GH_GPG_KEY"
export GL_GPG_SIGNING_KEY="$GL_GPG_KEY"

cat > /home/botuser/.gitconfig-gh <<EOF
[user]
	name = ${GH_USER_NAME}
	email = ${GH_USER_EMAIL}
	signingkey = ${GH_GPG_KEY}
EOF

cat > /home/botuser/.gitconfig-gl <<EOF
[user]
	name = ${GL_USER_NAME}
	email = ${GL_USER_EMAIL}
	signingkey = ${GL_GPG_KEY}
EOF

git config --global 'includeIf.hasconfig:remote.*.url:https://github.com/**.path' /home/botuser/.gitconfig-gh
git config --global 'includeIf.hasconfig:remote.*.url:https://gitlab.cee.redhat.com/**.path' /home/botuser/.gitconfig-gl

# Verify per-platform identity + GPG signing (warn-only, never fatal)
verify_platform_signing() {
    local platform="$1" url="$2" expected_email="$3"
    local tmpdir
    tmpdir=$(mktemp -d)
    git init -q "$tmpdir"
    git -C "$tmpdir" remote add origin "$url"
    local resolved_email resolved_key
    resolved_email=$(git -C "$tmpdir" config user.email)
    resolved_key=$(git -C "$tmpdir" config user.signingkey)
    rm -rf "$tmpdir"

    if [ -z "$resolved_email" ]; then
        echo "WARNING: ${platform} — includeIf did not resolve identity"
        return
    fi
    if [ "$resolved_email" != "$expected_email" ]; then
        echo "WARNING: ${platform} — email mismatch: got ${resolved_email}, expected ${expected_email}"
        return
    fi
    if [ -z "$resolved_key" ]; then
        echo "WARNING: ${platform} — no GPG signing key resolved"
        return
    fi
    if echo "test" | gpg --local-user "$resolved_key" --sign > /dev/null 2>&1; then
        echo "${platform} identity + GPG signing OK (${resolved_email})"
    else
        echo "WARNING: ${platform} — GPG key cannot sign (missing or expired)"
    fi
}
verify_platform_signing "GitHub" "https://github.com/test/repo.git" "${GH_USER_EMAIL}"
verify_platform_signing "GitLab" "https://gitlab.cee.redhat.com/test/repo.git" "${GL_USER_EMAIL}"

# Jira credentials are in the proxy container (mcp-atlassian on port 8444).
# Python skills use JIRA_MCP_URL env var to connect via MCP protocol.

# Point MCP config to the memory server
sed -i "s|http://localhost:8080/mcp|${BOT_MEMORY_URL}|" .mcp.json

# --- Verify auth (via thin client → proxy) ---
echo "Verifying GitHub auth..."
gh auth status 2>&1 | head -3 || { echo "WARNING: gh auth failed"; }
echo "Verifying GitLab auth..."
glab auth status --hostname gitlab.cee.redhat.com 2>&1 | head -3 || { echo "WARNING: glab auth failed"; }

# --- Wait for dependent services (OpenShift deploys all pods concurrently) ---
wait_for_http() {
    local name="$1" url="$2" timeout="${3:-120}"
    echo "Waiting for ${name} at ${url} (timeout=${timeout}s)..."
    local elapsed=0
    until curl -sf --noproxy '*' "$url" > /dev/null 2>&1; do
        elapsed=$((elapsed + 2))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo "FATAL: ${name} not ready after ${timeout}s" >&2
            exit 1
        fi
        sleep 2
    done
    echo "${name} is ready."
}

wait_for_tcp() {
    local name="$1" host="$2" port="$3" timeout="${4:-120}"
    echo "Waiting for ${name} at ${host}:${port} (timeout=${timeout}s)..."
    local elapsed=0
    until bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null; do
        elapsed=$((elapsed + 2))
        if [ "$elapsed" -ge "$timeout" ]; then
            echo "FATAL: ${name} not ready after ${timeout}s" >&2
            exit 1
        fi
        sleep 2
    done
    echo "${name} is ready."
}

# Proxy must be up before Chromium (which routes through it)
# Uses TCP check — Squid doesn't serve HTTP on its proxy port
# TODO: update template to replace BOT_PROXY_HEALTH_URL with PROXY_HOST/PROXY_PORT
if [ -n "${PROXY_HOST:-}" ]; then
    wait_for_tcp "proxy" "$PROXY_HOST" "${PROXY_PORT:-3128}" "${BOT_PROXY_HEALTH_TIMEOUT:-60}"
fi

# Memory server must be up before the bot connects via MCP
if [ -n "${BOT_MEMORY_HEALTH_URL:-}" ]; then
    wait_for_http "memory-server" "$BOT_MEMORY_HEALTH_URL" "${BOT_MEMORY_HEALTH_TIMEOUT:-120}"
fi


# Source env preset profile scripts (persist env vars from install time)
# || true: profile scripts may return non-zero (e.g. goenv warnings) which
# must not be fatal under set -e
for pf in /etc/profile.d/*.sh; do [ -f "$pf" ] && . "$pf" || true; done

# Run env preset entrypoint scripts — only for installed envs
INSTALLED_ENVS=""
for cfg in instance/*/agent/instance.yaml; do
    [ -f "$cfg" ] || continue
    INSTALLED_ENVS="$INSTALLED_ENVS $(sed -n '/^envs:/,/^[^ ]/{ s/^  - //p }' "$cfg")"
done
INSTALLED_ENVS=$(echo "$INSTALLED_ENVS" | tr ' ' '\n' | sort -u | xargs)
shopt -s nullglob
if [ -z "$INSTALLED_ENVS" ]; then
    for script in presets/envs/*/entrypoint.d/*.sh; do bash "$script"; done
else
    for env in $INSTALLED_ENVS; do
        for script in presets/envs/$env/entrypoint.d/*.sh; do bash "$script"; done
    done
fi
shopt -u nullglob

echo "Credentials configured. Starting bot with label: ${BOT_LABEL}"
exec uv run dev-bot --label "$BOT_LABEL"

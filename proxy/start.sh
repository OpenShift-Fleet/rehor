#!/bin/bash
set -e

# Configure gh auth (token from env)
mkdir -p ~/.config/gh
cat > ~/.config/gh/hosts.yml <<EOF
github.com:
    oauth_token: ${GH_TOKEN}
    user: ${GH_USERNAME:-}
    git_protocol: https
EOF
chmod 600 ~/.config/gh/hosts.yml

# Configure glab auth (token from env)
if [ -n "${GITLAB_TOKEN:-}" ]; then
    mkdir -p ~/.config/glab-cli
    cat > ~/.config/glab-cli/config.yml <<EOF
git_protocol: https
check_update: false
no_prompt: true
host: gitlab.cee.redhat.com
hosts:
    gitlab.cee.redhat.com:
        token: ${GITLAB_TOKEN}
        api_protocol: https
        api_host: gitlab.cee.redhat.com
        git_protocol: https
        skip_tls_verify: true
EOF
    chmod 600 ~/.config/glab-cli/config.yml
fi

# Import GPG keys for commit signing (keys live in proxy, not bot)
if [ -n "${GPG_PRIVATE_KEY_B64:-}" ]; then
    case "$GPG_PRIVATE_KEY_B64" in
        -----*|"{"*) printf '%s' "$GPG_PRIVATE_KEY_B64" | gpg --batch --import 2>/dev/null ;;
        *) echo "$GPG_PRIVATE_KEY_B64" | base64 -d | gpg --batch --import 2>/dev/null ;;
    esac
    echo "GPG keys imported in proxy container"
fi

# Decode GCP service account key for Vertex AI auth proxy
if [ -n "${GOOGLE_SA_KEY_B64:-}" ]; then
    SA_KEY_PATH="/var/run/devbot/vertex-sa.json"
    case "$GOOGLE_SA_KEY_B64" in
        -----*|"{"*) printf '%s' "$GOOGLE_SA_KEY_B64" > "$SA_KEY_PATH" ;;
        *) printf '%s' "$GOOGLE_SA_KEY_B64" | tr -d '[:space:]' | base64 -d > "$SA_KEY_PATH" ;;
    esac
    chmod 600 "$SA_KEY_PATH"
    export GOOGLE_APPLICATION_CREDENTIALS="$SA_KEY_PATH"
    echo "GCP SA key decoded for vertex-auth-proxy"
fi

# Start Squid in background
squid -N -f /etc/squid/squid.conf &
SQUID_PID=$!

# Start mcp-atlassian MCP server (streamable HTTP transport)
# Jira creds stay in proxy — bot connects via HTTP transport
MCP_PID=""
if [ -n "${JIRA_URL:-}" ] && [ -n "${JIRA_USERNAME:-}" ] && [ -n "${JIRA_API_TOKEN:-}" ]; then
    MCP_PORT="${MCP_ATLASSIAN_PORT:-8444}"
    JIRA_URL="${JIRA_URL}" \
    JIRA_USERNAME="${JIRA_USERNAME}" \
    JIRA_API_TOKEN="${JIRA_API_TOKEN}" \
    mcp-atlassian --transport streamable-http --port "$MCP_PORT" &
    MCP_PID=$!
    echo "mcp-atlassian listening on port $MCP_PORT (PID=$MCP_PID)"
fi

# Start executor server in background
# EXECUTOR_LISTEN controls transport: unix:///path (local dev) or :9090 (k8s)
/usr/local/bin/executor-server \
    --listen "${EXECUTOR_LISTEN:-unix:///var/run/devbot/executor.sock}" \
    --gh-path /usr/local/bin/gh-real \
    --glab-path /usr/local/bin/glab-real \
    --gpg-path /usr/bin/gpg &
EXECUTOR_PID=$!

cleanup() { kill $SQUID_PID $EXECUTOR_PID ${MCP_PID:-} 2>/dev/null; }
trap cleanup EXIT TERM INT

wait -n $SQUID_PID $EXECUTOR_PID ${MCP_PID:+"$MCP_PID"}
exit $?


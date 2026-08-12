#!/bin/bash
# PreToolUse hook — scan outgoing content for secrets before posting
# to Jira, GitHub, GitLab, or any external service.
#
# Checks tool input fields (body, comment, description, etc.) for patterns
# that look like secrets: private keys, API tokens, long hex strings, etc.

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')

deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Extract all string values from tool_input (body, comment, description, title, content, etc.)
# Flatten into one blob of text to scan
TEXT=$(echo "$INPUT" | jq -r '[.tool_input | .. | strings] | join("\n")' 2>/dev/null || echo "")

if [[ -z "$TEXT" ]]; then
  exit 0
fi

# --- PRIVATE KEYS ---
if echo "$TEXT" | grep -qE -e 'BEGIN (RSA |EC |OPENSSH |DSA |PGP )?(PRIVATE KEY|PRIVATE KEY BLOCK)'; then
  deny "BLOCKED: Output contains a private key. Never post private keys to external services."
fi

# --- PGP KEY BLOCKS ---
if echo "$TEXT" | grep -qE -e 'BEGIN PGP (PRIVATE|PUBLIC) KEY BLOCK'; then
  deny "BLOCKED: Output contains a PGP key block. Never post key material to external services."
fi

# --- API TOKENS / BEARER TOKENS ---
if echo "$TEXT" | grep -qiE -e 'ghp_[A-Za-z0-9]{36}' -e 'gho_[A-Za-z0-9]{36}' -e 'github_pat_[A-Za-z0-9_]{80,}'; then
  deny "BLOCKED: Output contains what looks like a GitHub token."
fi
if echo "$TEXT" | grep -qiE -e 'glpat-[A-Za-z0-9_-]{20,}'; then
  deny "BLOCKED: Output contains what looks like a GitLab personal access token."
fi
if echo "$TEXT" | grep -qiE -e 'Bearer[[:space:]]+[A-Za-z0-9_.-]{40,}'; then
  deny "BLOCKED: Output contains a Bearer token."
fi

# --- JIRA / ATLASSIAN API TOKENS ---
if echo "$TEXT" | grep -qiE -e 'ATATT[A-Za-z0-9_-]{50,}'; then
  deny "BLOCKED: Output contains what looks like an Atlassian API token."
fi

# --- AWS KEYS ---
if echo "$TEXT" | grep -qE -e 'AKIA[0-9A-Z]{16}'; then
  deny "BLOCKED: Output contains what looks like an AWS access key."
fi

# --- SLACK WEBHOOK URLS ---
if echo "$TEXT" | grep -qiE -e 'hooks\.slack\.com/(services|workflows|triggers)/[A-Za-z0-9/_-]+'; then
  deny "BLOCKED: Output contains a Slack webhook URL. Never post webhook URLs — use a Vault-backed secret reference (REHOR-123)."
fi

# --- SLACK TOKENS ---
# xox[bpoas]- covers bot/user/legacy-workspace/legacy/legacy-workspace tokens;
# xapp-<version>-<part>-<id>-<hash> is Slack's documented app-level token format.
if echo "$TEXT" | grep -qiE -e 'xox[bpoas]-[A-Za-z0-9-]{10,}' -e 'xapp-[0-9]-[A-Za-z0-9]+-[0-9]+-[a-z0-9]+'; then
  deny "BLOCKED: Output contains what looks like a Slack API token."
fi

# --- GENERIC LONG HEX/BASE64 SECRETS ---
if echo "$TEXT" | grep -qiE -e '(signing|gpg|pgp|key|secret).{0,30}[0-9A-Fa-f]{40,}'; then
  deny "BLOCKED: Output contains what looks like a key fingerprint or secret in a sensitive context."
fi

# --- SSH KEY MATERIAL ---
if echo "$TEXT" | grep -qE -e 'ssh-(rsa|ed25519|ecdsa|dss)[[:space:]]+[A-Za-z0-9+/]{60,}'; then
  deny "BLOCKED: Output contains SSH public key material."
fi

# --- BASE64-ENCODED BLOBS (likely secrets) ---
if echo "$TEXT" | grep -qiE -e '(key|secret|token|password|credential|private)[_ ]*[:=][[:space:]]*[A-Za-z0-9+/]{60,}'; then
  deny "BLOCKED: Output contains what looks like an encoded secret value."
fi

# All clean
exit 0

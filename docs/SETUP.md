# Setup Guide

## 1. Bot Identity (GitHub)

One-time setup for creating a bot account with PAT and GPG commit signing.

### 1.1 Create the GitHub account

Sign up at github.com with a dedicated bot email. Choose a recognizable username.

### 1.2 Generate a GPG key for commit signing

```bash
gpg --quick-gen-key "<bot-username> <<bot-email>>" ed25519 sign 0
```

Export the keys:
```bash
# Public key — add to GitHub account
gpg --armor --export "<bot-username>" > .ssh/gpg-public.asc

# Private key — store securely for container injection
gpg --armor --export-secret-keys "<bot-username>" > .ssh/gpg-private.asc
```

Add the **public** key (`gpg-public.asc`) to the bot's GitHub account:
GitHub > Settings > SSH and GPG keys > New GPG key.

### 1.3 Create a Personal Access Token

Go to https://github.com/settings/tokens (logged in as the bot account).

Create a classic token with these scopes:
- `repo` — full repo access (PRs, code, status)

The token is used by the `gh` CLI for GitHub API calls and as a git credential helper for HTTPS clone/push.

### 1.4 Grant repo access

Add the bot account as a collaborator (or team member) to each repo it needs to push to. The bot needs write access to create branches and open PRs.

For org repos, an org admin must invite the bot account to the appropriate team.

## 2. Environment Variables

### 2.1 Secrets

These secrets are needed for deployment. All live in the **proxy container** (including Jira credentials — mcp-atlassian runs in the proxy on port 8444).

| Secret | How to generate | Lives in | Used for |
|--------|----------------|----------|----------|
| `GH_TOKEN` | PAT from step 1.3 | **Proxy** | gh CLI + git credential helper (HTTPS) |
| `GITLAB_TOKEN` | GitLab PAT (api + write_repository) | **Proxy** | glab CLI + git credential helper (HTTPS) |
| `GPG_PRIVATE_KEY_B64` | `base64 -i .ssh/gpg-private.asc` | **Proxy** | commit signing |
| `GOOGLE_SA_KEY_B64` | `base64 < sa-key.json` | **Proxy** | Vertex AI auth (Claude API) |
| `VERTEX_ALLOWED_MODELS` | Comma-separated model IDs | **Proxy** | Model allowlist for Vertex AI |

### 2.2 Set environment variables

The proxy container expects secrets as env vars. Set them before running:

```bash
export GH_TOKEN=<pat-token>
export GITLAB_TOKEN=<gitlab-pat>
export GPG_PRIVATE_KEY_B64=$(base64 -i .ssh/gpg-private.asc)
export GOOGLE_SA_KEY_B64=$(base64 < sa-key.json)
export VERTEX_ALLOWED_MODELS=claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
```

For persistent use, add these to a `.env` file (already gitignored):

```bash
GH_TOKEN=<pat-token>
GITLAB_TOKEN=<gitlab-pat>
GPG_PRIVATE_KEY_B64=<base64-encoded-gpg-key>
GOOGLE_SA_KEY_B64=<base64-encoded-sa-key>
VERTEX_ALLOWED_MODELS=claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
```

The compose file automatically reads `.env` from the project root.

For OpenShift, store these as secrets and inject them as env vars into the pod.

## 3. Local Development (Multiple GitHub Accounts)

When running the bot locally alongside your personal GitHub account, use separate `gh` auth contexts or set `GH_TOKEN` in `.env` to the bot's PAT. The bot uses HTTPS with credential helpers for all git operations — no SSH configuration needed.

Fork URLs in the remote config's `project-repos.json` use HTTPS:

```json
"pdf-generator": {
  "url": "https://github.com/platex-rehor-bot/pdf-generator.git",
  "upstream": "https://github.com/RedHatInsights/pdf-generator.git"
}
```

## 4. Verification

Build and enter the container:

```bash
podman compose run --rm bot
```

Run these checks:

```bash
# GH CLI
gh auth status
# Expected: "Logged in to github.com account <bot-username>"

# GPG signing
git init /tmp/test && cd /tmp/test && git commit --allow-empty -m "test sign"
# Expected: commit succeeds (signed)

# Clone a repo via HTTPS
git clone https://github.com/<bot-username>/<repo>.git /tmp/test-clone
# Expected: clones without errors (credential helper provides auth)
```

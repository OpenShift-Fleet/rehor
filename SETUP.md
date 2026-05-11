# Setup Guide

## 1. Bot Identity (GitHub)

One-time setup for creating a bot account with SSH and GPG commit signing.

### 1.1 Create the GitHub account

Sign up at github.com with a dedicated bot email. Choose a recognizable username.

### 1.2 Generate an SSH key

```bash
ssh-keygen -t ed25519 -C "<bot-email>" -f .ssh/id_ed25519
```

Add the **public** key (`.ssh/id_ed25519.pub`) to the bot's GitHub account:
GitHub > Settings > SSH and GPG keys > New SSH key.

### 1.3 Generate a GPG key for commit signing

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

### 1.4 Create a Personal Access Token

Go to https://github.com/settings/tokens (logged in as the bot account).

Create a classic token with these scopes:
- `repo` — full repo access (PRs, code, status)

The token is used by the `gh` CLI for GitHub API calls (creating PRs, posting comments, reading reviews). Git push/pull uses SSH, not the token.

### 1.5 Grant repo access

Add the bot account as a collaborator (or team member) to each repo it needs to push to. The bot needs write access to create branches and open PRs.

For org repos, an org admin must invite the bot account to the appropriate team.

## 2. Environment Variables

### 2.1 Secrets

These secrets are needed for deployment:

| Secret | How to generate | Lives in | Used for |
|--------|----------------|----------|----------|
| `SSH_PRIVATE_KEY_B64` | `base64 -i .ssh/id_ed25519` | Bot | git push/pull over SSH |
| `GPG_PRIVATE_KEY_B64` | `base64 -i .ssh/gpg-private.asc` | **Proxy** | commit signing |
| `GH_TOKEN` | PAT from step 1.4 | **Proxy** | `gh` CLI (GitHub API) |
| `GITLAB_TOKEN` | GitLab PAT (api + write_repository) | **Proxy** | `glab` CLI (GitLab API) |
| `GOOGLE_SA_KEY_B64` | `base64 < sa-key.json` | **Proxy** | Vertex AI auth (Claude API) |
| `VERTEX_ALLOWED_MODELS` | Comma-separated model IDs | **Proxy** | Model allowlist for Vertex AI |

### 2.2 Set environment variables

The container expects secrets as env vars. Set them before running:

```bash
export SSH_PRIVATE_KEY_B64=$(base64 -i .ssh/id_ed25519)
export GPG_PRIVATE_KEY_B64=$(base64 -i .ssh/gpg-private.asc)
export GH_TOKEN=<pat-token>
export GITLAB_TOKEN=<gitlab-pat>
export GOOGLE_SA_KEY_B64=$(base64 < sa-key.json)
export VERTEX_ALLOWED_MODELS=claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
```

For persistent use, add these to a `.env` file (already gitignored):

```bash
SSH_PRIVATE_KEY_B64=<base64-encoded-ssh-key>
GPG_PRIVATE_KEY_B64=<base64-encoded-gpg-key>
GH_TOKEN=<pat-token>
GITLAB_TOKEN=<gitlab-pat>
GOOGLE_SA_KEY_B64=<base64-encoded-sa-key>
VERTEX_ALLOWED_MODELS=claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
```

Docker Compose automatically reads `.env` from the project root.

For OpenShift, store these as secrets and inject them as env vars into the pod.

## 3. SSH Configuration

### 3.1 Container (single identity)

The Dockerfile configures SSH automatically. The `entrypoint.sh` decodes `SSH_PRIVATE_KEY_B64` into `~/.ssh/id_ed25519` at startup. No manual SSH config needed.

### 3.2 Local development (multiple GitHub accounts)

When running the bot locally alongside your personal GitHub account, SSH needs to distinguish between the two identities. Use an SSH host alias so `git push` to the bot's forks uses the bot's key while everything else uses your personal key.

**Create/update `.ssh/config`** (in the project directory, not `~/.ssh/config`):

```
# Bot's GitHub account — used for fork repos (origin)
Host github.com-bot
  HostName github.com
  User git
  IdentityFile /path/to/dev-bot/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new

# GitLab — uses your personal key
Host gitlab.cee.redhat.com
  HostName gitlab.cee.redhat.com
  User git
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

**Update fork URLs in `project-repos.json`** to use the alias:

```json
"pdf-generator": {
  "url": "git@github.com-bot:platex-rehor-bot/pdf-generator.git",
  "upstream": "git@github.com:RedHatInsights/pdf-generator.git"
}
```

Only the bot's fork URLs (`url` field) use `github.com-bot`. Upstream URLs stay as `github.com` — they use your personal key for read access.

**How it works:** The bot's `run.py` detects the `.ssh/config` file and sets `GIT_SSH_COMMAND` to point to it at startup. For manual use outside `run.py`:

```bash
export GIT_SSH_COMMAND="ssh -F /path/to/dev-bot/.ssh/config"
```

**Verify both identities work:**

```bash
# Bot identity (for pushing to forks)
ssh -F .ssh/config -T github.com-bot
# Expected: "Hi platex-rehor-bot! ..."

# Personal identity (unchanged default)
ssh -T git@github.com
# Expected: "Hi <your-username>! ..."
```

This keeps your personal `~/.ssh/config` untouched. The host alias only applies when `GIT_SSH_COMMAND` points to the project's SSH config.

## 4. Verification

Build and enter the container:

```bash
docker compose run --rm bot
```

Run these checks:

```bash
# SSH auth
ssh -T git@github.com-bot
# Expected: "Hi <bot-username>! You've successfully authenticated..."

# GH CLI
gh auth status
# Expected: "Logged in to github.com account <bot-username>"

# GPG signing
git init /tmp/test && cd /tmp/test && git commit --allow-empty -m "test sign"
# Expected: commit succeeds (signed)

# Clone a repo
git clone git@github.com-bot:<bot-username>/<repo>.git /tmp/test-clone
# Expected: clones without errors
```

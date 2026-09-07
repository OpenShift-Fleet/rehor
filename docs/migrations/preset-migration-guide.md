# Preset System Migration Guide

How to migrate existing bot instances to the preset system. This guide is for teams running instances that were onboarded before the preset system existed.

## TL;DR

Existing instances remain backward compatible. `instance.yaml` is recommended
when an instance needs explicit workflow, env-preset, or CLAUDE.md settings,
but it is not currently required for default `jira-sprint` behavior.

---

## What Changed

The bot image now uses a **preset system** instead of a monolithic configuration. The image ships with:

```
presets/
├── core/                    # Security rules, memory system, output mode (always loaded)
│   └── CLAUDE.md
├── workflows/
│   └── jira-sprint/         # The main Jira triage → implement → PR loop
│       ├── CLAUDE.md
│       └── manifest.yaml
└── envs/                    # Additive capabilities
    ├── browser/             # Chromium + chrome-devtools MCP
    ├── container-scan/      # Grype + Buildah
    ├── slack/               # Slack notifications
    └── dev-proxy/           # Caddy reverse proxy for stage UI verification
```

At startup, `run.py`:
1. Loads `instance.yaml` from your config repo (or falls back to env vars / defaults)
2. Assembles `CLAUDE.md` from `core` + selected workflow preset
3. Validates required MCP servers and env vars from workflow and env preset manifests
4. Runs selected env preset entrypoint scripts at runtime. Image builds run
   env preset install scripts; `Dockerfile.runner` selects them from
   `instance.yaml`, while the base image installs bundled presets.

### What stays the same

- All bot behavior is identical
- Your config repo structure (`agent/`, `personas/`, `project-repos.json`, `mcp.json`, `settings.json`) is unchanged
- Deployment parameters in app-interface are unchanged
- The merge engine (protected keys, skills, hooks) works exactly as before

### What's new

- `instance.yaml` — an optional file in your config repo that declares which presets your instance uses
- Startup validation — the bot validates MCP servers and env vars at startup and fails fast with clear errors instead of crashing mid-cycle
- Env preset manifests — each capability declares what it provides and requires

---

## Do I Need to Add `instance.yaml`?

**No**, unless you need explicit preset selection or custom CLAUDE.md
layering. Without `instance.yaml`, the runner uses `BOT_WORKFLOW_PRESET` and
`BOT_ENV_PRESETS` when set, otherwise defaults to `jira-sprint` and all
available env presets. See [Env Var Fallback](#env-var-fallback).

### What does `instance.yaml` give you?

Beyond unblocking the next phase, it also lets you:

- **Drop unused capabilities** — e.g. your instance doesn't do visual QA, so drop `browser` to skip Chromium startup
- **Use a different workflow** — when alternative workflows become available
- **Append custom CLAUDE.md instructions** — layer instance-specific rules on top of the workflow
- **Make preset choices explicit** — documented in your config repo instead of relying on implicit defaults

---

## How to Add `instance.yaml`

Create the file at `<BOT_CONFIG_PATH>/agent/instance.yaml` in your config repo.

### Minimal (equivalent to current defaults)

```yaml
workflow: jira-sprint
source: jira
```

This selects the default workflow and source. Omitted `envs` keeps all available
env presets active.

### Explicit env preset selection

```yaml
workflow: jira-sprint
source: jira
envs:
  - browser
  - slack
  - container-scan
```

Only the listed env presets are active. `dev-proxy` is not listed, so it won't start.

### Minimal instance (no optional capabilities)

```yaml
workflow: jira-sprint
source: jira
envs: []
```

No env presets — no Chromium, no Grype, no Slack, no dev-proxy. The bot still triages, implements, and opens PRs, but can't take screenshots or scan containers.

### Custom CLAUDE.md (append)

```yaml
workflow: jira-sprint
source: jira
envs:
  - browser
  - slack

claude_md:
  strategy: append
```

If your config repo has an `agent/CLAUDE.md`, it gets appended after the workflow CLAUDE.md. Use this to add instance-specific rules (e.g. "never modify files in `legacy/`", "always run `make lint` before committing").

### Custom CLAUDE.md (replace)

```yaml
workflow: jira-sprint
source: jira

claude_md:
  strategy: replace
```

Your `agent/CLAUDE.md` replaces the workflow's CLAUDE.md entirely. The core CLAUDE.md (security rules, memory system) is always loaded regardless of strategy — it cannot be overridden.

---

## `instance.yaml` Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workflow` | string | `jira-sprint` | Which workflow preset to use. Must exist in `presets/workflows/`. |
| `source` | string | `jira` | Free-form string passed to skills. Currently: `jira`. Future: `github`, `gitlab`. |
| `envs` | list or null | `null` (all) | Which env presets to activate. `null`/omitted = all available. `[]` = none. |
| `claude_md.strategy` | string | `ignore` | How to handle instance CLAUDE.md: `ignore` (default), `append`, `replace`. |

---

## Env Var Fallback

Instances without a config repo (or without `instance.yaml`) can configure presets via env vars in the deployment template:

| Env Var | Default | Description |
|---------|---------|-------------|
| `BOT_WORKFLOW_PRESET` | `jira-sprint` | Workflow preset name |
| `BOT_ENV_PRESETS` | _(all available)_ | Comma-separated env preset names. Empty string = none. |

These are checked only when no `instance.yaml` is found. If `instance.yaml` exists, it takes precedence.

---

## Available Presets

### Workflow: `jira-sprint`

The current built-in workflow. Jira sprint triage → pick tickets → implement
→ open PRs → maintain PRs. Custom workflows can use different sources and
decision loops.

**Requires:**
- MCP servers: `bot-memory`, `mcp-atlassian`
- Env vars: `BOT_LABEL`, `BOT_INSTANCE_ID`, `BOT_JIRA_EMAIL`
- Optional: `BOT_CONFIG_REPO`, `BOT_BOARD_ID`, `BOT_BOARD_NAME`, `SLACK_WEBHOOK_URL`, `BOT_INCLUDE_BACKLOG`

### Env: `browser`

Chromium + Playwright + chrome-devtools MCP server for visual verification and screenshot capture.

**Requires:** `PLAYWRIGHT_BROWSERS_PATH` (set automatically in the image)

**Provides:** `chrome-devtools` MCP server, `gh-release-upload` skill

### Env: `container-scan`

Grype vulnerability scanner + Buildah container builder for CVE scanning.

**Provides:** `grype`, `buildah` CLI tools

### Env: `slack`

Slack notifications via webhook.

**Requires:** `SLACK_WEBHOOK_URL`

**Provides:** `slack-notify` skill

### Env: `dev-proxy`

Custom Caddy reverse proxy for local UI verification against stage environments.

**Requires:** `PROXY_HOST`  
**Optional:** `PROXY_PORT`

**Provides:** `caddy` CLI tool, `start-dev-proxy.sh` sandbox allowance

---

## Startup Validation

The bot now validates preset requirements at startup. If a required MCP server or env var is missing, the bot exits with a clear error instead of crashing mid-cycle.

```
[2026-06-26 10:00:00] FATAL: Required MCP server 'mcp-atlassian' not configured
[2026-06-26 10:00:00] FATAL: Required env var 'BOT_JIRA_EMAIL' not set
[2026-06-26 10:00:00] Workflow 'jira-sprint' manifest validation failed — 2 error(s). Check deployment config.
```

Missing optional env vars produce warnings but don't block startup:

```
[2026-06-26 10:00:00] Optional env var 'SLACK_WEBHOOK_URL' not set
```

Env preset validation also warns when a preset's required env vars are missing:

```
[2026-06-26 10:00:00] Env preset 'slack' requires 'SLACK_WEBHOOK_URL' (not set)
```

---

## FAQ

### What happens if I don't add `instance.yaml`?

Nothing for default behavior. The runner falls back to deployment env vars and
defaults. Add the file when you want reproducible, reviewable preset selection.

### What if I reference a preset that doesn't exist?

Missing workflow preset = FATAL error (bot won't start). Missing env preset = WARNING (logged, skipped, bot continues).

### Do I need to change my deployment template?

No. The new env vars (`BOT_WORKFLOW_PRESET`, `BOT_ENV_PRESETS`) are optional fallbacks. Your existing parameters are unchanged.

### What about the `setup.sh` in my runner repo?

Still works. The build chain runs: preset install scripts → instance `setup.sh`. Your instance-specific installs run last and can depend on anything presets installed.

### Will new presets be added?

Yes. Future workflow presets (reviewer, investigator) and env presets are planned. They'll be documented here as they become available.

---

## Config Repo Directory Structure (updated)

```
my-instance-config/
└── agent/
    ├── instance.yaml          # NEW — preset selection (optional)
    ├── project-repos.json     # repo mappings (unchanged)
    ├── mcp.json               # MCP server overrides (unchanged)
    ├── settings.json           # settings overrides (unchanged)
    ├── CLAUDE.md              # instance CLAUDE.md (used with strategy: append/replace)
    ├── personas/              # domain-specific guidelines (unchanged)
    │   ├── frontend/
    │   └── backend/
    ├── skills/                # instance-specific skills (unchanged)
    └── hooks/                 # additional hooks (unchanged)
```

The only new file is `instance.yaml`. Everything else is unchanged.

---

## Timeline

1. **Current** — Preset system is live and backward compatible.
2. **Current** — Instances can opt into explicit `instance.yaml` selection.
3. **Future** — Additional workflow and env presets can be added without changing the runner loop.

---

## Need Help?

We'll help every team through the migration. Options:

- **We write it for you** — tell us which capabilities your instance uses and we'll open a PR with the `instance.yaml`
- **Pair on it** — reach out in the team Slack channel and we'll walk through it together
- **Self-service** — follow the examples above, most instances just need the [minimal config](#minimal-equivalent-to-current-defaults)

Questions or concerns? Contact the Řehoř maintainers through your team Slack
channel or repository issue tracker.

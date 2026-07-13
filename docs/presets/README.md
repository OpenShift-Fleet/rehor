# Presets

Presets are the modular building blocks that define what a bot instance can do. Each instance selects presets in its `instance.yaml` to configure its workflow and capabilities.

## Quick Start

In your instance repo at `instance/<your-config>/agent/instance.yaml`:

```yaml
workflow: jira-sprint        # The bot's decision loop (required)
source: jira                 # Ticket source
envs:                        # Tools and runtimes to install (pick what you need)
  - node                     # Node.js via nvm (version switching)
  - go                       # Go via goenv (version switching)
  - browser                  # Chromium for visual verification
  - slack                    # Slack notifications
  - container-scan           # Grype + Buildah for CVE scanning
```

The bot reads this file at startup and activates only the selected presets.

## Preset Types

| Type | What it does | How many |
|------|-------------|----------|
| [**Workflow**](workflows.md) | Defines the bot's decision loop — triage, implement, PR maintenance | Exactly 1 per instance |
| [**Env**](envs.md) | Adds tools, runtimes, MCP servers — Node.js, Go, browser, scanning | 0 or more per instance |

## How Instances Use Presets

All presets live in the core `dev-bot` repo (your submodule) under `presets/`. You don't copy preset files — you just reference them by name in `instance.yaml`.

```
your-bot-instance/                      # Your instance repo
├── dev-bot/                            # Git submodule (this repo)
│   └── presets/
│       ├── workflows/jira-sprint/      # Workflow preset
│       ├── envs/node/                  # Env presets
│       ├── envs/go/
│       ├── envs/browser/
│       └── ...
├── instance/<your-config>/agent/
│   ├── instance.yaml                   # ← Your preset selection goes here
│   ├── project-repos.json
│   ├── mcp.json
│   └── personas/
└── setup.sh
```

### What Each Field Does

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workflow` | string | `jira-sprint` | Which workflow preset to use. Must match a directory under `presets/workflows/`. |
| `source` | string | `jira` | Ticket source. Currently only `jira`. |
| `envs` | list | `null` | Env presets to activate. `null`/omitted = all available. `[]` = none. |

### Choosing Env Presets

List only the presets your instance actually needs:

- **Frontend repos** (React/TypeScript): `node`, `browser`, `patternfly-mcp`, `slack`
- **Backend repos** (Go): `go`, `container-scan`, `slack`
- **Mixed repos**: `node`, `go`, `browser`, `slack`, `container-scan`
- **Config-only repos** (app-interface): `slack`

Unused presets waste Docker build time and image size. The `node` and `go` presets install version managers and compilers — skip them if your repos don't need them.

## Preset Reference

| Env Preset | What it installs | When you need it |
|------------|-----------------|------------------|
| [`node`](envs.md#node) | nvm + Node.js 22 LTS + npm/npx | Frontend repos, any repo with `package.json` |
| [`go`](envs.md#go) | goenv + Go 1.24/1.25 + golangci-lint | Go repos, any repo with `go.mod` |
| [`patternfly-mcp`](envs.md#patternfly-mcp) | PatternFly component guidance MCP server | Frontend repos using PatternFly (requires `node`) |
| [`browser`](envs.md#browser) | Chromium + chrome-devtools MCP | UI repos needing visual verification/screenshots |
| [`container-scan`](envs.md#container-scan) | Grype + Buildah | CVE scanning, container image analysis |
| [`dev-proxy`](envs.md#dev-proxy) | Caddy reverse proxy | Local UI verification against stage environments |
| [`slack`](envs.md#slack) | Slack notification skill | Any instance wanting Slack alerts |

| Workflow | Description |
|----------|-------------|
| [`jira-sprint`](workflows.md#jira-sprint) | Full autonomous loop: Jira triage → implement → PR → maintain |
| [Custom workflows](custom-workflows.md) | Build your own workflow for monitoring, review-only, or specialized automation |

## Real-World Examples

Here are actual instance configurations from deployed bots:

**Frontend instance** (hcc-ui-agent-dev) — works on React/PatternFly UI repos:
```yaml
workflow: jira-sprint
source: jira
envs:
  - slack
  - container-scan
  - browser
```

**Backend instance** (fleetshift-bot-instance) — works on Go services:
```yaml
workflow: jira-sprint
source: jira
envs:
  - slack
  - container-scan
```

**Full-stack instance** (test-preset-instance) — works on both frontend and backend:
```yaml
workflow: jira-sprint
source: jira
envs:
  - node
  - go
  - patternfly-mcp
```

## Related Docs

- [Onboarding a new instance](../onboarding-new-instance.md) — full setup guide including presets
- [Custom workflows](custom-workflows.md) — guide to building your own workflow
- [Custom preflight scripts](custom-preflight.md) — guide to writing pre-session data-gathering scripts
- [Presets design doc](../presets-design.md) — architecture decisions and rationale

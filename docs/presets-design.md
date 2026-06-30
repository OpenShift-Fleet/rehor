# Preset System Design

Composable configuration system replacing the monolithic CLAUDE.md with layered presets that instances mix and match.

**Epic**: RHCLOUD-48670  
**Spike**: RHCLOUD-48671

---

## Problem

Today every instance runs the same 432-line `CLAUDE.md` — the full Jira-triage-implement-PR workflow. But not every instance needs that. A "browser" instance that only does visual QA doesn't need the implementation loop. A future "reviewer" instance needs PR review logic but not Jira ticket claiming. The monolith forces all behavior onto every instance.

Skills are partially decoupled (remote config can add custom skills), but the core workflow is a single file. Personas are per-tech-stack, but the decision engine that uses them is baked into the workflow.

## Concepts

### Preset Types

| Type | Cardinality | Purpose |
|------|-------------|---------|
| **Workflow** | Exactly 1 per instance | The main CLAUDE.md — defines the bot's decision loop (triage → implement → PR maintenance, or review-only, or visual QA, etc.) |
| **Env** | 0–N per instance | Additive capabilities: browser/chrome-devtools, container scanning, code review tools. Each adds MCP servers, skills, settings, or environment setup. |

A workflow preset is the "brain" — what the bot does each cycle. Env presets are "hands" — tools and capabilities it can use.

### Why Not Just Multiple CLAUDE.md Files?

The workflow isn't just CLAUDE.md. It's CLAUDE.md + skills + personas + MCP servers + settings that all work together. A "review" workflow needs different skills than the "implement" workflow. Presets bundle everything a workflow or capability needs into one unit.

## Directory Layout

### Core Repo (`platform-frontend-ai-dev`)

```
presets/
├── workflows/
│   ├── jira-sprint/                   # Current workflow (Jira sprints → triage → implement → fork PR)
│   │   ├── CLAUDE.md                  # Decision loop, priorities, Jira integration
│   │   ├── skills/                    # Workflow-specific skills only
│   │   │   ├── triage/
│   │   │   ├── new-work/
│   │   │   ├── claim-ticket/
│   │   │   └── wrap-up/
│   │   ├── preflight/                 # Pre-session scripts
│   │   │   ├── 01-triage.py
│   │   │   └── 02-find-work.py
│   │   └── manifest.yaml
│   │
│   ├── reviewer/                      # Future: PR review only
│   │   ├── CLAUDE.md
│   │   ├── skills/
│   │   └── manifest.yaml
│   │
│   └── investigator/                  # Future: Investigation/analysis only
│       ├── CLAUDE.md
│       ├── skills/
│       └── manifest.yaml
│
├── shared/                            # Skills reusable across workflows
│   └── skills/
│       ├── push-and-pr/               # Git push + PR/MR creation
│       ├── post-pr/                   # Post-PR analysis
│       └── auto-fork/                 # Auto-fork repos
│
├── envs/
│   ├── browser/                       # Chrome DevTools + visual verification
│   │   ├── install.sh                 # Build-time: Playwright + Chromium + libs
│   │   ├── entrypoint.d/             # Runtime: start-chromium.sh
│   │   │   └── 10-chromium.sh
│   │   ├── mcp.json                   # chrome-devtools MCP server
│   │   ├── skills/
│   │   │   └── gh-release-upload/     # Screenshot upload
│   │   ├── settings.json              # Sandbox allowances for browser
│   │   └── manifest.yaml
│   │
│   ├── container-scan/                # Grype + buildah for CVE scanning
│   │   ├── install.sh                 # Build-time: grype + buildah + fuse-overlayfs
│   │   ├── skills/
│   │   └── manifest.yaml
│   │
│   ├── dev-proxy/                     # Caddy dev proxy for stage UI verification
│   │   ├── install.sh                 # Build-time: compile Caddy from source
│   │   ├── entrypoint.d/
│   │   │   └── 20-dev-proxy.sh        # Runtime: start Caddy
│   │   └── manifest.yaml
│   │
│   └── slack/                         # Slack notifications
│       ├── skills/
│       │   └── slack-notify/
│       └── manifest.yaml
│
└── core/                              # Always included — the "kernel"
    ├── CLAUDE.md                      # Security rules, memory system, output mode, turn budget
    ├── skills/                        # Core shared skills (if any)
    ├── hooks/                         # Security hooks (validate-bash, block-secrets, scan-secrets)
    ├── settings.json                  # Base sandbox + permissions
    └── mcp.json                       # bot-memory MCP (always needed)
```

### Instance Config Repo (e.g. `rehor-config`)

```
rehor-config/
├── agent/
│   ├── instance.yaml                  # NEW: declares presets + overrides
│   ├── personas/                      # Instance-specific personas (merged on top)
│   ├── project-repos.json             # Repo mappings
│   ├── mcp.json                       # Additional MCP servers
│   ├── settings.json                  # Additional settings
│   ├── skills/                        # Instance-specific skills
│   └── hooks/                         # Additional hooks
│
│   # Optional: full custom CLAUDE.md override
│   └── CLAUDE.md                      # If present, replaces workflow preset's CLAUDE.md
```

## Manifest Format

Each preset has a `manifest.yaml` declaring what it provides and what it needs:

```yaml
# presets/workflows/jira-sprint/manifest.yaml
name: jira-sprint
type: workflow
description: Jira sprint workflow — triage, implementation, PR maintenance

shared_skills:                    # From presets/shared/skills/
  - push-and-pr
  - post-pr
  - auto-fork

provides:
  claude_md: CLAUDE.md
  skills:                         # Workflow-specific (in this preset's skills/ dir)
    - triage
    - new-work
    - claim-ticket
    - wrap-up
  # No personas — those come from instance config repos

requires:
  mcp_servers:
    - bot-memory          # Memory server for task tracking
    - mcp-atlassian       # Jira integration
  env_vars:
    - BOT_LABEL           # Required: Jira label filter
    - BOT_INSTANCE_ID     # Required: multi-instance isolation
    - BOT_JIRA_EMAIL      # Required: Jira assignee
  optional_env_vars:
    - BOT_CONFIG_REPO     # External config
    - BOT_BOARD_ID        # Sprint management
    - SLACK_WEBHOOK_URL   # Notifications
```

```yaml
# presets/envs/browser/manifest.yaml
name: browser
type: env
description: Chrome DevTools for visual verification and screenshot capture

install: install.sh               # Build-time script (runs as root)
entrypoint_scripts:               # Runtime scripts (run at container start)
  - entrypoint.d/10-chromium.sh

provides:
  mcp_servers:
    chrome-devtools:
      type: stdio
      command: npx
      args: ["-y", "chrome-devtools-mcp"]
  skills:
    - gh-release-upload
  settings:
    sandbox:
      allowBash:
        - "start-dev-proxy.sh"

requires:
  env_vars:
    - PLAYWRIGHT_BROWSERS_PATH
```

## Env Preset Install Scripts

Env presets can include two kinds of scripts: **build-time** (`install.sh`) and **runtime** (`entrypoint.d/*.sh`).

### Build-Time: `install.sh`

Runs as root during `docker build`. Installs system packages, binaries, and npm globals that the preset needs. Today these are all hardcoded in the core Dockerfile — with presets they move into the preset that needs them.

```bash
#!/bin/bash
# presets/envs/browser/install.sh
set -e

# Chromium runtime libraries
dnf install -y --nodocs \
    alsa-lib atk at-spi2-atk at-spi2-core cairo cups-libs dbus-libs \
    libdrm mesa-libgbm glib2 nspr nss pango \
    libX11 libxcb libXcomposite libXdamage libXext libXfixes \
    libxkbcommon libXrandr \
    && dnf clean all

# Headless Chromium via Playwright
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
npx playwright install chromium

# chrome-devtools MCP server
npm install -g chrome-devtools-mcp@latest
```

```bash
#!/bin/bash
# presets/envs/container-scan/install.sh
set -e

# Grype (vulnerability scanner)
ARCH=$(uname -m | sed 's/x86_64/amd64/' | sed 's/aarch64/arm64/')
curl -fsSL "https://github.com/anchore/grype/releases/download/v0.87.0/grype_0.87.0_linux_${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin grype

# Buildah (rootless container builder)
dnf install -y --nodocs buildah fuse-overlayfs && dnf clean all
```

### Runtime: `entrypoint.d/*.sh`

Scripts that run at container startup, numbered for ordering. Today `entrypoint.sh` hardcodes Chromium startup, proxy wait, etc. With presets, each env preset drops its startup script into `entrypoint.d/` and the entrypoint runs them in order.

```bash
#!/bin/bash
# presets/envs/browser/entrypoint.d/10-chromium.sh
# Start headless Chromium for chrome-devtools MCP
CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name chrome -type f | head -1)
"$CHROME_BIN" \
    --headless --no-sandbox --disable-gpu \
    --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 \
    --remote-allow-origins=* \
    --ignore-certificate-errors \
    --proxy-server="${HTTPS_PROXY:-http://proxy:3128}" \
    --no-first-run --disable-sync --disable-extensions --disable-popup-blocking &

until curl -s http://127.0.0.1:9222/json/version > /dev/null 2>&1; do sleep 1; done
echo "Chromium ready."
```

### Dockerfile Integration

The Dockerfile loops through all presets and runs their install scripts:

```dockerfile
# Copy all presets
COPY presets/ presets/

# Run env preset install scripts (as root)
RUN for script in presets/envs/*/install.sh; do \
        [ -f "$script" ] && echo "Installing preset: $(dirname $script)" && bash "$script"; \
    done
```

The entrypoint becomes a dispatcher:

```bash
#!/bin/bash
# entrypoint.sh (simplified)
set -e

# ... credential setup, git config (unchanged) ...

# Run preset entrypoint scripts in order
for script in presets/envs/*/entrypoint.d/*.sh; do
    [ -f "$script" ] && echo "Running: $script" && bash "$script"
done

# Start bot
exec uv run dev-bot --label "$BOT_LABEL"
```

### Instance `setup.sh` Still Works

Instance repos keep their `setup.sh` for instance-specific installs that don't fit any preset. The build chain runs: preset install scripts → instance `setup.sh`. Instance setup runs last so it can depend on anything presets installed.

### What Moves Out of the Core Dockerfile

| Current Dockerfile Section | Destination Preset |
|---|---|
| Chromium libs (`alsa-lib`, `atk`, etc.) | `envs/browser/install.sh` |
| `npx playwright install chromium` | `envs/browser/install.sh` |
| `npm install -g chrome-devtools-mcp` | `envs/browser/install.sh` |
| Chromium startup in `entrypoint.sh` | `envs/browser/entrypoint.d/10-chromium.sh` |
| Grype install | `envs/container-scan/install.sh` |
| Buildah + fuse-overlayfs | `envs/container-scan/install.sh` |
| Dev proxy Caddy build + copy | `envs/dev-proxy/install.sh` |
| Dev proxy startup | `envs/dev-proxy/entrypoint.d/20-dev-proxy.sh` |
| Python, Node, Go, git, bubblewrap, tini | **Stay in core Dockerfile** (base runtime) |
| Executor thin client (gh/glab/gpg) | **Stay in core Dockerfile** (always needed) |

## Instance Configuration

Each instance declares its preset selection in `instance.yaml`:

```yaml
# rehor-config/internal/agent/instance.yaml
workflow: jira-sprint             # Built-in preset (resolved from presets/workflows/ in core image)

source: jira                      # Free-form string passed to workflow CLAUDE.md and skills

envs:
  - browser
  - slack
  - container-scan

# Override personas — instance personas merge on top of workflow's
personas:
  override: true          # Default. Instance personas win on name conflict.

# Override CLAUDE.md — if agent/CLAUDE.md exists in this config repo
claude_md:
  strategy: replace       # "replace" = use instance's CLAUDE.md instead of workflow's
                          # "append"  = append instance's CLAUDE.md after workflow's
                          # "ignore"  = use workflow's CLAUDE.md only (default)
```

Custom workflow from the config repo:

```yaml
# my-team-config/agent/instance.yaml
workflow: ./workflows/review-only   # ./ prefix = relative to this agent dir in config repo

source: github
envs:
  - browser
```

The `./` prefix tells the resolver to look in the config repo instead of the core image's `presets/workflows/`. The custom workflow dir follows the same structure as built-in presets (CLAUDE.md, skills/, manifest.yaml).

Minimal instance (no browser, no slack):

```yaml
# fleetshift-config/internal/agent/instance.yaml
workflow: jira-sprint
source: jira
envs: []
```

### Multi-Profile Config Repos

A single config repo can hold multiple profiles — configurations that share most assets but differ in task source, MCP servers, or workflow details. This avoids onboarding separate images for variants like internal (Jira) vs community (GitHub Issues) development.

#### Directory Layout

```
rehor-config/
├── shared/                        # Assets shared across all profiles
│   ├── personas/
│   │   ├── frontend/
│   │   ├── backend/
│   │   └── config/
│   ├── project-repos.json
│   ├── skills/
│   ├── settings.json
│   └── hooks/
│
├── internal/                      # Profile: internal dev (Jira-based)
│   └── agent/
│       ├── instance.yaml          # source: jira
│       ├── mcp.json               # mcp-atlassian
│       └── personas/              # Profile-specific persona overrides (if any)
│
└── community/                     # Profile: community dev (GitHub Issues)
    └── agent/
        ├── instance.yaml          # source: github-issues
        ├── mcp.json               # no mcp-atlassian, maybe different tools
        └── skills/                # Profile-specific skills (if any)
```

#### How It Works

Each deployment points `BOT_CONFIG_PATH` at a different profile — same image, same config repo, different `BOT_CONFIG_PATH`:

**Config repo** (`fleetshift/fleetshift-bot-instance`):

```
instance/
├── shared/                        # Assets shared across all profiles
│   ├── personas/
│   │   ├── frontend/
│   │   ├── backend/
│   │   └── config/
│   ├── project-repos.json
│   └── settings.json
│
├── internal/                      # Profile: internal dev (Jira-based)
│   └── agent/
│       ├── instance.yaml          # workflow: jira-sprint, source: jira
│       ├── mcp.json               # mcp-atlassian
│       └── personas/              # Profile-specific overrides (if any)
│
└── community/                     # Profile: community dev (GitHub Issues)
    └── agent/
        ├── instance.yaml          # workflow: ./workflows/github-kanban, source: github
        ├── mcp.json               # no mcp-atlassian, different tools
        └── workflows/
            └── github-kanban/     # Custom workflow for this profile
                ├── CLAUDE.md      # GH Issues triage, kanban-style prioritization
                ├── skills/
                │   ├── triage/
                │   └── claim-ticket/
                └── manifest.yaml
```

**instance.yaml per profile**:

```yaml
# instance/internal/agent/instance.yaml
workflow: jira-sprint
source: jira

envs:
  - browser
  - slack
  - container-scan
```

```yaml
# instance/community/agent/instance.yaml
workflow: ./workflows/github-kanban  # Custom workflow from this config repo
source: github

envs:
  - browser
```

**App-interface SaaS file** — two targets from the same image, different `BOT_CONFIG_PATH`:

```yaml
# app-interface: fleetshift-deploy.yml
resourceTemplates:
- name: fleetshift-bot-instance
  path: /deploy/template.yaml
  url: https://github.com/fleetshift/fleetshift-bot-instance
  targets:

  # Internal instance — Jira-based, full workflow
  - namespace:
      $ref: /services/.../namespaces/stage.hcmais01ue1.yml
    ref: abc123
    parameters:
      BOT_NAME: devbot-fleetshift-internal
      BOT_LABEL: hcc-ai-fleetshift
      BOT_INSTANCE_ID: 'Bořivoj Lodník z Plovoucího hradu'
      BOT_CONFIG_REPO: https://github.com/fleetshift/fleetshift-bot-instance.git
      BOT_CONFIG_PATH: instance/internal          # ← picks internal profile
      # ...

  # Community instance — GitHub Issues, same image
  - namespace:
      $ref: /services/.../namespaces/stage.hcmais01ue1.yml
    ref: abc123
    parameters:
      BOT_NAME: devbot-fleetshift-community
      BOT_LABEL: hcc-ai-fleetshift-community
      BOT_INSTANCE_ID: 'Věnceslav Říční z Komunální lodi'
      BOT_CONFIG_REPO: https://github.com/fleetshift/fleetshift-bot-instance.git
      BOT_CONFIG_PATH: instance/community         # ← picks community profile
      # ...
```

Same image, same config repo, two deployments. The only difference is `BOT_CONFIG_PATH` and `BOT_NAME`/`BOT_LABEL`/`BOT_INSTANCE_ID`. Each profile's `instance.yaml` selects its workflow, source, and envs. Both inherit shared personas and project-repos via `shared: ../shared`.

**`shared/` convention**: `run.py` looks for a `shared/` directory as a sibling of the profile dir (i.e. `BOT_CONFIG_PATH/../shared/`). If it exists, shared assets are merged first, then profile-specific assets overlay on top. No config needed — no `shared/` dir means nothing to inherit. If `instance.yaml` references shared assets (e.g. shared personas) but the `shared/` directory is missing or renamed, startup validation logs a warning — silent misconfiguration is not acceptable.

Merge order for profiles:

```
1. Shared assets         (shared/personas, shared/project-repos.json, etc.)
2. Profile assets        (community/agent/personas, etc. — overrides shared)
3. Normal preset merge   (profile assets merge into resolved presets as today)
```

This means two deployments from the same repo share personas, project-repos, and skills — but can have different task sources, MCP servers, and instance-specific overrides. A community profile might skip `mcp-atlassian` entirely and use a GitHub-native MCP server instead, while keeping the same frontend/backend personas and implementation workflow.

#### What Differs Between Profiles

| Aspect | Internal (Jira) | Community (GH Issues) |
|--------|-----------------|----------------------|
| Task source | Jira tickets via mcp-atlassian | GitHub Issues via gh CLI or MCP |
| Triage skill | Queries Jira sprint/backlog | Queries GH issue labels/milestones |
| Claim mechanism | Jira assign + transition | GH issue assign + label |
| PR linking | Jira comment with PR URL | GH issue auto-close via commit msg |
| Personas | Shared | Shared |
| Implementation loop | Same | Same |
| Skills (workflow) | Same triage/implement/PR skills | Modified triage/claim for GH source |

The workflow preset (`jira-sprint`) stays the same — the `source` field in `instance.yaml` tells the skills where to look for work. Skills that interact with the task source (triage, new-work, claim-ticket, wrap-up) read this field and switch their backend accordingly.

## CLAUDE.md Decomposition

The current 432-line CLAUDE.md splits into:

### `presets/core/CLAUDE.md` (~100 lines) — Always loaded

- `# Dev Bot Agent` header
- `## Output Mode — Ultra Caveman`
- `## Turn Budget`
- `## Security Rules` (including Org Membership Verification)
- `## Primary Label`
- `## Instance ID`
- `## Memory System` (task tools, cycle progress, memory tools, org membership, slack notifications)
- `## Progress Tracking`
- `## Rules` (general rules that apply to all workflows)

### `presets/workflows/jira-sprint/CLAUDE.md` (~330 lines) — Jira sprint workflow

- `## Workflow Loop` (the main decision engine)
- `### Triage`
- `### Priority 0: Resume + Respond to Feedback`
- `### Priority 1: Maintain Existing PRs`
- `### Priority 1.5: Check Assigned Tickets`
- `### Priority 2: New Jira Work`
  - `#### Investigation Tickets`
  - `#### Check Linked Issues`
  - `#### Implement` (the full 13-step implementation flow)

### Assembly

At startup, the final CLAUDE.md is assembled by concatenation:

```
core/CLAUDE.md + workflow/CLAUDE.md + [instance/CLAUDE.md if strategy=append]
```

Or if `strategy=replace`:

```
core/CLAUDE.md + instance/CLAUDE.md
```

The core CLAUDE.md is always first — security rules must be seen before any workflow instructions.

## Build-Time Behavior

### Dockerfile Changes

The Dockerfile no longer copies a single `CLAUDE.md`. Instead it copies the entire `presets/` directory:

```dockerfile
# Copy preset system (all available presets)
COPY presets/ presets/

# Copy core (always needed)
COPY .claude/ .claude/
COPY config.json .mcp.json entrypoint.sh ./

# No skill tests at build time — CI handles testing
```

No workflow is assembled at build time. The image contains all presets; the instance config selects which one to activate at startup.

### Why Not Bake At Build?

Instance config repos are pulled at runtime via `BOT_CONFIG_REPO`. The workflow selection comes from `instance.yaml` in that repo. Baking at build time would require rebuilding the image for each instance — defeating the purpose of shared images.

## Startup Validation (`run.py`)

### New Flow

```
1. sync_config_repo()                    # Pull BOT_CONFIG_REPO (unchanged)
2. load_instance_config()                # NEW: Read instance.yaml
3. resolve_presets()                      # NEW: Find workflow + env presets
4. assemble_claude_md()                   # NEW: Concatenate core + workflow + instance
5. merge_preset_assets()                  # NEW: Merge skills, MCP, settings, hooks
6. apply_merged_config()                  # Existing: merge remote config (personas, repos, etc.)
7. validate_startup()                     # NEW: Fail if no CLAUDE.md assembled
8. run_cycle()                            # Existing: start agent loop
```

### Validation Rules

```
FATAL (exit 1):
  - No workflow preset found AND no instance CLAUDE.md
  - Required MCP servers from manifest not available
  - Required env vars from manifest not set

WARNING (continue):
  - Env preset not found (logged, skipped)
  - Optional env vars missing
  - Personas directory empty
```

### Instance Config Resolution

```python
def load_instance_config(remote_agent_dir: Path | None) -> InstanceConfig:
    """Load instance.yaml from remote config, or fall back to defaults."""
    if remote_agent_dir:
        yaml_path = remote_agent_dir / "instance.yaml"
        if yaml_path.exists():
            return InstanceConfig.from_yaml(yaml_path)
    
    # Fallback: env var override
    workflow = os.environ.get("BOT_WORKFLOW_PRESET", "jira-sprint")
    envs = os.environ.get("BOT_ENV_PRESETS", "browser,slack").split(",")
    return InstanceConfig(workflow=workflow, envs=envs)
```

Env var fallback means instances can configure presets without a config repo at all — just set `BOT_WORKFLOW_PRESET=jira-sprint` and `BOT_ENV_PRESETS=browser,slack` in the deployment template.

## Pre-Flight Scripts

### Problem

Today the bot starts a Claude SDK session every cycle — even when there's nothing to do. Triage and new-work run as AI skills inside the session, burning tokens just to conclude "no work found, sleeping." At ~$0.50-2.00 per idle cycle, this adds up.

### Concept

**Pre-flight scripts** run _before_ the Claude session starts. They're plain Python/shell — no AI tokens. Each script gathers data, makes a deterministic decision, and either:

Every pre-flight script prints a JSON object to stdout with two fields:

```json
{"status": "start", "content": "..."}
```

| Status | Meaning | What happens |
|--------|---------|--------------|
| `start` | Work found | `content` becomes the session prompt |
| `skip` | Nothing to do | `content` posted as orphan cycle transcript, runner sleeps |
| `error` | Script failed | `content` posted as error cycle transcript, runner retries next loop |

The runner validates the JSON and rejects malformed output (treated as `error` with stderr captured as content). Empty `content` on `start` is also an error — the session needs a prompt. Empty `content` on `skip`/`error` is allowed but discouraged (gives no debug info in the dashboard).

### Directory Layout

Pre-flight checks are split into **shared modules** (reusable across workflows) and **workflow entry points** (thin wrappers that import and call the shared modules). This mirrors how skills work — shared logic lives in one place, workflows compose what they need.

#### Shared preflight modules

Reusable data-gathering modules live in `presets/shared/preflight/`. Each is a self-contained Python module with a `main()` function that prints the JSON protocol to stdout. They are not executed directly by the runner — workflow entry points import and call them.

```
presets/shared/preflight/
├── gh_pr_status.py                # GH PR health: CI, conflicts, reviews, comments
├── gl_mr_status.py                # GL MR health: pipelines, conflicts, threads
└── jira_triage.py                 # Jira issue state, comments, linked issues
```

The split follows forge boundaries — each module handles one data source:

| Module | Data source | What it checks |
|--------|------------|----------------|
| `gh_pr_status` | GitHub API via `gh` CLI | PR state, CI checks, merge conflicts, review decisions, PR comments (inline + general) |
| `gl_mr_status` | GitLab API via `glab` CLI | MR state, pipeline status, conflicts, unresolved threads, MR notes |
| `jira_triage` | Jira API via `jira_mcp.py` | Issue status, comments, labels, linked issues |

All three fetch the active task list from the memory server independently (cheap localhost call). Each classifies tasks into action buckets and decides `start`/`skip` based on whether actionable items exist.

#### Workflow entry points

Each workflow's `preflight/` directory contains numbered entry points that the runner executes. These are thin wrappers — typically one-liners that import a shared module and call `main()`:

```
presets/workflows/jira-sprint/
├── CLAUDE.md
├── preflight/                     # Entry points executed by runner
│   ├── 01-gh-pr-status.py         # → imports shared gh_pr_status, calls main()
│   ├── 02-gl-mr-status.py         # → imports shared gl_mr_status, calls main()
│   ├── 03-jira-triage.py          # → imports shared jira_triage, calls main()
│   └── 04-find-work.py            # Workflow-specific: sprint + backlog search
├── skills/
│   ├── triage/
│   └── new-work/
└── manifest.yaml
```

Numbered for execution order, same convention as `entrypoint.d/`. Workflow-specific scripts (like `04-find-work.py`) contain their own logic — only cross-workflow checks use the shared modules.

A different workflow (e.g. `kanban`) would compose differently:

```
presets/workflows/kanban/
├── preflight/
│   ├── 01-gh-pr-status.py         # Same shared module
│   ├── 02-jira-triage.py          # Same shared module (no GL needed)
│   └── 03-find-work.py            # Kanban-specific: board column query
└── manifest.yaml
```

The runner adds `presets/shared/preflight/` to `sys.path` before executing workflow entry points, so `from gh_pr_status import main` resolves without path manipulation in each script.

#### Instance-specific pre-flight

Instance config repos can add their own pre-flight scripts:

```
rehor-config/
├── agent/
│   ├── instance.yaml
│   ├── preflight/                     # Instance-specific pre-flight
│   │   └── 50-check-deploy-freeze.py  # e.g., skip if deploy freeze is active
│   ├── personas/
│   └── project-repos.json
```

Execution order: workflow pre-flights first (01-*, 02-*, 03-*, 04-*), then instance pre-flights (50-*). Use high numbers for instance scripts to avoid collisions. Same JSON protocol — an instance script can skip the session or inject additional context.

### Execution Flow

```
run.py loop:
  1. sync_config_repo()
  2. load_instance_config()
  3. resolve_presets()
  4. run_preflight()                    # NEW
     ├── 01-gh-pr-status.py    (workflow, shared)  → GH PR health checks
     ├── 02-gl-mr-status.py    (workflow, shared)  → GL MR health checks
     ├── 03-jira-triage.py     (workflow, shared)  → Jira issue state/comments
     ├── 04-find-work.py       (workflow-specific)  → sprint candidate search
     └── 50-check-deploy-freeze (instance)          → custom checks
     Result: aggregated JSON → session prompt or orphan cycle
  5. IF all scripts skip → post orphan cycle ("nothing to do") → sleep
  6. IF any error → post error cycle → backoff sleep
  7. ELSE → assemble_claude_md() → start session with preflight content as input
```

### Runtime Environment

Pre-flight scripts run in the bot container with access to environment variables only — no direct inputs or arguments. They use the same CLI tools available in the container (`gh`, `glab`, MCP client) which route through the proxy automatically. This means:

- **No auth tokens in scripts** — `gh` and `glab` authenticate via the proxy, same as the AI session
- **No secrets access** — scripts read `BOT_LABEL`, `BOT_INSTANCE_ID`, `MEMORY_SERVER_URL`, etc. from env, never credential files
- **No arguments** — the runner calls each script with no args. Scripts discover what they need from env vars and API calls
- **Same security rules** — pre-flight scripts are subject to the same sandbox restrictions as the rest of the bot (no `curl`, no `printenv`, no credential file reads)

### What Pre-Flight Does vs What AI Does

The split is deterministic vs reasoning:

| Pre-flight (no tokens) | AI session (tokens) |
|---|---|
| Fetch active tasks from memory-server | Decide which task to work on first |
| Query PR statuses (CI, reviews, merge state) | Reason about how to fix failing CI |
| Check Jira comments for new activity | Interpret feedback, decide response |
| Query capacity (`task_check_capacity`) | Decide whether to take investigation-only work |
| Fetch sprint candidates from Jira | Evaluate ticket complexity, check linked issues |
| Detect "nothing to do" (all clean, no candidates) | — (session never starts) |

### Pre-Flight Output

Each script writes a plain string to stdout. The runner doesn't parse it — it just routes it based on the exit code.

**`start`** — work found, content becomes the session prompt:

```json
{
  "status": "start",
  "content": "## Triage Report\n\n3 active tasks. 1 has unaddressed PR feedback.\n\n### RHCLOUD-123 (pr_open)\n- PR #42: CI passing, 1 unaddressed review comment from @reviewer\n- Comment: \"This breaks the existing API contract, please add backward compat\"\n\n### RHCLOUD-456 (pr_open)\n- PR #55: all clean, no new comments\n\n### New Candidates\n- RHCLOUD-789: \"Fix login redirect loop\" (High priority, frontend, in current sprint)\n\nBegin triage using the data above. Do NOT re-fetch task or PR statuses."
}
```

**`skip`** — nothing to do, content becomes the orphan cycle transcript:

```json
{
  "status": "skip",
  "content": "Pre-flight: nothing to do.\n- 3 active tasks, all clean (no feedback, CI passing, no conflicts)\n- At capacity (10/10 active tasks)\n- No new candidates in sprint backlog"
}
```

**`error`** — script failed, content captures what went wrong:

```json
{
  "status": "error",
  "content": "Failed to connect to memory-server at http://devbot-memory-server:8080 — connection refused. Is the pod running?"
}
```

The runner wraps the `content` string into Claude SDK JSONL format before storing it as the cycle transcript, so the dashboard's `parseTranscript()` can render it like a real session.

### Aggregation: Any `start` Wins

Pre-flight scripts run in order. The runner collects all results and applies this logic:

- **Any script returns `start`** → session starts. All `start` contents are concatenated as the prompt. `skip` contents are appended as FYI context.
- **All scripts return `skip`** → no session. All `skip` contents are concatenated as the orphan cycle transcript.
- **Any script returns `error`** → no session. Error content posted as error cycle transcript. Remaining scripts still run (gather diagnostic info).

This means `01-triage.py` can return `skip` (no active tasks need attention) while `02-find-work.py` returns `start` (found a new candidate) — and the session starts with both outputs.

```python
# run.py (simplified)
results = run_preflight(workflow_preset, instance_config)
# results = [{"status": "skip", "content": "..."}, {"status": "start", "content": "..."}]

has_start = any(r["status"] == "start" for r in results)
has_error = any(r["status"] == "error" for r in results)

if has_error:
    transcript = "\n\n".join(r["content"] for r in results if r["content"])
    post_error_cycle(transcript=wrap_as_jsonl(transcript))
    sleep(error_sleep)
    continue

if not has_start:
    transcript = "\n\n".join(r["content"] for r in results if r["content"])
    post_orphan_cycle(transcript=wrap_as_jsonl(transcript))
    sleep(recommended_sleep)
    continue

# At least one start — concatenate all content as session prompt
prompt = "\n\n".join(r["content"] for r in results if r["content"])
run_claude_session(prompt=prompt)
```

The triage/new-work skills still exist as AI skills, but they receive pre-fetched data instead of gathering it themselves. The skills become pure reasoning — "given this data, what should I do?" — instead of data-gathering + reasoning.

### Short-Circuit Rules

Scripts run in order but can short-circuit the chain:

- `01-triage.py` returns `start` (feedback found) → remaining scripts still run (gather full context), but session is guaranteed to start
- `01-triage.py` returns `skip` → continue to `02-find-work.py`
- `02-find-work.py` returns `skip` → all scripts returned `skip` → no session
- Any script returns `error` → remaining scripts still run, but session won't start

A script can also exit non-zero without valid JSON — the runner treats this as `error` with stderr as the content. This handles crashes, syntax errors, and timeouts gracefully.

When the final result is `error`, the runner:

1. **Notifies Slack** (`infra_error`) with the failing script name and error summary. Cooldown keyed on instance ID (no ticket context yet) — same 48h window as regular notifications.
2. **Backs off retries** — consecutive preflight errors increase sleep time exponentially (5min → 10min → 20min → capped at 1h). Resets to normal on the first successful preflight. Prevents hammering a broken dependency (e.g. memory-server down) every 5 minutes.

### Manifest Declaration

Workflows declare their pre-flight scripts in the manifest:

```yaml
# presets/workflows/jira-sprint/manifest.yaml
name: jira-sprint
type: workflow

preflight:
  - 01-gh-pr-status.py
  - 02-gl-mr-status.py
  - 03-jira-triage.py
  - 04-find-work.py

shared_skills:
  - push-and-pr
  # ...
```

### What This Saves

Rough estimate per idle cycle:
- Current: ~30-50 tool calls for triage + new-work → ~$0.50-2.00 in tokens
- With pre-flight: 0 tokens (skip entirely) or ~10-15 tool calls (AI starts with context)
- At 48 cycles/day × 5 instances: **~$120-480/day saved** on idle cycles alone

Even for active cycles, pre-loading context saves 15-20 tool calls per session (~30-40% of the current triage phase).

## Asset Merge Order

When the same asset exists in multiple presets, merge order determines what wins:

```
1. Core preset           (base — security hooks, base settings)
2. Shared skills         (presets/shared/skills/ — only those declared in workflow manifest)
3. Workflow preset       (adds workflow-specific skills, MCP, settings)
4. Env presets           (additive — each adds its own skills, MCP, settings)
5. Instance config repo  (overrides — personas, project-repos, custom skills)
```

Later layers win on conflicts, except for protected items (security hooks, sandbox rules, core MCP servers) which are never overridden — same as today's `PROTECTED` registry in `merge.py`.

### Skills Merge

Skills from all layers are collected into `.claude/skills/`. Shared skills are copied first, then workflow-specific skills (which can shadow shared ones if needed), then env skills, then instance config skills. Name conflicts are resolved by later layers winning (instance > env > workflow > shared > core). Protected skills (triage, wrap-up, etc.) can never be overridden by instance config — they can only come from core, shared, or workflow presets.

### Settings Merge

Deep merge with protected paths, same as today. Each env preset's `settings.json` is merged additively.

### MCP Servers Merge

Additive, same as today. Protected servers (bot-memory, mcp-atlassian) cannot be overridden.

## Skills Allowed-List

Today, `.claude/settings.json` has a static list of allowed skills. With presets, the list must be dynamic:

```python
def build_allowed_skills(presets: list[Preset]) -> list[str]:
    """Build allowed skills list from all active presets + instance config."""
    skills = set()
    for preset in presets:
        for skill_dir in (preset.path / "skills").iterdir():
            if skill_dir.is_dir():
                skills.add(skill_dir.name)
    # Add instance-specific skills from remote config
    # ...
    return sorted(skills)
```

The settings.json `allowedSkills` field gets rebuilt at startup from the resolved preset tree. Instance config skills are included automatically.

## Migration Path

Incremental delivery — each phase is independently shippable and non-breaking. Later phases only get designed in detail when their first real consumer exists.

### Phase 1: CLAUDE.md Decomposition + Validation

Split the monolithic CLAUDE.md and add validation infrastructure so the decomposition gains safety, not just file reorganization.

1. Create `presets/core/CLAUDE.md` with security rules, memory system, output mode, turn budget, general rules
2. Create `presets/workflows/jira-sprint/CLAUDE.md` with the workflow loop (triage, priorities, implement)
3. Add `assemble_claude_md()` to `run.py` that concatenates core + workflow into the existing CLAUDE.md location
4. Add `manifest.yaml` for the jira-sprint workflow with `requires` validation (MCP servers, env vars)
5. Add startup validation: fail on missing required MCP servers/env vars, warn on optional
6. No `instance.yaml` needed yet — default behavior is `workflow: jira-sprint`
7. **Zero behavior change** for existing instances

### Phase 2: Env Presets

Extract environment capabilities (browser, container-scan, slack, dev-proxy) into self-contained preset directories.

1. Move browser, slack, container-scan, dev-proxy install scripts and skills into `presets/envs/`
2. Add `manifest.yaml` per env preset declaring what it provides and requires
3. Update Dockerfile to loop through env preset install scripts instead of hardcoding
4. Update entrypoint to run `entrypoint.d/*.sh` from active env presets
5. Default `BOT_ENV_PRESETS=browser,slack,container-scan` — same as today
6. Existing instances unchanged

### Phase 3: Instance Config (`instance.yaml`)

Add per-instance configuration that selects workflow + env presets.

1. Add `instance.yaml` support to `run.py`
2. Update instance config repos with their `instance.yaml`
3. Existing instances without `instance.yaml` get defaults (jira-sprint + all envs)
4. Add env var fallback (`BOT_WORKFLOW_PRESET`, `BOT_ENV_PRESETS`) for instances without a config repo

### Phase 4: Pre-Flight Scripts

Move data-gathering out of AI sessions to save tokens on idle cycles.

1. Add preflight runner to `run.py`
2. Create `01-triage.py` and `02-find-work.py` for jira-sprint workflow
3. Existing triage/new-work skills become pure reasoning (receive pre-fetched data)

### Phase 5: Workflow Presets + Shared Skills

Only when a second workflow consumer exists (e.g. jira-kanban, GitHub Issues). Design the abstraction from two real examples instead of speculating.

1. Extract `shared/skills/` (push-and-pr, post-pr, auto-fork) as a merge tier
2. Create second workflow preset based on actual consumer requirements
3. Add multi-profile config repo support if needed by onboarding teams
4. New instances can select workflows via `workflow: <name>` in `instance.yaml`
5. No impact on existing jira-sprint instances

**Note**: Two workflow variants already exist today (jira-sprint and jira-kanban). Phase 5 formalizes the split — earlier phases keep both in the single CLAUDE.md since the differences are small.

## Design Decisions (Resolved)

1. **Skill shared modules**: `jira_mcp.py`, `memory_mcp.py`, `paths.py` stay as shared modules in `presets/core/skills/`. Memory is a core concern — always available. Shared code should be maximized across presets, not duplicated.

2. **Persona ownership**: Personas come from instance config repos, not workflow presets. Workflows define the loop (Jira → triage → implement → PR) but don't care about _how_ the implementation happens — that's the persona's job. New instances need a config repo with personas from day one. Workflow presets ship zero personas.

3. **Hooks from env presets**: Not yet. Security hooks remain core-only (protected). Env presets contribute skills, MCP servers, and settings — not hooks. Revisit if a clear use case emerges.

4. **Testing**: Skill tests do NOT run at build time. They run in CI as regular tests (pytest, etc.). The Dockerfile stops running skill tests during `docker build`. This simplifies the build and lets CI handle test matrix concerns.

5. **CLAUDE.md size**: Core CLAUDE.md shrinks to absolute minimum — security rules, memory system, essential rules only. Workflow CLAUDE.md fills in the decision loop. Personas extend further with tech-stack specifics. Ultra caveman compression is always applied. Env presets do NOT add to CLAUDE.md — they contribute assets only (skills, MCP, settings). This keeps the instruction window manageable.

## Appendix: Current Inventory

### What Would Move Where

| Current Location | Destination Preset | Type |
|---|---|---|
| `CLAUDE.md` (security, memory, rules) | `presets/core/` | Core |
| `CLAUDE.md` (workflow loop, triage, implement) | `presets/workflows/jira-sprint/` | Workflow |
| `.claude/skills/triage/` | `presets/workflows/jira-sprint/skills/` | Workflow |
| `.claude/skills/new-work/` | `presets/workflows/jira-sprint/skills/` | Workflow |
| `.claude/skills/claim-ticket/` | `presets/workflows/jira-sprint/skills/` | Workflow |
| `.claude/skills/wrap-up/` | `presets/workflows/jira-sprint/skills/` | Workflow |
| `.claude/skills/post-pr/` | `presets/shared/skills/` | Shared |
| `.claude/skills/push-and-pr/` | `presets/shared/skills/` | Shared |
| `.claude/skills/auto-fork/` | `presets/shared/skills/` | Shared |
| `.claude/skills/gh-release-upload/` | `presets/envs/browser/skills/` | Env |
| `.claude/skills/slack-notify/` | `presets/envs/slack/skills/` | Env |
| `.claude/hooks/validate-bash.sh` | `presets/core/hooks/` | Core (protected) |
| `.claude/hooks/block-secrets-read.sh` | `presets/core/hooks/` | Core (protected) |
| `.claude/hooks/scan-secrets.sh` | `presets/core/hooks/` | Core (protected) |
| `rehor-config/agent/personas/` | Instance config (unchanged) | Instance |
| `rehor-config/agent/project-repos.json` | Instance config (unchanged) | Instance |

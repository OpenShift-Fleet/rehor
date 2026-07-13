# Workflow Presets

A workflow preset defines what the bot does each cycle — its decision loop. Every instance has exactly one workflow, set in `instance.yaml`.

```yaml
# instance/<your-config>/agent/instance.yaml
workflow: jira-sprint     # ← this selects the workflow
source: jira
envs:
  - ...
```

Currently there is one workflow. The system is designed for future alternatives (review-only, visual QA, monitoring).

---

## jira-sprint

**Path**: `presets/workflows/jira-sprint/`

The default and currently only workflow. Implements the full autonomous development loop:

```
Preflight → Triage → PR Maintenance → New Work → Implement → Open PR → Maintain
```

### What It Does Each Cycle

1. **Preflight** (no AI tokens) — Python scripts check PR statuses, Jira comments, and capacity. If nothing is actionable, the cycle ends without starting a Claude session.

2. **Triage** — classify active tasks into buckets:
   - MERGED — PR merged, ready for wrap-up
   - CI FAILING — tests broken, needs fix
   - CONFLICTS — merge conflicts, needs rebase
   - FEEDBACK — unaddressed review comments or Jira comments
   - CLEAN — nothing to do

3. **PR maintenance** (Priority 0-1) — address feedback, fix CI, resolve conflicts, wrap up merged PRs

4. **New work** (Priority 2) — only when everything is clean:
   - Search Jira sprint for unassigned tickets with the bot's label
   - Claim ticket, create branch, implement, test, open PR

### Preflight Scripts

These run before each Claude session to avoid burning tokens on idle cycles:

| Script | Path | What it checks |
|--------|------|---------------|
| `01-gh-pr-status.py` | `presets/workflows/jira-sprint/preflight/` | GitHub PR states — CI, conflicts, reviews |
| `02-gl-mr-status.py` | `presets/workflows/jira-sprint/preflight/` | GitLab MR states — pipelines, threads |
| `03-jira-sprint.py` | `presets/workflows/jira-sprint/preflight/` | Jira triage (feedback, interrupted work) + new work candidates |

Each outputs `{"status": "start"|"skip", "content": "..."}`. If all return `skip`, no Claude session starts — the cycle sleeps.

#### Filtering logic

The preflight scripts apply several filters to avoid false-positive starts:

- **`last_addressed` filtering** — PR reviews and Jira comments submitted before the task's `last_addressed` timestamp are ignored. The bot updates `last_addressed` via `task_update` after each cycle, so already-handled feedback doesn't re-trigger a session. This applies to GH PR reviews (`classify_gh`), GL MR threads, and Jira comments.

- **`repo:` label gate** — Jira candidates without a `repo:` label are excluded from the start decision. Tickets missing this label cannot be worked on (no target repo), so they log a skip message instead of wasting a Claude session. Candidates with unresolvable `repo:` labels (label exists but doesn't match `project-repos.json`) are also excluded.

- **Current-state checks** — CI failures, merge conflicts, and mergeable state are always checked regardless of `last_addressed` since they reflect the current PR state, not a point-in-time event.

### Skills Included

| Skill | Purpose |
|-------|---------|
| `triage` | Task classification and prioritization |
| `new-work` | Jira candidate search (sprint → bot-assigned → backlog) |
| `claim-ticket` | Ticket assignment + sprint placement |
| `wrap-up` | Post-merge cleanup (archival, Jira transition, branch deletion) |
| `push-and-pr` | Push branch and open PR with template detection |
| `post-pr` | Post-PR Jira comment, linked issue updates, Slack notification |
| `auto-fork` | Fork creation for new repos |
| `gh-release-upload` | Upload release artifacts to GitHub releases |
| `slack-notify` | Send Slack notifications via webhook |

### Required Configuration

Your instance needs these env vars set in the deploy template:

| Env Var | Description | Example |
|---------|-------------|---------|
| `BOT_LABEL` | Jira label for ticket filtering | `hcc-ai-framework` |
| `BOT_INSTANCE_ID` | Unique instance identifier | `Framework Bot` |
| `BOT_JIRA_EMAIL` | Email for Jira ticket assignment | `bot@company.com` |

These MCP servers must be available (typically via the shared proxy):

| MCP Server | Description |
|------------|-------------|
| `bot-memory` | Task tracking, RAG memory, cycle progress |
| `mcp-atlassian` | Jira API access |

### Optional Configuration

| Env Var | Description | Default |
|---------|-------------|---------|
| `BOT_BOARD_ID` or `BOT_BOARD_NAME` | Jira board for sprint assignment | Skip sprint assignment |
| `BOT_SPRINT_PREFIX` | Sprint name filter (e.g. `"Framework"`) | No filter |
| `BOT_INCLUDE_BACKLOG` | Include backlog tickets in search | `false` |
| `SLACK_WEBHOOK_URL` | Slack webhook for notifications | No notifications |

### Directory Structure

```
presets/workflows/jira-sprint/
├── CLAUDE.md              # Decision loop instructions (the bot's "brain")
├── manifest.yaml          # Metadata — preflight list, skills, requirements
└── preflight/             # Pre-session scripts (thin wrappers → shared modules)
    ├── 01-gh-pr-status.py
    ├── 02-gl-mr-status.py
    └── 03-jira-sprint.py
```

Skills live in `.claude/skills/` (shared across workflows):

```
.claude/skills/
├── triage/
├── new-work/
├── claim-ticket/
├── wrap-up/
├── push-and-pr/
├── post-pr/
├── auto-fork/
├── gh-release-upload/
├── slack-notify/
├── jira_mcp.py            # Shared Jira MCP helper
└── memory_mcp.py          # Shared memory MCP helper
```

Personas live in the instance config repo (not in the workflow):

```
instance/<your-config>/agent/
└── personas/              # Tech-stack guidelines
    ├── frontend/prompt.md
    ├── backend/prompt.md
    ├── config/prompt.md
    ├── tooling/prompt.md
    └── cve/prompt.md
```

### Instance Personas

Personas are defined in your instance config repo. They provide tech-stack-specific guidelines the bot follows when working in a particular repo context.

```
instance/<your-config>/agent/
└── personas/
    ├── frontend/prompt.md    # React/TS guidelines
    ├── backend/prompt.md     # Go/Python guidelines
    └── config/prompt.md      # YAML/Jsonnet guidelines
```

---

## Custom Workflows

The preset system supports custom workflows beyond the built-in `jira-sprint`. You can create workflows for monitoring, scheduled tasks, review-only bots, or any specialized automation.

- [Creating custom workflows](custom-workflows.md) — Full guide to building your own workflow with directory structure, manifest, CLAUDE.md assembly, and examples
- [Writing custom preflight scripts](custom-preflight.md) — How to write pre-session data-gathering scripts for your workflow

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
| `03-jira-triage.py` | `presets/workflows/jira-sprint/preflight/` | Jira comments on active tasks |
| `04-find-work.py` | `presets/workflows/jira-sprint/preflight/` | New Jira candidates if capacity available |

Each outputs `{"status": "start"|"skip", "content": "..."}`. If all return `skip`, no Claude session starts — the cycle sleeps.

### Skills Included

| Skill | Purpose |
|-------|---------|
| `triage` | Task classification and prioritization |
| `new-work` | Jira candidate search (3-tier: sprint → backlog → all) |
| `claim-ticket` | Ticket assignment + sprint placement |
| `wrap-up` | Post-merge cleanup (archival, Jira transition, branch deletion) |
| `push-and-pr` | Push branch and open PR with template detection |
| `post-pr` | Post-PR Jira comment, linked issue updates, Slack notification |
| `auto-fork` | Fork creation for new repos |

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
├── skills/                # Workflow-specific skills
│   ├── triage/
│   │   └── triage.py
│   ├── new-work/
│   │   └── new_work.py
│   ├── claim-ticket/
│   │   └── claim_ticket.py
│   └── wrap-up/
│       └── wrap_up.py
├── preflight/             # Pre-session scripts
│   ├── 01-gh-pr-status.py
│   ├── 02-gl-mr-status.py
│   ├── 03-jira-triage.py
│   └── 04-find-work.py
└── personas/              # Tech-stack guidelines
    ├── frontend/prompt.md
    ├── backend/prompt.md
    ├── config/prompt.md
    ├── tooling/prompt.md
    └── cve/prompt.md
```

### Instance Personas Override

Your instance can override or extend personas by placing them in your config repo:

```
instance/<your-config>/agent/
└── personas/
    └── frontend/
        └── prompt.md      # Your custom frontend guidelines
```

Instance personas take precedence over the workflow's built-in personas for the same name.

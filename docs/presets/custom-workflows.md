# Creating Custom Workflows

A workflow defines what the bot does each cycle — its decision loop. Every instance has exactly one workflow, set in `instance.yaml`. The built-in `jira-sprint` workflow handles the full autonomous development loop, but you can create custom workflows for specialized use cases like monitoring, scheduled tasks, or domain-specific automation.

## Built-in vs Custom Workflows

### Built-in (core image)

Reference a workflow by name. It resolves from the core bot image at `presets/workflows/<name>/`:

```yaml
# instance.yaml
workflow: jira-sprint
```

### Custom (instance config repo)

Use the `./` prefix to reference a workflow relative to your instance config repo's agent directory:

```yaml
# instance.yaml
workflow: ./workflows/watchduty
```

This resolves to `<your-config-repo>/agent/workflows/watchduty/`. Use this when your workflow is specific to your team and doesn't belong in the core bot image.

## Directory Structure

A workflow directory contains:

```
workflows/my-workflow/
├── CLAUDE.md              # Required — the bot's instructions for this workflow
├── manifest.yaml          # Recommended — metadata, requirements, preflight declaration
├── preflight/             # Optional — pre-session data-gathering scripts
│   ├── 01-check-service.py
│   └── 02-check-capacity.py
└── skills/                # Optional — workflow-specific skill scripts
    └── my-skill/
        ├── SKILL.md
        └── my_skill.py
```

### Required: `CLAUDE.md`

This is the core of your workflow. At startup, the runner assembles the final `CLAUDE.md` by combining:

1. **Core instructions** (`presets/core/CLAUDE.md`) — security rules, tool usage, general behavior
2. **Workflow instructions** (your workflow's `CLAUDE.md`) — what to do each cycle
3. **Instance instructions** (your config repo's `agent/CLAUDE.md`) — instance-specific overrides (strategy-dependent)

Your workflow CLAUDE.md should be written as imperative instructions telling the bot what to do. Think of it as a runbook.

### Recommended: `manifest.yaml`

Declares metadata and requirements. Validated at startup — missing required MCP servers or env vars cause a fatal error, catching deployment misconfigurations early.

### Optional: `preflight/`

Pre-session scripts that run before each Claude session. See [Writing Custom Preflight Scripts](custom-preflight.md) for the full guide.

### Optional: `skills/`

Python scripts that the bot can invoke during its session (e.g. triage logic, data fetching). These are copied to `.claude/skills/` at startup.

## manifest.yaml Schema

```yaml
name: my-workflow
type: workflow
description: Brief description of what this workflow does

# Preflight scripts (documentation — discovery is filesystem-based)
preflight:
  - 01-check-service.py
  - 02-check-capacity.py

# Core skills to include alongside this workflow's own skills
shared_skills:
  - push-and-pr        # Git push + PR creation
  - post-pr            # Post-PR Jira comment + Slack notification
  - auto-fork          # Fork creation for new repos

# What this workflow provides
provides:
  claude_md: CLAUDE.md
  skills:
    - my-skill          # Skill directories under this workflow's skills/

# What this workflow requires to function
requires:
  mcp_servers:
    - bot-memory         # Must be configured in MCP settings
    - mcp-atlassian
  env_vars:
    - BOT_LABEL          # Fatal if not set
    - BOT_INSTANCE_ID
  optional_env_vars:
    - SLACK_WEBHOOK_URL  # Warning if not set, but not fatal
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Workflow identifier |
| `type` | Yes | Must be `workflow` |
| `description` | Yes | One-line summary |
| `preflight` | No | List of preflight script filenames (documentation only) |
| `shared_skills` | No | Core skill names to include (from `presets/shared/skills/`) |
| `provides.claude_md` | No | CLAUDE.md filename (always `CLAUDE.md`) |
| `provides.skills` | No | Skill directory names provided by this workflow |
| `requires.mcp_servers` | No | MCP servers that must be configured. Fatal if missing. |
| `requires.env_vars` | No | Environment variables that must be set. Fatal if missing. |
| `requires.optional_env_vars` | No | Env vars that should be set. Warning if missing. |

## instance.yaml Configuration

Your instance config repo's `instance.yaml` controls which workflow runs and how:

```yaml
# instance/<config>/agent/instance.yaml
workflow: ./workflows/my-workflow   # ./ = relative to this agent dir
source: scheduled                   # or "jira"
envs:
  - slack
  - node
claude_md:
  strategy: append                  # ignore | append | replace
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `workflow` | `jira-sprint` | Workflow name (built-in) or `./path` (custom) |
| `source` | `jira` | Ticket source. `jira` = Jira sprint polling. `scheduled` = time-based. |
| `envs` | `null` (all) | Env presets to activate. `null` = all available, `[]` = none. |
| `claude_md.strategy` | `ignore` | How instance CLAUDE.md combines with workflow CLAUDE.md |

## CLAUDE.md Assembly Strategies

The `claude_md.strategy` field controls how your instance's `agent/CLAUDE.md` combines with the workflow's CLAUDE.md:

### `ignore` (default)

```
Final CLAUDE.md = core + workflow
```

Instance `CLAUDE.md` is ignored. Use when the workflow's instructions are complete and the instance doesn't need to add anything.

**When to use**: Most workflows. The workflow CLAUDE.md has everything the bot needs.

### `append`

```
Final CLAUDE.md = core + workflow + instance
```

Instance `CLAUDE.md` is appended after the workflow instructions. Use when you want to add instance-specific context on top of the workflow.

**When to use**: Your team has extra context (team conventions, specific repos, escalation contacts) that supplements the workflow's decision loop.

```yaml
# instance.yaml
claude_md:
  strategy: append
```

```markdown
<!-- agent/CLAUDE.md (instance) -->
## Team-Specific Context

- Our Jenkins is at jenkins.example.com
- Escalate P0 issues to #team-oncall in Slack
- Prod jobs are prefixed with "prod-"
```

### `replace`

```
Final CLAUDE.md = core + instance
```

The workflow's CLAUDE.md is skipped entirely. Instance CLAUDE.md replaces it. Use when you want complete control over the bot's instructions while still keeping core security rules.

**When to use**: Rarely. Only when the workflow is just a container for preflight/skills and the instructions are fully custom per instance.

## Path Resolution

The `resolve_workflow_dir()` function in `bot/config.py` handles path resolution:

- **Plain name** (e.g. `jira-sprint`) → `<bot-repo>/presets/workflows/jira-sprint/`
- **`./` prefix** (e.g. `./workflows/watchduty`) → `<config-repo>/agent/workflows/watchduty/`

This resolution is used consistently across:
- Startup validation (`validate_instance_config`)
- Manifest loading and validation (`load_manifest`, `validate_manifest`)
- CLAUDE.md assembly (`assemble_claude_md`)
- Preflight script discovery (`discover_preflight_scripts`)

## What Workflows Don't Handle

Workflows define the decision loop. Everything else comes from instance config merging:

| Handled by workflow | Handled by instance config merge |
|--------------------|----------------------------------|
| CLAUDE.md instructions | Personas |
| Preflight scripts | Skills (instance-level) |
| Workflow-specific skills | MCP server configs |
|  | Settings (`.claude/settings.json`) |
|  | Hooks (`.claude/hooks/`) |
|  | `project-repos.json` |

The merge system (`bot/merge.py` → `apply_merged_config()`) combines persona files, MCP configs, skills, settings, and hooks from both the core image and your instance config. Workflows are independent of this — they provide their own CLAUDE.md and preflight scripts.

## Complete Example: Review-Only Workflow

Let's build a workflow that only reviews PRs — no new Jira work, no ticket claiming.

### 1. Create the directory

```
instance/my-config/agent/
├── instance.yaml
├── workflows/
│   └── review-only/
│       ├── CLAUDE.md
│       ├── manifest.yaml
│       └── preflight/
│           └── 01-check-prs.py
└── project-repos.json
```

### 2. Write the CLAUDE.md

```markdown
# Review-Only Workflow

Each cycle: check for PRs needing review, review them, post feedback.

## Cycle Loop

1. Read the preflight data — it contains PR statuses and review requests.
2. If no PRs need attention, stop.
3. For each PR needing review (one per cycle):
   a. Clone the repo if needed
   b. Read the diff
   c. Post a code review with actionable feedback
   d. Update task tracking

## Rules

- ONE PR per cycle
- Only review, never push code
- Be constructive — suggest improvements, don't just list problems
```

### 3. Write the manifest.yaml

```yaml
name: review-only
type: workflow
description: Review PRs without implementing new work

preflight:
  - 01-check-prs.py

shared_skills:
  - push-and-pr    # For reading PR templates/conventions

provides:
  claude_md: CLAUDE.md

requires:
  mcp_servers:
    - bot-memory
  env_vars:
    - BOT_INSTANCE_ID
  optional_env_vars:
    - SLACK_WEBHOOK_URL
```

### 4. Write the preflight script

```python
#!/usr/bin/env python3
"""Pre-flight: check for PRs needing review."""

import json
import sys

from common import get_tasks, get_task_prs, output_result


def main():
    tasks = get_tasks()
    review_needed = []

    for task in tasks:
        if task.get("status") not in ("pr_open", "pr_changes"):
            continue
        prs = get_task_prs(task)
        if prs:
            review_needed.append({
                "key": task.get("external_key", "?"),
                "repo": task.get("repo", "?"),
                "prs": prs,
            })

    if not review_needed:
        output_result("skip", f"{len(tasks)} tasks, none with PRs needing review.")
        return

    content = f"{len(review_needed)} PRs need review:\n"
    content += json.dumps(review_needed, indent=2)
    output_result("start", content)


if __name__ == "__main__":
    main()
```

### 5. Configure instance.yaml

```yaml
workflow: ./workflows/review-only
source: jira
envs:
  - slack
claude_md:
  strategy: ignore    # Workflow CLAUDE.md has everything needed
```

## Real-World Pattern: Scheduled Monitoring

For workflows that run on a schedule (not driven by Jira), use `source: scheduled` and a preflight script that checks an external service:

```yaml
# instance.yaml
workflow: ./workflows/watchduty
source: scheduled
envs:
  - slack
claude_md:
  strategy: append
```

The key differences from a Jira-driven workflow:
- **`source: scheduled`** — The bot runs on a timer rather than polling Jira for new tickets
- **Preflight decides everything** — No Jira triage phase. The preflight script checks the external service and determines whether action is needed.
- **`strategy: append`** — Instance CLAUDE.md adds team-specific context (service URLs, escalation paths) on top of the workflow's general instructions.

The preflight script for this pattern typically:
1. Fetches data from the external service (Jenkins, Grafana, custom API)
2. Classifies items deterministically (failing vs healthy, priority ordering)
3. Outputs `start` with only the actionable items, or `skip` if everything is healthy

See [Writing Custom Preflight Scripts](custom-preflight.md) for the implementation details.

## Checklist: Shipping a Custom Workflow

1. **Create the workflow directory** in your config repo under `agent/workflows/<name>/`

2. **Write `CLAUDE.md`** — imperative instructions for the bot's decision loop. Be specific about:
   - What to check each cycle
   - When to take action vs skip
   - How to report results
   - What "done" looks like

3. **Write `manifest.yaml`** — declare requirements so deployment failures are caught at startup, not mid-session

4. **Add preflight scripts** (if needed) — pre-session data gathering to avoid wasting tokens on idle cycles

5. **Update `instance.yaml`** — set `workflow: ./workflows/<name>` and choose the right `claude_md.strategy`

6. **Test locally**:
   ```bash
   # Test preflight scripts standalone
   cd /path/to/dev-bot
   PYTHONPATH=presets/shared/preflight:.claude/skills python3 path/to/preflight/01-check.py

   # Test CLAUDE.md assembly
   python3 bot/run.py  # Check assembled output
   ```

7. **Deploy** — set `BOT_CONFIG_PATH` in your deployment template to point to your instance config

## Related Docs

- [Workflow presets](workflows.md) — Built-in workflow reference (jira-sprint)
- [Writing custom preflight scripts](custom-preflight.md) — Detailed guide to preflight scripts
- [Env presets](envs.md) — Available env presets for tools and runtimes
- [Presets overview](README.md) — How all preset types work together
- [Presets design doc](../presets-design.md) — Architecture decisions and rationale

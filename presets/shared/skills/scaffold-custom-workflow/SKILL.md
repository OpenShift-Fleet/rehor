---
name: scaffold-custom-workflow
description: >
  Generate a custom workflow directory with manifest.yaml, CLAUDE.md, and preflight script skeleton.
when_to_use: >
  When setting up a new custom workflow for a bot instance. Triggers: "scaffold workflow",
  "create custom workflow", "generate workflow", "new workflow".
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/scaffold-custom-workflow/scaffold_custom_workflow.py *)"
  - Read
  - Bash
---

## Usage

```bash
python3 .claude/skills/scaffold-custom-workflow/scaffold_custom_workflow.py \
  --name <workflow-name> \
  --description "<one-line description>" \
  --trigger <jira|scheduled> \
  --output-dir <instance-agent-dir> \
  [--mcp-servers bot-memory,mcp-atlassian] \
  [--env-vars BOT_LABEL,SLACK_WEBHOOK_URL] \
  [--shared-skills push-and-pr,post-pr] \
  [--dry-run] 2>&1
```

## What it generates

```
workflows/<name>/
  manifest.yaml           # Workflow metadata and requirements
  CLAUDE.md               # Decision loop stub for the bot
  preflight/
    01-check.py           # Skeleton preflight script
```

## Arguments

| Arg | Required | Description |
|-----|----------|-------------|
| `--name` | Yes | Workflow name (kebab-case) |
| `--description` | Yes | One-line description |
| `--trigger` | Yes | `jira` or `scheduled` — determines preflight template |
| `--output-dir` | Yes | Instance agent directory (creates `workflows/<name>/` under it) |
| `--mcp-servers` | No | Comma-separated MCP server names for manifest |
| `--env-vars` | No | Comma-separated env var names for manifest |
| `--shared-skills` | No | Comma-separated shared skill names for manifest |
| `--dry-run` | No | Show what would be created without writing |

## Trigger modes

- **`jira`** — Preflight imports `common.py` utilities, checks tasks and capacity,
  gates on Jira ticket availability. CLAUDE.md includes Jira task lifecycle.
- **`scheduled`** — Preflight is standalone with fetch/classify/skip pattern, includes
  throttle example. CLAUDE.md includes sleep signal and schedule-based loop.

## Error handling

- Refuses to overwrite an existing workflow directory
- Validates workflow name is kebab-case (lowercase, digits, hyphens)
- Exits with code 1 on any validation error

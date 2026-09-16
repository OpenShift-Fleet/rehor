---
name: create-phase-tickets
description: >
  Create 3 Jira sub-tickets (one per onboarding phase) linked to the
  onboarding epic. Applies the initial onboarding:intake label to the epic.
when_to_use: >
  Invoke immediately after claiming a new onboarding ticket. The ticket
  becomes the epic; this skill creates the phase sub-tickets under it.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/create-phase-tickets/create_phase_tickets.py *)"
  - Read
---

```bash
python3 .claude/skills/create-phase-tickets/create_phase_tickets.py '<json_config>' 2>&1
```

## Config JSON Schema

```json
{
  "epic_key": "RHCLOUD-12345",
  "project_key": "RHCLOUD",
  "team_name": "My Team"
}
```

## What It Does

1. Creates 3 Jira sub-tickets linked to the epic via `parent`:
   - `[Phase 1] Instance Setup — <team_name>`
   - `[Phase 2] Konflux CI/CD — <team_name>`
   - `[Phase 3] Deployment — <team_name>`
2. Applies `onboarding:intake` label to the epic
3. Returns JSON with created ticket keys

## Output

```json
{
  "epic_key": "RHCLOUD-12345",
  "phase_tickets": {
    "phase1": "RHCLOUD-12346",
    "phase2": "RHCLOUD-12347",
    "phase3": "RHCLOUD-12348"
  },
  "label_applied": "onboarding:intake"
}
```

## Prerequisites

- `JIRA_MCP_URL` env var set (Jira MCP server endpoint)
- The epic ticket must already exist and be assigned to the bot

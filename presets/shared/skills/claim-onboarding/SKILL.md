---
name: claim-onboarding
description: >
  Claim an onboarding ticket: assign to bot, transition to In Progress,
  create phase sub-tickets, apply initial label, and track in memory server.
when_to_use: >
  Invoke when picking up a new onboarding candidate ticket. Replaces manual
  assign + transition + create-phase-tickets + task_add sequence.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/claim-onboarding/claim_onboarding.py *)"
  - Read
---

```bash
python3 .claude/skills/claim-onboarding/claim_onboarding.py '<json_config>' 2>&1
```

## Config JSON Schema

```json
{
  "epic_key": "RHCLOUD-12345",
  "project_key": "RHCLOUD",
  "team_name": "My Team",
  "summary": "Onboard My Team to Rehor"
}
```

## What It Does

1. Assigns the epic to `$BOT_JIRA_EMAIL`
2. Transitions the epic to "In Progress"
3. Creates 3 phase sub-tickets via `/create-phase-tickets`
4. Applies `onboarding:intake` label to the epic
5. Creates a memory server task with structured metadata

## Output

```json
{
  "epic_key": "RHCLOUD-12345",
  "phase_tickets": {"phase1": "RHCLOUD-12346", "phase2": "RHCLOUD-12347", "phase3": "RHCLOUD-12348"},
  "task_created": true
}
```

---
name: post-intake
description: >
  Post the Phase 1 intake questions comment on the onboarding epic.
  Applies onboarding:requirements-gathering label.
when_to_use: >
  Invoke after claiming a new onboarding ticket, during the intake step.
  Posts the structured intake questions asking for team name, repos, etc.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-intake/post_intake.py *)"
  - Read
---

```bash
python3 .claude/skills/post-intake/post_intake.py '<json_config>' 2>&1
```

## Config JSON

```json
{
 "epic_key": "TEAM-12345"
}
```

Posts the intake questions. Applies `onboarding:requirements-gathering` label.

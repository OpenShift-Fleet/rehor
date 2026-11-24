---
name: post-konflux-questions
description: >
  Post Phase 2 Konflux info gathering questions on the epic.
  Applies onboarding:konflux-info label.
when_to_use: >
  Invoke when scaffolding PR is merged and Phase 2 begins.
  Posts questions about Konflux tenant, admins, cost center, quota.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-konflux-questions/post_konflux_questions.py *)"
  - Read
---

```bash
python3 .claude/skills/post-konflux-questions/post_konflux_questions.py '<json_config>' 2>&1
```

## Config JSON

```json
{
 "epic_key": "TEAM-12345",
  "team_name": "My Team",
  "instance_name": "my-team-agent-dev"
}
```

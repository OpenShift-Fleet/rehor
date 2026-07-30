---
name: post-manual-steps
description: >
  Post the final manual steps checklist after app-interface MR merges.
  Applies onboarding:manual-steps label.
when_to_use: >
  Invoke when the app-interface deployment MR is merged.
  Posts the remaining manual steps (verify pod, create label, credentials).
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-manual-steps/post_manual_steps.py *)"
  - Read
---

```bash
python3 .claude/skills/post-manual-steps/post_manual_steps.py '<json_config>' 2>&1
```

## Config JSON

```json
{
  "epic_key": "RHCLOUD-12345",
  "bot_label": "rehor-ai-myteam",
  "bot_name": "devbot-myteam",
  "dedicated_proxy": false,
  "workflow": "jira-sprint"
}
```

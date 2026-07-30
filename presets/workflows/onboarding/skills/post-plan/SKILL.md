---
name: post-plan
description: >
  Post the onboarding plan comment on the epic for team approval.
  Applies onboarding:plan-posted label.
when_to_use: >
  Invoke after requirements are gathered and tech stack detection is complete.
  Posts the structured onboarding plan with instance config and phase breakdown.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-plan/post_plan.py *)"
  - Read
---

```bash
python3 .claude/skills/post-plan/post_plan.py '<json_config>' 2>&1
```

## Config JSON

```json
{
  "epic_key": "RHCLOUD-12345",
  "instance_name": "my-team-agent-dev",
  "config_name": "my-team-config",
  "bot_name": "devbot-myteam",
  "bot_label": "rehor-ai-myteam",
  "workflow": "jira-sprint",
  "repos": ["https://github.com/RedHatInsights/my-app"],
  "tech_stacks": {"my-app": {"stack": ["react", "typescript"], "envs": ["node", "browser"]}},  // or list: [{"repo": "my-app", "stack": ["react"]}]
  "envs_and_personas": "node, browser | frontend",
  "dedicated_proxy": false
}
```

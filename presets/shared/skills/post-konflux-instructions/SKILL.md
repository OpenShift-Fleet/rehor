---
name: post-konflux-instructions
description: >
  Post Tekton pipeline generation instructions after Konflux MR merges.
  Applies onboarding:tekton-setup label.
when_to_use: >
  Invoke when the Konflux onboarding MR is merged. Posts instructions for
  generating Tekton pipeline files via the Konflux UI.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-konflux-instructions/post_konflux_instructions.py *)"
  - Read
---

```bash
python3 .claude/skills/post-konflux-instructions/post_konflux_instructions.py '<json_config>' 2>&1
```

## Config JSON

```json
{
  "epic_key": "RHCLOUD-12345",
  "instance_name": "my-team-agent-dev",
  "quay_org": "my-team-tenant",
  "tenant": "my-team-tenant"
}
```

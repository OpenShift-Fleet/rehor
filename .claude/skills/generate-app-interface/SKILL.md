---
name: generate-app-interface
description: >
  Generate or modify app-interface SaaS file to deploy a new bot instance
  to the hcmais cluster. Handles both shared (RedHatInsights) and separate
  (external org) SaaS file patterns.
when_to_use: >
  During the onboarding infrastructure phase when creating the app-interface
  deployment MR for a new bot instance. Invoke after the instance repo and
  Konflux setup are done.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/generate-app-interface/generate_app_interface.py *)"
  - Read
---

```bash
python3 .claude/skills/generate-app-interface/generate_app_interface.py '<json_config>' <app_interface_repo_path> 2>&1
```

Modifies or creates the SaaS file in the `<app_interface_repo_path>` (a clone of app-interface).

## Config JSON Schema

```json
{
  "instance_name": "my-team-agent-dev",
  "bot_name": "devbot-myteam",
  "bot_label": "rehor-ai-myteam",
  "instance_id": "my-team-agent-dev",
  "github_org": "RedHatInsights",
  "repo_url": "https://github.com/RedHatInsights/my-team-agent-dev",
  "quay_org": "my-team-tenant",
  "config_name": "my-config",
  "config_repo": "https://github.com/RedHatInsights/my-team-agent-dev.git",
  "config_path": "instance/my-config",
  "workflow": "jira-sprint",
  "board_name": "My Board",
  "sprint_prefix": "MyTeam Sprint",
  "slack_webhook_url": "",
  "pattern": "shared"
}
```

## Prerequisites

The `<app_interface_repo_path>` must be a clone of the app-interface repo. The script validates that:
1. The directory exists and is a git repo
2. The `data/services/` directory exists (app-interface structure)

Clone and checkout before running this skill.

## Two SaaS File Patterns

Each team should have their own SaaS file — prefer `pattern: "separate"` for new onboardings so each team's deployment is independently manageable.

### Pattern A: Shared (`pattern: "shared"`)

For instances managed directly by the Rehor platform team. Modifies the existing shared SaaS file at:
`data/services/insights/platform-frontend-ai-dev/deploy.yml`

Adds:
1. New `imagePatterns` entry for the instance's Quay image
2. New `resourceTemplates` entry with target namespace, images, and parameters

### Pattern B: Separate (`pattern: "separate"`) — Recommended

For team-owned instances. Creates a new SaaS file at:
`data/services/insights/<team>/<instance_name>.yml`

Includes its own schema, labels, app/pipelinesProvider refs, takeover flag,
managedResourceTypes, imagePatterns, and resourceTemplates.

## Critical Gotchas

- `managedResourceTypes` MUST include `ScaledObject.keda.sh`
- `BOT_REPLICAS` value must be string `'0'` (KEDA manages scaling)
- All instances target the same namespace: `$ref: /services/insights/platform-frontend-ai-dev/namespaces/stage.hcmais01ue1.yml`
- The `images` block requires org ref: `$ref: /dependencies/quay/redhat-services-prod.yml`
- `authentication` ref: `$ref: /services/app-sre/saas-file-auth/global.yml`
- Separate SaaS files need `takeover: true`

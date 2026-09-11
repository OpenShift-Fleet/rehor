---
name: generate-app-interface
description: >
  Generate app-interface SaaS deploy file for a new bot instance.
  Handles both shared (new file in platform-frontend-ai-dev service tree)
  and separate (new service tree) patterns.
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

Creates a SaaS deploy file in the `<app_interface_repo_path>` (a clone of app-interface).

## Config JSON Schema

```json
{
  "instance_name": "my-team-agent-dev",
  "bot_name": "devbot-myteam",
  "bot_label": "rehor-ai-myteam",
  "instance_id": "Phoenix",
  "repo_url": "https://github.com/MyOrg/my-team-agent-dev",
  "quay_org": "my-team-tenant",
  "config_name": "my-config",
  "config_repo": "https://github.com/MyOrg/my-team-agent-dev",
  "config_path": "instance/my-config",
  "workflow": "jira-sprint",
  "board_name": "My Board",
  "sprint_prefix": "MyTeam Sprint",
  "slack_webhook_url": "",
  "slack_notify_mode": "",
  "gcp_project_id": "my-gcp-project",
  "gcp_region": "global",
  "vertex_allowed_models": "claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5",
  "target_branch": "main",
  "pattern": "shared",
  "service_tree": "my-platform/my-team",
  "team_name": "My Team",
  "include_backlog": "false",
  "app_ref": "/services/my-platform/my-team/app.yml",
  "namespace_ref": "/services/my-platform/my-team/namespaces/stage.myns01.yml",
  "pipelines_ref": "/services/my-platform/my-team/pipelines/saas-openshift.yaml",
  "auth_ref": "/services/app-sre/saas-file-auth/global.yml",
  "service_label": "my-team-service",
  "platform_label": "my-platform"
}
```

### Required Fields

- `instance_name`, `repo_url`, `quay_org`
- `gcp_project_id` — required for `separate` pattern; auto-discovered from shared deploy.yml for `shared`
- `service_tree` — required for `separate` pattern only

### Defaults and Behavior

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `gcp_project_id` | separate only | discovered | Auto-discovered from shared deploy.yml for `shared` pattern |
| `gcp_region` | no | `global` | |
| `vertex_allowed_models` | no | `claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5` | |
| `pattern` | no | `shared` | `shared` creates file in shared service tree; `separate` creates in team's service tree |
| `service_tree` | separate only | — | Path under `data/services/` (e.g., `my-platform/my-team`) |
| `config_repo` | no | `repo_url` | Used as-is — no `.git` suffix auto-added |
| `target_branch` | no | `main` | Branch ref for the deployment target |
| `slack_notify_mode` | no | — | Only included if set (e.g. `daily_digest`) |
| `team_name` | no | `instance_name` | Used in SaaS file description |
| `instance_id` | no | `instance_name` | `BOT_INSTANCE_ID` param value |
| `include_backlog` | no | `false` | Sprint workflow: include backlog tickets |
| `board_name` | no | — | Kanban workflow: Jira board name or ID |
| `team_role_ref` | no | — | Team's app-interface role file path for self-service deploy access (e.g., `teams/insights/roles/my-team`) |
| `jira_project` | no | — | Kanban workflow: Jira project key |
| `app_ref` | no | shared app.yml | `$ref` to app.yml — override for separate pattern |
| `namespace_ref` | no | discovered | `$ref` to namespace YAML — discovered from shared deploy.yml if not set |
| `pipelines_ref` | no | shared pipelines | `$ref` to pipeline provider — override for separate pattern |
| `auth_ref` | no | shared auth | `$ref` to saas-file-auth |
| `service_label` | no | `platform-frontend-ai-dev` | SaaS file `labels.service` — override for separate pattern |
| `platform_label` | no | `insights` | SaaS file `labels.platform` — override for separate pattern |

## Prerequisites

The `<app_interface_repo_path>` must be a clone of the app-interface repo. The script validates that:
1. The directory exists and is a git repo
2. The `data/services/` directory exists (app-interface structure)

Clone and checkout before running this skill.

## Two SaaS File Patterns

Defaults to `"shared"`. Set `pattern: "separate"` when the team needs their own service tree.

### Pattern A: Shared (`pattern: "shared"`)

Creates a new `<instance_name>-deploy.yml` in the shared service tree at:
`data/services/insights/platform-frontend-ai-dev/<instance_name>-deploy.yml`

The main `deploy.yml` is reserved for platform instances, memory-server, and proxy — not used for onboarding.

Discovers namespace ref and GCP project from existing entries in the main `deploy.yml`.

### Pattern B: Separate (`pattern: "separate"`)

Creates a new SaaS file in the team's own service tree at:
`data/services/<service_tree>/<instance_name>.yml`

Requires `service_tree` config. The team must work with app-sre to set up the service tree (app.yml, namespace, pipeline provider) in app-interface before the bot can generate the deploy file.

## Critical Gotchas

- `managedResourceTypes` MUST include `ScaledObject.keda.sh`
- `BOT_REPLICAS` value must be string `'0'` (KEDA manages scaling)
- Namespace `$ref` is discovered from existing entries in the shared `deploy.yml`
- The `images` block requires org ref: `$ref: /dependencies/quay/redhat-services-prod.yml`
- `authentication` ref: `$ref: /services/app-sre/saas-file-auth/global.yml`

---
name: generate-instance
description: >
  Generate all scaffolding files for a new Rehor bot instance runner repo.
  Creates instance config, deploy template, setup script, README, and
  gitmodules. Output is a directory tree ready to push as a new repo.
when_to_use: >
  During the onboarding scaffolding phase, after requirements have been gathered
  and the runner repo has been created (or will be created from these files).
  Invoke with a JSON requirements blob containing team name, repos, workflow,
  envs, label, schedule, fork accounts, and tech stack detection results.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/generate-instance/generate_instance.py *)"
  - Read
---

```bash
python3 .claude/skills/generate-instance/generate_instance.py '<json_requirements>' <output_dir> 2>&1
```

Generates the full instance repo directory tree at `<output_dir>`.

### Validate-only mode

```bash
python3 .claude/skills/generate-instance/generate_instance.py --validate-only '<json_requirements>' 2>&1
```

Runs the full pipeline (input validation → template rendering → output validation) without writing files. Exits 0 if all checks pass, 1 with errors if any fail. Use this to test template changes.

## Input Validation

Input is validated against `schema.json` (JSON Schema). Invalid input is rejected before rendering. The schema enforces required fields, types, enums, and naming patterns.

## Templates

Templates live in `templates/` and use Jinja2 with custom delimiters (`<< >>` for variables, `<% %>` for blocks) to avoid conflicts with OpenShift `${{VAR}}` syntax. Edit the `.j2` files directly to change generated output — no Python changes needed for most modifications.

| Template | Generates |
|---|---|
| `deploy-template.yaml.j2` | `deploy/template.yaml` — OpenShift Deployment, NetworkPolicy, KEDA ScaledObject |
| `readme.md.j2` | `README.md` |
| `claude.md.j2` | `instance/.../agent/CLAUDE.md` |
| `setup.sh.j2` | `setup.sh` |

## Requirements JSON Example

```json
{
  "instance_name": "my-team-agent-dev",
  "config_name": "my-config",
  "team_name": "My Team",
  "workflow": "jira-sprint",
  "envs": ["node", "slack"],
  "bot_name": "devbot-myteam",
  "bot_label": "rehor-ai-myteam",
  "repos": [
    {
      "name": "my-frontend",
      "url": "https://github.com/RedHatInsights/my-frontend.git",
      "host": "github",
      "fork_account": "platex-rehor-bot",
      "fork_name": "my-frontend"
    }
  ],
  "resources": {
    "cpu_request": "1",
    "cpu_limit": "2",
    "memory_request": "2Gi",
    "memory_limit": "4Gi"
  },
  "keda_schedule": {
    "timezone": "America/New_York",
    "start": "0 9 * * 1-5",
    "end": "0 18 * * 1-5"
  },
  "github_org": "RedHatInsights",
  "konflux_namespace": "my-team-tenant",
  "target_branch": "master",
  "claude_md_strategy": "append",
  "tech_stacks": [{"repo": "my-frontend", "personas": ["frontend"], "envs": ["node"]}]
}
```

## Generated Files

```
<output_dir>/
├── .gitmodules
├── deploy/
│   └── template.yaml
├── fork-manifest.json       ← used by /auto-fork --from-manifest
├── instance/
│   └── <config_name>/
│       └── agent/
│           ├── CLAUDE.md          (when strategy != "ignore")
│           ├── instance.yaml
│           ├── mcp.json
│           ├── project-repos.json
│           └── personas/
│               └── <persona>/
│                   ├── mcp.json   (empty stub)
│                   └── prompt.md
├── setup.sh
└── README.md
```

The output JSON includes a `fork_manifest` field with the path to `fork-manifest.json`.

**Note**: `.tekton/` pipeline files are NOT generated here. They are created by the Konflux UI after the Component is registered and must be merged separately.

## Resource Defaults

Resources are tiered based on whether `browser` is in the `envs` list:

| Field | Without `browser` | With `browser` |
|-------|-------------------|----------------|
| `cpu_request` | `1` | `1` |
| `cpu_limit` | `2` | `4` |
| `memory_request` | `2Gi` | `4Gi` |
| `memory_limit` | `4Gi` | `6Gi` |
| `ephemeral_request` | `4Gi` | `4Gi` |
| `ephemeral_limit` | `8Gi` | `8Gi` |

Override any value via the `resources` object in the requirements JSON.

## Prerequisites

- Bot account (`platex-rehor-bot` for GitHub, `platform-experience-services-bot` for GitLab) must have write access to the runner repo before the scaffolding PR can be opened. The workflow posts instructions asking the team to add the bot as a collaborator.
- The scaffolding PR is opened from a fork of the runner repo (via `/auto-fork`), not pushed directly.

## Critical Gotchas

- **NetworkPolicy proxy label**: Must be `devbot-proxy`, NOT `proxy`
- **DNS port**: OpenShift DNS is 5353, not 53
- **managedResourceTypes**: Must include `ScaledObject.keda.sh` for KEDA
- **BOT_REPLICAS**: String `"0"`, not integer — KEDA manages scaling
- **Fork URL generation**: GH forks → `https://github.com/<fork_account>/<repo>.git`; GL forks → `https://gitlab.cee.redhat.com/<fork_account>/<repo>.git`. Both SSH and HTTPS input URLs are parsed correctly. Custom fork repo names supported via `fork_name` field. HTTPS is required — the bot authenticates via `gh`/`glab` credential helpers, not SSH keys.
- **Memory server label**: `app.kubernetes.io/name: memory-server` (not `devbot-memory-server`)
- **Proxy ports**: 3128 (HTTP), 9090 (executor), 8443 (Vertex), 8444 (Jira MCP), 8446 (GH release upload)

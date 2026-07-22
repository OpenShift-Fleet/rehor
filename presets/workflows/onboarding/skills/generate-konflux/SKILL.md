---
name: generate-konflux
description: >
  Generate all files needed for a Konflux onboarding MR on
  konflux-release-data. Creates tenant namespace, RBAC, Application,
  Component, ImageRepository, ReleasePlan, RPA, constraints, and
  CODEOWNERS entries. Outputs files ready to commit and push.
when_to_use: >
  During the onboarding infrastructure phase when setting up Konflux CI/CD
  for a new bot instance. Invoke after gathering tenant name, cluster,
  admin/maintainer usernames, cost center, and quota tier.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/generate-konflux/generate_konflux.py *)"
  - Read
---

```bash
python3 .claude/skills/generate-konflux/generate_konflux.py '<json_config>' <konflux_repo_path> 2>&1
```

Writes files into the `<konflux_repo_path>` directory (a clone of `konflux-release-data`).

## Config JSON Schema

```json
{
  "tenant": "my-team-tenant",
  "cluster": "kflux-prd-rh02",
  "app_name": "my-agent-dev",
  "component_name": "my-agent-dev",
  "source_url": "https://github.com/RedHatInsights/my-agent-dev",
  "dockerfile": "dev-bot/Dockerfile.runner",
  "default_branch": "master",
  "admins": ["kerbuser1", "kerbuser2"],
  "maintainers": ["kerbuser1", "kerbuser2", "kerbuser3"],
  "cost_center": "735",
  "quota_tier": "1.small",
  "quay_org": "rh-platform-experien-tenant",
  "service_name": "my-agent-dev",
  "new_tenant": true
}
```

## Cluster Suffix Mapping

| Cluster | Config suffix |
|---------|---------------|
| `kflux-prd-rh02` | `kflux-prd-rh02.0fk9.p1` |
| `kflux-prd-rh03` | `kflux-prd-rh03.nnv1.p1` |
| `kflux-ocp-p01` | `kflux-ocp-p01.7ayg.p1` |

## Cluster Selection Rules

- Default for new public onboarding: `kflux-prd-rh02`
- `kflux-prd-rh03` is RESERVED for Hummingbird project
- `kflux-ocp-p01` for OCP/ART teams (internal)
- `stone-prd-rh01` is legacy/full — do not use for new tenants
- Check `verify-onboarding-allowed.sh` for disabled clusters

## New Tenant vs Existing Tenant

- `new_tenant: true` → full creation (admin, RBAC, app, component, RPA, constraints, CODEOWNERS)
- `new_tenant: false` → add component only (component subdir, update app kustomization, RPA)

## Generated File Structure (new tenant)

Same files as `add-namespace.sh create` would produce, generated as pure Python.

## Important Notes

- The RPA uses the `rh-push-to-external-registry` pipeline (service/Quay push), NOT `rh-advisories` (product)
- Policy is `app-interface-standard` for service releases
- CODEOWNERS entries must be sorted alphabetically (validated by `tox -e codeowners-lint`)
- `auto-generated/` files are created by CI — only commit source-of-truth files
- Use the Rehor fork (`platform-experience-services-bot/konflux-release-data`) for MR branches

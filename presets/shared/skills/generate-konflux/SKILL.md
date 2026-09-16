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
  "instance_name": "my-agent-dev",
  "repo_url": "https://github.com/MyOrg/my-agent-dev",
  "dockerfile": "dev-bot/Dockerfile.runner",
  "target_branch": "main",
  "admins": ["kerbuser1", "kerbuser2"],
  "maintainers": ["kerbuser1", "kerbuser2", "kerbuser3"],
  "cost_center": "735",
  "quota_tier": "1.small",
  "quay_org": "my-team-tenant",
  "service_name": "my-agent-dev",
  "new_tenant": true
}
```

### Required Fields

- `tenant`, `quay_org`, `instance_name`, `repo_url`
- `cost_center` required when `new_tenant: true`

## Cluster Suffix Discovery

The full cluster FQDN suffix (e.g., `kflux-prd-rh02.<hash>`) is discovered at runtime by scanning the `config/` directory in the cloned `konflux-release-data` repo. The generator matches directories starting with the short cluster name. No hardcoded suffix map — new clusters are picked up automatically.

## Cluster Selection Rules

- Default for new public onboarding: `kflux-prd-rh02`
- `kflux-prd-rh03` is RESERVED — do not use without checking with the Rehor team
- `kflux-ocp-p01` for internal teams — confirm with the team before using
- `stone-prd-rh01` is full — do not create new tenants, but existing tenants can add new components
- Check `verify-onboarding-allowed.sh` for disabled clusters

## New Tenant vs Existing Tenant

- `new_tenant: true` → full creation (admin, RBAC, app, component, RPA, constraints, CODEOWNERS)
- `new_tenant: false` → add component only (component subdir, update app kustomization, RPA)

## Generated File Structure (new tenant)

Same files as `add-namespace.sh create` would produce, generated as pure Python.

## Upstream Script (preferred when available)

The canonical tool is `add-namespace.sh` in the `konflux-release-data` repo. This Python generator
produces the same output but as pure Python — no dependency on `yq`, `kubectl`, `kustomize`, or `tox`.

**TODO**: When the executor container includes these tools, replace this generator with a wrapper
that invokes `add-namespace.sh create` directly. Track in the container image requirements.

## Important Notes

- The RPA uses the `rh-push-to-external-registry` pipeline (service/Quay push), NOT `rh-advisories` (product)
- Policy is `app-interface-standard` for service releases
- CODEOWNERS entries must be sorted alphabetically (validated by `tox -e codeowners-lint`)
- `auto-generated/` files are created by CI — only commit source-of-truth files
- Use the Rehor fork (`platform-experience-services-bot/konflux-release-data`) for MR branches

## Post-Generation Steps

After generating files, the bot (or user) must:

1. **Run `build-single.sh`** to regenerate the `auto-generated/` directory for the tenant:
   ```bash
   cd <konflux_repo>/tenants-config
   ./build-single.sh <tenant-name-without-tenant-suffix>
   ```
   Requires `kustomize` (install via `brew install kustomize` or `./get-kustomize.sh`).

2. **Commit both** the source files and the `auto-generated/` output.

3. **Validate** (optional locally, required in CI):
   ```bash
   tox -e tenants-config-test
   ```

4. **CODEOWNERS** — check if the tenant already has wildcard coverage. If not, add entries for both the source and `auto-generated/` paths.

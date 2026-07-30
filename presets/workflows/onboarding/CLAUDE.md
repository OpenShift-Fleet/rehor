Autonomous onboarding bot. Jira tickets → requirements → configs → PRs/MRs → manual steps → completion.

## Scope

V1: Instance repos GitHub only. Target repos GitHub or GitLab.

## Three-Phase Onboarding

Every Jira comment prefixed w/ phase header:
```
## [Phase 1/3] Instance Setup — <step>
## [Phase 2/3] Konflux CI/CD — <step>
## [Phase 3/3] Deployment — <step>
```

| Phase | Gather | Bot does | Team does |
|-------|--------|----------|-----------|
| 1 — Instance | name, repos, workflow, label | scaffolding PR | create repo, grant access, merge |
| 2 — Konflux | tenant, cluster, admins, quota | Konflux MR | merge MR, Tekton pipelines, verify Quay |
| 3 — Deploy | confirm values | app-interface MR | merge MR, verify pod |

---

## Workflow Loop

ONE ticket per cycle.

`bot_status_update`: cycle start → `working` / pick task → include `external_key` / end → `idle` / error → `error`

Sleep: skills write `data/cycle-sleep.json`. Default 300s.

### Input Data

Active tasks, comments, PR/MR states in input prompt. No re-fetch unless `[jira unavailable]`.

### P0: Handle Feedback

First match wins from input data:
1. Jira comment responses → advance
2. PR/MR review feedback → address, push fixes
3. Manual step confirmations → check off, advance

**Shared Jira identity**: bot shares creds w/ human. Bot comments = structured (### headers, checklists). Short conversational = human feedback. **Ambiguous → treat as human feedback.**

### P1: Advance Active Onboardings

Current step = **Jira labels on epic**. Advance ONE step/cycle.

#### Status Labels

Bot applies exactly one `onboarding:*` step label. Preflight reads labels for state.

| Label | Ph | Advance when | Action |
|-------|----|--------------|--------|
| `onboarding:intake` | 1 | ticket read | `/post-intake` |
| `onboarding:requirements-gathering` | 1 | team responded | detect stacks, `/post-plan` |
| `onboarding:plan-posted` | 1 | approved | post repo creation instructions |
| `onboarding:repo-requested` | 1 | repo confirmed | `/generate-instance`, open PR |
| `onboarding:scaffolding-pr` | 1 | PR merged | Phase 1 ticket→Done, `/post-konflux-questions` |
| `onboarding:konflux-info` | 2 | team responded | `/generate-konflux`, open MR |
| `onboarding:konflux-mr` | 2 | MR merged | `/post-konflux-instructions` |
| `onboarding:tekton-setup` | 2 | pipelines+Quay | Phase 2 ticket→Done, gather deploy details (dedicated: checkpoint), `/generate-app-interface`, open MR |
| `onboarding:app-interface-mr` | 3 | MR merged | `/post-manual-steps` |
| `onboarding:manual-steps` | 3 | steps confirmed | verify deployment |
| `onboarding:verification` | 3 | verified | close epic |
| `onboarding:complete` | — | — | — |

**`onboarding:blocked`** — additive label (does NOT replace the step label). Applied whenever manual intervention from the Rehor development team is required and the bot cannot advance on its own. Examples: team lacks an app-interface role, dedicated proxy setup needed, dedicated GCP project guidance, unsupported tech stack flagged for review. Preflight should skip tickets with this label. When the blocker is resolved (team replies or Rehor team assists), remove `onboarding:blocked` and resume from the current step label. Always post a Jira comment explaining what's blocked and how to unblock before applying.

**Advance**: replace `onboarding:*` step label via `jira_update_issue`. Phase boundaries → transition completed phase sub-ticket to Done. Transition the *next* phase sub-ticket to In Progress only when the team has action items (MR to merge, repo to create), not when the bot is still gathering info.

### P2: New Onboarding Tickets

All active clean → capacity → pick candidate from **REHOR** Jira project only.

**Claim**: `/claim-onboarding` `{"epic_key", "project_key", "team_name", "summary"}` — assigns, transitions, creates 3 phase sub-tickets, applies `onboarding:intake`, creates memory task.

Task metadata:
```json
{"phase":1,"step":"intake","epic_key":"PROJ-123","phase_tickets":{"phase1":"PROJ-124","phase2":"PROJ-125","phase3":"PROJ-126"},"requirements":{},"konflux":{}}
```

**Task status**: `in_progress` for work, `pr_open` when PR/MR opened, `pr_changes` for review feedback.

---

## Phase 1: Instance Setup

### `onboarding:intake`

Read ticket. Run `/post-intake` `{"epic_key"}`. Extract any pre-filled values from the ticket description and store in metadata `requirements`.

### `onboarding:requirements-gathering`

Parse team responses from comments.

**Defaults** (always set, not asked): `source: jira`

**Naming** (suggested defaults — team can override any):
- `instance_name`: repo name (e.g., `hcc-framework-agent-dev`). Also used as Konflux app/component name.
- `instance_id`: fun human-readable bot identity for `BOT_INSTANCE_ID` (e.g., `Řehoř Hrubý z Jelení`)
- `config_name`: `<slug>-config` — directory under `instance/`, always set explicitly
- `bot_name`: `devbot-<slug>` (OpenShift deployment name)
- `bot_label`: `rehor-ai-<slug>` (Jira label the bot filters on)

The slug for `bot_name`, `bot_label`, and `config_name` is derived from team/project context, not from `instance_name`. These are all independently settable.

When all gathered:
1. `git clone --depth 1` target repos
2. `/detect-tech-stack` on each
3. `needs_team_review` → tag Rehor team (unsupported stack), apply `onboarding:blocked`
4. `/post-plan` w/ config

Store all requirements in metadata.

### `onboarding:plan-posted`

Wait for: "approved", "lgtm", "looks good", "go ahead", "proceed".

Post (adapt fork account for dedicated infra teams who provide their own):
```
## [Phase 1/3] Instance Setup — Action Required: Create Repo

- [ ] **Create GitHub repo**: Org: <team's org>, Name: `<instance_name>`, Public
- [ ] **Grant bot access** — add `<fork_account>` as a collaborator (the bot forks your repo and opens PRs from the fork, so Read access is sufficient for public repos)
- [ ] **Default branch** — confirm if `main` or `master` (I'll default to `main`)

Reply with repo URL once done.
```
Use `platex-rehor-bot` for shared infra, or the team's own fork account for dedicated infra.

Apply `onboarding:repo-requested`. Transition the Phase 1 sub-ticket to "In Progress" (the team now has action items).

### `onboarding:repo-requested`

Wait for repo URL. Verify access via `/auto-fork`.

1. `/generate-instance` w/ requirements JSON → scaffolding + `fork-manifest.json`
2. `/auto-fork --from-manifest <output_dir>/fork-manifest.json` → forks instance repo, outputs fork URL
3. Clone fork, copy scaffolding files, `git submodule add https://github.com/OpenShift-Fleet/rehor.git dev-bot`
4. Push branch `bot/onboarding-<TICKET_KEY>`, open PR

**Note**: No `.tekton/` files — those come from Konflux Phase 2.

Post scaffolding PR link. Link PR to Jira: `jira_create_remote_issue_link` on both the parent ticket and the Phase 1 sub-ticket. Apply `onboarding:scaffolding-pr`.

---

## Phase 2: Konflux CI/CD

### `onboarding:scaffolding-pr`

When PR merged:
1. Phase 1 sub-ticket → Done
2. `/auto-fork` target repos from project-repos.json
3. `/post-konflux-questions` `{"epic_key", "team_name", "instance_name"}`

Update metadata: `phase: 2`, `step: "konflux-info"`.

### `onboarding:konflux-info`

Parse Konflux responses. Clone `konflux-release-data` fork → `/generate-konflux` → run `build-single.sh` → commit → push → open MR.

After `/generate-konflux`, run `build-single.sh` to regenerate the `auto-generated/` directory:
```bash
cd <konflux_repo>/tenants-config
./build-single.sh <tenant>
```
The script accepts the tenant name with or without the `-tenant` suffix. This runs `kustomize build` on the tenant directory and produces the `auto-generated/` files that CI requires.

Before committing, verify that `auto-generated/` changes are scoped to the target tenant only:
```bash
git diff --name-only -- tenants-config/auto-generated/ | grep -v "tenants/<tenant>"
```
If any auto-generated files for other tenants appear, discard them with `git checkout` before committing. Commit both the source files (tenant YAML, RPA, constraints, CODEOWNERS) and the scoped `auto-generated/` output.

Post MR link. Link MR to Jira: `jira_create_remote_issue_link` on both the parent ticket and the Phase 2 sub-ticket. Apply `onboarding:konflux-mr`. Transition Phase 2 sub-ticket to "In Progress" (team needs to merge MR). Store Konflux info in metadata.

### `onboarding:konflux-mr`

When MR merged: `/post-konflux-instructions` `{"epic_key", "instance_name", "quay_org", "tenant"}`. Apply `onboarding:tekton-setup`.

---

## Phase 3: Deployment

### `onboarding:tekton-setup`

Wait for: pipelines merged, build ran, Quay image exists.

1. Phase 2 sub-ticket → Done
2. Gather deployment details. Post one of the following comments depending on infra type:

   **Shared infra:**
   ```
   ## [Phase 3/3] Deployment — Getting Started

   Phase 2 is complete!

   Before I generate the app-interface deployment MR, I need one more thing:

   ### Required
   - **App-interface role path** — your team's role file in app-interface
     (e.g., `teams/insights/roles/platform-experience-services`).
     This lets your team self-approve future deploy config changes without app-sre review.

   If your team doesn't have an app-interface role yet, reach out to the Rehor development
   team in JIRA or Slack and we'll help get one set up.

   The MR will use shared infrastructure values discovered from the existing deploy configuration.
   ```
   Do NOT post the actual shared infra values (GCP project, namespace, etc.) — they may contain sensitive infrastructure details. If the team doesn't have an app-interface role, apply `onboarding:blocked` and instruct them to reach out to the Rehor team in JIRA or Slack for help.

   **Dedicated infra (separate pattern):** before gathering deployment fields, confirm the team has completed the prerequisite service tree setup with app-sre:
   ```
   ## [Phase 3/3] Deployment — Prerequisites Check

   Phase 2 is complete!

   Before we generate the deployment MR, please confirm:
   - [ ] Your app-interface service tree has been set up with app-sre (app.yml, namespace, pipeline provider)
   ```
   Wait for confirmation before proceeding. Then gather:
   ```
   ## [Phase 3/3] Deployment — Gathering Details

   ### Required
   - **App-interface role path** — your team's role file in app-interface
     (e.g., `teams/insights/roles/my-team`).
     This lets your team self-approve future deploy config changes.
   - **GCP project ID** — your team's GCP project with Vertex AI API enabled
   - **Service tree** — path under `data/services/` where your app-interface
     service lives (e.g., `insights/my-team`)
   - **Namespace ref** — `$ref` to your team's namespace YAML in app-interface

   ### Optional (defaults applied if not specified)
   - GCP region — default: `global`
   - App ref — `$ref` to your app.yml (default: shared)
   - Pipelines ref — `$ref` to your pipeline provider (default: shared)

   If your team doesn't have an app-interface role yet, reach out to the Rehor development
   team in JIRA or Slack and we'll help get one set up.
   ```
   If the team doesn't have an app-interface role, apply `onboarding:blocked`.
3. Clone app-interface fork → discover infrastructure values at generation time → `/generate-app-interface` → commit → push → open MR. The MR includes:
   - The deploy file (`<instance_name>-deploy.yml`)
   - A `codeComponents` entry in `app.yml` for the instance repo (if not already present)
   - A `self_service` datafile entry in the team's role file (`team_role_ref`) under the `saas-file-self-service` change type, pointing to the new deploy file. This gives the team self-service approval for future deploy config changes.

Post the MR link with approval instructions:
   ```
   ## [Phase 3/3] Deployment — App-Interface MR Opened

   I've opened an MR to deploy your bot instance:
   [MR !<number>: [Phase 3/3] Add <instance_name> deployment (<TICKET_KEY>)](<mr_url>)

   **What's in the MR:**
   - Deploy file (`<instance_name>-deploy.yml`) with your bot configuration
   - `codeComponents` entry in app.yml for your instance repo
   - Self-service datafile entry in your team's role file for future deploy config changes

   **Approvals needed for this initial MR:**
   This first deployment MR requires three approvals — comment `/lgtm` on the MR:
   1. Someone from your team
   2. Someone from the Rehor development team
   3. app-sre (automatically requested)

   The app-sre bot will post a comment on the MR listing which files changed and
   which teams must explicitly approve. Follow those instructions to ensure all
   required `/lgtm` comments are in place.

   Future updates to your deploy config will only require your team's approval
   via the self-service entry included in this MR.

   Reply here once the MR is merged and I'll post the final setup steps.
   ```

Link MR to Jira: `jira_create_remote_issue_link` on both the parent ticket and the Phase 3 sub-ticket. Apply `onboarding:app-interface-mr`. Transition Phase 3 sub-ticket to "In Progress" (team needs to review/approve MR). Update metadata: `phase: 3`.

### `onboarding:app-interface-mr`

When MR merged: `/post-manual-steps` `{"epic_key", "bot_label", "bot_name", "dedicated_proxy", "workflow"}`.

### `onboarding:manual-steps`

Parse "done" responses. All confirmed → verify checkable items, post summary. Apply `onboarding:verification`.

### `onboarding:verification`

Check: config repo accessible, Jira label exists, target repos forkable.

Post completion msg. Phase 3 sub-ticket → Done. Epic → Done/Release Pending. Apply `onboarding:complete`. Task → `completed`.

---

## Decision Branches

### Shared vs Dedicated Infrastructure

Determine early (Phase 1 intake) whether the team uses shared Rehor infrastructure or needs dedicated setup. Key questions: does the team need a separate GCP project (billing separation), or separate Jira/GitHub/GitLab credentials?

> **Terminology**: "fork account" = the GitHub/GitLab service account the bot uses to fork repos and open PRs/MRs (e.g., `platex-rehor-bot`). Team-facing text (intake, plan) calls these "bot accounts" since that's the team's mental model.

**Shared** (most teams — works across orgs, e.g., `RedHatInsights`, `project-kessel`):
Uses the shared proxy, memory server, GitHub/GitLab fork accounts, namespace, and GCP project.
- SaaS pattern: prefer a new `<instance>-deploy.yml` in the `platform-frontend-ai-dev` service tree. Main `deploy.yml` is reserved for platform instances, memory-server, and proxy — fallback only.
- Konflux tenant: may be existing or new
- GCP project: uses the shared project (discovered from `SHARED_SAAS_PATH`)
- Proxy: shared `devbot-proxy` in same namespace
- Fork accounts: `platex-rehor-bot` (GitHub), `platform-experience-services-bot` (GitLab)

**Dedicated** (teams needing separate GCP billing or credentials):
- Memory server: stays shared by default — only separate if the agent handles sensitive data
- SaaS pattern: `separate` — new service tree in app-interface (not under `insights/platform-frontend-ai-dev`). Requires `service_tree` (e.g., `<platform>/<team>`) — ask the team where their service lives in app-interface. The onboarding bot can generate the SaaS deploy file once the service tree exists, but cannot yet bootstrap the full app-interface service structure (app.yml, namespace, pipeline provider). The team must work with the app-interface / app-sre team to set that up first.
- Konflux tenant: almost always new
- GCP project: team must provide their own (surface this early in Phase 1) — most common reason for dedicated infra (billing separation)
- Proxy: dedicated proxy required — instruct team to create a ticket in the **REHOR** Jira project so the Rehor team can collaborate on setup. Apply `onboarding:blocked` until proxy setup is coordinated.
- Fork accounts: required, no default — team must provide their own GitHub/GitLab fork accounts
- Cost center: required, no default

Surface GCP project, dedicated proxy, and fork account requirements in Phase 1 intake for dedicated teams — don't wait until Phase 3.

### GitHub vs GitLab targets

`github.com` → `gh`, fork to `platex-rehor-bot` (or team's account) | `gitlab.cee.redhat.com` → `glab --hostname`, fork to `platform-experience-services-bot` (or team's account)

### SaaS pattern

`shared` (Pattern A) — new `<instance>-deploy.yml` in the `platform-frontend-ai-dev` service tree. Prefer this over appending to the main `deploy.yml`, which is reserved for platform instances, memory-server, and proxy (fallback only). | `separate` (Pattern B) — entirely new service tree outside `platform-frontend-ai-dev`. Own proxy deploy and bot instance deploy; memory server stays shared unless the agent handles sensitive data. Independent of shared/dedicated infra choice. Check app-interface or ask the team.

### Konflux tenant

New → `/generate-konflux` `new_tenant: true` (requires `cost_center`) | Existing → `new_tenant: false` (cluster is auto-detected from the tenant directory in `konflux-release-data`; if the tenant spans multiple clusters, ask the team which one to use)

---

## Progress Tracking

### Jira Labels (source of truth)

Epic's `onboarding:*` label = authoritative step indicator. Bot applies one label per transition. Preflight reads labels.

### Task Metadata

```json
{"phase":1,"step":"intake","epic_key":"PROJ-123","phase_tickets":{"phase1":"...","phase2":"...","phase3":"..."},"requirements":{"team_name":"","instance_name":"","config_name":"","repo_url":"","github_org":"","repos":[],"workflow":"jira-sprint","bot_name":"devbot-...","bot_label":"rehor-ai-...","instance_id":"","board_name":"","sprint_prefix":"","include_backlog":"false","jira_project":"","envs":[],"personas":[],"tech_stacks":[],"pattern":"shared","dedicated_proxy":false,"fork_account":"","slack_webhook_url":"","slack_notify_mode":""},"konflux":{"quay_org":"","tenant":"","cluster":"","new_tenant":true,"admins":[],"maintainers":[],"cost_center":"","quota_tier":""},"deployment":{"gcp_project_id":"","gcp_region":"global","target_branch":"main","config_repo":"","config_path":"","service_tree":"","app_ref":"","namespace_ref":"","pipelines_ref":"","auth_ref":"","team_role_ref":""},"prs":[],"mrs":[],"last_addressed":""}
```

- `step` matches label suffix
- `last_addressed` — update every time feedback addressed
- `pattern` and `dedicated_proxy` — set during Phase 1 requirements gathering
- `fork_account` — set during Phase 1 requirements gathering. Team-provided for dedicated infra; empty for shared (uses defaults)
- `deployment.gcp_project_id` — team-provided for dedicated infra only. For shared, discovered at generation time from `SHARED_SAAS_PATH` — do not cache.
- `deployment.service_tree`, `app_ref`, `namespace_ref`, `pipelines_ref` — only for separate pattern. Team-provided or coordinated with app-sre.
- `prs`/`mrs` — arrays of `{"repo": "...", "number": N, "host": "github|gitlab"}`

**Resume**: `task_get(external_key)` → read metadata → cross-check metadata `step` vs epic label.
**End cycle**: `task_update` w/ updated metadata.

## Canonical Field Names

All skills MUST use these field names. No aliases.

| Canonical | Used in | Meaning |
|-----------|---------|---------|
| `instance_name` | all skills | Repo name and Konflux app/component name (e.g., `hcc-framework-agent-dev`) |
| `instance_id` | generate-app-interface | Human-readable bot identity (`BOT_INSTANCE_ID`), set in deploy template |
| `repo_url` | generate-konflux, generate-app-interface, detect-tech-stack | Full HTTPS URL of instance repo |
| `target_branch` | generate-konflux, generate-app-interface, detect-tech-stack | Default branch of instance repo (`main` or `master`) |
| `envs` | detect-tech-stack, generate-instance, post-plan | Runtime environments needed (`node`, `browser`, etc.) |
| `personas` | detect-tech-stack, generate-instance, post-plan | Detected personas from repo analysis |
| `epic_key` | all Jira-posting skills | Jira epic key (e.g., `RHCLOUD-12345`) |
| `quay_org` | generate-konflux, generate-app-interface, post-konflux-instructions | Quay org for image push |
| `tenant` | generate-konflux | Konflux tenant namespace name |
| `config_name` | generate-instance, generate-app-interface | Config directory name under `instance/` |
| `config_repo` | generate-app-interface | Repo URL for `BOT_CONFIG_PATH` source (defaults to `repo_url`) |
| `config_path` | generate-app-interface | Path within config_repo to config dir |
| `pattern` | generate-app-interface | SaaS file pattern: `shared` or `separate` |
| `gcp_project_id` | generate-app-interface | GCP project for Vertex AI |
| `gcp_region` | generate-app-interface | GCP region (default: `global`) |
| `bot_name` | generate-instance, generate-app-interface | OpenShift deployment name |
| `bot_label` | generate-instance, generate-app-interface, post-manual-steps | Jira label the bot filters on |
| `dedicated_proxy` | post-plan, post-manual-steps | Whether team needs own proxy (dedicated infra) |
| `service_tree` | generate-app-interface | Path under `data/services/` for separate pattern (e.g., `my-platform/my-team`). Required for `separate`, not used for `shared`. |
| `app_ref` | generate-app-interface | `$ref` to app.yml (default: shared service tree). Override for separate pattern. |
| `namespace_ref` | generate-app-interface | `$ref` to namespace YAML. Discovered from shared deploy.yml if not provided. |
| `pipelines_ref` | generate-app-interface | `$ref` to pipeline provider. Override for separate pattern. |
| `team_role_ref` | generate-app-interface | App-interface role file path for self-service deploy access (e.g., `teams/insights/roles/platform-experience-services`). The bot adds a `saas-file-self-service` datafile entry for the new deploy file. |

**Retired aliases** (do NOT use): `source_url`, `default_branch`, `app_name`, `component_name`, `suggested_envs`, `suggested_personas`, `instance_repo_url`.

## Rules

- ONE ticket per cycle
- Feedback > advancing > new tickets
- Blocked/ambiguous → Jira comment + stop. If blocked on Rehor team intervention, also apply `onboarding:blocked` label (additive — keep the step label)
- No Jira spam — read before posting
- Phase headers on every comment
- PR/MR titles: `[Phase N/3] <desc> (<TICKET_KEY>)`
- PR/MR descriptions: link Jira ticket + summary
- After completion: `memory_store` category `learning` tags `onboarding`
- Use runtime env vars: `GH_USER_NAME`, `BOT_JIRA_EMAIL`, `BOT_CONFIG_PATH`
- No emojis in Jira comments or PR/MR descriptions — keep tone professional and plain

---

## Known Limitations / V2

Things the onboarding workflow cannot yet handle for dedicated-infra teams (outside shared infrastructure). If a team hits one of these, coordinate manually with the Rehor platform team.

### Dedicated proxy deployment

`deploy-template.yaml.j2` hardcodes ~15 service references to shared infrastructure: `devbot-proxy` (ports 3128, 8443, 8444, 8446, 9090), `devbot-memory-server` (port 8080), and `devbot-secrets`. These are string literals in the Jinja2 template, not OpenShift template parameters. A team needing separate credentials (different Jira/GitHub/GitLab accounts) requires a dedicated proxy, which means either:
- Parameterizing the deploy template to accept proxy/memory-server/secret names
- Creating a separate deploy template variant for dedicated-proxy deployments

The NetworkPolicy also hardcodes pod label selectors for `devbot-proxy` and `memory-server`.

### Arbitrary GitLab hosts

`generate_instance.py` hardcodes `gitlab.cee.redhat.com` for GitLab fork URL construction. Teams using a different GitLab instance (e.g., `gitlab.com`) would get wrong fork URLs in `project-repos.json`, causing git-clone failures at runtime.

### Separate namespace / app-interface service

The `separate` SaaS pattern requires `service_tree` and supports `app_ref`, `namespace_ref`, `pipelines_ref` overrides. However, it cannot bootstrap the service tree itself. For a team that needs their own namespace on a different cluster, the following must be created manually (with app-sre):
- A new `app.yml` in app-interface
- A new namespace YAML under the team's service tree
- A new pipeline provider definition

**`namespace_ref` fallback risk**: if `namespace_ref` is not explicitly provided, the generator falls back to discovering it from the shared `deploy.yml`. For a team on a different cluster/namespace, this fallback gives the wrong namespace. Always require `namespace_ref` for separate pattern teams on their own namespace — do not rely on the fallback.

### Arbitrary Konflux clusters

`generate_konflux.py` discovers cluster FQDN suffixes at runtime from the `config/` directory in the cloned `konflux-release-data` repo. A cluster that doesn't have an existing `config/<cluster>.*` directory will raise a `ValueError` with the list of available clusters.

# Onboarding a New Bot Instance

How to add a new bot runner instance to the shared OpenShift cluster. Each instance gets its own Jira label, repo set, and personas, but shares the memory server, database, and Vault secrets deployed by the primary instance (platform-frontend-ai-dev). Instances share the proxy by default, but can optionally deploy their own proxy for custom Jira credentials.

For the system architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Prerequisites

Before starting, you need:

- [ ] A GitHub repo for your instance (e.g. `RedHatInsights/my-bot-instance`)
- [ ] A Jira label for your team's tickets (e.g. `hcc-ai-myteam`)
- [ ] Access to the app-interface repo (`gitlab.cee.redhat.com/service/app-interface`)
- [ ] The primary instance (platform-frontend-ai-dev) already deployed in the target namespace — it provides the shared proxy, memory server, and secrets

---

## Step 1: Create the Runner Repo

The runner repo uses dev-bot as a git submodule. It contains only instance-specific config — no bot code.

```bash
mkdir my-bot-instance && cd my-bot-instance
git init
git submodule add https://github.com/RedHatInsights/platform-frontend-ai-dev.git dev-bot
```

Create the required files:

### `setup.sh`

Runs as root during the Docker build. Install instance-specific packages here.

```bash
#!/bin/bash
set -e

echo "my-bot-instance" > /home/botuser/app/.instance-id

# Instance-specific packages go here:
# dnf install -y --nodocs <package>
# pip3.12 install <package>
# npm install -g <package>

echo "Instance setup complete: my-bot-instance"
```

### `instance/` directory

Create your instance config. This entire directory gets COPYed into the image at `/home/botuser/app/instance/`. The bot loads it at startup via `BOT_CONFIG_PATH`.

```
instance/my-config/
└── agent/
    ├── instance.yaml         # preset selection (workflow, env presets, CLAUDE.md strategy)
    ├── project-repos.json    # repos this instance works on
    ├── mcp.json              # MCP server overrides (usually just Jira)
    └── personas/             # domain-specific guidelines
        ├── frontend/
        │   └── prompt.md
        └── ...
```

#### `instance.yaml`

Declares which workflow and env presets your instance uses. **Required for all new instances.**

```yaml
workflow: jira-sprint
source: jira
envs:
  - browser
  - slack
  - container-scan
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workflow` | string | `jira-sprint` | Which workflow preset to use. Must exist in `presets/workflows/`. |
| `source` | string | `jira` | Ticket source. Currently: `jira`. Future: `github`, `gitlab`. |
| `envs` | list or null | `null` (all) | Env presets to activate. `null`/omitted = all available. `[]` = none. |
| `claude_md.strategy` | string | `ignore` | How to handle instance CLAUDE.md: `ignore`, `append`, `replace`. |

Available env presets:
- `browser` — Chromium + chrome-devtools MCP for visual verification (requires `PLAYWRIGHT_BROWSERS_PATH`, set automatically)
- `container-scan` — Grype + Buildah for CVE scanning
- `slack` — Slack notifications via webhook (requires `SLACK_WEBHOOK_URL`)
- `dev-proxy` — Caddy reverse proxy for stage UI verification (requires `PROXY_HOST`)

List only the presets your instance actually needs. Omitting unused ones saves container startup time and avoids unnecessary env var requirements.

For the full preset system reference, see [preset-migration-guide.md](migrations/preset-migration-guide.md).

#### `project-repos.json`

List only the repos your instance should work on:

```json
{
  "my-frontend": {
    "url": "https://github.com/your-bot-fork/my-frontend.git",
    "upstream": "https://github.com/YourOrg/my-frontend.git"
  },
  "my-backend": {
    "url": "https://github.com/your-bot-fork/my-backend.git",
    "upstream": "https://github.com/YourOrg/my-backend.git"
  },
  "app-interface": {
    "url": "https://gitlab.cee.redhat.com/your-bot-fork/app-interface.git",
    "upstream": "https://gitlab.cee.redhat.com/service/app-interface.git",
    "host": "gitlab"
  }
}
```

- `url` — bot's fork (where it pushes branches)
- `upstream` — original repo (PR/MR target)
- `host` — set to `"gitlab"` for GitLab repos (default: GitHub)
- `readonly` — set to `true` if bot should only read, never push

#### `mcp.json`

Typically just points to the shared Jira MCP server:

```json
{
  "mcpServers": {
    "mcp-atlassian": {
      "url": "${JIRA_MCP_URL}"
    }
  }
}
```

#### Personas

Copy and adapt from `dev-bot/rehor-config/agent/personas/`. Each persona is a `prompt.md` with coding standards, test commands, and conventions for that repo type.

### `README.md`

```markdown
# my-bot-instance

Custom bot runner built on [dev-bot](https://github.com/RedHatInsights/platform-frontend-ai-dev).

## Build

\`\`\`bash
git submodule update --init --recursive
docker build -f dev-bot/Dockerfile.runner -t my-bot-instance:local .
\`\`\`

## Updating dev-bot

\`\`\`bash
cd dev-bot && git pull origin master && cd ..
git add dev-bot
git commit -m "chore: update dev-bot submodule"
\`\`\`
```

### Reference PRs

- [Bootstrap runner with dev-bot submodule](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/1) — initial repo setup
- [Add UI instance config](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/12) — project-repos.json, personas, mcp.json

---

## Step 2: Deploy Template

Create `deploy/template.yaml`. This is a **bot-only** template — it does NOT create the memory server (that comes from the primary instance). The proxy is shared by default but can optionally be deployed per-instance for custom Jira credentials.

Copy from [`hcc-ui-agent-dev/deploy/template.yaml`](https://github.com/RedHatInsights/hcc-ui-agent-dev/blob/master/deploy/template.yaml) and adjust:

- `metadata.name` — your instance name
- Default `BOT_NAME` — e.g. `devbot-myteam`
- Default `BOT_LABEL` — your Jira label
- `BOT_IMAGE` — your Quay image path

The template creates these resources:
1. **Proxy Deployment** (optional) — own proxy with custom Jira credentials. Set `PROXY_REPLICAS=0` (default) to use the shared proxy, or `PROXY_REPLICAS=1` to deploy your own.
2. **Proxy Service** (optional) — ClusterIP service for the per-instance proxy.
3. **Bot Deployment** — bot container with env vars pointing to shared infra.
4. **NetworkPolicy** — egress restricted to proxy + memory-server + DNS only. References `${PROXY_NAME}` so it correctly targets either shared or per-instance proxy.
5. **ScaledObject** (KEDA cron scaler) — auto-scales the bot on a time-based schedule. See [Step 2b: Scheduling](#step-2b-scheduling-keda-cron-scaler).

Key environment variables (already wired in the template):
- `BOT_MEMORY_URL=http://devbot-memory-server:8080/mcp` — shared memory server
- `EXECUTOR_ADDR=${PROXY_NAME}:9090` — executor (shared or per-instance proxy)
- `HTTP_PROXY=http://${PROXY_NAME}:3128` — Squid proxy
- `JIRA_MCP_URL=http://${PROXY_NAME}:8444/mcp` — Jira MCP

### Shared vs Per-Instance Proxy

| Mode | `PROXY_REPLICAS` | `PROXY_NAME` | `JIRA_SECRET_NAME` | When to use |
|------|-------------------|--------------|---------------------|-------------|
| **Shared** (default) | `0` | `devbot-proxy` | `devbot-secrets` | Same Jira identity as primary instance |
| **Per-instance** | `1` | unique name (e.g. `devbot-myteam-proxy`) | your secret name | Custom Jira credentials needed (different Jira project access) |

**Why a separate proxy?** Bot pods are network-isolated — the NetworkPolicy only allows egress to the proxy and memory server. The proxy runs mcp-atlassian (Jira MCP server) with the Jira credentials baked in. To use a different Jira account, you need a separate proxy pod with different credentials. A sidecar won't work because pods in the same deployment share the same NetworkPolicy.

### NetworkPolicy proxy label — Important

The NetworkPolicy must use `app.kubernetes.io/name: devbot-proxy` to match the shared proxy pod. **Do NOT use `proxy`** — the proxy pod's label is `devbot-proxy`, not `proxy`. A wrong label silently blocks all egress and the bot pod will hang waiting for the executor.

```yaml
# Correct
- to:
  - podSelector:
      matchLabels:
        app.kubernetes.io/name: devbot-proxy    # ← must match the proxy pod label
  ports:
  - port: 3128
    protocol: TCP
  # ...
```

If using a per-instance proxy (`PROXY_REPLICAS=1`), use `${PROXY_NAME}` instead (it resolves to your custom proxy name).

### DNS Egress — Important

OpenShift uses custom DNS on port **5353** in the `openshift-dns` namespace, not the standard port 53. Your NetworkPolicy must allow:

```yaml
- to:
  - namespaceSelector:
      matchLabels:
        kubernetes.io/metadata.name: openshift-dns
  ports:
  - port: 5353
    protocol: UDP
  - port: 5353
    protocol: TCP
```

Using port 53 or `k8s-app: kube-dns` will cause pods to hang — they can't resolve service names.

### Reference PRs

- [Add OpenShift deploy template](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/3) — initial template
- [Fix DNS egress and parameterize bot name](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/7) — critical DNS fix
- [Add BOT_JIRA_EMAIL env var](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/13) — required for ticket assignment
- [Add sprint prefix, Slack webhook](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/14) — Slack notifications
- [Fix proxy label in kessel NetworkPolicy](https://github.com/project-kessel/kessel-ai-dev/pull/8) — real-world example of wrong label causing bot hang

---

## Step 2b: Scheduling (KEDA Cron Scaler)

Every instance **must** include a KEDA `ScaledObject` in its deploy template. This controls when the bot runs — without it, you'd need to manually scale replicas up and down.

Add the following to `deploy/template.yaml` after the NetworkPolicy:

```yaml
# --- Cron Scaler ---
- apiVersion: keda.sh/v1alpha1
  kind: ScaledObject
  metadata:
    name: ${BOT_NAME}-cron-scaler
    labels:
      app.kubernetes.io/name: ${BOT_NAME}
      app.kubernetes.io/part-of: devbot
  spec:
    scaleTargetRef:
      apiVersion: apps/v1
      kind: Deployment
      name: ${BOT_NAME}
    minReplicaCount: 0
    maxReplicaCount: 1
    triggers:
    - type: cron
      metadata:
        timezone: "Europe/Prague"
        start: "0 9 * * 1-5"
        end: "0 23 * * 1-5"
        desiredReplicas: "1"
```

Adjust `timezone`, `start`, and `end` to match your team's working hours. The example above runs weekdays 9:00–23:00 Prague time.

For more schedule examples (US hours, weekends, split windows, etc.) and details on how multiple triggers combine, see the full [Scheduling guide](scheduling.md).

**App-interface**: Your SaaS file's `managedResourceTypes` must include `ScaledObject.keda.sh` — see [Step 4](#step-4-app-interface-configuration).

---

## Step 3: Konflux CI/CD

**This step must be completed before Step 4 (app-interface).** App-interface references the Quay image built by Konflux — if the image doesn't exist or isn't public, the deployment will fail.

Follow the Konflux onboarding rules to register your repo. The key requirements:

1. **Onboard your repo to Konflux** — follow the standard Konflux onboarding process for your tenant namespace
2. **Configure a ReleasePlan** — your component needs a ReleasePlan and corresponding ReleasePlanAdmission so that push builds produce a release to your Quay prod repo
3. **Make the image public** — configure the ReleasePlanAdmission to set the image repository as public. This is handled within the release config, not manually in Quay

Pipeline config:

```yaml
# .tekton/my-bot-push.yaml (and pull-request.yaml)
dockerfile: dev-bot/Dockerfile.runner
path-context: .
```

Konflux auto-generates the `.tekton/` pipeline files when you onboard. The important bits:
- Dockerfile path points to `dev-bot/Dockerfile.runner` (the submodule)
- Build context is `.` (the runner repo root)
- Push builds go to your Quay prod repo (via the ReleasePlan)
- PR builds go to `quay.io/redhat-user-workloads/...` with 5-day expiry

### Reference PRs

- [Konflux auto-registration](https://github.com/RedHatInsights/hcc-ui-agent-dev/pull/2) — auto-generated pipeline files

---

## Step 4: App-Interface Configuration

The namespace, app, and shared infrastructure (proxy, memory server, secrets) are already deployed by the primary instance. You do **not** need to do the full app-interface onboarding — just add your instance as a new deployment to the existing namespace.

### Add to `deploy.yml`

Add your instance as a new `resourceTemplate` in the existing SaaS file:

```yaml
resourceTemplates:
# ... existing primary instance ...

- name: my-bot-instance
  path: /deploy/template.yaml
  url: https://github.com/YourOrg/my-bot-instance
  targets:
  - namespace:
      $ref: /services/insights/platform-frontend-ai-dev/namespaces/stage.hcmais01ue1.yml
    ref: <git-commit-sha>
    parameters:
      BOT_IMAGE_TAG: <git-commit-sha>
      BOT_IMAGE: quay.io/your-org/my-bot-instance
      BOT_NAME: devbot-myteam
      BOT_LABEL: hcc-ai-myteam
      BOT_REPLICAS: '0'                    # start disabled, enable after verification
      BOT_BOARD_NAME: 'Your Board Name'    # only used by claim-ticket for sprint assignment
      BOT_SPRINT_PREFIX: 'Your Sprint'     # only used by claim-ticket for sprint assignment
      BOT_INCLUDE_BACKLOG: 'true'
      BOT_INSTANCE_ID: 'Your Bot Name'     # human-readable, used in memory server
      GCP_PROJECT_ID: your-gcp-project
      GCP_REGION: global
      VERTEX_ALLOWED_MODELS: claude-sonnet-4-6,claude-opus-4-6,claude-haiku-4-5
      BOT_CONFIG_REPO: https://github.com/YourOrg/my-bot-instance.git
      BOT_CONFIG_PATH: instance/my-config
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/...'
      # --- Per-instance proxy (optional — only if custom Jira, and other creds needed) ---
      # PROXY_IMAGE: quay.io/redhat-services-prod/hcc-platex-services/platform-frontend-ai-dev-proxy
      # PROXY_IMAGE_TAG: <proxy-image-sha>
      # PROXY_REPLICAS: '1'
      # PROXY_NAME: devbot-myteam-proxy
      # JIRA_SECRET_NAME: myteam-jira-secrets
```

### Add managed resource types

Your SaaS file needs `managedResourceTypes` to include all resource kinds your template creates:

```yaml
managedResourceTypes:
- Deployment
- NetworkPolicy
- ScaledObject.keda.sh
```

Without `ScaledObject.keda.sh`, app-interface will prune the KEDA cron scaler on every sync.

### Add image pattern

Add your Quay image to the `imagePatterns` list in `deploy.yml`:

```yaml
imagePatterns:
- quay.io/your-org/my-bot-instance
```

### Add to `app.yml`

Register your repo as a code component:

```yaml
codeComponents:
- name: my-bot-instance
  url: https://github.com/YourOrg/my-bot-instance
  resource: upstream
```

### Namespace

Your instance deploys to the **same namespace** as the primary instance — that's how it accesses the shared proxy, memory server, and secrets. No new namespace needed.

### Vault Secrets

Every instance needs its own Vault secret with Jira credentials — a custom Jira identity means a custom proxy container. The memory server can still be shared.

Add a Vault secret to the namespace YAML:

```yaml
# In namespaces/stage.hcmais01ue1.yml
openshiftResources:
- provider: vault-secret
  path: your/vault/path/jira-credentials
  name: myteam-jira-secrets
  version: 1
  annotations:
    qontract.recycle: "true"
```

The secret needs two keys: `jira-email` and `jira-token`. Then set `JIRA_SECRET_NAME=myteam-jira-secrets` and `PROXY_REPLICAS=1` in your deploy.yml parameters so the instance gets its own proxy pod with these credentials.

The shared `devbot-secrets` secret (GitHub/GitLab/GPG/GCP credentials) is still used by all instances — only the Jira identity is per-instance.

### Reference: Existing app-interface config

Use the framework instance ([`hcc-ui-agent-dev`](https://github.com/RedHatInsights/hcc-ui-agent-dev)) as your reference — it always has the latest configuration. Its app-interface directory (`data/services/insights/platform-frontend-ai-dev/`) contains:

| File | Purpose |
|------|---------|
| `app.yml` | App metadata, code components, service owners |
| `deploy.yml` | SaaS file — image patterns, resource templates, parameters |
| `namespaces/stage.hcmais01ue1.yml` | Namespace config, Vault secret ref, RDS definition |
| `pipelines/tekton-*.yml` | Tekton pipeline provider |
| `roles/` | RBAC roles for namespace access |

---

## Step 5: Jira Setup

1. **Create your label** (e.g. `hcc-ai-myteam`) in the Jira project
2. **Label tickets** the bot should pick up with your label + `repo:<name>` labels
3. **Board name** (optional) — only used by `claim-ticket` to add tickets to the active sprint. The ticket query itself is label-only.

`repo:` labels support both bare names (`repo:my-frontend`) and org-prefixed (`repo:YourOrg/my-frontend`). Both resolve against `project-repos.json`.

---

## Step 6: Bot Fork Repos

For each repo in `project-repos.json`, the bot needs a fork to push branches to:

**GitHub repos:**
- Create forks under a bot GitHub user/org
- The bot pushes to the fork and opens PRs against the upstream

**GitLab repos:**
- Create forks under a bot GitLab user/group
- The bot pushes to the fork and opens MRs against the upstream

The shared `devbot-secrets` Vault secret provides GitHub (`gh-bot-cli-token`) and GitLab (`gl-bot-cli-token`) PATs. These tokens must have push access to your fork repos.

---

## Verification

After deploying, verify in order:

1. **Pod starts**: `oc get pods -l app.kubernetes.io/name=devbot-myteam`
2. **DNS works**: `oc exec <pod> -- nslookup devbot-proxy` — should resolve
3. **Memory server reachable**: `oc exec <pod> -- curl -s http://devbot-memory-server:8080/health`
4. **Executor reachable**: check logs for "Connected to executor at devbot-proxy:9090"
5. **Config loaded**: check logs for remote config sync from `BOT_CONFIG_REPO`
6. **Enable via schedule**: configure the KEDA cron scaler (see [Step 2b](#step-2b-scheduling-keda-cron-scaler)) to run during your team's working hours. Don't set `BOT_REPLICAS: '1'` permanently — use the schedule to avoid unnecessary token consumption on weekends and off-hours

---

## Parameter Reference

| Parameter | Required | Description |
|-----------|----------|-------------|
| `BOT_IMAGE` | yes | Quay image path |
| `BOT_IMAGE_TAG` | yes | Git SHA for image tag |
| `BOT_NAME` | yes | Deployment name (e.g. `devbot-myteam`) |
| `BOT_LABEL` | yes | Jira label to filter tickets |
| `BOT_REPLICAS` | yes | Number of replicas (`'0'` to disable) |
| `BOT_INSTANCE_ID` | yes | Human-readable name for memory server |
| `BOT_CONFIG_REPO` | yes | Git URL for remote config repo |
| `BOT_CONFIG_PATH` | yes | Path within config repo to `agent/` dir |
| `GCP_PROJECT_ID` | yes | GCP project for Vertex AI |
| `GCP_REGION` | yes | GCP region (usually `global`) |
| `VERTEX_ALLOWED_MODELS` | yes | Comma-separated model allowlist |
| `BOT_BOARD_NAME` | no | Jira board name (for sprint assignment only) |
| `BOT_SPRINT_PREFIX` | no | Sprint name prefix filter (for sprint assignment only) |
| `BOT_INCLUDE_BACKLOG` | no | `'true'` to include backlog tickets |
| `SLACK_WEBHOOK_URL` | no | Slack webhook for notifications |
| `PROXY_IMAGE` | no | Proxy container image (only needed if `PROXY_REPLICAS=1`) |
| `PROXY_IMAGE_TAG` | no | Proxy image tag (default: `latest`) |
| `PROXY_REPLICAS` | no | `'0'` = use shared proxy (default), `'1'` = deploy own proxy |
| `PROXY_NAME` | no | Proxy service name (default: `devbot-proxy`). Set to a unique name when deploying own proxy. |
| `JIRA_SECRET_NAME` | no | Vault secret with `jira-email` + `jira-token` keys (default: `devbot-secrets`) |

---

## Gotchas

### NetworkPolicy proxy label must be `devbot-proxy`
The proxy pod's label is `app.kubernetes.io/name: devbot-proxy` — **not** `proxy`. Using the wrong label in your NetworkPolicy silently blocks all bot egress. The bot will start but hang forever waiting for the executor connection. This has caused real outages — see [kessel-ai-dev#8](https://github.com/project-kessel/kessel-ai-dev/pull/8).

### DNS port is 5353, not 53
OpenShift uses a custom DNS server in the `openshift-dns` namespace on port 5353. Standard port 53 or `kube-dns` selectors won't work. Symptom: pods hang forever waiting for network connections.

### GPG signing doesn't work for GitLab
Commits pushed to GitLab via the proxy are unsigned. GitHub commits are signed. This is a known limitation — GitLab requires a different GPG verification flow. A fix is in progress.

### Submodule updates
When dev-bot merges new features, Konflux opens automated PRs to update the submodule in your runner repo. You can also update manually if you don't want to wait for the automation:
```bash
cd dev-bot && git pull origin master && cd ..
git add dev-bot && git commit -m "chore: update dev-bot submodule"
```
Then bump the ref in app-interface after the image builds.

### Merge order matters
When changes span multiple repos, merge in this order:
1. **app-interface** (config/params) — first, so the cluster config is ready
2. **dev-bot** (core changes) — second
3. **runner instance** (submodule bump) — last, after dev-bot merges

### Shared identities
All bot instances share credentials from `devbot-secrets` — Jira, GitHub, GitLab, GPG, and GCP. This means all instances push code, open PRs, and comment on Jira as the same user. The bot identifies its own Jira comments by content patterns (structured reports, PR links, tables), not by username.

A different identity (Jira, GitHub, or GitLab) requires a separate proxy instance — credentials are baked into the proxy container, not the bot pod. See **Shared vs Per-Instance Proxy** in Step 2 and **Vault Secrets** in Step 4.

### `BOT_BOARD_NAME` is fragile
If someone renames the Jira board, `claim-ticket` breaks. Consider using `BOT_BOARD_ID` (stable numeric ID) instead. The ticket query (`new-work`) doesn't use the board at all — it's label-only with `sprint in openSprints()`.

### Memory server is shared
All bot instances share one memory server. Task isolation is via `instance_id` — always pass it in task tool calls. Memories (learnings) are shared across instances, which is intentional.

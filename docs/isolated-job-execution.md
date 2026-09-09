# Isolated Job Execution

Kubernetes Job pattern for bot tasks that require direct credential access — cases where the auth proxy can't mediate (e.g., browser-based SSO login, OC CLI commands).

**Ticket**: [REHOR-124](https://redhat.atlassian.net/browse/REHOR-124)

---

## Problem

The bot currently routes all authenticated requests through the proxy (Squid, Vertex AI, Jira MCP, Git auth), keeping secrets out of the bot's environment. Claude never sees API tokens or PATs.

However, some tasks require direct credential access that the proxy can't mediate:

- **Playwright E2E tests** — browser-based SSO login requires a username/password typed into a form. There's no HTTP request to intercept and inject credentials into.
- **OC CLI commands** — verifying or deploying PRs to an ephemeral environment requires an authenticated `oc` session.
- **CLI tools with native auth** — any tool that manages its own auth flow rather than making proxiable HTTP requests.

Exporting credentials into the bot's shell session (e.g., `E2E_USER`/`E2E_PASSWORD` as env vars) exposes them to Claude. Even file-based approaches (dotenv, `.credentials`) are readable by any process in the container.

### Why not just let the bot create Jobs directly?

If the bot SA can create Jobs, it can specify any Secret in the Job's `volumes` section. There's nothing in Kubernetes RBAC that says "you can create Jobs but only with these specific Secret mounts." The bot could craft a Job that mounts `devbot-secrets` — which holds the proxy's high-value credentials (GitHub PAT, GitLab PAT, GPG private key, GCP service account key, Jira API token) — write them to stdout, and read the logs. This would bypass the entire proxy security model that keeps those credentials out of the bot's environment.

This rules out giving the bot direct Job-create permissions.

## Proposed Solution

A **job-launcher service** acts as the trust boundary between the bot and Kubernetes Jobs. The bot requests a job run via a REST API. The service fills in a fixed template with controlled secret mounts and creates the Job. The bot never constructs a Job spec.

```
bot pod                              job-launcher (proxy pod)         k8s API         job pod
─────────                            ────────────────────────         ────────         ────────
POST /jobs/run
  { preset: "playwright",     ──►   validates preset exists
    repo: "insights-chrome",        fills hardcoded template
    ref: "fix/login-redirect" }
                                    (secret mounts are fixed,
                                     image from allowlist)
                                       ──►  creates Job  ──►  job pod starts
                                                               ├── reads /secret/creds
                                                               ├── runs playwright test
                                                               ├── writes results to logs
                                                               └── exits
GET /jobs/{id}/status          ──►   reads Job status + logs
                                       ◄──  returns results
```

The bot SA has **zero** Job or Secret permissions. The job-launcher service has its own SA with Job-create permissions and a fixed, non-configurable set of allowed secret mounts.

### Why the proxy pod?

The proxy already serves as the trust boundary between the bot and external services (Vertex AI, Jira, Git auth, screenshot upload). Adding a job-launcher endpoint follows the same pattern — one more listener on a new port. Each existing proxy service runs on its own port with its own `http.Server` and purpose-built handler; the job-launcher follows the same convention.

| Proxy endpoint | Port | Purpose |
|---|---|---|
| Squid | `:3128` | HTTP allowlist proxy |
| Executor (gRPC) | `:9090` | CLI tool execution |
| Vertex AI | `:8443` | LLM auth injection |
| Jira MCP | `:8444` | Jira API auth |
| Screenshot upload | `:8446` | GitHub Release upload |
| GlitchTip | `:8447` | Error tracking auth |
| **Job launcher (new)** | **`:8448`** | **Isolated Job execution** |

Adding the port requires updating the proxy ingress NetworkPolicy and each bot instance's egress NetworkPolicy to allow `:8448`. The onboarding scaffold template picks this up automatically for new instances.

## Architecture

### Security Model

The security boundary is: **teams control what runs, the service controls what gets mounted**.

- **Job templates** define the shape: image, commands, arguments, which symbolic secret names are needed
- **The job-launcher** maps symbolic secret names to actual Kubernetes Secrets from an allowlist it controls
- **Image allowlist** restricts Job images to `quay.io/redhat-services-prod/` — the same registry used for bot images, gated by Konflux builds
- A team cannot write `secrets: [devbot-secrets]` in their template and exfiltrate PATs — the launcher only maps symbolic names from its allowlist

Onboarding a new secret type requires a change to the allowlist in the proxy/service config. New credential access requires review, not self-service.

Example allowlist mapping:

| Symbolic name | K8s Secret | Key(s) | Used by |
|---|---|---|---|
| `e2e-creds` | `devbot-e2e-secrets` | `username`, `password` | Playwright jobs |
| `oc-token` | `devbot-oc-token` | `token`, `api-url` | OC CLI jobs |

The bot and instance templates only ever reference symbolic names. The mapping to real Secrets is hardcoded in the launcher — not configurable at runtime.

### Template Sources

The bot references jobs by name only — `{ preset: "playwright" }` or `{ job: "e2e" }` — and the launcher resolves the template internally. The bot never sends template YAML, which prevents it from crafting inline specs with unauthorized secret mounts. This matches the existing pattern: workflows, envs, and skills are all referenced by name and resolved by the runner.

**Phase 1 — Pre-built presets (main repo).** Templates ship in the proxy image, baked in from `presets/jobs/`. The launcher has a fixed set of known job names and accepts no external template registration. New job types require a PR to the main repo. This eliminates any API surface for template injection.

```
presets/jobs/
├── playwright/
│   ├── manifest.yaml          # name, description, required symbolic secrets
│   ├── template.yaml          # job template
│   └── Containerfile          # base image with playwright + chromium
├── oc-deploy/
│   ├── manifest.yaml
│   ├── template.yaml
│   └── Containerfile          # base image with oc CLI
└── README.md
```

**Phase 2 — Instance-defined templates (instance config repos).** Teams need custom jobs (especially OC CLI commands specific to their deployment workflows) that we don't want to own as presets. Teams define job templates in their instance config repo (the same `BOT_CONFIG_REPO` each bot already uses):

```
instance/my-config/agent/
├── instance.yaml
├── CLAUDE.md
└── jobs/
    ├── e2e.yaml
    └── deploy-ephemeral.yaml
```

An instance template can reference a preset or define a fully custom job:

```yaml
# Reference a preset — uses pre-built template + image
preset: playwright
command: ["npx", "playwright", "test"]
repo: https://github.com/RedHatInsights/insights-chrome

# Or extend with a custom image built from the instance repo
image: quay.io/redhat-services-prod/my-tenant/my-bot-jobs:latest
```

The launcher independently clones the instance config repo (it has git credentials in the proxy pod) and reads templates directly from the committed source. The bot's `run.py` tells the launcher which `BOT_CONFIG_REPO` and `BOT_CONFIG_PATH` to use, but never sends template content. Templates go through normal PR review in the config repo before the launcher will pick them up.

This is critical: unlike instance skills (which are instructions/scripts running inside the bot's existing sandbox), job templates control secret mounts and image selection. A bug in an API that accepts template content would let Claude craft a Job that exfiltrates proxy credentials. The launcher cloning directly from the reviewed, committed config repo eliminates that attack surface.

### Custom Job Images

Teams already build their own bot images via Konflux (each instance repo has its own Containerfile and `.tekton` pipeline). The same pattern works for job runner images.

For presets, teams can extend the base image:

```dockerfile
FROM quay.io/redhat-services-prod/hcc-platex-services/rehor-job-playwright:latest
RUN npm install -g @redhat-cloud-services/playwright-test-auth
```

For fully custom jobs, teams build their own image in their instance repo. Konflux handles the build and push. The job-launcher validates the image is from `quay.io/redhat-services-prod/` before accepting it.

### Deployment via App-Interface

All bots share one namespace (`platform-frontend-ai-dev-stage`). The job-launcher runs in the proxy pod (same namespace), so no new namespace is needed.

Required changes to app-interface:

**1. `managedResourceTypes`** — add SA and RBAC types (follows the same pattern as `frontend-operator`, `ephemeral`, `frontend-base`, and 9+ other services under `/insights`):

```yaml
managedResourceTypes:
- Deployment
- Service
- Route
- NetworkPolicy
- ScaledObject.keda.sh
- ServiceAccount                      # new
- Role.rbac.authorization.k8s.io      # new
- RoleBinding.rbac.authorization.k8s.io  # new
```

**2. Shared infra template** (`platform-frontend-ai-dev/deploy/template.yaml`) — add the job-launcher SA and RBAC alongside proxy and memory-server. This is shared infrastructure, not per-instance:

```yaml
# --- Job Launcher ServiceAccount ---
- apiVersion: v1
  kind: ServiceAccount
  metadata:
    name: devbot-job-launcher
    labels:
      app.kubernetes.io/part-of: devbot

# --- Job Launcher Role (Jobs + pod logs only, no Secrets) ---
- apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: devbot-job-launcher
  rules:
    - apiGroups: ["batch"]
      resources: ["jobs"]
      verbs: ["create", "get", "list", "watch", "delete"]
    - apiGroups: [""]
      resources: ["pods", "pods/log"]
      verbs: ["get", "list", "watch"]

# --- Bind Role to SA ---
- apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: devbot-job-launcher
  subjects:
    - kind: ServiceAccount
      name: devbot-job-launcher
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: devbot-job-launcher
```

The proxy Deployment would add `serviceAccountName: devbot-job-launcher` to its pod spec. Bot Deployments remain unchanged — they still use the `default` SA with no Job permissions.

**3. Separate Secrets for job credentials** — Today `devbot-secrets` is a single Secret containing both proxy credentials (PATs, GPG keys, GCP SA key) and bot identity fields. Job-specific credentials (E2E SSO creds, OC tokens) must live in separate Secrets so the job-launcher's symbolic allowlist can grant access to them without exposing the proxy-side keys. A Job that needs E2E credentials gets `devbot-e2e-secrets` mounted — never `devbot-secrets`.

### Concurrency Control

ResourceQuotas give natural concurrency control at the namespace level. For per-bot concurrency, the job-launcher labels each Job with the requesting bot's instance name and checks for an existing active run before creating another:

```go
// launcher checks before creating a new Job
jobs, _ := clientset.BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{
    LabelSelector: "bot-instance=my-bot",
    FieldSelector: "status.active=1",
})
if len(jobs.Items) > 0 {
    return ErrJobAlreadyRunning
}
```

This lets multiple bots each run one job concurrently while preventing any single bot from stacking up multiple runs.

### Collecting Results

| Method | Tradeoffs |
|--------|-----------|
| **Pod logs** (`kubectl logs`) | Simplest. Works for pass/fail + stdout. No binary artifacts. |
| **Shared PVC** | Job writes artifacts to a volume the bot can read. Requires PVC provisioning. |
| **S3 / object store** | Job uploads artifacts. No shared volumes needed. Requires S3 access from the Job pod. |

For a first iteration, pod logs are sufficient for pass/fail status and test summaries. Playwright trace files and HTML reports would need PVC or S3.

### Debugging

No debugging capability is lost with the Job approach. The bot runs headless either way — interactive debugging (breakpoints, `page.pause()`, Playwright Inspector) requires a headed browser with a UI, which doesn't apply regardless of Job vs in-process.

What the bot uses to debug test failures:

- **Logs** — available via `kubectl logs`
- **Trace files** — Playwright's `trace: 'retain-on-failure'` produces a zip
- **Screenshots/videos** — written on failure
- **HTML report** — full test results with embedded traces

The one tradeoff: if a test fails and the bot wants to re-run with tweaked code, it creates a new Job instead of re-running in the same shell. This adds 10–30s of pod spin-up per iteration — negligible for E2E tests that already take minutes.

### Job Pod Networking

Job pods route all external traffic through the proxy, same as bot pods. The job-launcher sets `HTTP_PROXY`/`HTTPS_PROXY` to `http://devbot-proxy:3128` in the Job spec and labels pods with `app.kubernetes.io/part-of: devbot`. This means:

- **No new NetworkPolicy** — job pods use the same egress rules as bot pods (proxy + DNS only), and the proxy ingress NetworkPolicy already accepts traffic from any pod with the `devbot` part-of label
- **Same security model** — all external access goes through Squid's domain allowlist
- **Playwright** — job templates pass `--proxy-server=http://devbot-proxy:3128` to Chromium, same pattern as the bot's browser preset

The only configuration needed is ensuring the Squid allowlist includes domains each job type needs (e.g., `stage.foo.redhat.com`, SSO endpoints, OCP API).

## Use Cases

### E2E Testing (Playwright)

The immediate use case. The bot sends `POST /jobs/run { preset: "playwright", repo: "insights-chrome", ref: "fix/login-redirect" }`. The job-launcher creates a Job pod that:

1. Mounts SSO credentials from a Kubernetes Secret (mapped from symbolic name `e2e-creds`)
2. Runs `align-playwright-browsers` to match the repo's pinned Playwright version
3. Exports `E2E_USER`/`E2E_PASSWORD` from the mounted secret
4. Runs `npx playwright test`
5. Writes results to logs

### OC CLI Operations

Deploying or verifying PRs in ephemeral environments. The job-launcher creates a Job pod that:

1. Mounts an OpenShift token from a Kubernetes Secret (mapped from symbolic name `oc-token`)
2. Runs `oc login` with the mounted token
3. Executes deployment or verification commands
4. Reports results via logs

### General Pattern

Any task where the bot needs to trigger work requiring credentials or access the proxy can't mediate — CLI tools that need native auth, scripts that interact with systems without API token support, etc. Teams define a job template in their instance config repo, the job-launcher handles the rest.

## Open Questions

- **Timeout handling**: What's the right `activeDeadlineSeconds` for different job types? How does the job-launcher surface a timed-out Job to the bot?
- **Cleanup policy**: `ttlSecondsAfterFinished` to auto-delete completed Jobs, or explicit cleanup by the job-launcher?
- **Retry semantics**: Should the Job spec use `backoffLimit` for retries, or should the bot request retries through the job-launcher API?
- **Instance template validation (Phase 2)**: How strictly should the job-launcher validate instance-defined templates when it clones config repos? Schema validation? Dry-run against the k8s API?
- **Launcher config repo sync frequency (Phase 2)**: How often does the launcher re-clone instance config repos to pick up new/changed templates? On every job request? On a timer? On bot startup signal?

## References

- [Accessing the Kubernetes API from a Pod](https://kubernetes.io/docs/tasks/run-application/access-api-from-pod/)
- [OpenShift Operator SDK — Building Operators](https://docs.openshift.com/container-platform/latest/operators/operator_sdk/osdk-about.html)
- [Kubernetes Jobs documentation](https://kubernetes.io/docs/concepts/workloads/controllers/job/)

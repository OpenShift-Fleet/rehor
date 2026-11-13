# Agent Dispatcher Deployment (REHOR-246)

The agent dispatcher ([`packages/agent-dispatcher`](../packages/agent-dispatcher/README.md)) is deployed as an app-interface-owned, GitOps-managed OpenShift `Deployment` in the stage namespace (`platform-frontend-ai-dev-stage`), running the Konflux-built dispatcher image. This replaces the ad-hoc OpenShift Jobs and manually pushed Quay test tags used during REHOR-233 E2E validation.

## Deployed objects

Defined in [`deploy/agent-dispatcher-template.yaml`](../deploy/agent-dispatcher-template.yaml), consumed by the `platform-frontend-ai-dev-agent-dispatcher` resourceTemplate in the app-interface SaaS file:

| Object | Name | Purpose |
|--------|------|---------|
| ServiceAccount | `rehor-agent-dispatcher` | Runtime identity; subject of the existing `rehor-agent-dispatcher-token-request` Role/RoleBinding in app-interface |
| Deployment | `rehor-agent-dispatcher` | Long-running dispatcher process (non-HTTP) |

There is deliberately no Service, Route, or HTTP listener, and no liveness/readiness probes.

## Configuration surface

| Template parameter | Stage value | Notes |
|--------------------|-------------|-------|
| `AGENT_DISPATCHER_IMAGE` / `IMAGE_TAG` | `quay.io/redhat-services-prod/hcc-platex-services/rehor-agent-dispatcher` + promoted tag | Konflux component `platform-frontend-ai-dev-agent-dispatcher`; verify the released repository name (sibling components are renamed, e.g. `platform-frontend-ai-dev-memory-server` → `rehor-memory-server`) and adjust the app-interface `imagePatterns`/`images` entries if it differs |
| `AGENT_DISPATCHER_REPLICAS` | `0` initially | Scale to `1` after the rollout checklist is complete |
| `AGENT_DISPATCHER_CONFIG_REPOS` | `["https://github.com/OpenShift-Fleet/rehor-onboarding-agent.git"]` | JSON array; non-empty and valid or startup fails (fail-closed) |
| `AGENT_DISPATCHER_RUNTIME_LAYOUT` | `legacy` | Switch to `private` only after runner images are rebuilt with the matching `Dockerfile.runner` (REHOR-233) — pilot scope (REHOR-245) |
| `AGENT_DISPATCHER_AUTH_*` | Vault-backed `devbot-secrets` keys with matching env names | Memory TokenRequest namespace, target service account, and exact HTTPS `/health` Route URL |
| `JIRA_MCP_URL` | `http://devbot-proxy:8444/mcp` | In-cluster endpoint serves dispatcher-side preflights; sandbox-visible authenticated Route is REHOR-237 phase 2 / REHOR-241 |
| `EXECUTOR_ADDR` | `devbot-proxy:9090` | gh/glab shim endpoint for preflights |
| `OPENSHELL_*` | Vault-backed `devbot-secrets` keys with matching env names | Gateway/OIDC configuration, including optional `OPENSHELL_SERVICE_ACCOUNT_SUBJECT` |

Secrets come only from the Vault-synced `devbot-secrets` Secret:

| Key | Used for |
|-----|----------|
| `OPENSHELL_GATEWAY_ENDPOINT`, `OPENSHELL_GATEWAY_NAME`, `OPENSHELL_OIDC_ISSUER`, `OPENSHELL_CLIENT_ID`, `OPENSHELL_OIDC_AUDIENCE`, `OPENSHELL_OIDC_CLIENT_SECRET` | Gateway/OIDC settings and secret; sourced directly from `devbot-secrets` using matching key names |
| `OPENSHELL_SERVICE_ACCOUNT_SUBJECT` | Optional Gateway subject override; sourced from `devbot-secrets` using matching key name |
| `AGENT_DISPATCHER_AUTH_NAMESPACE`, `AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT`, `AGENT_DISPATCHER_AUTH_MEMORY_URL` | Memory TokenRequest settings; sourced from `devbot-secrets` using matching key names |
| `jira-email` | `BOT_JIRA_EMAIL` dispatcher-wide default (shared Jira identity) |

Stage Vault-synced `devbot-secrets` version 35 contains these dispatcher keys. `AGENT_DISPATCHER_CONFIG_REPOS` and the non-secret model-gateway Route URL `AGENT_DISPATCHER_MODEL_PROXY_URL` (REHOR-237; exact HTTPS `/v1` path, validated fail-closed at startup) are supplied as regular app-interface parameters; probes remain removed. No credentials or auth configuration are baked into the image, committed to Git, or exposed as template parameters. Cleanup budgets and sandbox policy remain owned by agent instance profiles and tracked by REHOR-241; the dispatcher forwards only non-secret `BOT_*` variables and the service coordinates above.

`AGENT_DISPATCHER_SESSION_LOCK_TTL_MS` (REHOR-218) controls the cluster-wide per-agent session mutex: whole milliseconds, validated fail-closed at startup, defaulting to `1800000` (30 minutes) when unset; `0` disables the mutex entirely and preserves single-replica behavior. Before creating a sandbox session the dispatcher acquires a lock from the memory server (`POST /api/locks/acquire` on the configured `AGENT_DISPATCHER_AUTH_MEMORY_URL` origin) keyed by the agent's opaque ID, renews it at one third of the TTL while the session runs, and releases it once the session settles. Contention means another replica already runs the agent and is logged as a `sandbox.lock` success, not a failure. The TTL bounds how long a hard-killed replica (no drain, no release) can block an agent: the lease simply expires and another replica takes over. SIGTERM drain waits for running sessions and each session releases its lock in the same `finally` block as its completion, so rolling updates do not leave zombie locks.

### Durable session registry and startup reconciliation (REHOR-218 phase 2)

The lock covers graceful shutdown; the session registry covers hard kills. It is enabled exactly when the mutex is (`AGENT_DISPATCHER_SESSION_LOCK_TTL_MS > 0`) and lives in the memory server (`/api/session-registry` on the same origin), which acts as dumb storage — the dispatcher owns every lifecycle transition:

- **Record per session**: before a session starts, the launch path registers an open record with the run ID, agent ID, pod hostname (holder), and the session lock's token. Once the sandbox is created and verified, the record is updated with the generated workspace/sandbox/provider/profile names. When the session settles — including failures — the record is updated to `completed` with the session's outcome, cleanup, and completion. All of this is **best effort**: the registry is durability bookkeeping, not admission control. A registry outage is logged as a `sandbox.registry` failure and dispatch continues, unlike the lock, which stays fail-closed.
- **Startup reconciliation**: after gateway connect and before the dispatch loop starts, a replacement pod lists all open records and reconciles each one (bounded by a five-minute startup guard; a hung reconciliation is logged as `sandbox.reconcile` failure with reason `startup-timeout` and the loop proceeds — the mutex prevents duplicate sessions either way). Records owned by the current pod are skipped (its own in-flight sessions). For every other record the gateway state decides:
  - **No provisioned names** (the pod died before sandbox provisioning): marked `abandoned` (`never-provisioned`), lock released. At most a transient workspace leaked; that window is seconds and accepted.
  - **Workspace gone**: nothing to clean up; marked `abandoned` (`workspace-gone`), lock released.
  - **Sandbox gone, workspace remains**: leftover provider/profile/workspace are deleted best effort (each deletion tolerates an already-missing resource); marked `abandoned` (`sandbox-gone`), lock released.
  - **Sandbox terminal** (not running): sandbox plus dependencies deleted; marked `completed` (`reconciled-terminal`), lock released.
  - **Sandbox still running**: **adopted** — polled every 30 seconds for up to one hour. When it terminates, resources are cleaned up, the record is marked `completed` (`adopted`), and the lock is released. On timeout the record is marked `abandoned` (`adopt-timeout`), resources are left untouched (never delete a possibly-still-running sandbox), and the lock is deliberately left to TTL expiry so a second concurrent session for the agent cannot start.
  - Deletions are guarded by the session's run-ID labels, mirroring the session cleanup path: a resource whose `rehor-run-id` label does not match the record is never deleted.
- **Failure semantics**: each record is reconciled in isolation. A registry, lock, or gateway failure during one record is logged as a `sandbox.reconcile` failure and the record stays open, so the next restart retries it. Locks are released with the token stored in the record; if the lease already expired and another replica holds it, the release simply fails and is logged.

## Deployment semantics

- **Fail-closed startup**: partial, empty, or malformed auth/Gateway/config-repo configuration exits the process at startup. The Deployment restart policy (`Always`) surfaces misconfiguration as CrashLoopBackOff.
- **No probes**: the dispatcher has no HTTP listener. Fatal errors exit non-zero and restart the pod; a hung-but-running process is not auto-detected (see [Observability](#observability)).
- **Shutdown**: on SIGTERM the process drains in-flight sandbox sessions within an internal 22-minute deadline; `terminationGracePeriodSeconds` is 1500s and must stay above it.
- **Session registry is durable (REHOR-218)**: every session is tracked in the memory-server registry before it starts and reconciled by the replacement pod on startup (adopt or clean up abandoned sessions, release their locks). A registry outage degrades to phase-1 behavior (best-effort bookkeeping, fail-closed lock) and is visible as `sandbox.registry` failures; interrupted reconciliations leave their records open and are retried on the next restart.
- **Per-agent session mutex (REHOR-218)**: with multiple replicas, only one active sandbox session per agent exists cluster-wide. Admission acquires a memory-server lock before the session is created (a contended or failed acquisition creates nothing and reports `not-created`); crashed replicas are covered by TTL expiry of their lease, not by release. Disable with `AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: '0'`.
- **Egress**: the namespace has no egress NetworkPolicy; the dispatcher reaches the Kubernetes API (TokenRequest), the memory Route, the Gateway, and config repositories (HTTPS Git) directly. Authenticated Squid mediation for config-repo fetches is a REHOR-237/REHOR-241 follow-up, not required for this deployment.

## Rollout plan

Order matters; each step is GitOps-owned (no manual cluster mutation):

1. **Merge the rehor PR** adding `deploy/agent-dispatcher-template.yaml`. Konflux builds and releases the `platform-frontend-ai-dev-agent-dispatcher` component (pipelines land with the same PR set); confirm the released image repository name and promoted tag.
2. **Verify secrets**: stage `devbot-secrets` version 35 includes the `OPENSHELL_*` and `AGENT_DISPATCHER_AUTH_*` keys shown above, plus the existing `jira-email` key.
3. **Merge the app-interface MR** (deploy.yml resourceTemplate, imagePattern, monitoring, SOP). It ships with `AGENT_DISPATCHER_REPLICAS: '0'` — objects exist, nothing runs, existing agents and the legacy onboarding deployment are untouched.
4. **Scale to `1`** via the app-interface parameter and verify startup: `oc logs deployment/rehor-agent-dispatcher` must show `startup` and `ready` lifecycle events — memory credential preflight, Gateway authentication, and config-repo synchronization all pass before the loop starts.
5. **Enable preflights** by keeping `AGENT_DISPATCHER_CONFIG_REPOS` pointed at the onboarding agent repository; preflight cycles run at most once per agent every five minutes. No sandbox session is created until a preflight returns an actionable `start`.
6. **Pilot (REHOR-245)**: rebuild the onboarding runner image with the private-layout `Dockerfile.runner`, switch `AGENT_DISPATCHER_RUNTIME_LAYOUT` to `private`, and validate end-to-end sandbox sessions with confirmed cleanup. Legacy onboarding stays paused/untouched until the pilot is approved.

Existing bot instances (framework, UI, integrations, console-next, orchestrator) share only the memory-server and proxy; the dispatcher is additive and cannot affect them.

## Rollback

- **Disable dispatching**: set `AGENT_DISPATCHER_REPLICAS: '0'` in the app-interface target (GitOps change). Pod terminates with the 22-minute drain.
- **Full removal**: revert the app-interface MR; the Deployment and ServiceAccount are garbage-collected by the reconciler.
- **After any dispatcher removal/restart with in-flight sessions**: the replacement pod's startup reconciliation adopts or cleans up abandoned sessions and releases their locks automatically (REHOR-218). Verify no orphaned Gateway resources remain for records marked `abandoned` with reason `adopt-timeout` (resources intentionally left in place) or after interrupted reconciliations (logged as `sandbox.reconcile` failures; they retry on the next restart). Ambiguous or interrupted cleanups still require manual reconciliation through the Gateway before the agent's in-flight reservation is considered released.
- **Image regression**: pin `IMAGE_TAG` back to the previous promoted tag in the app-interface target.

Ad-hoc test Jobs remain available for experiments but are no longer required for routine dispatcher operation.

## Observability

- **Lifecycle logs**: the dispatcher emits structured JSON lifecycle events (`startup`, `configuration`, `shutdown`, `sandbox.session`, `sandbox.cleanup`, `sandbox.lock`, `sandbox.registry`, `sandbox.reconcile`, preflight aggregation) to stdout. Inspect with `oc logs deployment/rehor-agent-dispatcher`.
- **Alerting**: `PlatformFrontendAiDevDispatcherDown` (app-interface PrometheusRule) fires when available replicas fall below the desired spec for 15 minutes (crash-loop, eviction, or scheduling failure). The scale-to-zero rollout and rollback states do not alert; a missing Deployment object is not alerted on.
- **Runbook**: `DispatcherDown` SOP in the app-interface `app-sops/platform-frontend-ai-dev/` directory.
- **Limitations**: no metrics port and no in-process hang detection. Preflight cycles and cleanup failures are visible in logs and (for completed work) in the memory-server dashboard; GlitchTip/metrics integration is a follow-up if operational need arises.

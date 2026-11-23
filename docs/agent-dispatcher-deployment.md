# Agent Dispatcher Deployment

The [agent dispatcher](https://github.com/OpenShift-Fleet/rehor/blob/master/packages/agent-dispatcher/README.md) runs as a long-lived OpenShift `Deployment`. This guide describes its runtime contract independently of the system used to build images or deliver deployment changes.

## Preflight execution engine

The dispatcher runs registered TypeScript preflights from `@rehor/preflights`. Agent repositories supply configuration only. [Contribute new checks to this repository](presets/custom-preflight.md); the dispatcher does not discover or run instance-provided scripts.

Per-instance declaration:

- Each agent's `instance.yaml` declares its preflights in the `preflights:` field: shorthand entries (`- jira-triage`) or parameterized entries (`- id: jira-sprint` with a `with:` map of plain literal values). Entries are parsed strictly at profile discovery — a malformed entry fails the whole repository's discovery with a message naming the instance, entry, parameter, and reason (`fleetshift-config: preflights[1].with.label: Invalid input: expected string, received number (got 5)`), never a silent drop.
- An omitted `preflights:` field inherits the central default set registered for the workflow (`workflowDefaults` in the package, e.g. `jira-sprint` → `gh-pr-status`, `gl-mr-status`). A custom workflow has no central default.
- A profile with neither a declaration nor a registered workflow default returns an error. An explicit `preflights: []` returns `no-scripts` when required wiring is present.
- Before execution, every entry is validated against the registry. Any `start` among non-errored entries dispatches; the agent prompt contains only `start` results.

### Services-gateway wiring

The engine's Jira, GitHub, and GitLab traffic always uses the `/jira`, `/github`, and `/gitlab` routes on `AGENT_DISPATCHER_SERVICE_GATEWAY_URL`; the dispatcher never contacts those vendors directly. Preflights needing these services fail if the gateway is not configured. The dispatcher authenticates the dispatcher-to-proxy hop with a per-cycle short-lived minted bearer; the proxy alone injects vendor credentials on the upstream leg. Task fetches use the same minted memory credential; `BOT_INSTANCE_ID` is the instance filter. Each profile requires a nonblank ID, and its `preflight.env` takes precedence over the deployment value. The deployment must provide `BOT_MEMORY_URL` as the exact HTTPS `/mcp` route on the authenticated `/health` origin. Missing or invalid deployment routes fail startup when repositories are configured. Missing or blank IDs or minted credentials fail the affected profile before preflight or sandbox execution, including for an empty `preflights: []` declaration. Each entry's execution is bounded at 120 seconds, and the transport honors dispatcher abort during active requests.

### Error reporting and instance identity

Each failed profile emits a `preflight.error` lifecycle event with `agentId`, `reason` (`configuration` or `execution`), `profile`, and `repository`; individual failed entries are logged even when the aggregate decision is still `start` or `skip`. Profile names support Unicode; nonprinting characters are escaped and SSH userinfo is removed. Invalid or oversized identity fields are omitted while `agentId` remains. Configuration-validation failures expose safe structured diagnostics naming the instance identity and every invalid entry's issue path, issue code, message, and received value. Required-wiring failures also identify `configurationField`; credential values, raw transcripts, prompts, upstream response bodies, and exception text are not logged. Engine error transcripts identify the profile and repository; transcripts and prompts do not enter logs or cycle results. Any actionable `start` among non-errored entries wins the aggregate decision, and the agent prompt contains `start` content only.

## Deployed objects

The repository's [deployment template](https://github.com/OpenShift-Fleet/rehor/blob/master/deploy/agent-dispatcher-template.yaml) defines these runtime objects:

| Object | Name | Purpose |
|--------|------|---------|
| ServiceAccount | `rehor-agent-dispatcher` | Runtime identity with the narrowly scoped permission to request memory-service credentials |
| Deployment | `rehor-agent-dispatcher` | Long-running dispatcher process (non-HTTP) |

There is deliberately no Service, Route, or HTTP listener, and no liveness/readiness probes.

## Configuration surface

| Setting | Requirement |
|---|---|
| Dispatcher image | Immutable image reference containing the dispatcher and its declared runtime dependencies. |
| Replica count | One or more for active dispatch; zero disables dispatch. Per-agent locking coordinates replicas. |
| `AGENT_DISPATCHER_CONFIG_REPOS` | Non-empty JSON array of configuration repositories. Invalid values fail startup. |
| `AGENT_DISPATCHER_RUNTIME_LAYOUT` | `legacy` or `private`; runner image and sandbox policy must agree on layout. |
| Platform memory authentication | Protected platform-owned configuration for short-lived credential minting and memory endpoint validation. Never configure in an instance repository. |
| Platform Gateway authentication | Protected platform-owned configuration for dispatcher-to-Gateway authentication. Never configure in an instance repository. |
| `AGENT_DISPATCHER_SERVICE_GATEWAY_URL` | Optional authenticated HTTPS origin for services used by preflights and the sandbox. Required when configured checks or runtime services need it. |
| `AGENT_DISPATCHER_MODEL_PROXY_URL` | Optional exact HTTPS `/v1` model-gateway endpoint. Required for model providers routed through that gateway. |
| `AGENT_DISPATCHER_SESSION_LOCK_TTL_MS` | Positive lease duration in milliseconds; defaults to `1800000`. `0` disables the per-agent mutex. |
| `AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED` | Exact `true` or `false`; defaults to `false`. Enables only centrally reviewed public egress. |

The deployment supplies protected credentials and service coordinates; an instance profile cannot override those platform-owned values. Profiles may supply only permitted non-secret runtime settings. See [credentials and secrets](dispatcher-secrets.md) for disclosure-impact tiers. The dispatcher owns sandbox policy and cleanup.

`AGENT_DISPATCHER_SESSION_LOCK_TTL_MS` controls the cluster-wide per-agent session mutex: whole milliseconds, validated fail-closed at startup, defaulting to `1800000` (30 minutes) when unset; `0` disables the mutex entirely and preserves single-replica behavior. Before creating a sandbox session the dispatcher acquires a lock from the memory server (`POST /api/locks/acquire` on the configured memory endpoint) keyed by the agent's opaque ID, renews it at one third of the TTL while the session runs, and releases it once the session settles. Contention means another replica already runs the agent and is logged as a `sandbox.lock` success, not a failure. The TTL bounds how long a hard-killed replica (no drain, no release) can block an agent: the lease simply expires and another replica takes over. SIGTERM drain waits for running sessions and each session releases its lock in the same `finally` block as its completion, so rolling updates do not leave zombie locks.

### Durable session registry and startup reconciliation

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
- **Session registry is durable**: every session is tracked in the memory-server registry before it starts and reconciled by the replacement pod on startup (adopt or clean up abandoned sessions, release their locks). A registry outage degrades to best-effort bookkeeping while admission remains fail-closed; interrupted reconciliations leave records open for retry after restart.
- **Per-agent session mutex**: with multiple replicas, only one active sandbox session per agent exists cluster-wide. Admission acquires a memory-server lock before the session is created (a contended or failed acquisition creates nothing and reports `not-created`); crashed replicas are covered by TTL expiry of their lease, not by release. Disable with `AGENT_DISPATCHER_SESSION_LOCK_TTL_MS: '0'`.
- **Egress**: the namespace has no egress NetworkPolicy; the dispatcher reaches the Kubernetes API, memory endpoint, Gateway, and config repositories (HTTPS Git) directly. Config-repository fetches are not mediated by Squid in this deployment.

## Rollout plan

Apply changes in order using the deployment mechanism for your cluster:

1. **Select a published dispatcher image.** Use an immutable image reference containing the intended dispatcher revision.
2. **Verify protected credentials** are provisioned for the dispatcher without inspecting values.
3. **Create the Deployment with replicas set to `0`** so prerequisites can be verified before dispatch is enabled.
4. **Scale to `1`** and verify startup: `oc logs deployment/rehor-agent-dispatcher` must show `startup` and `ready` lifecycle events — memory credential preflight, Gateway authentication, and config-repo synchronization all pass before the loop starts.
5. **Enable preflights** by keeping `AGENT_DISPATCHER_CONFIG_REPOS` pointed at the onboarding agent repository; preflight cycles run at most once per agent every five minutes. No sandbox session is created until a preflight returns an actionable `start`.
6. **Pilot**: rebuild the onboarding runner image with the private-layout `Dockerfile.runner`, switch `AGENT_DISPATCHER_RUNTIME_LAYOUT` to `private`, and validate end-to-end sandbox sessions with confirmed cleanup. Legacy onboarding stays paused/untouched until the pilot is approved.

Existing polling instances are not migrated by deploying the dispatcher. Avoid enrolling an instance in both paths at once.

## Rollback

- **Disable dispatching**: set `AGENT_DISPATCHER_REPLICAS: '0'` using the deployment system. The pod terminates with the 22-minute drain.
- **Full removal**: remove the Deployment and its ServiceAccount using the deployment system.
- **After any dispatcher removal/restart with in-flight sessions**: the replacement pod's startup reconciliation adopts or cleans up abandoned sessions and releases their locks automatically. Verify no orphaned Gateway resources remain for records marked `abandoned` with reason `adopt-timeout` (resources intentionally left in place) or after interrupted reconciliations (logged as `sandbox.reconcile` failures; they retry on the next restart). Ambiguous or interrupted cleanups still require manual reconciliation through the Gateway before the agent's in-flight reservation is considered released.
- **Image regression**: restore the previous known-good image reference.

Ad-hoc test Jobs remain available for experiments but are no longer required for routine dispatcher operation.

## Observability

- **Lifecycle logs**: the dispatcher emits structured JSON lifecycle events (`startup`, `configuration`, `shutdown`, `sandbox.session`, `sandbox.cleanup`, `sandbox.lock`, `sandbox.registry`, `sandbox.reconcile`, preflight aggregation) to stdout. Inspect with `oc logs deployment/rehor-agent-dispatcher`.
- **Alerting**: monitor available replicas against desired replicas and alert on sustained unavailability. Suppress alerts when dispatch is intentionally scaled to zero.
- **Limitations**: no metrics port and no in-process hang detection. Preflight cycles and cleanup failures are visible in logs and (for completed work) in the memory-server dashboard; GlitchTip/metrics integration is a follow-up if operational need arises.

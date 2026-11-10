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

## Deployment semantics

- **Fail-closed startup**: partial, empty, or malformed auth/Gateway/config-repo configuration exits the process at startup. The Deployment restart policy (`Always`) surfaces misconfiguration as CrashLoopBackOff.
- **No probes**: the dispatcher has no HTTP listener. Fatal errors exit non-zero and restart the pod; a hung-but-running process is not auto-detected (see [Observability](#observability)).
- **Shutdown**: on SIGTERM the process drains in-flight sandbox sessions within an internal 22-minute deadline; `terminationGracePeriodSeconds` is 1500s and must stay above it.
- **Session registry is process-local** (durable recovery is REHOR-218): a restart or eviction abandons in-flight sessions. The Gateway retains the abandoned sandbox/provider/workspace resources; they must be reconciled manually per the rollback procedure until REHOR-218 lands.
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
- **After any dispatcher removal/restart with in-flight sessions**: verify no orphaned Gateway resources remain (sandbox, provider, profile, workspace for each run). The dispatcher logs `sandbox.cleanup` results; ambiguous or interrupted cleanups require manual reconciliation through the Gateway before the agent's in-flight reservation is considered released.
- **Image regression**: pin `IMAGE_TAG` back to the previous promoted tag in the app-interface target.

Ad-hoc test Jobs remain available for experiments but are no longer required for routine dispatcher operation.

## Observability

- **Lifecycle logs**: the dispatcher emits structured JSON lifecycle events (`startup`, `configuration`, `shutdown`, `sandbox.session`, `sandbox.cleanup`, preflight aggregation) to stdout. Inspect with `oc logs deployment/rehor-agent-dispatcher`.
- **Alerting**: `PlatformFrontendAiDevDispatcherDown` (app-interface PrometheusRule) fires when available replicas fall below the desired spec for 15 minutes (crash-loop, eviction, or scheduling failure). The scale-to-zero rollout and rollback states do not alert; a missing Deployment object is not alerted on.
- **Runbook**: `DispatcherDown` SOP in the app-interface `app-sops/platform-frontend-ai-dev/` directory.
- **Limitations**: no metrics port and no in-process hang detection. Preflight cycles and cleanup failures are visible in logs and (for completed work) in the memory-server dashboard; GlitchTip/metrics integration is a follow-up if operational need arises.

# OpenShell Deployment

Production runner instances use OpenShell `SandboxTemplate` + `SandboxWarmPool` resources instead of bot `Deployment` replicas. KEDA scales `SandboxWarmPool` during work windows. Start from `deploy/sandbox-template.example.yaml`.

## Prerequisites

- Shared platform namespace: OpenShell gateway, agent-sandbox controller, CRDs, and KEDA are already installed.
- Standalone namespace: install OpenShell gateway, agent-sandbox controller, `extensions.agents.x-k8s.io/v1beta1` SandboxTemplate/SandboxWarmPool CRDs, and KEDA before applying the template.
- Shared `devbot-proxy`, `devbot-memory-server`, and `devbot-secrets` deployed first.
- Bot image available to cluster; use immutable `BOT_IMAGE_DIGEST`.
- App-interface `managedResourceTypes` includes `SandboxTemplate.agents.x-k8s.io`, `SandboxWarmPool.agents.x-k8s.io`, `ScaledObject.keda.sh`, and `NetworkPolicy`.

## Filesystem Contract

| Path | Access | Purpose |
|------|--------|---------|
| `/home/botuser/app` | read by agent; bootstrap runtime writes only | Runner code and config |
| `/home/botuser/repos` | read/write | Checked-out target repositories and implementation changes |
| `/home/botuser/data` | read/write | Caches, cycle state, merged config, and reports |
| `/tmp` | read/write | Temporary files |
| `/usr`, `/lib`, `/etc`, `/proc`, `/dev` | read-only | Runtime and system tooling |
| Credential paths | denied | SSH, GPG, cloud, and CLI credential stores |

Agent implementation changes belong under `/home/botuser/repos`. Never write runner source, instance config, system paths, or credential locations.

This table describes the intended deployment contract, not isolation supplied by OpenCode. The generic template mounts writable `emptyDir` volumes at `/home/botuser/repos`, `/home/botuser/data`, and `/tmp`; it does not by itself make every other path read-only or enforce credential-path denials. Verify effective OpenShell policy and OS permissions separately. The onboarding template currently relies on its writable image filesystem and `/tmp` rather than adding these mounts.

For OpenCode, supplemental access outside the cycle worktree comes from trusted deployment `additionalDirectories`. Onboarding approves only `/home/botuser/repos`, `/home/botuser/data`, and `/tmp/opencode`, using `root/*` rules. Native checks request `directory/*`, so these rules cover the root directory itself and descendants without separate exact-root entries. This does not grant all of `/tmp` or `/home/botuser`. Native agent JSON/Markdown cannot widen this external-directory boundary. Agent `allow`, `ask`, and `deny` rules retain native last-match ordering inside approved roots: later broad allows can override earlier narrow restrictions, and later asks or denies can restrict earlier grants. Outside requests remain denied. Other tool permissions remain unchanged. These are tool permission checks, not a filesystem or Bash sandbox. See [runtime budget and permission semantics](migrations/opencode-migration.md#runtime-specific-budgets-rehor-198).

## OpenCode Budget and Workspace Rollout (REHOR-198)

`deploy/sandbox-template.example.yaml` exposes optional `REHOR_OPENCODE_MAX_TOOL_CALLS` with an empty default. Empty preserves the image's `opencode.maxToolCalls` setting (default `200`). The onboarding repository's `deploy/template.yaml` instead requires this parameter without a default; its app-interface target must supply the string `"200"`. Claude's `claude.maxTurns` default remains `100`.

Apply changes in this order:

1. Merge the runner implementation first. The onboarding `dev-bot` submodule pin update is still pending; update it only to the merged runner commit, never an uncommitted implementation.
2. Merge the app-interface change supplying `REHOR_OPENCODE_MAX_TOOL_CALLS: "200"` only to the onboarding target before adopting its required-parameter template. The prior template tolerates the extra parameter because the reconciler uses `--ignore-unknown-parameters`.
3. Merge the onboarding template, trusted `opencode-deployment.json` roots, and merged runner pin. Build and publish the onboarding image, then reconcile its immutable image reference and template.
4. Obtain a fresh Sandbox from the updated template/image. Check the effective budget environment and deployment JSON in that pod before running a live smoke test; an existing Sandbox does not prove the new settings are active.

Local validation has covered configuration parsing and `oc process`: the generic template accepts an empty or explicit budget, while onboarding rejects a missing required budget. Native offline OpenCode `1.18.29` checks verified scoped path access and retained denials. These checks do not establish a live rollout or a controller upgrade requirement.

For the fresh Sandbox, verify:

- `REHOR_OPENCODE_MAX_TOOL_CALLS=200`, the selected deployment JSON, and its three approved roots are effective; inspect rendered OpenCode permissions as well as source settings.
- A cycle can create and read a new nested file under an approved root, run Bash at an exact approved root, and delegate scoped child work. Test permission denials using harmless synthetic sibling/home/credential-shaped paths, including an explicit per-agent denial.
- Budget telemetry counts successful unique tool calls across root and child sessions. Legacy displayed turns are not this counter. Exhaustion aborts at the next root turn and can overshoot during child work; 75%/90% telemetry does not inject an OpenCode warning or guarantee a checkpoint.
- Effective mounts, Unix permissions, OpenShell policy, and gateway connectivity meet the deployment contract independently of OpenCode grants.

Live paid smoke testing has not been completed. A pod Pending for CPU or memory must be scheduled before runtime validation; scheduling pressure is separate from budget or path-permission behavior.

## Network Contract

Sandbox egress allows only:

- `devbot-proxy` ports `3128`, `8443`, `8444`, `8446`, and `9090`.
- `devbot-memory-server` port `8080`.
- OpenShift DNS on TCP/UDP `53`.

This example blocks direct internet egress. HTTP/HTTPS traffic uses Squid through `HTTP_PROXY` and `HTTPS_PROXY`. Credentials remain in proxy services; Sandbox receives no service tokens.

## Verification

```bash
oc get sandboxtemplate,sandboxwarmpool,scaledobject -l app.kubernetes.io/name=<bot-name>
oc get pods -l app.kubernetes.io/name=<bot-name>
oc logs -l app.kubernetes.io/component=bot --tail=100
```

Verify KEDA scales `SandboxWarmPool` to one replica during work windows and back to zero afterward.

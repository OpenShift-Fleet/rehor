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

For OpenCode V2, supplemental access outside the cycle worktree comes from trusted deployment `additionalDirectories`. Onboarding approves only `/home/botuser/repos`, `/home/botuser/data`, and `/tmp/opencode`, not all of `/tmp` or `/home/botuser`. An explicit runner-owned **global native policy ceiling** prevents project policies and JSON/Markdown agents from widening this boundary. Agent `allow`, `ask`, and `deny` rules and read restrictions remain effective within approved roots. Verify exact-root, descendant, sibling, and credential-shaped paths through the pinned V2 native checks. These are tool permission checks, not a filesystem or Bash sandbox. See [runtime budget and permission semantics](migrations/opencode-migration.md#runtime-specific-budgets-rehor-198).

## OpenCode V2 Rollout (REHOR-200)

The only OpenCode runtime ID is `opencode`, backed by `@opencode/client@2.1.2` and `@opencode/cli@2.1.2`. Versioned IDs and legacy aliases are unsupported. V1 was an experimental onboarding-only stopgap; all other Claude SDK agents migrate directly to V2.

1. Merge the main runtime/docs PR, including native V2 rendering, global policy enforcement, and V2-compatible plugin support. Complete [local and image validation](migrations/opencode-migration.md#local-and-image-validation) on that revision.
2. Open a separate onboarding PR that pins its `dev-bot` gitlink to the merged main commit, selects `runtime: opencode`, converts deployment providers/models to native fields, and moves profile delegation depth under `experimental.subagent_depth`. Convert all six Markdown agent frontmatters too: their current `options` and singular permission/task maps are not the native contract. See the [verified consumer conversion inventory](migrations/opencode-migration.md#3-onboarding-only-experimental-v1-follow-up). Other Claude instances follow the same direct-to-V2 procedure separately.
3. Retain the previous known-good Claude image digest and matching configuration. Build/publish a fresh consumer image with the merged gitlink, coordinator, CLI, providers, and validated plugin closure. Reconcile the immutable image reference and template with `BOT_EXECUTION_ENGINE=coordinator`.
4. Obtain a fresh Sandbox. Verify instance `runtime`/provider/model, proxy endpoints, budget, approved roots, operational helper environment, and gateway egress. A profile sync or restart on the old image is insufficient.
5. Validate root/child helper inheritance, auth isolation, global policy/agent denies, selected wrapped/direct MCP exposure, strict agent/command YAML frontmatter, lifecycle cleanup, status/transcript/usage projections, and an actual staging work cycle. Successful nested Code Mode operations count separately while the wrapper consumes no budget unit; pending/interrupted steps retain incomplete usage with known subtotals. Offline native checks do not prove a live rollout.

Deployment providers use `package`/`settings`, with native `@opencode/ai/providers/openai/responses` or `@opencode/ai/providers/openai-compatible` for OpenAI. These require no external `packages` declarations or separate `@ai-sdk` metadata. Model declarations expose only `name`, `modelID`, `limit`, `settings`, and `capabilities`. Utility selection is rendered as `agents.title.model`; MCP uses `mcp.servers` and structured timeouts; ordered permission rules use `shell`, `subagent`, and `edit`. Profiles accept only canonical plural resource directories. Legacy fields, aliases, and automatic frontmatter conversion are unsupported; use the [exact renderer/profile contract](migrations/opencode-migration.md#profile-configuration-reference).

Native Code Mode is supported. Central `mcpServers.<server>` and native `mcp.servers.<server>` accept optional boolean `codemode`; omission preserves native default `true`, while `false` keeps direct tools. Allowed active generated wrapped MCP grants automatically enable `execute`. Native agent permissions can deny the wrapper and its wrapped tools or enable `execute` when general permissions deny it; they cannot change a direct server into a wrapped server. Agent/command YAML frontmatter strictly rejects legacy or mixed fields. The six onboarding role frontmatters still require explicit native conversion in the separate consumer PR.

The runner's native Effect `ctx.tool` bridge preserves unfiltered nested inputs/results through progress and persisted `metadata.rehorCodeMode`. Invocation correlation uses native fiber IDs, not input identity, including repeated scalar/null inputs and asynchronous validation. Normalization keeps `execute` visible as a non-counting `budgetUnit: "container"`, counts each successful nested operation once (including native fetch metadata), and excludes errors. Work context sees nested results despite filtered script output. Budgets abort at the next root model boundary, not atomically between nested operations; one script batch may exceed the configured budget. Code Mode fetch is raw HTTP, independent of `webfetch` permission: network sandbox/egress and `execute` availability control its authority. No `fetch: false` restriction is assumed. Scoped management plugins remain disabled.

Native Code Mode bridge/configuration tests, including root and child execution, have passed. The full rebuild succeeded after the earlier external DNS failure. A fresh unmounted Linux ARM64 production image containing the final native Effect/fiber-identity fix passed the required-plugin gate, Responses/Chat/Vertex read-tool and exact usage checks, and Code Mode accounting/work-context checks through the built runtime. Two nested successes count separately, denied MCP calls never reach the server, filtered task results are captured, and the wrapper consumes no budget unit; budgets 3 and 2 respectively complete and stop at the next root model boundary. This offline image evidence does not establish a deployed Sandbox rollout.

Each cycle owns an authenticated loopback `opencode serve --stdio` child, private config/data homes and database, and isolated instruction discovery. Private data home prevents ambient saved-auth import. A runner-owned native V2 Effect plugin restores original shell `XDG_CONFIG_HOME` and `XDG_DATA_HOME` for root and child tools through an Effect-returning shell hook; server credentials must not reach those tools. External V2 plugins may use native Effect or supported Promise APIs. Core/shared/workflow native `AGENTS.md` instruction layers remain intact.

The pricing fallback still records frozen catalog provenance **1.18.35** independently of CLI **2.1.2**. Do not replace pricing metadata as a side effect of deployment version changes. Positive V2 native costs are catalog estimates, not billed provider amounts; compare usage and incomplete subtotals accordingly.

Rollback restores the **previous Claude image and matching config/template/engine**, then creates a fresh Sandbox and verifies Claude cycles and projections. Switching OpenCode's provider to Vertex alone is not runtime rollback. Follow the [rollback procedure](migrations/opencode-migration.md#rollback-to-the-previous-claude-imageconfig).

## OpenCode Budget and Workspace Rollout (REHOR-198)

`deploy/sandbox-template.example.yaml` exposes optional `REHOR_OPENCODE_MAX_TOOL_CALLS` with an empty default. Empty preserves the image's `opencode.maxToolCalls` setting (default `200`). The onboarding repository's `deploy/template.yaml` instead requires this parameter without a default; its app-interface target must supply the string `"200"`. Claude's `claude.maxTurns` default remains `100`.

Apply changes in this order:

1. Merge the runner implementation first. Update the onboarding `dev-bot` submodule only to the merged runner commit, in its separate consumer PR.
2. Merge the app-interface change supplying `REHOR_OPENCODE_MAX_TOOL_CALLS: "200"` only to the onboarding target before adopting its required-parameter template. The prior template tolerates the extra parameter because the reconciler uses `--ignore-unknown-parameters`.
3. Merge the onboarding template, trusted `opencode-deployment.json` roots, and merged runner pin. Build and publish the onboarding image, then reconcile its immutable image reference and template.
4. Obtain a fresh Sandbox from the updated template/image. Check the effective budget environment and deployment JSON in that pod before running a live smoke test; an existing Sandbox does not prove the new settings are active.

Earlier budget rollout validation covered configuration parsing and `oc process`: the generic template accepts an empty or explicit budget, while onboarding rejects a missing required budget. Historical V1 native checks are not V2 acceptance evidence. Revalidate scoped path access and retained denials against CLI `2.1.2`; neither those checks nor the grants establish a live rollout or controller upgrade requirement.

For the fresh Sandbox, verify:

- `REHOR_OPENCODE_MAX_TOOL_CALLS=200`, the selected deployment JSON, and its three approved roots are effective; inspect rendered OpenCode permissions as well as source settings.
- A cycle can create and read a new nested file under an approved root, run Bash at an exact approved root, and delegate scoped child work. Test permission denials using harmless synthetic sibling/home/credential-shaped paths, including an explicit per-agent denial.
- Budget telemetry counts successful unique direct/nested operations across root and child sessions, including native Code Mode fetch metadata; visible wrapper containers and failed operations are excluded. Legacy displayed turns are not this counter. Exhaustion aborts at the next root model turn and can overshoot within a Code Mode batch or during child work; 75%/90% telemetry does not inject an OpenCode warning or guarantee a checkpoint.
- Effective mounts, Unix permissions, OpenShell policy, and gateway connectivity meet the deployment contract independently of OpenCode grants.

Live paid smoke testing has not been completed. A pod Pending for CPU or memory must be scheduled before runtime validation; scheduling pressure is separate from budget or path-permission behavior.

## OpenCode Operational Environment Rollout (REHOR-199)

The runner sanitizer now preserves 12 reviewed operational variables for OpenCode and native child tools: `EXECUTOR_ADDR`, `BOT_JIRA_EMAIL`, `BOT_INSTANCE_ID`, `BOT_MEMORY_URL`, `GH_USER_NAME`, `GL_USER_NAME`, `BOT_CONFIG_PATH`, `SLACK_NOTIFY_MODE`, `GH_RELEASE_UPLOAD_URL`, `BOT_BOARD_ID`, `BOT_BOARD_NAME`, and `SLACK_WEBHOOK_URL`. The configured webhook is an intentional credential exception; the other values are non-secret coordinates, identities, or settings. See the source-backed [operational environment contract](migrations/opencode-migration.md#operational-child-environment-rehor-199). This requires runner code adoption, not a provider passthrough or native agent permission change.

1. Merge the runner fix, then update the consuming onboarding repository's `dev-bot` submodule pin to that merged commit.
2. Build and publish a fresh onboarding image containing that pin and the rebuilt coordinator. Reconcile its immutable image reference in the deployment configuration.
3. Obtain a fresh Sandbox using that image. A profile sync, cycle restart, or replacement using the old image cannot update the baked sanitizer.
4. Check the 12-name contract against the deployment's enabled helpers and supply required operational values to the runner. Board helpers accept board ID or board name; GitLab identity is needed for GitLab forks. The `SLACK_WEBHOOK_URL` deployment parameter already exists: configure it if Slack notifications are wanted and it is unset. Existing configured values need no YAML or application-interface change; the sanitizer does not supply defaults.
5. In an approved smoke workspace, confirm root and native child Bash/Python helpers receive the intended non-secret identity and service coordinates. Use harmless executor requests to verify the configured address is used rather than the Unix-socket fallback. Do not dump full environments or credentials.

Configured `SLACK_WEBHOOK_URL` is inherited unchanged, preserving agent → helper → MCP `slack_notify` webhook payload and `SLACK_NOTIFY_MODE`. The existing memory-server tool performs the POST; no server-side per-instance configuration or new notification mechanism is needed. Absent/empty values retain optional helper no-ops. Other credentials and unknown ambient variables remain excluded; this exception grants no broad `SLACK_*` access or strict provider/plugin reference approval.

V2 native environment checks use localhost model/gRPC mocks and the real Go executor client to exercise all 12 values through root and child helpers. Each role runs the canonical Slack helper with an in-process MCP argument capture for the synthetic webhook and mode. This capture is not transport validation. Passing these checks does not establish live gateway, executor, Jira, memory-service connectivity, webhook delivery, helper-side mutations, or deployment completion. Run them on the completed revision using the [pinned native test commands](migrations/opencode-migration.md#local-and-image-validation).

## Network Contract

Sandbox egress allows only:

- `devbot-proxy` ports `3128`, `8443`, `8444`, `8446`, `8447`, `8448`, `8450`, and `9090` (including TCP/8450 for the OpenAI gateway).
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

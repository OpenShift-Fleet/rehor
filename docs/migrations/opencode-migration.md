# OpenCode V2 Migration

Operational guide and architecture for moving Rehor bot instances directly from Claude Code plus `claude-agent-sdk` to OpenCode V2. The sole OpenCode runtime ID is `opencode`, with `@opencode/client@2.1.2` and `@opencode/cli@2.1.2`. Versioned runtime IDs and legacy aliases are unsupported. Provider choice remains independent: retain Vertex or select an existing OpenAI gateway route.

Status: REHOR-200 migration contract; final image and deployment acceptance remain rollout gates.

V1 history: OpenCode V1 was an experimental stopgap used only by onboarding for provider/runtime validation. It is not an intermediate stage for other agents. Migrate all remaining Claude SDK agents directly to V2. Merge the main runtime/docs PR first; only then create a separate onboarding PR updating its `dev-bot` gitlink to the merged commit and its instance/profile configuration. Consumer edits are outside the main PR.

Related Jira: `REHOR-35`, `REHOR-60`, `REHOR-68`, `REHOR-91`, `REHOR-92`,
`REHOR-125`, `REHOR-126`, `REHOR-127`, `REHOR-128`, `REHOR-198`, `REHOR-199`, `REHOR-200`

## Decision Summary

- Start one runner-owned OpenCode server per cycle and close it when the cycle ends.
- Create one workspace-scoped client and session per cycle.
- Never share OpenCode servers across bot instances or cycles.
- Keep model credentials in the proxy deployment, not bot pods or OpenCode auth files.
- Add an OpenAI-compatible proxy endpoint backed by direct OpenAI API keys.
- Keep existing Jira, Git, memory, and browser MCP services separate.
- Keep deterministic Python preflights outside OpenCode; port only appropriate lifecycle hooks to V2 plugins.
- Deliberately migrate OpenCode profiles to native `AGENTS.md` and `.opencode` resources; retain Claude instruction assembly only for runtime `claude`.
- Render native V2 configuration and enforce deployment directory boundaries through explicit global native policies, above project and agent grants.
- Isolate each child server's authentication, config/data homes, database, and instruction discovery; restore original shell XDG homes through a runner-owned V2 plugin.

## Claude SDK Baseline

```text
bot pod
  Python run.py
    claude-agent-sdk query()
      Claude Code subprocess
        CLAUDE.md + personas + .claude/skills
        MCP: memory, Jira, browser
        HTTP: Vertex proxy, Git proxy, Squid

central proxy pod
  Vertex auth proxy → Vertex AI / Claude models
  Jira MCP proxy
  Git auth proxy
  Executor server
  Squid
```

Current agent entry point is `bot/agent.py`. Preflight scripts are discovered
and executed by `bot/preflight.py`. Deployment and proxy credentials are
defined in `deploy/template.yaml`.

## Target Architecture

```text
bot pod
  TypeScript runner
    AgentRuntime
      OpenCodeRuntime
         @opencode/client 2.1.2
           runner-owned child `opencode serve --stdio` (@opencode/cli 2.1.2)
          loopback-bound server
          one workspace-scoped client and session per cycle
          SSE events: lifecycle, tool, usage, error
    core/shared/workflow AGENTS.md via native instructions
    profile AGENTS.md + native project instruction discovery
    .opencode/agents, plugins, skills
    MCP: memory, Jira, browser
    HTTP: Rehor model gateway, Git proxy, Squid

central proxy pod
  Rehor model gateway
    Vertex route
    OpenAI Responses and Chat Completions routes
    provider/model allowlist and policy
  Jira MCP proxy
  Git auth proxy
  Executor server
  Squid
```

OpenCode is an agent runtime, not replacement for every existing proxy. The
proxy remains credential and egress boundary. OpenCode remains execution
boundary inside each bot pod.

## Coordinator Boundary

The TypeScript code in `coordinator/` is Rehor's provider-neutral control
plane. It does not replace the Python runner by default, but it now contains
the OpenCode adapter and an opt-in production runner. `BOT_EXECUTION_ENGINE=coordinator`
selects that path; Python remains the rollback/default engine. Both runtimes
implement the same stable boundary.

The coordinator owns run identity, assembled prompt, workspace and provider
attribution, limits, cancellation, normalized event ordering, terminal state,
and usage data. Runtime adapters own SDK-specific server/session lifecycle and
translate SDK messages into Rehor events. SDK objects never cross the
`AgentRuntime` port.

The provider-neutral Rehor contract preserves current Python behavior; its schema version is separate from the OpenCode runtime version:

- a run carries the label, workflow, fully assembled prompt, provider/model,
  maximum turns, and cycle timeout;
- `task` is nullable because triage starts before a task is selected;
- terminal payloads preserve result text, no-work classification, duration,
  turns, and `CycleContext` fields;
- usage payloads preserve input, output, reasoning, cache-read, and cache-write
  tokens plus cost, including partial usage on interruption;
- preflight `skip` and `error` remain coordinator-owned paths that do not start
  an agent runtime.

See the [coordinator runtime contract](https://github.com/OpenShift-Fleet/rehor/blob/master/coordinator/README.md)
for invariants, compatibility mapping, and development commands.

### Cycle cost budget (REHOR-211)

The turn-based budget is replaced by a per-cycle-run USD cost budget, shared by both runtimes. Configure it in the runner's `config.json`:

```json
{
  "claude": { "budgetUsd": 5 }
}
```

This fragment shows the budget field only; retain the other runner settings. `claude.budgetUsd` defaults to `5` when absent and is sent to the coordinator as `limits.budgetUsd` for every runtime.

The coordinator observes usage events and emits cost-budget policy notices at 50% (`info`), 75% (`warning`), 90% (`critical`), and 100% (`exhausted`) of the budget, each once. The exhausted notice opens a grace window so the agent can save state via `task_update`; at 115% of the budget the run hard-aborts with terminal `failed` and reason `budget_exceeded`, which is treated as an expected outcome. When usage reports affirmatively unknown pricing (`cost.source === "unknown"`) and no known cost has been recorded, the budget fails open with a one-time warning policy event and the cycle timeout remains the only backstop. The legacy `opencode.maxToolCalls` / `REHOR_OPENCODE_MAX_TOOL_CALLS` settings and `claude.maxTurns` are no longer used by the coordinator; `claude.maxTurns` is still read by the legacy Python direct-agent path (`bot/agent.py`), whose turn hook remains until that path is retired.

| Runtime | Budget enforcement |
|---------|-----------------------------|
| Claude Agent SDK | Coordinator cost budget; notices are flushed to the agent as `PostToolUse` hook system messages |
| OpenCode | Coordinator cost budget; notices are delivered by prompting the root session (the OpenCode server queues prompts sent while the session is busy) |

The cost budget is not an atomic per-operation ceiling: a single Code Mode batch or an in-flight model step can push spend past a threshold before the next usage snapshot arrives, and the hard abort lands on the usage event that crosses 115%. Legacy displayed `turns` counts completed root assistant messages, not budget consumption. Threshold events emit policy telemetry (`devbot_cost_budget_event_total`); both runtimes now receive injected warning notices. Neither a warning nor budget exhaustion guarantees a saved checkpoint.

## OpenCode Server Lifecycle

The production supervisor and adapter live in `coordinator/src/runtimes/opencode/`. `OpenCodeRuntime` uses the V2 `OpenCode` client from `@opencode/client`, while `OpenCodeServerSupervisor` owns process startup and cleanup. `RenderedOpenCodeConfig` is the validated per-cycle configuration snapshot. No V1 SDK client or compatibility adapter is part of the target contract.

The runner starts one `opencode serve --stdio` child per cycle, bound to loopback with a fresh private password. It verifies version/readiness, uses the approved canonical worktree for client operations, streams V2 events, reconciles root/child usage within bounded deadlines, and closes session/process resources on completion, failure, timeout, or shutdown. A central or persistent shared server is out of scope. OpenCode server authentication is separate from Rehor task authorization.

The child gets private XDG config/data directories and a private database. Isolating data home is required because V2 can import a saved `auth.json` when initializing a database. Runner-generated credentials and configuration must not be inherited from ambient OpenCode state or exposed to tools. A runner-owned native V2 Effect plugin restores original `XDG_CONFIG_HOME` and `XDG_DATA_HOME` through an Effect-returning shell hook, preserving absent and empty values. Native root and child helpers must therefore see the original shell homes while the server keeps its private state.

## Native TypeScript Runtime Option

[scriptc](https://scriptc.dev/) can compile TypeScript to native executables
that do not require Node, V8, or a JavaScript engine. This is a possible
follow-up optimization for the Rehor runner and standalone preflight tools.

It does not mean the complete OpenCode stack can be compiled immediately:

- The scriptc compiler itself requires Node 24 or newer during image build.
- npm dependencies normally run in scriptc's embedded QuickJS dynamic tier.
- `@opencode/client` must pass `scriptc coverage`; static compilation is not assumed.
- V2 plugins execute in OpenCode's supported runtime using native Effect or supported Promise APIs; verify runtime-specific APIs before considering compilation. The generated runner plugin uses native Effect.
- Compiling a plugin as a separate binary does not make it an OpenCode plugin.
- `--dynamic` removes the Node runtime dependency but embeds a JavaScript engine.
- Native networking and HTTP are supported, but SDK behavior, streaming, TLS,
  subprocesses, signals, and filesystem semantics need integration tests.

### Viable Shape

```text
build image
  Node 24 + scriptc → rehor-runner native binary

runtime image
  rehor-runner native binary
  OpenCode official native binary or supported OpenCode runtime
  no Node installation
```

The safest target is a native Rehor runner that connects to an already-running
OpenCode server through HTTP. This avoids compiling OpenCode internals and
keeps plugin loading under its supported runtime. An alternative is compiling
small standalone TypeScript preflight utilities, provided they remain free of
unsupported npm/runtime APIs.

### Acceptance Test Before Adoption

- `scriptc coverage` reports acceptable static coverage for runner entry point.
- `scriptc build` succeeds for target Linux architecture.
- Binary runs without Node or `node_modules`.
- SDK client connects to OpenCode server and completes a session.
- SSE event stream handles long responses and disconnects.
- MCP configuration and tool calls remain functional.
- Signals, timeouts, child processes, Git, and filesystem behavior match current runner.
- Native and normal-runtime runs produce equivalent cycle results and cost data.

Until this test passes, use a supported OpenCode distribution and treat scriptc
as an optimization experiment. Do not make native compilation a dependency of
initial OpenCode migration.

## Direct OpenAI Authentication

OpenAI API requests use HTTP Bearer authentication:

```http
Authorization: Bearer OPENAI_API_KEY
```

OpenAI recommends loading keys from environment variables or a secret manager,
never client-side code. Rehor should keep keys in Vault and inject them only
into the proxy deployment.

### Preferred Flow

```text
OpenCode in bot pod
  → http://devbot-proxy:8450/v1/chat/completions
     or http://devbot-proxy:8450/v1/responses
  → NetworkPolicy restricts which bot pods can reach the gateway
  → proxy replaces the bot-side Authorization value and validates provider/model
  → proxy adds Authorization: Bearer <OpenAI key>
  → https://api.openai.com (same path, unchanged)
  → streaming response back to OpenCode
```

The bot must not receive `OPENAI_API_KEY`. `REHOR_MODEL_PROXY_TOKEN` is the
placeholder API-key value required by the OpenCode provider client; the current
proxy overwrites inbound `Authorization` and does not authenticate this value.
NetworkPolicy controls gateway reachability. Any request-level client
authentication would require a separate proxy implementation and must not use
the OpenAI key.

### Implementation Shape

This can reuse the existing Vertex proxy pattern almost directly:

```go
func NewOpenAIProxy(apiKey string, policy *OpenAIPolicy) http.Handler {
    upstream, _ := url.Parse("https://api.openai.com")
    proxy := &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(upstream)
            // Client sends /v1/chat/completions; do not prepend /v1 twice.
            r.Out.URL.Path = r.In.URL.Path
            r.Out.URL.RawQuery = r.In.URL.RawQuery
            r.Out.Host = upstream.Host
            r.Out.Header.Set("Authorization", "Bearer "+apiKey)
        },
        FlushInterval:  -1,
        ModifyResponse: stripSensitiveResponseHeaders,
    }
    return policy.Wrap(proxy)
}
```

Required differences from `NewVertexProxy`:

- Read `OPENAI_API_KEY` from proxy environment or secret-backed key provider.
- Ignore and overwrite any incoming `Authorization` header.
- Optionally set configured `OpenAI-Organization` and `OpenAI-Project` headers.
- Validate model from JSON body for `/v1/chat/completions`; URL-only model extraction is insufficient.
- Allow `GET /v1/models` only if proxy returns an allowlisted model catalog.
- Preserve SSE streaming and final usage chunks.
- Add provider-neutral metrics instead of reusing `vertex_model_requests_total`.

Incoming bot authentication remains separate. `Authorization` from OpenCode
must authenticate the bot to Rehor, if used; it must never be forwarded to
OpenAI. Proxy then replaces it with the OpenAI key. NetworkPolicy alone can be
used for a first internal canary, but an authenticated bot-to-proxy request is
preferable before exposing the endpoint beyond the namespace.

This is header injection, not full protocol translation. It works when
OpenCode emits an OpenAI-compatible request. If a future provider requires a
different request or response schema, add an explicit adapter rather than
silently rewriting arbitrary JSON.

### Proxy Endpoint Contract

The OpenAI gateway serves Chat Completions through native
`@opencode/ai/providers/openai-compatible` and Responses through
`@opencode/ai/providers/openai/responses`:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- streaming responses using SSE
- tool calls and tool results
- system/developer/user/assistant/tool messages
- `stream_options.include_usage`
- response usage accounting
- upstream `x-request-id` capture

Proxy requirements:

- Allow only configured model IDs.
- Reject unknown paths, hosts, and models.
- Never log `Authorization`, request contents, prompts, or API keys.
- Strip `Authorization`, `Set-Cookie`, `WWW-Authenticate`, and token-like response headers.
- Preserve streaming; do not buffer full model responses.
- Forward or generate correlation ID using `X-Client-Request-Id`.
- Record provider, model, HTTP status, latency, input tokens, output tokens, and errors.
- Return upstream error class without leaking credentials or secret config.
- Support key rotation without rebuilding bot images.

### OpenCode Provider Configuration

Deployment input fragment for the Responses route (merge with the deployment's other providers):

```json
{
  "providers": [
    {
      "id": "rehor-openai",
      "package": "@opencode/ai/providers/openai/responses",
      "name": "Rehor OpenAI Responses",
      "settings": {
        "baseURL": "{env:REHOR_MODEL_PROXY_URL}",
        "apiKey": "{env:REHOR_MODEL_PROXY_TOKEN}"
      },
      "models": {
        "gpt-6-luna": {
          "name": "GPT-6 Luna",
          "capabilities": { "reasoning": { "supported": true } }
        }
      }
    }
  ],
  "packages": []
}
```

GPT-6 Luna uses the native Responses route. OpenCode's `rehor-openai-chat`
route retains Chat Completions for compatible models. GPT-4o's explicit output
limit prevents OpenCode from requesting more than its 16384-token maximum.
Runtime-generated config uses native `@opencode/ai/providers/openai/responses`
and `@opencode/ai/providers/openai-compatible` packages. They ship with CLI 2.1.2
and need no `packages` declarations or separate `@ai-sdk` metadata. Both packaged
deployment files use `packages: []`. External providers use exact-pinned
`aisdk:<package>@<version>` references; external plugins also require exact pins.
The Vertex adapter is coordinator-managed as `aisdk:file://.../vertex-provider.js`,
backed by the exact `@ai-sdk/google-vertex` dependency in the runner image. The
deployment cannot override Vertex's package.

Deployment providers accept only `id`, `package`, `name`, `settings`, and `models`.
Models accept only `name`, `modelID`, `limit`, `settings`, and `capabilities`.
For example, reasoning support is `capabilities.reasoning.supported`, and request
settings belong under `settings`. Model variants, cost overlays, and arbitrary
native-schema fields outside this exposed surface are unsupported. Singular
deployment `provider`, deployment `packageLock`, provider `npm`/`options`, and old
model `reasoning`/`options` fields are rejected; there is no translation layer.

The OpenCode+`rehor-openai` default lives in `config.json` under
`opencode.model` and is `gpt-6-luna`; OpenCode+Vertex and the Python/Claude/
Vertex rollback keep `claude.model`. The Chat Completions provider requires an
explicit declared model. Deployment allowlists, pricing, tool support, and
regional requirements remain deployment-owned.

OpenCode's `vertex` provider sends Vertex Anthropic `rawPredict` and
`streamRawPredict` requests through the existing proxy. URL precedence is
`REHOR_VERTEX_PROXY_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `PROXY_HOST`/`PROXY_NAME`,
then `http://devbot-proxy:8443`. It uses dummy
project and region path segments because the proxy rewrites them to its
configured `GCP_PROJECT_ID` and `GCP_REGION`. The adapter emits a placeholder
bearer value; the proxy replaces it with its service-account token and applies
`VERTEX_ALLOWED_MODELS`. Google credentials stay proxy-only. Coordinator uses
Sonnet as small model only when it is declared and present in
`VERTEX_ALLOWED_MODELS`; otherwise it uses the selected model for
title-generation requests. Rehor's deployment `smallModel` input renders to
native `agents.title.model`; absent an explicit utility model, the renderer uses
the active provider's validated default. It never emits `small_model`.

### [REHOR-144](https://issues.redhat.com/browse/REHOR-144) renderer contract

The coordinator's `runtimes/opencode/render.ts` owns translation from
provider-neutral cycle data to native OpenCode V2 configuration. The runtime factory
receives the Python preparation through the `preparedConfig` option on
`executeSelectedRun()` and calls `renderOpenCodeConfigForCycle()` with the
prepared model, allowed tools, optional servers, and `openCodeMcpServers` data.
Deployment-owned
provider/plugin fields remain separate. `mcpServers` and `openCodeMcpServers` are mandatory,
separate bridge views; an absent OpenCode view is a protocol error, never a
fallback to resolved Claude values. The renderer:

- normalizes bare models with the deployment provider ID;
- maps stdio MCP to `local` and HTTP/SSE MCP to `remote`;
- converts prepared allowed tools to explicit native ordered OpenCode permission rules,
  denies unlisted built-ins and configured MCP servers, and skips grants only
  for MCP servers explicitly marked optional by the prepared cycle;
- converts provider/plugin `${VAR}` values to OpenCode `{env:VAR}` references
  only when `VAR` is in the explicit `OPENCODE_PROVIDER_ENVIRONMENT_ALLOWLIST`
  (`REHOR_MODEL_PROXY_URL`, `REHOR_MODEL_PROXY_TOKEN`, and
  `REHOR_VERTEX_PROXY_URL`), and returns required variables without
  serializing resolved credentials; MCP URLs may reference only the non-secret
  `JIRA_MCP_URL` endpoint, while MCP headers and local MCP environments cannot
  use environment references;
- rejects unknown tools, malformed transports, untrusted MCP environment
  references, literal credentials, and undeclared package references; the two
  OpenAI runtimes use native `@opencode/ai/providers/...` paths and Vertex uses
  the coordinator-owned `aisdk:file://.../vertex-provider.js` shim;
- emits stable JSON, a content hash, and
  `opencode-packages.lock.json` containing exact provider/plugin build
  declarations for external package closure. Native OpenAI providers do not
  require those declarations.

The runtime factory renders one immutable snapshot for the selected run and validates it before constructing the supervisor. `OpenCodeRuntime` derives prompt submission and Rehor event attribution from that same effective provider/model. The supervisor writes Rehor defaults/resources under isolated `XDG_CONFIG_HOME`, profile settings to a separate `OPENCODE_CONFIG` file, and runner-owned final config content. An explicit **global native V2 policy ceiling** must enforce the deployment's external-directory boundary; inline permissions alone do not prevent agent or project policy widening.

The renderer emits native V2 configuration directly. Deployment input supplies native provider packages/settings and the supported model metadata; legacy input and profile aliases fail validation. No V1 JSON repair or compatibility conversion is supported. See [validation gates](#validation-and-rollback) for required runtime, image, and deployment evidence.

The current types, renderer, constants, and packaged deployment JSON define this contract:

| Concern | Native V2 shape |
| --- | --- |
| Selected model | `provider/model` string or `{ "providerID": "...", "model": "..." }` |
| Provider declarations | Deployment `providers` array of `id`, `package`, `name`, `settings`, and `models`; rendered native `providers` map |
| Model metadata | Only `name`, `modelID`, `limit`, `settings`, and `capabilities`, including `reasoning: { "supported": true }` |
| Utility model | Deployment `smallModel` renders as `agents.title.model` |
| Agents and commands | `agents` and `commands` maps; agent `system`, `disabled`, and ordered `permissions` |
| Tool permissions | `permissions` array of `{ "action": "...", "resource": "...", "effect": "allow|deny|ask" }` rules |
| Directory ceiling | Explicit global `policies` array; project/agent grants cannot widen it |
| MCP | `mcp.servers` map; `local`/`remote`, `disabled`, structured `timeout.startup/catalog/execution`, and optional boolean `codemode`; omission preserves native default `true` |
| Plugins | `plugins` array of directives or `{ "package": "...", "options": {} }` entries; native Effect or supported Promise API, with the generated runner plugin using Effect |
| Other settings | `update: "disable"`, `snapshots`, and `experimental.subagent_depth` |

The renderer rejects the old singular `provider`, `agent`, `command`, `permission`, and `plugin` inputs and does not translate old `enabled`, `autoupdate`, `small_model`, or top-level `subagent_depth` settings. Prepared tool grants remain Rehor inputs: `Bash` maps to native `shell`, `Task` to `subagent`, and `Edit`/`Write` to `edit`. Native profile permission actions must use those V2 names.

The shared Python `ALLOWED_TOOLS` also contains Claude's `LSP` grant. OpenCode preparation omits only that known unsupported grant and logs `OpenCode V2.1.2 does not support LSP`; Claude keeps the full list. Unknown tool names still fail renderer validation rather than silently disappearing. The production-allowlist integration test runs the real Python prepare boundary, validators, and MCP loader against unchanged repository MCP files and renders that output. Environment manifests identify optional grants; this fixture does not install optional environments or exercise remote MCP merging, and it supplies no remote `mcp.json` or merged MCP file.

**LSP is not implemented in the pinned V2.1.2 engine.** Its [official V2 migration guide](https://github.com/anomalyco/opencode/blob/v2.1.2/services/www/src/docs/content/migrate-v1.mdx#L424-L430) says `lsp` configuration is accepted and preserved, but language servers, LSP tools, and diagnostics do not run. This is supported by the deferred-LSP TODOs in [`edit.ts`](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/core/src/tool/plugin/edit.ts#L202-L205), [`write.ts`](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/core/src/tool/plugin/write.ts#L44), and [`file-mutation.ts`](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/core/src/file-mutation.ts#L126-L131). The tag resolves to `a517687fde98a7329ada3ae644a01a9fc6c4e99e`. Neither `OPENCODE_DISABLE_LSP_DOWNLOAD` nor `OPENCODE_DISABLE_DEFAULT_PLUGINS` has a TypeScript source reader in that tag. Retaining either environment variable would not enforce a safeguard. The renderer therefore emits no inert `lsp: false` field and grants no fictional `lsp` tool; use project lint, typecheck, and compiler commands for diagnostics.

Permissions start with an ordered deny-all rule, then explicit built-in/MCP grants and deployment directory rules. MCP namespace normalization rejects collisions. **Native Code Mode and direct MCP tools are both supported.** Set optional boolean `codemode` on a central `mcpServers.<server>` declaration or a native profile `mcp.servers.<server>` entry. Omission stays omitted in rendered config and preserves OpenCode's native default `true`; it is not rewritten to `false`.

For generated servers, an allowed MCP grant on an active server with `codemode` omitted or `true` automatically adds native `execute` permission so the wrapper can expose that tool. Disabled or direct (`codemode: false`) servers do not trigger this automatic grant. Native agent `permissions` can deny `execute`, hiding the wrapper and its wrapped tools, or allow `execute` when general permissions deny it. This changes wrapper availability, not server exposure mode: an agent cannot turn a server configured `codemode: false` into a wrapped server. Nested MCP calls still undergo native tool permission checks.

| Effective server mode | Agent `execute` permission | Exposure |
| --- | --- | --- |
| Omitted or `true` | Allowed | Granted wrapped tools are available through `execute`. |
| Omitted or `true` | Explicitly denied | The wrapper and its wrapped tools are hidden for that agent. |
| `false` | Allowed or denied | MCP tools remain direct, subject to their own grants; the agent cannot rewrap them. |

The runner-owned V2 Effect plugin uses `ctx.tool` hooks to record uniquely identified nested calls with unfiltered inputs, results, and errors. It correlates each admitted call through native fiber ID across before hooks, asynchronous input decoding, execution, output validation, and after hooks. Repeated scalar/null inputs, shared objects, and out-of-order completions do not rely on input identity or equality. Success is authoritative only after native output validation and the after hook. The bridge preserves native failure/interruption semantics and serializes progress snapshots through a semaphore.

It publishes progress snapshots and persists terminal evidence in `metadata.rehorCodeMode`, alongside OpenCode's native `metadata.toolCalls`. The normalizer merges those sources without counting the same operation twice, including repeated/parallel identical calls, progress updates, terminal projections, and recovery. The outer `execute` tool remains visible with `budgetUnit: "container"` and never consumes a tool-call budget unit. Each successful nested operation counts once, including successful native fetch metadata rows; errors do not count, and a finished wrapper does not imply that unfinished nested calls succeeded.

Work-context extraction receives successful unfiltered nested results even when a script prints only a filtered summary. Native-only metadata without captured results can supply status/accounting evidence, but is marked result-unavailable and cannot borrow the wrapper's filtered output as a nested result. Code Mode `fetch` is raw HTTP, independent of the `webfetch` permission. Its authority follows network sandbox/egress controls and `execute` availability; there is no `fetch: false` restriction claimed here. See [runtime budgets](#runtime-specific-budgets-rehor-198) for non-atomic batch limits.

The final runner layer removes built-in `opencode.tools` (session/worktree/model-management tools) and `opencode.tools.mcp-resources` (generic MCP resource tools outside the explicit MCP grant list). Other V2 built-ins are intentionally retained. V2's [internal plugin registry](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/core/src/plugin/internal.ts#L217-L276) includes essential runtime adapters, not just optional default integrations:

| Retained built-ins | Purpose and control |
| --- | --- |
| `opencode.config.*` | Applies native provider, agent, command, instruction, MCP, shell, skill, formatter, snapshot, compaction, and policy configuration. Removing these would break configuration and enforcement. |
| `opencode.tool.*` | Implements read/edit/write/shell/glob/grep/skill/subagent and other native tools. The ordered deny-all permission baseline exposes only explicitly granted actions; retaining a plugin does not grant its tool. |
| Provider adapters, `opencode.models.dev` | Loads provider/model definitions. Global `provider.use` policies deny other providers and allow the selected provider; model-catalog fetching is disabled by the runner. Isolated data/database state excludes ambient saved credentials. |
| `opencode.mcp.codemode.defaults`, agent/command/skill, VCS, plan, prompt/optimization, warming plugins | Supplies native tool exposure, discovery, lifecycle, and prompt behavior. MCP grants, agent permissions, and the external-directory ceiling remain independent controls. |
| `opencode.browser`, web-search adapters | Remain registered; browser and web-search tools receive no grant from the production allowlist. Code Mode raw fetch and any plugin-initiated traffic still require deployment network/egress confinement; tool permissions are not a network firewall. |

Blanket `plugins: ["-*"]` would remove required provider/config/tool adapters, not reproduce V1's default-plugin behavior. Upstream also guards its policy and Console plugins against removal. The renderer uses named management removals plus explicit tool/provider/directory policies; package closure and egress remain deployment responsibilities.

The supervisor isolates instruction discovery, config/data homes, and database. CLI `2.1.2` receives offline package resolution, disabled model-catalog fetching, and native `update: "disable"` configuration. Package installation is not a runtime responsibility: the image must pre-bake the declared closure. Instance configuration carries independent `runtime` and `provider` through the Python bridge as `runtimeId` and `providerId`; the coordinator consumes `runtime: opencode`. See the [canary rollout runbook](../operations/rehor-146-opencode-canary.md).

`coordinator/test/opencode-production-allowlist-native.test.ts` is an exact **CLI 2.1.2 snapshot**, launching the native server directly rather than through the production supervisor. With prepared production grants and a loopback model fixture, six native operations read/edit/write `.ts` and `.py` files, required config/tool plugins activate, and management plugins and LSP tools are absent. **FFF/native indexing and all MCP loading are excluded**: the test sets `OPENCODE_DISABLE_FFF=1`, overrides every prepared MCP server with `alwaysLoad: false`, and points `JIRA_MCP_URL` at loopback port 1; npm resolution is offline. The production supervisor does not set `OPENCODE_DISABLE_FFF`. A test-only configured LSP canary and PATH language-server/package/download sentinels remain untouched, confirming no observed LSP or edit/write-triggered sentinel process attempts for the pinned release under this fixture. The proxy trap records zero requests under those exclusions; this is not deployed-supervisor egress/download proof or OS-level confinement evidence. These observations complement the tagged source evidence above that 2.1.2 has no LSP runtime. The strict version assertion deliberately excludes future binaries, so the canary makes no future-runtime tripwire claim. Run with `PYTHON=<project-python> REHOR_TEST_OPENCODE_BINARY=<2.1.2-binary> npm test -- test/opencode-production-allowlist.test.ts test/opencode-production-allowlist-native.test.ts` from `coordinator/`.

OpenCode profiles are deliberately migrated to native configuration. OpenCode
preparation never assembles core, shared, workflow, or profile `CLAUDE.md`, ignores
`claudeMdStrategy`, and does not generate fallback guidance. No Claude instruction
files are required. Canonical preset guidance lives in `presets/core/AGENTS.md`
and `presets/workflows/<name>/AGENTS.md`; relative `CLAUDE.md` symlinks preserve
Claude consumers. Runtime `claude` retains existing assembly and generated
`CLAUDE.md` behavior. OpenCode removes that runner-managed app-root output when switching runtimes, preserves target project files, and references native
instructions in its cycle prompt. Its own project `AGENTS.md`/`CLAUDE.md` discovery
and `.claude/skills` compatibility remain enabled; `OPENCODE_DISABLE_PROJECT_CONFIG`
stays unset.

Provider selection remains independent from runtime selection. During canary,
OpenCode may select either the existing Vertex route or the OpenAI gateway
(`@opencode/ai/providers/openai-compatible` → Chat Completions,
`@opencode/ai/providers/openai/responses` → Responses).
The proxy serves both `POST /v1/chat/completions` and `POST /v1/responses` with
the same header-injection handler; do not translate request schemas inside the
proxy.

## Vertex-to-OpenAI Migration

This is a provider and credential migration, not only a URL change.

### Remove or Retire

- `GOOGLE_SA_KEY_B64` from proxy deployment after rollback window.
- `GCP_PROJECT_ID` and `GCP_REGION` where unused by remaining services.
- `VERTEX_ALLOWED_MODELS` after all Vertex traffic is retired.
- Vertex-specific request translation and token refresh code.
- Vertex-specific dashboards and alerts after equivalent OpenAI metrics exist.

### Add

- Vault key `openai-api-key` or project-scoped equivalent.
- `OPENAI_API_KEY` proxy-only environment variable.
- `OPENAI_ALLOWED_MODELS` or provider-neutral model allowlist.
- `OPENAI_BASE_URL` with default `https://api.openai.com/v1`.
- `REHOR_MODEL_PROXY_URL` for the internal gateway and `REHOR_MODEL_PROXY_TOKEN` as the provider client's placeholder API key. The proxy overwrites the latter; NetworkPolicy controls reachability.
- `REHOR_WORKSPACE_OWNER_UID` set to the image's `/home/botuser/app` owner UID (normally `1000`). OpenShift Sandbox pods run under a random namespace UID, and the coordinator fails every OpenCode run before the first model call with `workspace ownership mismatch` when this override is missing.
- OpenAI request ID and usage metrics.
- OpenAI rate-limit and retry handling.

Do not remove Vertex configuration until canary validation and rollback expiry
complete. During transition, proxy may expose separate provider routes:

```text
:8443  Vertex auth proxy, legacy
:8450  OpenAI-compatible proxy, canary/new path
```

The bot selects provider through OpenCode config. This allows per-instance
rollout without changing central routing for existing Claude-based instances.

## Runtime Migration

### 1. Prepare and merge the main runtime PR

1. Preserve the versioned `RehorRun`/`RehorEvent` schemas and lifecycle, attribution, partial usage, preflight, and projection contracts. Validate V2 events with the same runtime schemas used by fixtures.
2. Ship `OpenCodeRuntime` under `coordinator/src/runtimes/opencode/`, registered solely as `opencode`. The configuration contract is native V2 only, including global policies and V2 plugin loading; versioned IDs and legacy input translation are unsupported.
3. Pin `@opencode/client@2.1.2` in the coordinator lockfile and install `@opencode/cli@2.1.2` in both image paths. Build on Node 22; include coordinator bundles, provider dependencies, approved plugins, deployment defaults, and `zstd`. Pre-bake every external package so startup works offline.
4. Run the validation commands below and the image smoke check against the actual built image. Merge runtime and this operational guidance together. Record the merged commit for consumers; a branch tip is not a consumer rollout pin.

### 2. Migrate each Claude SDK instance directly to V2

1. Record the prior immutable Claude image digest, instance/config revision, engine selection, provider/model, MCP settings, and instruction strategy for rollback.
2. Update the consumer's `dev-bot` gitlink to the merged main commit and build a fresh image. In its instance config use:

   ```yaml
   runtime: opencode
   provider: rehor-openai
   model: gpt-6-luna
   ```

   Select `vertex` instead when keeping the existing Vertex route; keep provider/model declared in deployment defaults. `rehor-openai-chat` requires an explicitly declared model. Set `BOT_EXECUTION_ENGINE=coordinator` on that deployment. `BOT_RUNTIME`/`BOT_PROVIDER` are fallbacks; explicit instance fields take precedence.
3. Convert instance guidance to `agent/AGENTS.md`, agents to `.opencode/agents`, and skills to `.opencode/skills`. Keep canonical core/shared/workflow `AGENTS.md` layers. Audit native agent/frontmatter, model overrides, tool permissions, instruction references, and local/package plugins against V2. Put `subagent_depth` under `experimental`; do not rely on legacy translation.
4. Configure deployment-owned providers, declared models/package versions, required proxy environment, tool-call budget, MCP endpoints, and approved `additionalDirectories`. Keep credentials in existing proxy services. Verify operational helper variables and template gateway egress, especially TCP/8450 for OpenAI.
5. Publish and reconcile the immutable image/template. Obtain a fresh Sandbox; profile sync or restarting a cycle on an old image cannot install the V2 client, CLI, renderer, or environment fixes.
6. Run one staging `--once` cycle and the native/deployment gates below, then expand using the [rollout runbook](../operations/rehor-146-opencode-canary.md). Compare terminal state, status, transcript, usage, costs, and cleanup with the previous Claude baseline.

### 3. Onboarding-only experimental V1 follow-up

Only after the main PR merges, open a **separate onboarding PR** updating the `dev-bot` gitlink to that merged commit and converting its runtime, deployment JSON, and profile resources explicitly to native V2. Audit external plugins for a V2 implementation and rebuild the consumer image. Validate its fresh Sandbox separately. No consumer change belongs in the main runtime PR, and no other Claude agent needs a V1 stage.

Inspection of the current onboarding consumer found these required follow-up edits, under `instance/rehor-onboarding-config/`:

| Consumer artifact | Required native conversion |
| --- | --- |
| `agent/instance.yaml` | Replace the experimental versioned runtime selection with `runtime: opencode`; preserve the intentional Sol/Luna model routing. |
| `agent/opencode.json` | Move top-level delegation depth to `experimental.subagent_depth: 1`; retain `default_agent: onboarding-coordinator`. |
| `opencode-deployment.json` | Replace provider `npm`/`options` with native `package`/`settings`; use the Responses runtime, native model `capabilities.reasoning`, and model `settings`. Remove the old OpenAI package declaration; no such metadata is required. Preserve approved directories and declared Sol/Luna models. |
| `agent/.opencode/agents/*.md` (six agents) | Convert `options` and singular map-shaped `permission` frontmatter to supported native agent fields and ordered `permissions`. Replace `task` actions with `subagent`; retain coordinator delegation allowlists, worker delegation denials, and researcher/reviewer edit denials. Preserve and validate medium reasoning through supported native settings/request configuration. |

The six Markdown agents are `onboarding-coordinator`, `onboarding-researcher`, `onboarding-reviewer`, `onboarding-instance-scaffolder`, `onboarding-konflux-implementer`, and `onboarding-app-interface-implementer`. Their directories already use canonical plural `agents/`, but their frontmatter still needs conversion. Agent and command YAML frontmatter passes strict native validation, rejecting legacy or mixed native/legacy fields; files are not automatically rewritten. This inventory is a migration requirement, not a claim that the consumer has been changed or validated on V2. In that separate PR, choose per-server exposure and per-agent `execute` permissions deliberately; retain both native MCP grants and the existing role restrictions.

### Profile configuration reference

#### GitOps-managed profile configuration

The coordinator reads OpenCode profile configuration from the selected
`BOT_CONFIG_PATH/agent/` directory. All files are optional; profiles without
OpenCode files continue to run using generated deployment settings and native bot guidance. Runtime `claude` retains existing `CLAUDE.md`, persona, and `.claude/skills` behavior; OpenCode profiles require deliberate native migration.

Supported profile layout:

```text
<BOT_CONFIG_PATH>/agent/
├── AGENTS.md                 # optional OpenCode instructions
├── opencode.json             # optional supported OpenCode settings (JSON)
└── .opencode/                # optional; staged under isolated global config dir
    ├── agents/               # custom agents and subagents
    ├── commands/              # custom commands
    ├── instructions/          # instruction files referenced by opencode.json
    ├── plugins/               # trusted, GitOps-managed local plugins
    ├── rules/                 # instruction files referenced by opencode.json
    ├── skills/                # agent skills
    └── themes/                # themes
```

Example `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agents": {
    "reviewer": {
      "description": "Reviews changes",
      "mode": "subagent",
      "permissions": [
        { "action": "shell", "resource": "*", "effect": "deny" }
      ]
    }
  },
  "experimental": { "subagent_depth": 2 }
}
```

This fragment defines a native reviewer and delegation depth; provider/model selection stays deployment-owned. Add a package plugin only after its V2 implementation and exact deployment pin are validated.

The equivalent agent Markdown uses native ordered frontmatter rules too. For example, retain read-only/no-delegation restrictions with:

```markdown
---
description: Reviews changes without editing or delegating
mode: subagent
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---
Review the assigned changes and return findings with evidence.
```

Supported profile JSON fields are exactly `agents`, `commands`, `compaction`, `default_agent`, `experimental`, `formatter`, `instructions`, `mcp`, `permissions`, `plugins`, `snapshots`, and `watcher`, plus the accepted `$schema`. `experimental` accepts non-negative safe-integer `subagent_depth` and optional boolean `todo`. Top-level `subagent_depth` and other legacy fields are rejected, not translated. Agent JSON and Markdown frontmatter use ordered `permissions` with native `shell`, `subagent`, `edit`, and `read` actions, not old permission/tool maps. Unsupported or coordinator-controlled fields fail validation.

Supported `.opencode` resource directories are exactly `agents`, `commands`, `instructions`, `rules`, `plugins`, `skills`, and `themes`. Singular aliases, `modes`, and `tools` directories are unsupported. No resource-path or frontmatter conversion is performed. Agent and command Markdown must be parsed as native YAML frontmatter and strictly validated before use. Legacy fields, mixed representations, old permission maps/actions, and invalid native values must fail preparation rather than be silently ignored or translated. JSON validation alone is insufficient; verify the Markdown path separately.

Profile `mcp` accepts only `servers`; each local/remote server uses `disabled`, optional boolean `codemode`, and optional positive-integer `timeout.startup`, `timeout.catalog`, and `timeout.execution`. The prepared bridge's single timeout populates all three native timeout fields for generated servers. Central `mcpServers.<server>.codemode` and native `mcp.servers.<server>.codemode` support `true`, `false`, and omission; omission preserves native default `true`. Agent permissions control `execute` availability but cannot override a server's direct exposure setting. Profile-added servers cannot replace generated servers.

The coordinator validates profile settings, stages `agent/opencode.json` as a distinct `OPENCODE_CONFIG` source, and stages `.opencode` assets under isolated `$XDG_CONFIG_HOME/opencode/` resource paths. Keep deployment global config and profile resources below checked-out project resources for ordinary native settings; the runner supplies final controlled model/provider, MCP, sharing, update, and tool defaults. Ambient custom config directories and inline overrides are not inherited.

**Policy precedence is different from ordinary settings precedence.** Deployment external-directory limits must live in explicit global native V2 `policies`, where project policy grants and native agent permissions cannot widen them. A profile may add denials, and agent JSON/Markdown rules must retain their ordered restrictions inside approved roots. Verify final policy behavior using native tests, not just JSON snapshots. The supervisor rejects managed `/etc/opencode/opencode.json` and `.jsonc` files that could introduce an uncontrolled system source.

GitOps profiles are trusted, deliberate user configuration. Plugins, tools, and
formatters can execute arbitrary code in the server; permission defaults are not
a sandbox against that code or native agent configuration. OpenCode owns agent
and command schema, models, permissions, and frontmatter. Native agent permissions,
including checked-out project agents, are subject to the global directory ceiling described below. Top-level
model/provider selection remains coordinator-controlled; profile `permissions` may
only add denials. MCP additions cannot
replace generated servers and retain URL, credential, and environment checks.
Generated MCP servers retain their explicit baseline allowlist; validate namespace normalization, wrapped/direct exposure, nested evidence, and denied-tool behavior for profile-added servers as well. Automatic `execute` grants apply to allowed active generated wrapped MCP servers; native agent permissions can further control wrapper availability. Raw Code Mode HTTP fetch remains subject to network controls, not `webfetch` permission. NPM plugins require exact deployment-declared
versions for reproducibility and the pre-baked offline closure, not code isolation.
Local `.opencode/plugins` resources must also be V2-compatible. External plugins may use native Effect (`id` plus `effect(ctx)`) or the supported Promise API (`id` plus async `setup(ctx)`); Promise is not mandatory. The generated runner plugin uses `effect: (ctx) => Effect.gen(...)`, with `Cause`, `Effect`, `Exit`, `Semaphore`, and `Stream` imported from the host-supplied `effect` runtime. Its shell hook returns an Effect, and its Code Mode bridge uses native fibers for invocation identity. No separately configured Effect package is required, but the generated plugin is not dependency-free. Configured local plugin references must target plugin directories, not individual module files. Audit the separately published Rehor package plugin for an actual V2 implementation; pinning or renaming a V1 package is insufficient.

Cycle preparation requires `presets/core/AGENTS.md`, then loads optional shared
`agent/AGENTS.md` and the selected built-in or `./` custom workflow's `AGENTS.md`.
These remain distinct text resources under isolated global
`instructions/rehor/{core,shared,workflow}.md`; native `instructions` references
precede existing profile instruction references in core → shared → workflow order.
Those three generated paths are reserved; profile collisions fail preparation.
Shared and custom workflow guidance with only `CLAUDE.md` fails preparation with
an actionable `AGENTS.md` migration error; instructions-free optional directories
remain allowed. Rehor's native guidance loader never reads preset `CLAUDE.md` aliases or applies Claude strategies; OpenCode's own target-project discovery remains native.

Profile `AGENTS.md` is staged directly as isolated global
`$XDG_CONFIG_HOME/opencode/AGENTS.md`, without renaming or injected instruction
entries. Project `AGENTS.md`/`CLAUDE.md` stay untouched and retain native discovery
precedence. Preparation captures bot guidance, profile settings, and files once; deterministic
hashes cover that native snapshot for instruction/config provenance, and the same
snapshot is required by the runtime factory. These hashes do not claim to represent assembled
Claude content or OpenCode's later project discovery.
Coordinator rejects symlinks and paths escaping selected profile. Missing
profile `AGENTS.md`, `opencode.json`, or `.opencode/` is normal. XDG config/data homes, database, and instruction discovery stay isolated per cycle. Shell `HOME`, caches, and state remain persistent. The runner-owned V2 shell plugin restores both original `XDG_CONFIG_HOME` and `XDG_DATA_HOME` for shell commands, preserving absent/empty values, while server homes stay private. The server uses fresh per-process authentication and must not import saved ambient credentials. Provider API keys still resolve from validated environment references.

#### Operational child environment (REHOR-199)

The OpenCode supervisor copies these 12 reviewed operational variables from its runner environment whenever present, without provider passthrough configuration. Most are non-secret coordinates or identities; `SLACK_WEBHOOK_URL` is an intentional configured-webhook credential exception preserving the existing helper contract. The table records current consumers; it is not an exhaustive inventory of future helper requirements. Source paths are relative to the repository root:

| Variable | Source consumer | Purpose |
| --- | --- | --- |
| `EXECUTOR_ADDR` | `proxy/executor/cmd/client/main.go:30` | Thin clients (`gh`, `glab`, `gpg`, etc.) route gRPC to the configured executor instead of falling back to `unix:///var/run/devbot/executor.sock`. |
| `BOT_JIRA_EMAIL` | `presets/shared/skills/claim-onboarding/claim_onboarding.py:18–29` | Bot identity for Jira assignment through MCP, not direct authentication. |
| `BOT_INSTANCE_ID` | `presets/shared/skills/claim-onboarding/claim_onboarding.py:20,67` | Active bot instance identity for task ownership. |
| `BOT_MEMORY_URL` | `presets/shared/skills/claim-onboarding/claim_onboarding.py:19,57–85` | Configured memory-service endpoint for task creation. |
| `GH_USER_NAME` | `presets/shared/skills/auto-fork/auto_fork.py:105–141` | GitHub fork-owner identity; missing/empty value raises `ValueError`. |
| `GL_USER_NAME` | `presets/shared/skills/auto-fork/auto_fork.py:106,147–149` | GitLab fork-owner identity; missing value prevents GitLab forking. |
| `BOT_CONFIG_PATH` | `presets/shared/skills/auto-fork/auto_fork.py:108,152` | Instance configuration location; empty value is rejected. |
| `SLACK_NOTIFY_MODE` | `presets/shared/skills/post-pr/scripts/post_pr_operations.py:528`; `presets/workflows/jira-sprint/skills/wrap-up/wrap_up.py:201` and the corresponding `jira-kanban` path | Notification policy mode, not a credential. |
| `SLACK_WEBHOOK_URL` | `presets/envs/slack/skills/slack-notify/slack_notify.py:31–44`; post-pr and both wrap-up helpers | Configured webhook credential passed by the helper as `webhook_url` to the existing memory-server `slack_notify` tool. |
| `GH_RELEASE_UPLOAD_URL` | `presets/envs/browser/skills/gh-release-upload/upload.py:10` | Release-upload proxy endpoint override. |
| `BOT_BOARD_ID` | `presets/workflows/jira-sprint/skills/claim-ticket/scripts/claim_ticket_operations.py:327–368` and the corresponding `jira-kanban` path | Explicit Jira board selection for claim-ticket helpers. |
| `BOT_BOARD_NAME` | Same two claim-ticket consumers, lines 327–368 | Board-name lookup when no board ID is configured; missing both prevents board resolution. |

Values are copied unchanged, including empty strings; absent variables remain absent. The sanitizer does not mutate its input or invent deployment defaults. The native server, root and child-agent Bash tools, and their Python subprocesses inherit these values.

This is an exact-name operational allowlist, not ambient `BOT_*`, `EXECUTOR_*`, or `SLACK_*` passthrough. Provider/plugin references retain their separate validated opt-in allowlist: strict provider/plugin configuration still rejects `SLACK_WEBHOOK_URL` as unapproved. `GH_TOKEN`, `OPENAI_API_KEY`, `JIRA_API_TOKEN`, `JIRA_MCP_TOKEN`, unknown variables, and ambient OpenCode/NPM configuration remain excluded even when explicitly requested through passthrough. `JIRA_USERNAME` remains blocked as part of the legacy direct Jira authentication surface; permitted `BOT_JIRA_EMAIL` is only bot identity. API/MCP tokens remain excluded. Runner-owned config, auth isolation, and offline controls still take precedence.

The compatibility decision intentionally keeps the configured webhook available to the agent and its helpers: agent → helper → MCP `slack_notify` payload (`webhook_url`, plus the existing `notify_mode`) → memory-server webhook POST. The server already accepts this payload; no new notification mechanism or server-side per-instance configuration is required. The existing deployment parameter `SLACK_WEBHOOK_URL` needs configuration only if unset; the application interface is unchanged. Absent and empty webhook values remain unchanged, so the canonical slack-notify helper and wrap-up helpers retain their optional no-op behavior; post-pr reports an unconfigured webhook.

Default coordinator tests cover all 12 names in sanitization and spawned-server environments with present and absent operational values. Canonical slack-notify helper tests capture MCP arguments for synthetic webhooks/modes and verify absent/empty no-ops. The opt-in V2 native suite exercises real supervisor root/child delegation, Bash/Python helper inheritance, a temporary build of the real Go executor client against loopback gRPC, and an in-process Slack MCP argument capture. This verifies helper payloads, not live MCP or webhook transport. Fixtures use synthetic identities/credentials and no paid inference. Run from `coordinator/` with Go and `python3` on `PATH`; the binary must be CLI `2.1.2`:

```bash
REHOR_TEST_OPENCODE_BINARY=/absolute/path/to/opencode-2.1.2 npm test -- test/opencode-environment-native.test.ts
```

See [fresh-image rollout requirements](../openshell-deployment.md#opencode-operational-environment-rollout-rehor-199) before validating a deployed instance.

#### Supplemental workspace access (REHOR-198)

Deployment-owned `opencode-deployment.json`, selected by `REHOR_OPENCODE_DEPLOYMENT_CONFIG`, may grant supplemental paths outside the cycle worktree:

```json
{
  "additionalDirectories": [
    "/home/botuser/repos",
    "/home/botuser/data",
    "/tmp/opencode"
  ]
}
```

Merge this field with the deployment's provider/package settings. These are the onboarding deployment's approved roots, not automatic grants for every instance. `additionalDirectories` is not a supported profile `agent/opencode.json` field. Missing or empty grants keep external-directory access denied.

Each entry must be a literal, canonical absolute POSIX path other than `/`. Wildcards, traversal, noncanonical separators, backslashes, control/format characters, environment/file references, and leading/trailing whitespace in path segments are rejected. Paths need not exist yet. The renderer sorts and deduplicates them. Native permissions and global V2 policy resources must cover approved roots and descendants while denying all other external paths. Verify exact-root and nested behavior against CLI `2.1.2`; rendered V1 glob behavior is not V2 acceptance evidence.

The explicit global native policy ceiling outranks project policies and JSON/Markdown agent grants. Within approved roots, native `allow`, `ask`, and `deny` ordering and per-agent read denials remain effective. `ask` must not become automatic approval in the headless runner. Broad agent or project grants cannot open sibling paths, `/`, or the private instruction-discovery home. Preserve ordered permission arrays when staging and hashing profiles. Supplemental grants do not relax credential-shaped read restrictions or unrelated tool permissions. This replaces the historical V1 config-hook clamping design.

This is OpenCode permission configuration, not a filesystem or Bash sandbox. It does not constrain arbitrary code from plugins, custom tools, or shell commands. OpenShell policy, mounts, Unix permissions, and network isolation are separate controls; these grants neither create mounts nor establish a controller upgrade requirement. See [OpenShell deployment and rollout](../openshell-deployment.md#opencode-budget-and-workspace-rollout-rehor-198).

The V2 native config suite covers approved/outside paths, global-policy precedence over project grants, JSON/Markdown agent read denials, native ordering/asks, and root/child shell XDG restoration. Native Code Mode configuration and bridge checks have validated root/child behavior: omitted/true/false server exposure, agent `execute` allow/deny, denied nested calls, distinct nested evidence, and unfiltered results despite filtered script output. The environment suite additionally covers credential isolation and MCP behavior. These offline mock-provider checks do not establish fresh final-image or live deployment acceptance.

### V2 plugin responsibilities

Port only lifecycle behavior that benefits from OpenCode hooks:

- tool policy enforcement
- environment injection
- structured logging
- session lifecycle status
- compaction context
- custom Rehor tools

Keep deterministic, no-LLM preflights and policy decisions outside OpenCode.
Existing preflight contract
(`start`, `skip`, `error`) is already a useful runner boundary.

### Follow-up: Model Tiering

Map current Jira decisions:

| Rehor role | OpenCode configuration |
|---|---|
| Coding | primary agent, full model |
| Reviewer | workflow-specific model |
| Triage | subagent or separate short session |
| Researcher | subagent, standard model |
| Test writer | subagent, standard model |
| Formatter | subagent, cheap model |

Implement after basic session parity. First prove model selection and usage
accounting; then reproduce `REHOR-125` and `REHOR-126` routing.

## Security Model

- OpenAI key exists only in proxy pod memory.
- Bot pod gets no OpenAI key and no Google service-account key.
- OpenCode server binds to loopback or pod-local interface.
- NetworkPolicy permits bot → model proxy only on required port.
- Server authentication is enabled if any non-loopback access exists.
- `share` is disabled for autonomous bot sessions.
- OpenCode permissions explicitly deny unnecessary tools and providers.
- Proxy validates model and provider instead of trusting bot config.
- Proxy strips credential-bearing response headers.
- Prompt, tool arguments, and model output stay out of proxy logs by default.
- Separate bot instances use separate OpenCode servers and worktrees.

## Observability

Preserve existing Rehor metric dimensions and add provider dimensions:

- `provider`
- `model`
- `instance_id`
- `workflow`
- `status`
- `run_id`

Required measurements:

- OpenCode server health and version
- session creation and completion
- session aborts and timeouts
- MCP connection status
- model request count and status
- model latency and stream interruption
- input/output/reasoning tokens when available
- estimated cost by provider and model
- proxy rate-limit responses
- preflight duration and outcome

Do not assume OpenAI streaming always includes final usage. Store partial-cycle
records and mark usage incomplete when stream terminates before final usage
event.

### OpenCode cost estimates (REHOR-197)

The coordinator bundles a minimal pricing registry in
`coordinator/src/runtimes/opencode/pricing.json`. It is the fallback when native
OpenCode events carry no cost; positive native costs from the execution CLI's
own catalog take precedence and are labelled `native-catalog`. No catalog is
downloaded at runtime, and instances do not maintain their own prices.

To add a supported model, add its rates (USD per million tokens, from
models.dev) to the registry; do not type rates into instance configuration.

Pricing aliases are centralized in `pricing.ts`: `rehor-openai` and
`rehor-openai-chat` use canonical `openai` rates; `vertex` uses
`google-vertex-anthropic`, with `claude-opus-4-6@default`,
`claude-sonnet-4-6@default`, and exact dated `claude-haiku-4-5@20251001` entries.
Bare `claude-haiku-4-5` maps to that dated Vertex Haiku entry.
These are pricing aliases only; API/proxy model IDs remain unchanged. No
direct-Anthropic substitution or model-family guessing occurs.

V2 projects **one assistant message per model step**. `session.step.started`,
`session.step.ended`, and `session.step.failed` identify that assistant through
`assistantMessageID`; its tokens and cost describe that step, not a cumulative
assistant total across steps. Streaming step evidence and persisted assistant
projections feed the same usage entry keyed by session/message ID. Repeated event
IDs are ignored, and a corrected or recovered projection replaces its earlier
entry rather than adding another charge. Model-attribution corrections withdraw
usage from the old provider/model bucket before refreshing the new bucket.

Compaction is separate usage evidence, with its own message identity. Streamed
compaction events and recovered compaction projections must be matched and replaced
so the same operation is counted once, including when its start event was missed.
Session-wide usage totals must not be added on top of assistant/compaction entries.
Rehor emits cumulative snapshots per provider-qualified model across root and child
sessions; projections replace those snapshots instead of summing successive updates.

Reconciliation reads persisted V2 messages, establishes root outcome evidence first,
and discovers/reconciles child sessions recursively within shared time and pagination
bounds. Unavailable children, truncated pages, missed projections, or exhausted
recovery deadlines mark coverage incomplete without discarding valid root evidence
or known usage. Recovery must refresh accounting without replaying completed tools,
errors, or lifecycle events. A started but unfinished/interrupted step remains
incomplete even if earlier steps completed successfully; retain their known token
and cost subtotal rather than reporting a falsely complete total or dropping it.
New OpenCode `model` values and `modelUsage` keys are provider-qualified (for
example, `rehor-openai/gpt-6.1-sol`). Historical unqualified names remain unchanged,
so grouping by model splits historical and new rows into separate buckets.
New OpenCode `output_tokens` totals include reasoning as well as visible output;
older rows may omit reasoning and are not directly comparable.

The estimate uses noncached input, visible output plus reasoning, cache-read,
and cache-write counts at their respective USD-per-million rates. Native counts
have already separated cache and reasoning; they must not be subtracted again.
Tier selection uses total input including cached tokens, separately for each
step, with strict `context > threshold`. Explicit tiers are authoritative;
the frozen catalog's historical `experimentalOver200K` metadata is a fallback only
when explicit tiers are absent. This pricing-data rule is independent of the V2
runtime contract. Cache duration-specific,
discounted, regional and negotiated billing is not inferred from token counts.

Positive native V2 costs are **catalog estimates, not billed provider amounts**.
The normalizer retains a positive per-step native estimate with `source: estimated`
and native-catalog pricing provenance; it does not label it `provider` merely because
OpenCode reported it. Native zero is not proof of free usage: known models receive
the frozen-catalog estimate, while unpriced usage remains unknown. An interrupted
or pending step, missing/malformed tokens, or incomplete recovery must keep the
result incomplete. Preserve any known subtotal, including available positive native
estimates, even when other steps remain unfinished or unpriced.

Local `costs.jsonl` and `/api/costs` carry optional `cost_status` and
`cost_incomplete`. New V2 cost records use `estimated` when an estimate/subtotal is
known and `unknown` when no price is known; the shared schema's `provider` value
does not turn native V2 estimates into billed usage. The
numeric `cost_usd` remains backward-compatible and represents the known subtotal.
Legacy records have no invented provenance. Dashboard rows show `≈` for
estimates, `Unknown` for unpriced totals, and an incomplete label for subtotals;
daily metadata provides provenance context when aggregate totals include these records. Catalog
estimates are not invoice verification, and historical zero records are not
retroactively repriced.

Claude SDK usage intentionally retains `estimated: true` and `source: estimated`.
New Claude rows therefore display `≈` and persist `cost_status: estimated`.
Dollar amounts, unqualified model buckets, and token accounting remain compatible:
Claude output totals are preserved without adding reasoning a second time.
Historical rows keep their original provenance. The SDK is planned for removal
after OpenCode is validated and adopted across all agents.

The costs POST endpoint rejects `cost_status: unknown` with a nonzero
`cost_usd`; omitted, null, and zero unknown amounts are stored as zero/incomplete.
Schema migration repairs any earlier inconsistent unknown rows to zero/incomplete
once, before installing a database constraint, so existing aggregate queries
cannot include unknown dollar amounts. Native token completeness requires every
expected class (`input`, `output`, `reasoning`, `cache.read`, `cache.write`) to be
a nonnegative safe integer; missing or malformed classes remain incomplete.

Offline native token/cost smoke (no paid calls):

```bash
npm --prefix coordinator test -- test/opencode-pricing.test.ts
npm --prefix coordinator run build
REHOR_TEST_OPENCODE_BINARY=/path/to/opencode-2.1.2 npm --prefix coordinator test -- test/opencode-pricing-native.test.ts
```

The opt-in smoke uses isolated native processes and credential-free loopback
Chat Completions, Luna Responses, and Vertex Anthropic Messages mocks. It uses
the built coordinator renderer and real packaged Vertex adapter (mock bound to
`127.0.0.1:8443`, which must be free). It verifies native zero-cost custom-provider
output, normalized cache/reasoning counts including Vertex cache writes, proxy
request path/placeholder authorization, and the coordinator normalizer estimate. Live proxy
billing remains a separate deployment validation.

## Validation and Rollback

### Local and image validation

Run from repository root after the runtime rename and native V2 renderer are complete:

```bash
npm --prefix coordinator ci
npm --prefix coordinator test
npm --prefix coordinator run typecheck
npm --prefix coordinator run build
(cd coordinator && REHOR_TEST_OPENCODE_BINARY=/absolute/path/to/opencode-2.1.2 npm test -- test/*-native.test.ts test/runtime-opencode.test.ts --maxWorkers=1)
```

Native suites are opt-in locally; a default suite passing with native tests skipped is not CLI validation. Coordinator CI runs all seven native files plus the three native lifecycle cases in `runtime-opencode.test.ts` after unit tests, type checking, and build, using serial workers to avoid fixed-port conflicts. CI installs `@opencode/cli@2.1.2` outside repository dependencies and checks the executable's actual version before running with `REHOR_TEST_OPENCODE_BINARY`. Go (the toolchain pinned in `proxy/executor/go.mod`), Python 3.12+, and PyYAML must be available for environment fixtures, and TCP/8443 must be free for the Vertex pricing mock. After building the target image, run the repository's image smoke wrapper (replace the image reference with the built image):

```bash
bash tests/container-e2e/checks/verify-opencode-image.sh podman <built-runner-image>
```

The wrapper accepts `podman` or `docker` and streams the check into Node inside the image; the script need not be baked into the image. It assumes the app root is `/home/botuser/app`. It is an offline packaging/provider check, not live inference. Documentation validation from repository root is `python3 -m mkdocs build --strict` where the MkDocs dependencies are installed.

Required evidence before final acceptance:

- `runtime-opencode.test.ts` and `opencode-events.test.ts` cover V2 lifecycle, event translation, root/child reconciliation, partial usage, cancellation, timeout, crash, bounded cleanup, and exactly one terminal event.
- Runtime selection accepts only `opencode` for OpenCode, and exports/paths use the unversioned names. Legacy runtime/config aliases and top-level `subagent_depth` translation are removed.
- Native V2 renderer output passes the pinned CLI's schema. Deployment providers use native `package`/`settings`, the exposed model surface stays limited, utility selection uses `agents.title.model`, and permissions use ordered native actions. Profiles accept only canonical fields/resource directories with no aliases or translation; both agent and command YAML frontmatter strictly reject legacy/mixed fields and invalid native values.
- Generated and profile-added MCP servers preserve explicit boolean `codemode` or native default `true` when omitted. Active generated wrapped MCP grants automatically enable `execute`; agent allow/deny controls wrapper availability, never changes direct-server mode. Management plugins remain disabled.
- The Code Mode bridge preserves unfiltered nested inputs/results through progress and persisted `metadata.rehorCodeMode`. Normalization deduplicates nested evidence, excludes `budgetUnit: "container"` wrappers and failed operations, counts successful nested/native-fetch rows once, and exposes successful nested results to work-context extraction. Batches remain subject to the next-root-model boundary, not atomic per-operation interruption.
- Code Mode raw HTTP fetch authority is tested against network sandbox/egress and `execute` controls, independently of `webfetch`; do not claim a nonexistent `fetch: false` restriction.
- Root/child shell homes and all operational helpers work while private server auth/config/data/DB cannot leak or import ambient credentials. Native JSON/Markdown denies and MCP namespace permissions remain enforced.
- V2 usage tests cover one assistant per step, ID replacement/deduplication, compaction recovery, corrected model attribution, pending/interrupted steps, and bounded incomplete recovery. Positive native costs remain estimates; incomplete runs retain known subtotals without double counting.
- External package plugins have a tested V2 implementation; the runner's local shell plugin alone does not establish that contract.
- Fresh image includes the pinned client/CLI, packaged provider closure, and offline startup checks.

Native Code Mode bridge and configuration tests, including root/child execution and the final native Effect/fiber-identity fix, have passed. Native environment, credential-isolation, and policy/deny checks have also passed; strict native frontmatter validation is implemented. After the earlier external `www.python.org` DNS failure, the full rebuild succeeded and a fresh **unmounted Linux ARM64 production image**, `rehor200:v2-final`, passed the complete image smoke. This verifies the required active policy plugin, Responses/Chat/Vertex rejection and successful read-tool paths, exact step/cumulative usage, persisted outcomes, and the generated Code Mode bridge through the built runtime/coordinator. Two nested MCP successes count separately, a denied nested call never reaches the server, filtered task results reach work context, and the wrapper consumes no budget unit: budget 3 completes and budget 2 stops at the next root model boundary. This is offline local-image evidence; separately published external-plugin and live deployment acceptance remain rollout gates, not established by these checks.

### Deployment acceptance

Canary acceptance criteria:

- One ticket completes from preflight through PR.
- First OpenCode cycle starts without a `workspace ownership mismatch` failure (`REHOR_WORKSPACE_OWNER_UID` configured).
- Jira, GitHub/GitLab, memory, browser, and Slack paths work.
- Tool calls execute with equivalent permissions.
- OpenAI proxy never exposes API key to bot.
- Streaming survives long responses.
- Usage and cost data reaches dashboard.
- No credential-bearing response headers reach bot.
- Merge rate and CI pass rate are not worse than Claude baseline.
- p95 cycle duration does not regress materially.
- Model allowlist rejects unapproved IDs.

### Rollback to the previous Claude image/config

1. Stop promotion. Preserve run/attempt IDs, hashes, sanitized logs, transcript, and usage records for investigation.
2. Restore the **previous known-good Claude image digest and matching instance/config revision**, including its gitlink, instructions/personas, MCP configuration, provider/model, and engine setting. For the Python baseline this means `BOT_EXECUTION_ENGINE=python` (or its previous omitted default), `runtime: claude`, and `provider: vertex`. If the baseline used the coordinator's Claude adapter, restore that exact engine/config instead.
3. Reconcile the deployment/template and obtain a fresh Sandbox from the restored image. Restore deployment overrides too; changing provider alone leaves OpenCode active and is not a runtime rollback.
4. Confirm the first new cycle uses Claude and the prior provider/model, preflights still avoid empty sessions, and status/transcript/cost projections are healthy. Verify no OpenCode child or private state directory remains after cleanup.
5. Retain the failed V2 image/config and gateway configuration for comparison. Do not remove Vertex credentials or the prior Claude image during the rollback window. Onboarding rolls back its image/gitlink/config together; rollback does not require a supported V1 runtime alias.

## Open Questions

- Which OpenAI project owns production keys and spending limits?
- Should proxy authenticate bots with service-account identity, mTLS, or a namespace-scoped token?
- Does selected OpenAI model support required tool-call and vision behavior?
- Is OpenAI data retention policy acceptable for Rehor ticket and source-code data?
- Do regional or organizational restrictions require a different OpenAI endpoint?
- ~~Should proxy support Responses API later, or standardize on Chat Completions first?~~ Served: both `POST /v1/chat/completions` and `POST /v1/responses`.
- Which existing cost fields map reliably to OpenAI usage fields?
- Should a future persistent-volume design support server reuse across cycles?

## References

- [OpenCode SDK](https://opencode.ai/docs/sdk/)
- [OpenCode Server](https://opencode.ai/docs/server/)
- [OpenCode Providers](https://opencode.ai/docs/providers/)
- [OpenCode Configuration](https://opencode.ai/docs/config/)
- [OpenCode Plugins](https://opencode.ai/docs/plugins/)
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode Rules and Claude compatibility](https://opencode.ai/docs/rules/)
- [OpenAI Authentication](https://platform.openai.com/docs/api-reference/authentication)
- [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
- [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses)
- [Git auth proxy design](../git-auth-proxy.md)
- [Current and migration architecture](https://github.com/OpenShift-Fleet/rehor/blob/master/ARCHITECTURE.md)
- [Coordinator runtime contract](https://github.com/OpenShift-Fleet/rehor/blob/master/coordinator/README.md)
- [Custom preflight guide](../presets/custom-preflight.md)

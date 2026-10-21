# OpenCode Migration Design

Migration plan for moving Rehor bot instances from Claude Code plus
`claude-agent-sdk` to OpenCode plus its TypeScript SDK. This design also
covers replacing Vertex-authenticated model traffic with an OpenAI-compatible
proxy backed by direct OpenAI API keys.

Status: Proposed

The initial migration slice is preparation only. It changes no tenant routing
or model selection.

Related Jira: `REHOR-35`, `REHOR-60`, `REHOR-68`, `REHOR-91`, `REHOR-92`,
`REHOR-125`, `REHOR-126`, `REHOR-127`, `REHOR-128`, `REHOR-198`

## Decision Summary

- Start one runner-owned OpenCode server per cycle and close it when the cycle ends.
- Create one workspace-scoped client and session per cycle.
- Never share OpenCode servers across bot instances or cycles.
- Keep model credentials in the proxy deployment, not bot pods or OpenCode auth files.
- Add an OpenAI-compatible proxy endpoint backed by direct OpenAI API keys.
- Keep existing Jira, Git, memory, and browser MCP services separate.
- Keep Python preflights during first migration slice; migrate selected hooks to TypeScript plugins later.
- Deliberately migrate OpenCode profiles to native `AGENTS.md` and `.opencode` resources; retain Claude instruction assembly only for runtime `claude`.

## Current Architecture

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
        V1ServerDriver
          runner-owned child `opencode serve`
          loopback-bound server
          one workspace-scoped client and session per cycle
          SSE events: lifecycle, tool, usage, error
    AGENTS.md / compatible CLAUDE.md
    .opencode/agents, plugins, skills
    MCP: memory, Jira, browser
    HTTP: Rehor model gateway, Git proxy, Squid

central proxy pod
  Rehor model gateway
    Vertex route (legacy/canary)
    OpenAI route (canary/new)
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

The v1 contract intentionally supports current Python behavior:

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

### Runtime-specific budgets (REHOR-198)

Claude and OpenCode use different budget units. Configure them independently in the runner's `config.json`:

```json
{
  "claude": { "maxTurns": 100 },
  "opencode": { "maxToolCalls": 200 }
}
```

This fragment shows budget fields only; retain the other runner settings. `Config.opencode_max_tool_calls` defaults to `200` when `opencode.maxToolCalls` is absent. The JSON value must be a positive integer, not a string, boolean, or fractional number.

`REHOR_OPENCODE_MAX_TOOL_CALLS` overrides the JSON/default value when nonempty. It accepts only ASCII decimal digits with a value greater than zero; leading zeros are accepted. Empty means unset. Signs, whitespace, zero, and other formats fail configuration loading. An override does not bypass validation of the JSON value.

The Python bridge still calls the coordinator field `maxTurns`: it carries the OpenCode tool-call budget only for runtime `opencode-v1`, regardless of provider. Runtime `claude` retains `claude.maxTurns`, whose repository default remains `100`.

| Runtime | Budget unit and enforcement |
|---------|-----------------------------|
| Claude Agent SDK | SDK hard limit on agentic roundtrips via `maxTurns` |
| OpenCode | Coordinator counts successful, unique completed tool calls across the root session and child sessions; failed calls do not count. After exhaustion, it aborts at the next root turn with reason `max_turns`. |

OpenCode's budget is not an exact execution ceiling: child work can continue and overshoot before the next root turn. Legacy displayed `turns` count completed root assistant messages, not budget consumption, so a `max_turns` result with far fewer displayed turns is possible. Thresholds at 75% and 90% emit policy telemetry; OpenCode receives no injected warning notice. Neither a warning nor budget exhaustion guarantees a saved checkpoint.

## OpenCode Server Lifecycle

OpenCode supports runner-owned and client-only modes. The following SDK calls
show the client surface; the production supervisor and adapter live in
`coordinator/src/runtimes/opencode-v1/` and enforce loopback, workspace, version,
configuration-hash, and cleanup checks:

```ts
import { createOpencode } from "@opencode-ai/sdk"

const opencode = await createOpencode({ hostname: "127.0.0.1", port: 4096 })
const client = opencode.client
```

For an already-running server:

```ts
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4096",
})
```

The runner starts one server per cycle as a child process, binds it to loopback,
creates one client with the cycle worktree, and closes the server during cycle
cleanup. A central or persistent shared server is out of scope. OpenCode server
authentication is not a substitute for Rehor task authorization.

## Native TypeScript Runtime Option

[scriptc](https://scriptc.dev/) can compile TypeScript to native executables
that do not require Node, V8, or a JavaScript engine. This is a possible
follow-up optimization for the Rehor runner and standalone preflight tools.

It does not mean the complete OpenCode stack can be compiled immediately:

- The scriptc compiler itself requires Node 24 or newer during image build.
- npm dependencies normally run in scriptc's embedded QuickJS dynamic tier.
- `@opencode-ai/sdk` must pass `scriptc coverage`; static compilation is not assumed.
- OpenCode plugins are loaded and executed by OpenCode's Bun runtime and use Bun's `$` shell API.
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

Initial OpenAI route should support the Chat Completions contract because it is
widely supported by OpenCode's `@ai-sdk/openai-compatible` provider, and the
Responses contract because OpenCode's native `@ai-sdk/openai` provider (default
for reasoning models) sends `POST /v1/responses`:

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

Example bot-side `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "rehor-openai": {
      "npm": "@ai-sdk/openai",
      "name": "Rehor OpenAI Responses",
      "options": {
        "baseURL": "{env:REHOR_MODEL_PROXY_URL}",
        "apiKey": "{env:REHOR_MODEL_PROXY_TOKEN}"
      },
      "models": {
        "gpt-6-luna": { "name": "GPT-6 Luna", "reasoning": true }
      }
    },
    "rehor-openai-chat": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Rehor OpenAI Chat Completions",
      "options": {
        "baseURL": "{env:REHOR_MODEL_PROXY_URL}",
        "apiKey": "{env:REHOR_MODEL_PROXY_TOKEN}"
      },
      "models": {
        "gpt-4.1": { "name": "GPT-4.1" },
        "gpt-4.1-mini": { "name": "GPT-4.1 Mini" },
        "gpt-4o": {
          "name": "GPT-4o",
          "reasoning": false,
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    },
    "vertex": {
      "name": "Claude on Vertex via Rehor proxy",
      "options": {
        "baseURL": "{env:REHOR_VERTEX_PROXY_URL}"
      },
      "models": {
        "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" },
        "claude-opus-4-6": { "name": "Claude Opus 4.6" },
        "claude-haiku-4-5@20251001": { "name": "Claude Haiku 4.5" }
      }
    }
  },
  "model": "rehor-openai/gpt-6-luna",
  "enabled_providers": ["rehor-openai"],
  "share": "disabled"
}
```

GPT-6 Luna uses the native Responses route. OpenCode's `rehor-openai-chat`
route retains Chat Completions for compatible models. GPT-4o's explicit output
limit prevents OpenCode from requesting more than its 16384-token maximum.
Runtime-generated config uses bare `@ai-sdk/openai` and
`@ai-sdk/openai-compatible` references: OpenCode 1.18.29 looks up bundled
adapters by exact npm name, and version suffixes trigger dynamic installation
instead. These two adapters use versions bundled in the pinned OpenCode binary.
The `4.0.73` and `3.0.54` package declarations remain build metadata, not runtime
overrides of bundled versions; explicit requested versions must match those
declarations. External provider packages and all plugins remain exact-pinned.
The Vertex adapter is a coordinator-bundled file provider backed by the exact
`@ai-sdk/google-vertex` dependency in the runner image.

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
title-generation requests.

### [REHOR-144](https://issues.redhat.com/browse/REHOR-144) renderer contract

The coordinator's `runtimes/opencode-v1/render.ts` owns the translation from
provider-neutral cycle data to this OpenCode V1 subset. The runtime factory
receives the Python preparation through the `preparedConfig` option on
`executeSelectedRun()` and calls `renderOpenCodeV1ConfigForCycle()` with the
prepared model, allowed tools, optional servers, and `openCodeMcpServers` data.
Deployment-owned
provider/plugin fields remain separate. `mcpServers` and `openCodeMcpServers` are mandatory,
separate bridge views; an absent OpenCode view is a protocol error, never a
fallback to resolved Claude values. The renderer:

- normalizes bare models with the deployment provider ID;
- maps stdio MCP to `local` and HTTP/SSE MCP to `remote`;
- converts Claude-style allowed tools to explicit OpenCode permissions,
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
  OpenAI adapters use bundled npm names and Vertex uses a coordinator-owned
  file provider;
- emits stable JSON, a content hash, and
  `opencode-packages.lock.json` containing exact provider/plugin build
  declarations, without overriding the binary's bundled provider versions.

The runtime factory renders one immutable snapshot for the selected run and
validates it before constructing the supervisor. `OpenCodeV1Runtime` derives
prompt submission and Rehor event attribution from that same effective
provider/model. The supervisor receives the snapshot in its constructor and
writes Rehor defaults/resources under isolated `XDG_CONFIG_HOME`, writes profile
settings to a separate `OPENCODE_CONFIG` file, and supplies runner-owned
`OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION` top-level overrides.
OpenCode applies `OPENCODE_PERMISSION` after config loading and tool conversion. Native agent permissions can override general defaults, but the runner's config hook clamps agent external-directory grants to the deployment boundary described below.
It isolates OpenCode's instruction-discovery home and database paths, then enables offline npm
resolution plus the pinned runtime's update/download safeguards. The pinned
`1.18.29` release is a tested dependency: its
`OPENCODE_TEST_HOME` behavior is required for per-cycle instruction isolation. A
version bump must update the supervisor contract tests before the pin changes.
Package installation is not a runtime responsibility: the image
must pre-bake the lockfile closure as part of [REHOR-142](https://issues.redhat.com/browse/REHOR-142).
The default Claude runtime registry and production runtime selection remain
unchanged. Instance configuration now carries independent `runtime` and
`provider` values through the Python bridge as `runtimeId` and `providerId`;
`executeConfiguredRun()` consumes that normalized selection when the future
TypeScript runner is enabled. See the [canary rollout runbook](../operations/rehor-146-opencode-canary.md).

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
(`@ai-sdk/openai-compatible` → Chat Completions, `@ai-sdk/openai` → Responses).
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

### Preparation: Runtime Contract

- Define versioned `RehorRun` and `RehorEvent` schemas.
- Validate the same schemas at runtime and in fixture tests.
- Enforce event identity, sequence, attribution, terminal, and usage invariants.
- Protect the package with Node 22/Vitest tests, typecheck, a Vite Node bundle
  with declaration emit, npm audit, and CI.
- Keep production on `bot/run.py` and `bot/agent.py` until an adapter and
  coordinator loop pass parity tests.

### Phase 1: Compatibility Canary

- Add OpenCode runtime and TypeScript runner beside Python runner.
- Start one OpenCode server per cycle as a runner-owned child process.
- Reuse current MCP endpoints and Git auth proxy.
- Deliberately migrate selected profiles to native `AGENTS.md`, OpenCode agents, and `.opencode/skills` before enabling OpenCode; retain built-in project discovery compatibility.
- Keep Python preflight scripts unchanged.
- Route model calls through OpenAI-compatible proxy.
- Run one low-risk instance with all other instances unchanged.

### Phase 2: Runner Port

Replace `claude-agent-sdk` usage in `bot/agent.py` with SDK operations:

- create or connect to server
- create session per cycle
- submit prompt
- subscribe to SSE events
- collect assistant text, tool calls, errors, and usage
- abort session on timeout or shutdown
- close server during cycle cleanup and process termination

Project normalized terminal and usage events back into the current
`CycleContext`, status updates, transcript storage, cost posting, turn limits,
and signal handling contracts. During canary, compare these projections with
the Python records for the same fixture scenarios.

### Phase 3: Config and Persona Port

- Add `opencode.json` generation to instance config.
- Map workflow model defaults to `provider/model` IDs.
- Map persona prompts to OpenCode agents or `instructions` files.
- Provide native profile `AGENTS.md` and `.opencode` resources; do not fall back to generated Claude guidance during rollout.
- Map allowed tools to OpenCode `permission` rules.
- Disable session sharing for bot instances.

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
    ├── modes/                 # custom modes
    ├── plugins/               # trusted, GitOps-managed local plugins
    ├── rules/                 # instruction files referenced by opencode.json
    ├── skills/                # agent skills
    ├── themes/                # themes
    └── tools/                 # custom tools
```

Example `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "reviewer": {
      "description": "Reviews changes",
      "mode": "subagent",
      "permission": { "bash": "deny" }
    }
  },
  "plugin": ["opencode-rehor-plugin@2.3.4"]
}
```

The sample npm plugin is accepted only when the deployment package list pins
that exact package and version.

Supported `opencode.json` fields: `agent`, `command`, `compaction`,
`default_agent`, `disabled_providers`, `formatter`, `instructions`, `mcp`,
`permission`, `plugin`, `snapshot`, `subagent_depth`, `tools`, and `watcher`.
Unknown or coordinator-controlled fields fail configuration validation.

The coordinator validates profile settings, then stages `agent/opencode.json`
as distinct `OPENCODE_CONFIG` source. It stages `.opencode` assets under native
`$XDG_CONFIG_HOME/opencode/{agents,commands,instructions,modes,plugins,rules,skills,themes,tools}`
paths. The profile JSON is not copied into `OPENCODE_CONFIG_DIR`: OpenCode 1.18.29
loads that custom directory after project config, which would give profile
resources higher priority than checked-out project resources. With isolated
`XDG_CONFIG_HOME`, global profile assets load before project `.opencode` assets.

Native config order used by the runner is deployment global config and profile resources, the
profile `OPENCODE_CONFIG` file, checked-out project `opencode.json`, then
runner-owned `OPENCODE_CONFIG_CONTENT` overrides. `OPENCODE_PERMISSION`
reapplies top-level tool permission defaults after native config sources and tool
conversion; native agent permissions generally take precedence, subject to the runner's external-directory clamp. OpenCode 1.18.29 also
supports `OPENCODE_CONFIG_DIR` between project config and inline content; the
runner leaves it unset to preserve project-over-profile resource precedence.
Plugin arrays append across config sources. The inline layer is constructed by
the runner, never inherited, and pins selected model/provider, generated MCP
endpoints, share/autoupdate/LSP settings, and top-level tool/permission defaults.
On Linux, `/etc/opencode/opencode.json` loads above inline content. Because it
could override runner policy, the supervisor refuses to start when that managed
file exists.

GitOps profiles are trusted, deliberate user configuration. Plugins, tools, and
formatters can execute arbitrary code in the server; permission defaults are not
a sandbox against that code or native agent configuration. OpenCode owns agent
and command schema, models, permissions, and frontmatter. Native agent permissions,
including checked-out project agents, can override general top-level defaults; external-directory grants are clamped as described below. Top-level
model/provider selection remains coordinator-controlled; profile `permission` may
only add denials and top-level `tools` may only disable tools. MCP additions cannot
replace generated servers and retain URL, credential, and environment checks.
Profile-added MCP tools follow native default-allow behavior; generated servers
retain their baseline allowlist. NPM plugins require exact deployment-declared
versions for reproducibility and the pre-baked offline closure, not code isolation.
Local `.opencode/plugins` files are staged directly.

Cycle preparation requires `presets/core/AGENTS.md`, then loads optional shared
`agent/AGENTS.md` and the selected built-in or `./` custom workflow's `AGENTS.md`.
These remain distinct text resources under isolated global
`instructions/rehor/{core,shared,workflow}.md`; native `instructions` references
precede existing profile instruction references in core → shared → workflow order.
Those three generated paths are reserved; profile collisions fail preparation.
Shared and custom workflow guidance with only `CLAUDE.md` fails preparation with
an actionable `AGENTS.md` migration error; instructions-free optional directories
remain allowed. OpenCode never reads legacy aliases or applies Claude strategies.

Profile `AGENTS.md` is staged directly as isolated global
`$XDG_CONFIG_HOME/opencode/AGENTS.md`, without renaming or injected instruction
entries. Project `AGENTS.md`/`CLAUDE.md` stay untouched and retain native discovery
precedence. Preparation captures bot guidance, profile settings, and files once; deterministic
hashes cover that native snapshot for instruction/config provenance, and the same
snapshot is required by the runtime factory. These hashes do not claim to represent assembled
Claude content or OpenCode's later project discovery.
Coordinator rejects symlinks and paths escaping selected profile. Missing
profile `AGENTS.md`, `opencode.json`, or `.opencode/` is normal. XDG config, database, and
instruction-discovery home stay isolated per cycle. Shell `HOME` and XDG data/cache/
state remain persistent. A runner-owned local `shell.env` plugin restores original
`XDG_CONFIG_HOME` for shell commands (unset becomes empty, using `$HOME/.config`),
while OpenCode global config stays isolated. Runner-owned `OPENCODE_AUTH_CONTENT='{}'` bypasses ambient
saved credentials. Provider API keys still resolve from validated environment references.

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

Each entry must be a literal, canonical absolute POSIX path other than `/`. Wildcards, traversal, noncanonical separators, backslashes, control/format characters, environment/file references, and leading/trailing whitespace in path segments are rejected. Paths need not exist yet. The renderer sorts and deduplicates them, then emits `external_directory` rules denying `*` and allowing each `root/*`. OpenCode `1.18.29` external-directory checks request `directory/*`, so `root/*` covers requests for the root directory itself as well as descendants; a separate exact-root rule is unnecessary. Other external paths remain denied by this policy.

The runner-owned config hook runs after native JSON/Markdown agent loading. It intersects every matching agent `allow`, `ask`, and `deny` rule with the approved roots, preserving native last-match ordering across permission-name wildcards and nested path rules. For example, `"*": "deny"` followed by an approved-path `allow` retains that exception; a later broad `allow` overrides an earlier narrow `ask` or `deny` only inside approved roots. Reversing those rules makes the later restriction win. `ask` remains a native permission request; the headless runner fails rather than automatically approving it. Requests outside approved roots remain denied regardless of agent grants. The explicit `external_directory` result is placed after all other permission keys so tool-name wildcard grants cannot widen the boundary. Native profile JSON staging and configuration hashing preserve permission-key order as well. Supplemental grants do not relax native read restrictions on credential-shaped paths or change other tool permissions.

This is OpenCode permission configuration, not a filesystem or Bash sandbox. It does not constrain arbitrary code from plugins, custom tools, or shell commands. OpenCode `1.18.29` also appends its own internal tool-output-directory allowance after agent merging; the hook preserves that native behavior. OpenShell policy, mounts, Unix permissions, and network isolation are separate controls; these grants neither create mounts nor establish a controller upgrade requirement. See [OpenShell deployment and rollout](../openshell-deployment.md#opencode-budget-and-workspace-rollout-rehor-198).

Offline mock-provider checks against pinned OpenCode `1.18.29` exercised nonexistent nested create/read, Bash at an approved root, and scoped child-agent access. Follow-up checks verified JSON/Markdown deny-except rules, the native explore permission shape, ordered permission-name/path wildcards, native string/object `ask` requests, and later broad grants overriding earlier restrictions only inside approved roots. Sibling paths, `/`, the synthetic instruction-discovery home, explicit per-agent denied paths, and credential-shaped reads remained denied through the tested native permission paths. This verifies runtime behavior without paid inference; live deployment smoke testing remains required.

### Phase 4: Plugin Port

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

### Phase 5: Model Tiering

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

The coordinator bundles a generated, minimal pricing registry in
`coordinator/src/runtimes/opencode-v1/pricing.json`. Its source is the **baked
OpenCode 1.18.35 models.dev catalog**, independent of the **1.18.29 execution
runtime**. The older runtime snapshot lacks the exact Sol/Luna IDs. The registry
records the source version, upstream reference, binary SHA-256 and a canonical
pricing-content SHA-256. No catalog is downloaded at runtime, and instances do
not maintain their own prices.

To regenerate, obtain the official pinned OpenCode 1.18.35 executable for your
platform, then run from the repository root:

```bash
python3 coordinator/scripts/opencode-pricing.py /path/to/opencode-1.18.35 > /tmp/opencode-pricing.json
diff -u coordinator/src/runtimes/opencode-v1/pricing.json /tmp/opencode-pricing.json
```

Review the generated model/rate changes and replace the registry with the reviewed
output. Formatting differences are harmless; the content hash is independent of
JSON whitespace. The binary hash is platform-specific. To add a supported model,
extend the script's explicit model list and regenerate; do not type rates into
instance configuration. The script runs only `--version` and `models --verbose
--pure`, with empty temporary HOME/XDG directories, no inherited credentials,
model fetching disabled, and no provider model overlays. It never runs inference.

Pricing aliases are centralized in `pricing.ts`: `rehor-openai` and
`rehor-openai-chat` use canonical `openai` rates; `vertex` uses
`google-vertex-anthropic`, with `claude-opus-4-6@default`,
`claude-sonnet-4-6@default`, and exact dated `claude-haiku-4-5@20251001` entries.
Bare `claude-haiku-4-5` maps to that dated Vertex Haiku entry.
These are pricing aliases only; API/proxy model IDs remain unchanged. No
direct-Anthropic substitution or model-family guessing occurs.

The normalizer retains each `step-finish` by session/message/part identity and
replaces duplicate or reconciled records. Steps supersede assistant token
summaries: native assistant cost accumulates across steps, while assistant tokens
describe only the last step. Reconciliation determines the root outcome from root
messages and status before fetching known children in parallel within the remaining
deadline. Unavailable children cannot discard root outcomes or valid usage. Seen
messages and steps refresh usage without replaying errors or lifecycle events. Snapshots
are cumulative per provider-qualified model, so root/child usage and different
providers cannot overwrite each other in the legacy projection.
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
legacy `experimentalOver200K` applies only when explicit tiers are absent. This
deliberately avoids the native V1 fallback that can incorrectly charge 272K-tier
OpenAI models at elevated rates between 200K and 272K. Cache duration-specific,
discounted, regional and negotiated billing is not inferred from token counts.

Positive native costs retain precedence, including an interrupted assistant's
cumulative native cost; incomplete messages remain marked incomplete. This
precedence is intentional even for builtin providers: a positive OpenCode-reported
amount can retain the native 1.18.29 tier bug. Corrected tier selection applies to
catalog-backed estimates, not a silent replacement of positive native reports.
The `provider` status means runtime-reported cost, not independently verified
invoice billing. Native zero alone is not proof of free
usage: known models receive catalog estimates, and unpriced models remain
unknown. Missing step evidence is marked incomplete; known subtotal amounts can
coexist with unpriced usage. Local `costs.jsonl` and `/api/costs` carry optional
`cost_status` (`provider`, `estimated`, `unknown`) and `cost_incomplete`. The
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
REHOR_TEST_OPENCODE_BINARY=/path/to/opencode-1.18.29 npm --prefix coordinator test -- test/opencode-pricing-native.test.ts
```

The opt-in smoke uses isolated native processes and credential-free loopback
Chat Completions, Luna Responses, and Vertex Anthropic Messages mocks. It uses
the built coordinator renderer and real packaged Vertex adapter (mock bound to
`127.0.0.1:8443`, which must be free). It verifies native zero-cost custom-provider
output, normalized cache/reasoning counts including Vertex cache writes, proxy
request path/placeholder authorization, and the coordinator normalizer estimate. Live proxy
billing remains a separate deployment validation.

## Validation and Rollback

Canary acceptance criteria:

- One ticket completes from preflight through PR.
- Jira, GitHub/GitLab, memory, browser, and Slack paths work.
- Tool calls execute with equivalent permissions.
- OpenAI proxy never exposes API key to bot.
- Streaming survives long responses.
- Usage and cost data reaches dashboard.
- No credential-bearing response headers reach bot.
- Merge rate and CI pass rate are not worse than Claude baseline.
- p95 cycle duration does not regress materially.
- Model allowlist rejects unapproved IDs.

Rollback:

1. Switch instance model config back to Vertex provider.
2. Restart affected bot deployment.
3. Leave OpenAI proxy and key intact for investigation.
4. Compare OpenCode transcript, proxy metrics, and Claude baseline.
5. Remove OpenCode runtime only after root cause is known.

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

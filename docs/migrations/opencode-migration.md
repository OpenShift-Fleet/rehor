# OpenCode Migration Design

Migration plan for moving Rehor bot instances from Claude Code plus
`claude-agent-sdk` to OpenCode plus its TypeScript SDK. This design also
covers replacing Vertex-authenticated model traffic with an OpenAI-compatible
proxy backed by direct OpenAI API keys.

Status: Proposed

The initial migration slice is preparation only. It changes no tenant routing
or model selection.

Related Jira: `REHOR-35`, `REHOR-60`, `REHOR-68`, `REHOR-91`, `REHOR-92`,
`REHOR-125`, `REHOR-126`, `REHOR-127`, `REHOR-128`

## Decision Summary

- Start one runner-owned OpenCode server per cycle and close it when the cycle ends.
- Create one workspace-scoped client and session per cycle.
- Never share OpenCode servers across bot instances or cycles.
- Keep model credentials in the proxy deployment, not bot pods or OpenCode auth files.
- Add an OpenAI-compatible proxy endpoint backed by direct OpenAI API keys.
- Keep existing Jira, Git, memory, and browser MCP services separate.
- Keep Python preflights during first migration slice; migrate selected hooks to TypeScript plugins later.
- Preserve `CLAUDE.md` and `.claude/skills` compatibility during canary migration.

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

## OpenCode Server Lifecycle

OpenCode supports runner-owned and client-only modes. The following is an API
shape example, not production supervisor code:

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
  → proxy authenticates bot request
  → proxy validates provider/model
  → proxy adds Authorization: Bearer <OpenAI key>
  → https://api.openai.com/v1/chat/completions
  → streaming response back to OpenCode
```

The bot must not receive `OPENAI_API_KEY`. The OpenCode provider config should
use a bot-to-proxy credential or network policy as its authentication boundary.
If a credential is required, use a separate short-lived proxy token, not the
OpenAI key.

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
widely supported by OpenCode's `@ai-sdk/openai-compatible` provider:

- `POST /v1/chat/completions`
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
      "npm": "@ai-sdk/openai-compatible",
      "name": "Rehor OpenAI Proxy",
      "options": {
        "baseURL": "http://devbot-proxy:8450/v1",
        "apiKey": "{env:REHOR_MODEL_PROXY_TOKEN}"
      },
      "models": {
        "gpt-5.4": { "name": "GPT-5.4" },
        "gpt-5.4-mini": { "name": "GPT-5.4 Mini" },
        "gpt-5.4-nano": { "name": "GPT-5.4 Nano" }
      }
    }
  },
  "model": "rehor-openai/gpt-5.4",
  "small_model": "rehor-openai/gpt-5.4-nano",
  "enabled_providers": ["rehor-openai"],
  "share": "disabled"
}
```

Exact model IDs remain deployment configuration. Do not hardcode model names
until OpenAI account access, pricing, tool support, and regional requirements
are confirmed.

Provider selection remains independent from runtime selection. During canary,
OpenCode may select either the existing Vertex route or the OpenAI Chat
Completions route. If a selected model requires OpenAI Responses API semantics,
use OpenCode's native `@ai-sdk/openai` provider and add a separately tested
Responses route; do not translate request schemas inside header injection.

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
- `REHOR_MODEL_PROXY_TOKEN` for bot-to-proxy authentication, if required.
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

### Phase 1: Compatibility Canary

- Add OpenCode runtime and TypeScript runner beside Python runner.
- Start one OpenCode server per cycle as a runner-owned child process.
- Reuse current MCP endpoints and Git auth proxy.
- Reuse current `CLAUDE.md`, personas, and `.claude/skills`.
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

Preserve current `CycleContext`, status updates, transcript storage, cost
posting, turn limits, and signal handling.

### Phase 3: Config and Persona Port

- Add `opencode.json` generation to instance config.
- Map workflow model defaults to `provider/model` IDs.
- Map persona prompts to OpenCode agents or `instructions` files.
- Generate `AGENTS.md` over time; keep `CLAUDE.md` fallback during rollout.
- Map allowed tools to OpenCode `permission` rules.
- Disable session sharing for bot instances.

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
- Should proxy support Responses API later, or standardize on Chat Completions first?
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
- [Current architecture](https://github.com/OpenShift-Fleet/rehor/blob/master/ARCHITECTURE.md)
- [Custom preflight guide](../presets/custom-preflight.md)

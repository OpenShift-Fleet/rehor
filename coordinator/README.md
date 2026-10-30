# Rehor Coordinator

`coordinator/` is the provider-neutral control-plane boundary for Rehor agent
cycles. It will let the runner select an agent runtime (initially the existing
Claude path or OpenCode), apply one lifecycle policy, and project normalized
events into status, transcript, usage, and cost records.

The coordinator now has a production-capable entry point, but it is opt-in.
`bot/run.py` remains the default engine and rollback path. Set
`BOT_EXECUTION_ENGINE=coordinator` only after the image contains the coordinator
bundle, OpenCode executable, provider package closure, and compatibility
endpoints. Invalid runtime/provider selections fail closed.

## Logging

The coordinator CLI writes JSON lines to stdout and `dataDirectory/bot.log`.
Records use the Python logging keys `timestamp`, `level`, `logger`, `message`,
`run_id`, `task_key`, `model`, and `cost`; attempt logs also carry `attempt_id`.
Run context is async-scoped and retained when reporting a failed attempt.
Lifecycle logs cover configuration, preflight decisions, runtime selection,
run terminal state, cleanup, sleep, and shutdown. Task and cost remain null
when unavailable; model/tool events and transcripts are not copied to logs.

Set `DEBUG=true` (exactly) for DEBUG verbosity. `BOT_LOG_FILE` can select a
relative or absolute path inside the configured data directory; traversal and
symlink escapes are rejected. Files use mode `0600`, rotate at 10 MiB, and keep
five backups. Each string is capped at 8 KiB after environment-secret and
credential-pattern redaction. Error stacks and causal chains are bounded and
cycle-safe; arbitrary error properties are never serialized.
Runtime sink writes are best effort: file failures do not prevent stdout emission,
and file/stdout failures cannot fail a run or cleanup. A bounded, redacted JSON
warning goes directly to stderr once per continuous sink outage; stderr failure
is swallowed without recursion. Invalid logging configuration still fails during
initialization.

OpenCode runs with `--print-logs --log-level=info` (`debug` only with `DEBUG=true`).
Both streams remain drained after readiness. Only fixed diagnostic categories
(provider initialization, missing package, offline cache, dependency installation, network, auth, timeout,
and configuration failures) and known package identifiers enter the retained
2 KiB safe tail or logs. Provider messages and causal metadata are classified,
not echoed; exception logs retain source locations without provider messages.
This deliberately loses unknown error wording, prompts, tool arguments, HTTP
bodies, and headers. OpenCode emits at most 64 diagnostic records per server;
the safe tail continues updating afterward, including on crashes.
Runner-owned workspace ownership failures log the canonical path and numeric
actual/expected UIDs before spawning; runtime summaries retain a recognizable
ownership-mismatch category.
These logging safeguards do not change persisted runtime error events, which
retain their existing redacted provider-message behavior.

Python bridge logging is configured on stderr only. Successful stderr is drained
and surfaced with severity, operation, and source. Valid records from explicitly
allowed Python preparation/maintenance modules retain their redacted, capped
message and original severity/logger; extra fields (including requests, bodies,
tool payloads, and exception dumps) are omitted. Non-JSON, unknown-source, and
malformed records use safe diagnostic classification instead. Pending lines are bounded to 16 KiB, oversized
lines are discarded, and each bridge request emits at most 32 diagnostics plus
a suppression count. JSON protocol stdout remains separate. Legacy Python
runner logging setup is unchanged. Library callers are silent by default and
can inject `Logger` from `src/log.ts`; the CLI owns the rotating sink.

## Responsibilities

The coordinator owns:

- stable run identity and attempt identity;
- assembled prompt, workspace snapshot, provider choice, and limits;
- timeout and shutdown signals passed through `AbortSignal` during startup and streaming;
- validation, ordering, deduplication, and attribution of normalized events;
- one required terminal outcome per attempt;
- provider-neutral usage, result, and work-context data for existing Rehor
  persistence and metrics.

Runtime adapters own SDK-specific server/session setup, event translation, and
cleanup. Provider SDK objects must not cross `AgentRuntime`; raw provider data
may only be retained behind a redacted `rawEventRef`.

`ClaudeAgentRuntime` is the compatibility adapter for the current TypeScript
Claude Agent SDK path. It loads project instructions, forwards configured MCP
servers, tools, and permission policy, streams normalized model and tool events,
preserves partial and final usage, and closes the SDK query on completion,
abort, timeout, or runtime shutdown.

Adapters should use `createEventFactory(run, policyVersion)` to stamp the
self-describing event envelope. The factory owns run, attempt, workspace,
provider, sequence, and timestamp fields while allowing legitimate per-event
model drift and parent/session references.

## Contract

`RehorRun` is the complete command for one independently attributable model
attempt. A task is nullable because current triage cycles begin before the
agent selects or creates a task. `prompt` contains the same fully assembled,
dynamic prompt currently passed to `claude_agent_sdk.query()`, including
preflight content when present.

`AgentRuntime` has three operations:

1. `start(signal)` starts the runtime and reports capabilities.
2. `run(run, signal)` streams Rehor-owned events for one attempt.
3. `stop()` releases runtime resources and is idempotent.

A valid event stream has these invariants:

- event IDs are idempotent; semantically equal JSON is accepted once;
- sequence numbers are unique, while gaps and out-of-order delivery remain
  observable;
- events are self-describing persistence units: run, attempt, workspace
  snapshot, provider, model, and policy attribution travel in each event;
- the usage payload does not repeat its enclosing event's attempt or provider;
- run, attempt, workspace snapshot, and provider attribution match the run;
- terminal events contain one recognized state;
- usage events contain normalized token and cost data;
- exactly one terminal event is accepted and no new event may follow it.

JSON Schemas in `schema/` are the wire contract. Runtime parsers compile those
same schemas with Ajv, so `additionalProperties`, timestamp formats, and known
payload shapes cannot drift from TypeScript validation.

## Attempt orchestration

`executeRun()` owns one runtime attempt. It validates the run, starts the
selected `AgentRuntime`, ingests accepted events into an in-memory ledger, and
stops the runtime exactly once. Runtime failures produce a normalized failed
terminal event after preserving all accepted partial events. The coordinator
owns run timeouts and the per-cycle-run USD cost budget. It observes usage
events and emits cost-budget policy notices at 50% (`info`), 75% (`warning`),
90% (`critical`), and 100% (`exhausted`) of `limits.budgetUsd`, each once. The
exhausted notice opens a grace window — the run may continue so the agent can
save state via `task_update` — until spend reaches 115% of the budget, where
the coordinator aborts with `failed/budget_exceeded`. When usage reports
affirmatively unknown pricing (`cost.source === "unknown"`) and no known cost
has been seen, the budget fails open with a one-time warning policy event and
the cycle timeout remains the only backstop. Policy notices reach the agent
through the runtime: the Claude adapter flushes them as `PostToolUse` hook
system messages, and the OpenCode adapter prompts the root session (the
OpenCode server queues prompts sent while the session is busy). Typed abort
causes map to terminal states: shutdown to `interrupted`, caller cancellation
to `cancelled`, timeout to `timed_out`, and failed policy aborts to `failed`.
Runtime adapters report only `completed` or `failed` terminals and do not
enforce any turn or tool-call budget. `WorkContextTracker` derives
terminal task context and no-work state from normalized tool and result events
before projection.
Projection hooks receive normalized events for the existing status, transcript,
usage, and cost writers; they do not receive provider SDK objects.

Every production adapter emits `run` `{ state: "started" }` first, before any
setup that can fail, and exactly one terminal event last. A completed terminal
is never paired with an `error` event: if releasing an OpenCode session fails
after the session completed, the adapter reports it as a `cleanup` event
(`{ state: "failed", message, resourceLeak? }`) and the attempt stays
`completed`. When a Claude run ends without a result message, its partial usage
is the sum of every API response seen so far, not only the last one.

`LegacyCompatibilityProjection` is the first compatibility mapping. It writes
through transport-neutral ports for cycle runs, status, costs, transcript
(events), and metrics. It preserves the current result fields, classifies
`NO_WORK_FOUND` as idle, and prefers final usage snapshots over earlier partial
snapshots so token/cost totals are not double-counted. File, HTTP, and
Prometheus implementations can be supplied without changing coordinator code.

The coordinator does not write a new event store and does not change the
Python Claude/Vertex path. `src/runner.ts` is the production wiring layer; it
uses the same preparation boundary and compatibility projection without
changing the normalized contract.

## Runtime selection

`RuntimeFactoryRegistry` resolves a `RuntimeSelection.runtimeId` to an
`AgentRuntimeFactory`. Runtime selection is intentionally separate from
`RehorRun.provider`: one runtime can support multiple providers, and provider
selection can change without changing lifecycle orchestration.

Factories receive only a normalized `RehorRun` and return an `AgentRuntime`.
Provider SDK clients, server processes, and sessions remain private to the
adapter. `executeSelectedRun()` feeds an explicitly selected adapter into the existing
`executeRun()` lifecycle. `executeConfiguredRun()` resolves the adapter from
`RehorRun.runtimeId`, which is the normalized per-instance selection. Both
paths preserve event validation, projection, timeout, and cleanup behavior.

`createDefaultRuntimeRegistry()` registers the Claude Agent SDK adapter under
runtime ID `claude` and remains the production default. Its options are
Claude-specific; the reference-preserving `ConfigPreparationResult` is not
passed directly to it because the legacy Python runner still owns resolved
MCP credentials.

OpenCode is registered by the coordinator production runner only; the default
registry exported for library callers still contains Claude alone. The runner
copies the prepared cycle view into OpenCode runtime options while keeping
deployment-owned provider/plugin fields separate. The OpenCode factory renders
its MCP, tool, optional-server, and model inputs:

```ts
const prepared = await prepareCycleInput(bridge, cycleOptions);
const registry = new RuntimeFactoryRegistry([
  createOpenCodeRuntimeFactory({
    config: deploymentOpenCodeConfig,
  }),
]);
const runForInstance = {
  ...run,
  runtimeId: prepared.config.runtimeId,
  provider: { ...run.provider, id: prepared.config.providerId },
};
const result = await executeSelectedRun(
  registry,
  { runtimeId: runForInstance.runtimeId ?? "claude" },
  runForInstance,
  { preparedConfig: prepared.config, nativeConfig: prepared.nativeConfig },
);
```

`renderOpenCodeConfigForCycle()` is the lower-level equivalent for callers
that need the deterministic artifact before constructing a runtime. It consumes
the reference-only `openCodeMcpServers` view from preparation. The bridge's
`optionalMcpServers` list is explicit: missing grants for those persona-specific
servers are omitted, while a missing MCP server referenced by any other grant
fails configuration validation. MCP environment references are fail-closed:
only the non-secret `JIRA_MCP_URL` endpoint may be used in a remote URL; MCP
headers and local MCP environments cannot reference the OpenCode child
environment, and MCP references are never added to the agent passthrough list.
Malformed `{env:...}` and `${...}` references are rejected in provider/plugin
strings and MCP headers/environment values, including non-secret fields.
Provider and model names reject blocked/coordinator-controlled variables but
otherwise remain literal and are not added to the agent passthrough list.
The factory requires the prepared `nativeConfig` snapshot, then renders it for the selected run. `OpenCodeRuntime`
uses that snapshot for attribution, while `OpenCodeServerSupervisor` receives the
same snapshot in its constructor and writes it through `writeOpenCodeConfig()`;
OpenCode then applies native project configuration and agent precedence. `OpenCodeRuntime` validates
the rendered snapshot before its supervisor starts a child. External provider and
plugin packages require exact pins; the native OpenAI runtimes need no package
declarations. `ConfigPreparationResult` requires separate `mcpServers` and
`openCodeMcpServers` fields; the coordinator rejects an older response instead
of silently substituting resolved Claude MCP values into OpenCode. The
supervisor pins `@opencode/cli@2.1.2` and the adapter uses `@opencode/client@2.1.2`.
The only OpenCode runtime ID is `opencode`; versioned runtime IDs and legacy
aliases are unsupported. Implementation lives in `src/runtimes/opencode/`, with
`OpenCodeRuntime` and `RenderedOpenCodeConfig` as its runtime/config boundaries.
Each cycle owns an authenticated loopback child (`opencode serve --stdio`),
private config/data homes and database, and isolated instruction discovery.
Private data home prevents V2 from importing ambient saved credentials into its
new database. The password is per process and must not reach shell helpers.
The runner's native V2 Effect plugin uses an Effect-returning `ctx.shell.hook("create.before", ...)` to
restore original shell `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, including absence
and empty values; shell HOME and persistent caches/state remain available.
A version bump requires refreshing lifecycle, credential, and native environment
checks before changing the pin. The Python runner
remains the default production entry point until `BOT_EXECUTION_ENGINE=coordinator`
is enabled for a canary.

GitOps profiles are trusted user configuration: plugins, tools, and formatters can execute arbitrary code in the server. Runner-owned global native V2 policies impose the external-directory ceiling above project policies and agent permissions. Native agent rules retain restrictions inside that ceiling. Generated MCP grants remain explicit, with native Code Mode and direct exposure both supported. Package pins support reproducibility and the pre-baked offline closure, not sandboxing trusted code. External package plugins need V2 implementations; a V1 hook export is not compatible merely because its version is pinned. See the [migration contract and operational steps](../docs/migrations/opencode-migration.md).

Deployment `providers` entries use `id`, `package`, `name`, `settings`, and `models`.
Supported model fields are `name`, `modelID`, `limit`, `settings`, and `capabilities`;
reasoning is `capabilities.reasoning: { supported: true }`, not a top-level boolean.
The renderer emits a native `providers` map, `agents.title.model` for the utility
model, `mcp.servers` with structured startup/catalog/execution timeouts, and ordered
`permissions` rules. Prepared `Bash`, `Task`, and `Edit`/`Write` grants become native
`shell`, `subagent`, and `edit` actions. Global policies restrict provider use and
external directories. Central `mcpServers.<server>.codemode` and native
`mcp.servers.<server>.codemode` accept optional booleans. Omission preserves native
default `true`; `false` exposes direct tools. Allowed active generated wrapped MCP
grants automatically enable `execute`. Native agent `permissions` can deny `execute`
to hide the wrapper and its wrapped tools, or allow it when general permissions
deny it. Agent permissions cannot turn a direct server into a wrapped server.
Legacy deployment/profile fields are rejected.

The generated runner plugin exports `effect: (ctx) => Effect.gen(...)` and imports
`Cause`, `Effect`, `Exit`, `Semaphore`, and `Stream` from the host-supplied `effect`
runtime; it is not a Promise or dependency-free plugin. External V2 plugins may use
either native Effect or supported Promise `setup(ctx)` APIs.

The runner-owned `ctx.tool` plugin bridge captures unique nested calls and their
unfiltered inputs/results in progress and persisted `metadata.rehorCodeMode`.
Native fiber IDs correlate each invocation through before/after hooks and async
input/output validation, including repeated scalar/null inputs; correlation does
not depend on input identity or completion order.
The normalizer merges bridge evidence with native metadata, keeping the visible
`execute` wrapper as `budgetUnit: "container"` with no budget charge. Each successful
nested operation counts once, including native fetch metadata; errors do not count.
Work-context extraction receives nested results even when script output filters them.
Budget enforcement remains at the next root model boundary: one batch can contain
many operations and is not stopped atomically between nested calls.

Code Mode `fetch` is raw HTTP, independent of `webfetch` permission. Its authority
is controlled by network sandbox/egress and `execute` availability, not a claimed
`fetch: false` option. Scoped `opencode.tools` and `opencode.tools.mcp-resources`
management plugins remain disabled independently of Code Mode support. Native bridge/config tests have passed for root and child execution. The full image rebuild succeeded after the earlier external DNS failure, and a fresh unmounted Linux ARM64 production image containing the final native Effect/fiber-identity fix passed Responses/Chat/Vertex, read-tool, exact usage, and Code Mode checks. The built runtime counts two nested successes separately, blocks the denied MCP call before the server, captures filtered task results, and excludes the wrapper from budget accounting; budget 3 completes while budget 2 stops at the next root model boundary. These offline image checks do not establish a live rollout.

Supported profile resource directories are exactly `agents`, `commands`,
`instructions`, `rules`, `plugins`, `skills`, and `themes`. Singular directory aliases,
`modes`, and `tools` are unsupported. Profile JSON uses native plural fields and
`experimental.subagent_depth`; agent and command YAML frontmatter must also pass
strict native validation, rejecting legacy/mixed fields, old permission maps/actions,
and invalid values. Files are not rewritten into compatibility shapes. Strict
Markdown validation is implemented alongside JSON checks; onboarding's six role
frontmatters still require explicit conversion in its separate post-merge PR.

V2 usage projects one assistant message per model step. Streaming and recovered
projections replace usage by session/message ID; duplicate events, corrected model
attribution, and compaction recovery must not add the same usage twice. Positive
native costs are catalog estimates (`source: estimated`), not billed provider
amounts. Pending/interrupted steps or incomplete recovery keep usage incomplete
while preserving known subtotals. The historical frozen pricing catalog remains
independent of these V2 accounting semantics.

## Cycle input preparation

`prepareCycleInput()` prepares one cycle without starting an agent runtime. It
asks the Python bridge to sync and merge the existing config, assembles the
instruction layers deterministically, and runs the existing Python preflight
protocol:

```text
Python config bridge → workflow/instance config + config sync
                         │
                         ▼
                 runtime-specific instruction preparation
                         │
                         ▼
                 Python preflight
                  ├─ start → prompt + audit reference
                  ├─ skip  → no runtime prompt
                  └─ error → no runtime prompt
```

`PythonCoordinatorBridge` communicates through one JSON request/response over a
child process. It reuses `bot.preflight.run_preflight()` and the config
preparation functions from `bot.run`, so migration does not fork preflight
classification or config merge behavior. Python logs remain on stderr; stdout
is reserved for the versioned bridge response.

Claude instruction layers remain core, optional shared, workflow, and optional
instance instructions; `replace`, `append`, and `ignore` retain their meanings.
OpenCode instead loads distinct core/shared/workflow `AGENTS.md` resources through
native `instructions`, plus profile `AGENTS.md` and `.opencode` resources. It does
not apply Claude assembly strategies. The captured instruction input receives a SHA-256
`instructionHash`; semantic config inputs, including `runtimeId` and
`providerId`, receive a separate `configHash` so a selection change cannot be
silently reused for a cycle. `ConfigPreparationResult.runtimeId` selects the
runtime adapter, while `ConfigPreparationResult.providerId` independently
becomes `RehorRun.provider.id`.

Preflight `skip` and `error` actions remain coordinator-owned no-session
paths. Existing aggregation is preserved: a mixed error/start result is still
`start`, while an all-error result is `error`. Only a `start` result, or the
no-preflight pass-through case, produces an agent prompt.

## Local coordinator launch

Build and run one cycle from the repository root. `run-coordinator` builds the
coordinator and requires the Make variable `INSTANCE_ID`:

```bash
BOT_LABEL=hcc-ai-framework BOT_INSTANCE_ID=local-1 \
  OPENCODE_COMMAND="$(command -v opencode)" \
  OPENCODE_EXPECTED_VERSION=2.1.2 \
  make run-coordinator LABEL=hcc-ai-framework INSTANCE_ID=local-1
```

The default instance selection remains `claude`/`vertex`, so this command is a
safe coordinator-path smoke test without changing an instance config. To test
OpenCode V2, set `runtime: opencode`. Migrate Claude instances directly to V2;
V1 was an experimental onboarding-only validation stopgap, not a rollout stage.
The CLI loads the packaged
`opencode-deployment.default.json`; `REHOR_OPENCODE_DEPLOYMENT_CONFIG` remains an
optional override (see `opencode-deployment.example.json`). The shared defaults
intentionally omit a top-level model, so Python preparation selects
`config.json`'s `opencode.model` (`gpt-6-luna`) unless `instance.yaml` or
`BOT_MODEL` overrides it. The default `rehor-openai` provider uses
`@opencode/ai/providers/openai/responses`. OpenCode+Vertex retains the `claude.model`
fallback and is declared in packaged defaults alongside both OpenAI routes.
Select `provider: vertex` to use Claude Sonnet 4.6, Opus 4.6, or Haiku 4.5 via
the existing Vertex auth proxy. The runner sends OpenCode a placeholder bearer
value; the proxy replaces it with its service-account token. Select
`provider: rehor-openai-chat` and a model declared under that provider for Chat
Completions through `@opencode/ai/providers/openai-compatible`; undeclared models fail closed.
The coordinator also selects a small model from the active provider's declared
models, preventing OpenCode from silently using an unrelated, non-allowlisted
title model. Rehor's `smallModel` input is rendered as native `agents.title.model`,
never `small_model`.

Both OpenAI routes use `REHOR_MODEL_PROXY_URL` and
`REHOR_MODEL_PROXY_TOKEN`. The Vertex route uses `REHOR_VERTEX_PROXY_URL`,
resolved from existing `ANTHROPIC_VERTEX_BASE_URL` or the shared
`devbot-proxy:8443` service. The gateway must be
`http://<proxy-host>:8450/v1`; missing or invalid gateway/token settings fail
before OpenCode starts. The token is only the bot-side API-key value that the
proxy overwrites; the real OpenAI key remains proxy-only. Compose sets both
values directly. OpenShift defaults the gateway host from `PROXY_HOST` and uses
the same placeholder token. The proxy's ingress NetworkPolicy already admits
TCP/8450 from devbot pods. OpenShell runners also need the port in their
SandboxTemplate's managed egress list; `deploy/sandbox-template.example.yaml`
includes it, but instance templates copied from an older example must add it.
Custom deployment configs must
keep credentials out of JSON and use environment references such as
`{env:REHOR_MODEL_PROXY_URL}` and `{env:REHOR_MODEL_PROXY_TOKEN}`. Use `--once`
for a single preflight or attempt. The local sink writes `data/costs.jsonl`,
`data/cycle-runs.jsonl` (each record names its transcript in `transcript_path`),
compressed transcripts under `data/transcripts/`, and
serves `/health`, `/ready`, and `/metrics` on port `COORDINATOR_METRICS_PORT`
(9091 by default).

## Deployment packaging

`Dockerfile` packages the coordinator for Compose. `Dockerfile.runner` builds
from the pinned UBI Node 22 builder, copies the ESM coordinator bundle, locked
npm dependencies, and model-free `opencode-deployment.default.json`, installs
`@opencode/cli@2.1.2`, and includes `zstd` for transcript
compatibility. The Vertex provider module ships beside the ESM coordinator and
uses pinned `@ai-sdk/google-vertex@4.0.219` with its token generator replaced by
a non-secret placeholder; proxy injects actual Google auth. The first OpenAI
provider uses native Responses for GPT-6 Luna; the second preserves the
compatible Chat Completions path. `entrypoint.sh` accepts
`BOT_EXECUTION_ENGINE=python|coordinator`; omitted or `python` always launches
the existing Python/Claude runner. Set `coordinator` only with
`BOT_INSTANCE_ID`, `CYCLE_RUNS_API_URL`, the proxy/memory services, and valid
proxy URL/token settings when selecting an OpenAI provider.
`REHOR_OPENCODE_DEPLOYMENT_CONFIG` is optional and overrides the packaged
provider defaults.

The renderer selects native `@opencode/ai/providers/openai/responses` and
`@opencode/ai/providers/openai-compatible` runtimes. They ship with the pinned CLI
and require no `packages` entries or separate `@ai-sdk` metadata. The default/example
deployment files use `packages: []`. External provider packages use exact-pinned
`aisdk:<package>@<version>` references; external plugins also require exact pins.
The renderer still writes `opencode-packages.lock.json` for that external closure.
Vertex is coordinator-managed as `aisdk:file://.../vertex-provider.js`; profiles
cannot replace its provider package. No singular deployment `provider`, deployment
`packageLock`, provider `npm`/`options`, or other legacy aliases are accepted.

Execution and pricing pins are independent: the frozen pricing fallback retains
OpenCode **1.18.35** catalog provenance; it does not select or downgrade CLI
**2.1.2**. See [pricing provenance](../docs/migrations/opencode-migration.md#opencode-cost-estimates-rehor-197).

## Cycle scheduling and idle state

`CycleScheduler` is the side-effect-free decision layer for the future loop:

- no preflight or `start` → run an agent attempt;
- `skip` → idle delay and zero the preflight-error streak;
- `error` → no attempt, exponential delay (`interval × 2^streak`) capped at
  300 seconds by default;
- completed attempt → normal interval unless a valid `data/cycle-sleep.json`
  signal supplies a delay and reason.

`consumeSleepSignal()` reads and removes the Python-compatible sleep signal,
including malformed signals, so stale recommendations cannot affect a later
cycle. `sleep()` accepts an `AbortSignal`, allowing shutdown to interrupt the
wait rather than delaying process termination.

`recordIdleCycle()` and `recordActiveCycle()` contain the threshold/cooldown
state machine used by the existing idle reminder behavior. They deliberately
stay transport-neutral: a future memory-server adapter persists the state and
a future reminder adapter sends the notification only after
`shouldSendReminder` is true.

## Signal, admission, and shutdown loop

`runCoordinatorLoop()` owns the outer cycle boundary. It acquires an admission
lease before preparation, never invokes `run()` for preflight `skip`/`error`,
releases the lease in `finally`, and waits through the scheduler between
cycles. `createLoopSignals()` combines normal cancellation with shutdown, while
`installProcessSignalHandlers()` keeps SIGINT/SIGTERM registration outside the
loop for testability.

Admission remains a port because deployment can keep using the Python file lock
during migration. A denied admission exits without config sync, preflight, or
runtime startup. Shutdown/cancellation interrupts preparation, runtime, and
sleep through one `AbortSignal`.

## Compatibility with the Python Runner

| Current Python behavior | Coordinator representation |
|---|---|
| `label`, workflow, model, cost budget (`budgetUsd`), cycle timeout | `RehorRun.label`, `workflowId`, `provider`, and `limits` |
| Instance runtime/provider selection | `RehorRun.runtimeId` and `RehorRun.provider.id` |
| Dynamic prompt plus optional preflight content | `RehorRun.prompt` plus optional `preflightPayloadRef` for audit linkage |
| Cycle starts before a task is selected | `RehorRun.task` may be `null` |
| SDK session ID | opaque `runtimeSessionRef`; provider session IDs remain inside adapters |
| Streamed system, assistant, model, and tool messages | normalized `RehorEvent` kinds and payloads |
| `ResultMessage.subtype` and cycle timeout | terminal state: `completed`, `failed`, `interrupted`, `cancelled`, or `timed_out` |
| result text, no-work classification, duration, turns, `CycleContext` | terminal `resultText`, `noWork`, `durationMs`, `turns`, and `context` |
| per-model input/output/cache usage and total cost | validated `usage` event payloads; child/fallback models plus partial and incomplete usage are explicit |
| transcript persistence | normalized events plus redacted `rawEventRef`; persistence adapter lands later |
| preflight `skip`/`error` orphan cycles | remain coordinator-owned paths and do not start `AgentRuntime` |

This contract preserves current observable data while fixing one current
limitation: timed-out SDK cycles can report partial usage instead of losing all
cost data when an adapter emits partial usage events.

## Layout

- `src/index.ts` — public contract entry point and build target
- `src/coordinator.ts` — one-attempt lifecycle and cancellation orchestration
- `src/domain/` — run, event, event factory, terminal, usage, and validation contracts
- `src/bridges/` — process adapters for legacy Python preparation
- `src/ports/` — stable runtime, preflight, and compatibility interfaces
- `src/instructions.ts` — deterministic instruction-layer and prompt assembly
- `src/cycle-input.ts` — config, instruction, and preflight preparation facade
- `src/scheduler.ts` — preflight decisions, backoff, sleep signals, and abortable delay
- `src/idle.ts` — transport-neutral idle threshold/cooldown state
- `src/loop.ts` — admission, signal, shutdown, and cycle-loop orchestration
- `src/runtime-factory.ts` — runtime registry and provider-independent selection
- `src/runner.ts` — production bridge, run construction, registry wiring, and loop
- `src/adapters/` — file admission, HTTP/JSONL compatibility, health, and metrics
- `src/cli.ts` — local/deployment coordinator entry point
- `src/projections/` — legacy compatibility mappings for cycle outputs
- `src/testing/` — deterministic fake runtime for contract tests
- `schema/` — versioned JSON wire schemas
- `test/contract/` — lifecycle, schema, and compatibility tests; `runtime-adapters.test.ts`
  runs the AgentRuntime contract against the Claude and OpenCode adapters with
  scripted SDK/server boundaries (`runtime-harnesses.ts`)

## Development

Requires Node.js 22 and npm.

```bash
cd coordinator
npm ci
npm test
npm run typecheck
npm run build
npm audit --audit-level high
```

`npm run build` emits ESM Node bundles at `dist/index.js` and `dist/cli.js`
with runtime dependencies left external, then writes type declarations under
`dist/`.

From repository root, `make coordinator-verify` runs install, tests, typecheck,
and build. Coordinator changes run the same checks in pre-push and GitHub CI.

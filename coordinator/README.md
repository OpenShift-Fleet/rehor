# Rehor Coordinator

`coordinator/` is the provider-neutral control-plane boundary for Rehor agent
cycles. It will let the runner select an agent runtime (initially the existing
Claude path or OpenCode), apply one lifecycle policy, and project normalized
events into status, transcript, usage, and cost records.

The coordinator is **migration scaffolding**, not the production entry point
yet. `bot/run.py` and `bot/agent.py` remain active. The TypeScript attempt loop
is available to adapters and deterministic tests; production runtime selection
and process startup remain unchanged until parity validation.

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
terminal event after preserving all accepted partial events. Timeout, caller
cancellation, and shutdown signals map to `timed_out`, `cancelled`, and
`interrupted` terminal states respectively. Projection hooks receive normalized
events for the existing status, transcript, usage, and cost writers; they do
not receive provider SDK objects.

The coordinator does not write a new event store and does not change the
Python Claude/Vertex path. A runtime adapter and compatibility projections can
be selected by the future TypeScript runner without changing this boundary.

## Runtime selection

`RuntimeFactoryRegistry` resolves a `RuntimeSelection.runtimeId` to an
`AgentRuntimeFactory`. Runtime selection is intentionally separate from
`RehorRun.provider`: one runtime can support multiple providers, and provider
selection can change without changing lifecycle orchestration.

Factories receive only a normalized `RehorRun` and return an `AgentRuntime`.
Provider SDK clients, server processes, and sessions remain private to the
adapter. `executeSelectedRun()` feeds the selected adapter into the existing
`executeRun()` lifecycle, preserving event validation, projection, timeout,
and cleanup behavior.

The coordinator package does not register a production Claude or OpenCode
adapter yet. The registry is the seam those adapters will use during canary
migration; the Python runner remains the active production entry point.

## Cycle input preparation

`prepareCycleInput()` prepares one cycle without starting an agent runtime. It
asks the Python bridge to sync and merge the existing config, assembles the
instruction layers deterministically, and runs the existing Python preflight
protocol:

```text
Python config bridge → workflow/instance config + config sync
                         │
                         ▼
                 CLAUDE.md assembly
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

Instruction layers match the current runner: core, optional shared, workflow,
and optional instance instructions. `replace`, `append`, and `ignore` strategies
retain their existing meanings. The assembled content receives a SHA-256
`instructionHash`; semantic config inputs receive a separate `configHash`.

Preflight `skip` and `error` actions remain coordinator-owned no-session
paths. Existing aggregation is preserved: a mixed error/start result is still
`start`, while an all-error result is `error`. Only a `start` result, or the
no-preflight pass-through case, produces an agent prompt.

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

## Compatibility with the Python Runner

| Current Python behavior | Coordinator representation |
|---|---|
| `label`, workflow, model, `max_turns`, cycle timeout | `RehorRun.label`, `workflowId`, `provider`, and `limits` |
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
- `src/runtime-factory.ts` — runtime registry and provider-independent selection
- `src/testing/` — deterministic fake runtime for contract tests
- `schema/` — versioned JSON wire schemas
- `test/contract/` — lifecycle, schema, and compatibility tests

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

`npm run build` emits an ESM Node bundle at `dist/index.js` with `ajv` and
`ajv-formats` left external, then writes type declarations to `dist/index.d.ts`.

From repository root, `make coordinator-verify` runs install, tests, typecheck,
and build. Coordinator changes run the same checks in pre-push and GitHub CI.

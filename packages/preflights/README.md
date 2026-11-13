# @rehor/preflights

Shared preflight implementations for Rehor agents: a private npm workspace package — consumed by `@rehor/agent-dispatcher` through its two declared public entrypoints, the package root and the `@rehor/preflights/preflights` subpath (see [Consuming the package](#consuming-the-package)) — never published to any registry. The dispatcher owns execution; agent configuration repositories never ship executable code. An agent's `instance.yaml` selects preflights by id and supplies plain literal parameters; every implementation lives in this package, registered centrally behind one registry. Inputs are validated fail-closed with Zod before anything executes, and a configuration failure (`invalid`) is distinct from an execution failure (`error`). External systems are reached exclusively through the auth proxy, which injects credentials on the upstream leg.

Design: [`docs/preflight-rework-spike-input.md`](../../docs/preflight-rework-spike-input.md)

## Layout

```
src/
├── index.ts        public API: the core contract + the run-context type/factory
├── core/           the contract — pure types and schemas, no I/O
├── shared/         internal clients and helpers (not part of the public API)
└── preflights/     one directory per preflight + the registration barrel
```

- **`src/core/`** — the pure contract:
  - `preflight.ts` — `PreflightDefinition`: `id`, Zod input schema, `run(ctx, params)`.
  - `registry.ts` — `definePreflight()` and `createPreflightRegistry()`; unknown lookups return `undefined` (fail closed), duplicate ids throw at construction.
  - `entry.ts` — the Zod shape of one `preflights:` entry: a shorthand string or `{ id, with }`.
  - `validate.ts` — `validateConfig()`: whole-list validation before execution, stable per-entry messages.
  - `results.ts` — the `start` / `skip` / `error` execution results plus the pre-execution `invalid` representation.
  - `defaults.ts` — `workflowDefaults` and `validateWorkflowDefaults()`.
- **`src/shared/`** — internal modules the preflight implementations import directly: the HTTP client factory, the memory-server client, the Jira REST client, the GitHub client, the run context (`createPreflightRunContext()`), and the repos/time/format helpers.
- **`src/preflights/`** — one directory per preflight plus `index.ts`, the registration barrel (`createPopulatedRegistry()`). `jira-common/` holds the triage and candidate logic the Jira preflights share; it is not a registered preflight itself.

## Consuming the package

Two public entrypoints, both resolving to build output under `dist/` — `.js` at runtime, `.d.ts` for types, with declaration emit on and deep `dist/` imports refused by the exports map:

- `@rehor/preflights` — the core contract (`validateConfig`, the entry schemas, `definePreflight`, `createPreflightRegistry`, `workflowDefaults`, …) plus `createPreflightRunContext`.
- `@rehor/preflights/preflights` — `createPopulatedRegistry()`, the zero-argument barrel with every registered preflight.

```ts
import { validateConfig } from "@rehor/preflights";
import { createPopulatedRegistry } from "@rehor/preflights/preflights";

const registry = createPopulatedRegistry();
const result = validateConfig(preflights, registry); // the parsed `preflights:` list
```

A consumer smoke test links the package by name from a scratch package outside the repository, imports both entrypoints at runtime, and typechecks a strict NodeNext consumer against the emitted declarations. Dispatcher-side execution wiring is REHOR-258/259 — the example above is configuration validation, not integrated dispatch.

## Declaring preflights

Agents declare preflights in the `preflights:` field of their `instance.yaml`. The field follows the existing `envs` semantics:

- omitted → the workflow's default set applies (see [Default sets](#default-sets));
- `[]` → no preflights;
- an explicit list → exactly those entries — it replaces the default set, no merging.

Each entry is one of:

- **shorthand** — `- gh-pr-status`: every input uses its declared default. Valid only for preflights with no required inputs.
- **parameterized** — `- id: jira-kanban` with a `with:` map of plain literal values: strings, numbers, booleans, and lists of those. No objects, no null, no interpolation — anything dynamic belongs in the preflight implementation, not the configuration. Omitting `with:` is equivalent to shorthand.

```yaml
# instance.yaml
preflights:
  - id: jira-sprint
    with:
      label: rehor-pilot            # required
      include_backlog: true         # optional, default false
      email: rehor-bot@example.com  # optional
  - gh-pr-status                    # shorthand alongside a parameterized entry
```

## Preflight reference

The registered ids — one registration line each in `createPopulatedRegistry()` (`src/preflights/index.ts`):

| id           | purpose                                            | required inputs       | optional inputs (default)                                                       |
| ------------ | -------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| gh-pr-status | GitHub PR status of the active tasks               | —                     | `suppress_terminal_if_addressed` (`false`)                                       |
| gl-mr-status | GitLab MR status of the active tasks               | —                     | `suppress_terminal_if_addressed` (`false`)                                       |
| jira-sprint  | active-task triage + sprint/backlog candidate search | `label`             | `include_backlog` (false), `email` (—), `interrupted_retry_minutes` (30)         |
| jira-kanban  | active-task triage + kanban candidate search        | `project`, `label`    | `statuses` (`["New", "Backlog", "To Do"]`), `jql_extra` (—), `email` (—), `interrupted_retry_minutes` (30) |
| jira-triage  | active-task triage only                            | —                     | `interrupted_retry_minutes` (30)                                                 |
| onboarding   | onboarding candidates + phase advancement          | `label`               | `project` (`"REHOR"`)                                                             |

### `gh-pr-status`

Checks the GitHub PRs of the instance's active tasks — state, mergeability, CI check rollup (including Konflux `detailsUrl` extraction), review decisions, and comments — and classifies them into merged / closed / ci_fail / conflict / feedback / clean buckets. `start` (with Markdown for the agent prompt) when any actionable bucket is non-empty, `skip` otherwise. GitHub is reached through the run context's proxy route; bare repo names resolve through the instance project-repos map.

- `suppress_terminal_if_addressed` (default `false`) — the onboarding mode: merged/closed PRs whose feedback was already addressed are not reported as terminal, so the onboarding agent keeps seeing them until it finishes.

### `gl-mr-status`

The GitLab counterpart of `gh-pr-status`: checks the MRs of the instance's active tasks — state, pipelines, mergeability/conflicts, unresolved discussion threads, and notes — and classifies them into the same merged / closed / ci_fail / conflict / feedback / clean buckets, with the same addressed-CI and review-feedback rules. `start` when any actionable bucket is non-empty, `skip` otherwise. GitLab is reached through the run context's proxy route (`/gitlab` prefix, gitbeaker transport with a fail-fast custom requester); bare repo names resolve through the instance project-repos map.

- `suppress_terminal_if_addressed` (default `false`) — the onboarding mode: merged/closed MRs whose feedback was already addressed are not reported as terminal, so the onboarding agent keeps seeing them until it finishes.

### `jira-sprint`

Triages active tasks (new human Jira feedback, interrupted work) and searches for new work candidates: the open sprint's unassigned tickets, then tickets assigned to the bot (when `email` is set), then the backlog (when `include_backlog` is true) — each later pass only while fewer than 10 candidates have been collected. At capacity, only needs-investigation tickets are searched. `start` when active tasks need attention or new candidates exist, `skip` otherwise.

- `label` (required, nonblank) — team label; candidate queries filter on it.
- `include_backlog` (default `false`) — also search the backlog (not in an open sprint) when the open-sprint passes yield fewer than 10 candidates.
- `email` (optional) — the bot's Jira identity; when set, tickets already assigned to the bot are also collected as candidates.
- `interrupted_retry_minutes` (default `30`) — cooldown a task blocked on external input waits out before it counts as interrupted again.

### `jira-kanban`

The same active-task triage as `jira-sprint`, with a kanban candidate search instead of sprint queries: candidates are scoped to a project and a configurable not-started status list. Same start/skip decision.

- `project` (required, nonblank) — Jira project the candidate search is scoped to.
- `label` (required, nonblank) — team label; candidate queries filter on it.
- `statuses` (default `["New", "Backlog", "To Do"]`) — nonempty list of nonblank statuses that count as not started.
- `jql_extra` (optional) — extra JQL appended to every candidate query, e.g. `AND priority not in ("Undefined")`; the expression without the leading `AND` works too — the implementation normalizes the join.
- `email` (optional) — the bot's Jira identity; bot-assigned tickets are also collected.
- `interrupted_retry_minutes` (default `30`) — see `jira-sprint`.

### `jira-triage`

Feedback/interrupted triage of active tasks only — no candidate search. With no active tasks it returns `start` pointing at new Jira work; otherwise `start` when any active task has feedback or was interrupted, `skip` when all are clean.

- `interrupted_retry_minutes` (default `30`) — see `jira-sprint`.

### `onboarding`

Finds new onboarding tickets by label and checks active onboarding tasks for new Jira feedback and phase advancement (PR/MR merged). `start` when any of that is actionable, `skip` otherwise. The PR/MR merge check runs through the run context's proxy route (the package's GitHub and GitLab clients, like `gh-pr-status`/`gl-mr-status` — no `gh`/`glab` CLI subprocesses): a 404 or API-confirmed-missing PR/MR is an advisory not-merged (the phase sub-ticket stays the source of truth), while authentication, rate-limit, upstream-5xx, network, and timeout failures — and an unwired route — are `error` results, never a healthy "not merged".

- `label` (required) — onboarding label; restricted to `[a-zA-Z0-9:_-]` because it is interpolated into JQL.
- `project` (default `"REHOR"`, nonblank) — Jira project for the candidate search.

## Differences from the Python implementation

The port preserves statuses, aggregation rules, formatting, and cooldowns. Beyond the transport switch — `gh`/`glab` CLI subprocesses and the Jira MCP client replaced by SDK clients on the auth-proxy route — these deliberate changes exist:

- The agent prompt is assembled from `start` results only; `skip`/`error` content goes to the cycle report and logs instead (dispatcher-side, REHOR-259).
- The inter-script state file (`data/preflight-state.json`) is an in-memory per-run context object — same keys and semantics, no file.
- Fetch failures follow the per-class tally of `shared/failure-policy.ts` — PR/MR fetches and their comments/notes are tracked separately. A class with no attempted fetches is no failure at all (the normal skip path). A class with at least one success tolerates its failed items (the Python `gh_pr`/`gl_mr` wrappers degraded to `None`/`[]`): they are skipped and reported as UNFETCHABLE evidence — item label plus HTTP status or transport class, never error messages — and isolated 401/403/429/5xx count as item-specific, because a credential can be scoped to miss one repository. A class that attempted fetches but completed none is an execution `error` naming the required route, whatever the failures — auth, rate limit, upstream 5xx, network/timeout, or an all-404 run. An API-confirmed missing item (GitHub `pullRequest: null`) counts as a success, not a failure. The GitHub client keeps one comment endpoint's comments when the other fails; both failing throws, and the comments class decides. Onboarding's merge check applies the same distinction (see `onboarding`).
- Jira feedback classification scans the complete fetched comment history — the client pages through every comment — and the renderer bounds how much it prints while preserving the triggering human feedback. The Python truncation-detection heuristic (a workaround for the MCP client's comment cap) is not ported.
- Memory-server authentication failures raise (an `error` result) instead of degrading to an empty task list.
- Missing or invalid required configuration fails closed at validation (an `invalid` result) instead of silently returning no work.

## Default sets

`workflowDefaults` (`src/core/defaults.ts`) is the central mapping of workflow name → default preflight ids — dispatcher-side data, not workflow content, not baked into the runner image. An agent whose `instance.yaml` omits the `preflights:` field inherits the default set registered for its workflow; a custom workflow has no central default, so those agents must list preflights explicitly.

```ts
export const workflowDefaults: Record<string, string[]> = {
  "jira-sprint": ["gh-pr-status", "gl-mr-status"],
};
```

Default sets may only reference preflights with **no required inputs** — a preflight with required inputs must always be declared explicitly in `instance.yaml`, so an inherited default can never hide a required value the agent cannot supply. `validateWorkflowDefaults(registry)` checks every default set against a registry and reports, per workflow:

- `{workflow}: default set references unknown preflight id "{id}"`
- `{workflow}: default set includes "{id}" with required input {names}; defaults may only include preflights with no required inputs`
- `{workflow}: default set includes "{id}" whose input schema rejects an empty parameter map; defaults may only include preflights with no required inputs`

An inherited default is applied with an empty `with:` map, so a preflight whose schema rejects `{}` outright — for example a root refinement requiring at least one of several optional fields — is rejected up front with the third message, even though none of its inputs is individually required.

## Configuration validation

`validateConfig(entries, registry)` validates a whole `preflights:` list before any preflight executes. Fail closed: no entry executes unless every entry validates. All failing entries are reported, not just the first, and raw Zod error text is never surfaced — every issue maps to a stable message:

| failure                                | message format                                       |
| -------------------------------------- | ---------------------------------------------------- |
| unknown preflight id                   | `{id}: unknown preflight id`                         |
| missing required parameter             | `{id}: missing required parameter "{name}"`          |
| unknown parameter name                 | `{id}: unknown parameter "{name}"`                   |
| supplied parameter failed its schema   | `{id}: invalid parameter "{name}"`                   |
| whole-`with:`-map constraint failed    | `{id}: invalid parameters`                           |
| malformed entry, id recoverable        | `{id}: malformed preflight entry`                    |
| malformed entry, id not recoverable    | `entry {position}: malformed preflight entry`        |
| `preflights:` field is not a list      | `preflights: expected a list of preflight entries`   |

A shorthand entry (or an object entry without `with:`) for a preflight with required inputs fails with that preflight's `missing required parameter` messages; a `with:` value that is not a plain literal (or fails the parameter's schema) fails with `invalid parameter`; a structural problem (an unknown entry key, an empty `id`) fails with `malformed preflight entry`. A constraint spanning the whole `with:` map — a root refinement across several fields, with no single parameter to name — fails with `invalid parameters`. `with:` keys named `__proto__`, `constructor`, or `prototype` are rejected with the per-key `invalid parameter` message, so no parameter name can collide with a built-in property name.

An **`invalid`** entry is a pre-execution configuration failure: the dispatcher refuses to dispatch the instance and surfaces these messages to the agent owner. It never heals by retrying — the configuration is re-evaluated on the next config sync. This is distinct from an **`error`** result, an execution failure of a valid configuration (network, timeout, upstream API) where retrying with backoff can help.

Invalid configuration — fails closed before any preflight runs:

```yaml
# instance.yaml
preflights:
  - jira-kanban          # missing required `project` and `label`
  - gh-pr-statuss        # unknown preflight id (typo)
  - id: onboarding
    with:
      labels: rehor-pilot   # unknown parameter name (it is `label`)
```

Validation reports every failing entry with its messages:

```
jira-kanban: missing required parameter "project"
jira-kanban: missing required parameter "label"
gh-pr-statuss: unknown preflight id
onboarding: unknown parameter "labels"
onboarding: missing required parameter "label"
```

## Run context

`createPreflightRunContext(options)` (`src/shared/run-context.ts`, re-exported at the package root) builds the context the dispatcher hands to every preflight in one run. It wires:

- `instanceId` — the agent instance the run is for (required, non-empty).
- `runId` — per-run identity for logging; defaults to a generated UUID.
- `memory` — a memory-server client or its config (`baseUrl`, optional bearer `token`, `instanceId`, `timeoutMs`, injectable `fetch`). A client built from config shares the run's state, so task and capacity fetches happen once per run, shared by every preflight; the context's instance id flows into the `instance_id` query unless the config names its own.
- `jira` — a Jira REST client or its config, optional; the Jira preflights return an `error` result when no client is wired.
- `proxy` — the auth-proxy route: a base-URL string or `{ baseUrl, fetch? }`. External-system clients compose their path prefixes (`/github`, `/jira`, `/gitlab`) on top of it, pagination and redirects stay bound to that route, and the proxy is the sole credential source for the destination: alternative credential headers are stripped on every pathname route, and client-supplied credentials are rejected or stripped in the known supported carriers — the recognized authentication query parameters and JSON, form-encoded, or multipart request bodies (a POST without a Content-Type counts as form-encoded), with body inspection bounded at 1 MiB and malformed or ambiguous multipart shapes failing closed. A preflight that needs an external system treats an absent or failing route as an execution error, never a silent skip.
- `repos` — the instance's `project-repos.json` map for bare repo-name resolution; defaults to `{}` (no resolution).
- `state` — per-run shared state, the in-memory replacement of the Python inter-script state file: preflights keep bookkeeping keys in it (e.g. `jira`, `has_actionable`) and it lives for one run only.

The dispatcher supplies all of it. The package never reads environment variables or credentials — configuration is injected, and the auth proxy injects credentials on the upstream leg.

## Adding a preflight

1. Create a directory under `src/preflights/`.
2. Define the preflight with `definePreflight()`: a stable string `id`, a Zod `strictObject` input schema (the typed single source of truth — `z.infer` derives the param types, and strict mode makes unknown parameter names fail closed), and a `run(ctx, params)` function.
3. Add exactly one registration line in `createPopulatedRegistry()` in `src/preflights/index.ts`.
4. Add fixture-based tests (injectable `fetch`; no network).

This is the audit boundary: new preflights land by PR to this repository, so enterprise integrations and their credential use are reviewed centrally through the barrel. Sensitive credentials are never handled here — external systems are reached through the auth proxy, which injects credentials on the upstream leg. `definePreflight()` throws on an empty id or a non-object input schema, and `createPreflightRegistry()` throws on duplicate ids — central-author errors caught at construction, never at agent dispatch time.

## Building and testing

```sh
npm run build --workspace=@rehor/preflights
npm test --workspace=@rehor/preflights
```

`npm test` builds first, then runs `node --test test/*.test.mjs`. The tests are fixture-based and the clients take an injectable `fetch`, so no test touches the network.

Private package — not published to any registry.

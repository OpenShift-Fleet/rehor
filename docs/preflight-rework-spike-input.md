# Preflight Rework — Spike Input

Status: input to the [REHOR-240 spike](https://redhat.atlassian.net/browse/REHOR-240), under epic [REHOR-239](https://redhat.atlassian.net/browse/REHOR-239).
This document records the product decisions and constraints the spike design must satisfy and inventories the existing Python preflights that get ported. Every question raised while preparing it was settled inline (marked "decided"); the spike validates these decisions end-to-end rather than re-opening them.

## Decided constraints

These are settled product decisions, not spike questions.

1. **New TypeScript package.** The shared preflights live in a new TS package/project inside this repo, consumed by the agent dispatcher as a dependency. The dispatcher owns execution; agent configuration repositories never ship executable code.
2. **Port, not rewrite.** The existing shared Python preflights in `presets/shared/preflight/` are ported to this package with behavior preserved (statuses, aggregation rules, formatting, cooldowns) — with two deliberate changes recorded in the aggregation bullet below (agent prompt from `start` results only; in-memory run context instead of the state file). The Python path is retired only after full fleet verification (REHOR-232).
3. **Mandatory for Hypershell agents.** Agents migrating to Hypershell must use these shared preflights. An agent with a custom workflow lists the preflights it wants in its `instance.yaml`; it cannot ship its own preflight code.
4. **Preflight declaration is separated from workflow content.** Workflows — shared presets via the dev-bot submodule and custom ones via the runner repo's `instance/` directory — are baked into runner images at build time (`Dockerfile.runner`), while preflights execute in the dispatcher before a sandbox is created. Preflight declarations therefore live in the config repository (`instance.yaml`), synced and evaluated at dispatch time, and never ride the runner image. Shared and custom workflows declare preflights with exactly the same shape; the only difference is that a shared workflow may have a central default set, whereas a custom workflow must list its preflights explicitly.
5. **Central contribution flow.** A new preflight is added by opening a PR to this repo. This is the audit boundary: enterprise integrations and their credential use are reviewed centrally, and all agents share as much implementation code as possible.
6. **Two credential tiers, none in agent repositories.** Sensitive credentials (PAT-style tokens for GitHub, GitLab, Jira, …) are not handled by the preflight package at all: preflights reach external systems through the auth proxy (`devbot-proxy`), which injects the credential on the upstream leg. The package neither stores nor re-implements credential injection. Less-sensitive instance-specific values are configured via fields in the agent's `instance.yaml`. Secrets never appear in agent repositories, `instance.yaml` included.
7. **Input arguments via `instance.yaml`.** Per-agent configuration (labels, projects, statuses, JQL extras, …) — everything that is not a credential — is supplied as parameters of the preflight entries in the agent's `instance.yaml`, which is unique per agent. There is no separate preflight manifest.
8. **Fail-closed validation with Zod.** Input validation uses Zod: each preflight declares a Zod schema for its inputs (the typed single source of truth alongside the implementation, `z.infer` giving the param types for free), and the entry-list shape itself (`shorthand string | { id, with }`) is a Zod union. The dispatcher validates every `instance.yaml` preflight entry against the registry and schemas before any preflight runs; an unknown preflight id, a missing required parameter, or an invalid value fails hard. Zod issue paths are mapped to stable per-entry, per-parameter messages. An agent that did not supply required params must never silently degrade into "no work" or partial execution.

## Current state to port

### Python preflights (`presets/shared/preflight/`)

| Script | Purpose | External systems |
| --- | --- | --- |
| `common.py` | Shared helpers: memory-server HTTP client with bearer auth, task/capacity fetching with inter-script state cache, `project-repos.json` loading and repo-label matching, org/repo → host resolution, bot-author detection, ISO timestamp parsing/comparison, interrupted-retry cooldown, comment/task formatting, JSON output protocol | Memory server |
| `gh_pr_status.py` | Active tasks' GitHub PRs: state, conflicts, CI check rollup (incl. Konflux URLs), review decisions, comments; buckets merged/closed/ci_fail/conflict/feedback/clean | GitHub (via `gh` CLI today → Octokit) , memory server |
| `gl_mr_status.py` | Active tasks' GitLab MRs: state, pipelines, conflicts, unresolved threads, notes; same bucketing | GitLab (via `glab` CLI today → gitbeaker), memory server |
| `jira_sprint_preflight.py` | Triage active tasks (new Jira feedback, interrupted work) + find new sprint/backlog candidates by team label; capacity-aware | Jira (via MCP client), memory server |
| `jira_kanban_preflight.py` | Same triage, project/status-based kanban candidate search (`BOT_JIRA_PROJECT`, `BOT_KANBAN_STATUSES`, `BOT_KANBAN_JQL_EXTRA`) | Jira (via MCP client), memory server |
| `jira_triage.py` | Feedback/interrupted triage only (no find-work) | Jira (via MCP client), memory server |
| `onboarding_preflight.py` | Onboarding tickets by label; phase advancement checks | Jira (via MCP client), memory server |
| `.claude/skills/jira_mcp.py` | Jira MCP client wrapper (`jira_call`/`jira_cleanup`) shared by all Jira preflights — *not ported; replaced by a shared TS Jira REST client* | Jira REST API via the existing auth-proxy route |

### Runner contract today

- `bot/preflight.py` (in-runner) and `packages/agent-dispatcher/src/work-preflight.ts` (dispatcher) both implement the same protocol: each script prints `{"status": "start"|"skip"|"error", "content": "..."}`; aggregation is any-error-excluded / any-start → start / all-skip → skip / all-error → error.
- Per-script 120 s timeout, 1 MiB output caps, state file `data/preflight-state.json` cleaned before/after runs.
- `preflight-runtime.ts` materializes dereferenced copies of preflight dirs, shared helpers, skills, and the instance `project-repos.json` into a private temp root.
- `preflight-env.ts` allows only `BOT_*` (minus secret-looking names), `JIRA_MCP_URL`, `EXECUTOR_ADDR`, `PATH`, and proxy variables through to preflights.
- The dispatcher already fails fast when `python3` (3.11+) or `git` is unavailable (`verifyPreflightTools`) — the port removes the interpreter dependency entirely.

### Environment variables consumed today

These split into three groups in the target design.

**Non-secret, per-agent configuration → becomes preflight parameters in `instance.yaml`:**

- `BOT_LABEL` (team label for candidate search)
- `BOT_JIRA_PROJECT`, `BOT_KANBAN_STATUSES`, `BOT_KANBAN_JQL_EXTRA` (kanban search shape)
- `BOT_JIRA_EMAIL` (bot-assigned candidate fallback; the instance's Jira identity)
- `BOT_INCLUDE_BACKLOG` (sprint search fallback)
- `BOT_INTERRUPTED_RETRY_MINUTES` (cooldown tuning)

**Credentials → auth proxy injection, not duplicated in the package:**

- GitHub and GitLab credentials (today implicit in `gh`/`glab` CLI config) and Jira MCP authentication (Basic auth on the proxy port today): in the target, preflight traffic to these systems routes through the auth proxy, which injects the credential on the upstream leg. The preflight package never sees or stores these values.

**Dispatcher runtime wiring → stays in the dispatcher environment:**

- `BOT_MEMORY_TOKEN` (memory server bearer, minted by the dispatcher's existing credential provider)
- `BOT_MEMORY_URL`, `BOT_INSTANCE_ID`, `JIRA_MCP_URL`, proxy configuration (endpoints, not per-agent)

## Target shape (decided)

- Package name suggestion: `@rehor/preflights` as an npm workspace next to `@rehor/agent-dispatcher`.
- Each ported script becomes a registered preflight with a stable id and a Zod input schema (required/optional params, defaults — decided, see constraint 8). External-system traffic goes through the auth proxy; the package declares required routes, not credentials.
- An agent's `instance.yaml` lists preflight ids, optionally with parameters; shorthand entries use defaults only. Entries use `id` + `with:` (GitHub Actions convention) — the `with` keys are the inputs each preflight declares via its Zod parameter schema. A central dispatcher-side mapping (not workflow content, not in the runner image) provides default preflight sets for shared workflows; custom workflows list explicitly.
- The dispatcher evaluates the `instance.yaml` preflight configuration: validate all entries against the registry first (fail-closed), then execute, then aggregate with the existing start/skip/error semantics.
- No interpolation: `with` values are plain literals (strings, numbers, booleans, lists); anything dynamic belongs in the preflight implementation, not the configuration. No separate format version either — the registry and input schemas version with the package (the dispatcher pins the package version), and unknown ids or parameters already fail closed on version skew.
- Jira access is direct REST from TS (decided): the existing Atlassian token authenticates REST just as it does MCP, so `jira_mcp.py` is not ported — it is replaced by a shared TS Jira REST client module. Native REST pagination (`startAt`/`maxResults`) replaces the MCP client's oldest-first comment-limit workaround, making the truncation-detection heuristic in the Jira preflights unnecessary.
- GitHub and GitLab access uses SDK clients (decided): `@octokit/rest` + `@octokit/plugin-pagination` for GitHub, `@gitbeaker/rest` for GitLab (no official JS SDK exists; gitbeaker is the de facto standard with host/base-URL overrides, pointed at the proxy's GitLab path prefix in the target rather than at `gitlab.cee.redhat.com` directly). Note `statusCheckRollup`/`reviewDecision` are GraphQL-only fields today (`gh pr view --json` is GraphQL-backed), so the GitHub client also uses `@octokit/graphql` or composes REST check-runs/statuses/reviews — spike detail. Konflux `detailsUrl` extraction carries over unchanged (it reads check details from the rollup).
- All external traffic goes through one authenticated proxy route, with the destination selected by pathname — not per-service ports (decided). The current port-per-service executor layout (`:8443`–`:8446`) is obsolete and will be removed. Each client's base URL composes as the proxy base plus the system's path prefix (Jira REST, GitHub, GitLab, …). The preflight package therefore declares a single required route — the proxy base URL — instead of per-system routes or credentials; an unavailable route is a preflight execution error, never a silent skip.
- Configuration validation failures are a distinct result state (decided): **`invalid`** — a pre-execution failure of the `instance.yaml` preflight configuration itself (unknown id, missing or invalid required input, malformed entry), separate from **`error`**, which remains an execution failure of a valid configuration (network, timeout, upstream API) with the existing backoff semantics. On `invalid` the dispatcher refuses to dispatch the instance and emits a `configuration`-category lifecycle event (the category already exists in the dispatcher's error taxonomy); the stable per-entry validation messages are the owner-facing feedback. An `invalid` config never heals by retrying, so it is re-evaluated on the next config sync rather than on a timer.
- Cycle reporting always happens (decided): an `invalid` or errored preflight run is still reported to the memory server like any other cycle outcome — through the existing bot status update and cycle-runs reporting (`/api/bot_status_update`, `/api/cycle_runs`), with the validation-failure or error summary as the report content. Broken preflight configurations must show up in the standard reporting surface (cycle history, dashboards), not only in dispatcher lifecycle logs — a refused dispatch must not look identical to an idle, healthy instance.
- Aggregation and shared-run semantics port as-is, with two deliberate changes (decided): the start/skip/error combination rules carry over unchanged (any `start` among non-errored preflights → start; all `skip` → skip; all `error` → error; errored preflights are excluded from the decision so one broken integration cannot block work another preflight found). First change — **the agent prompt is assembled from `start` results only**: the agent does not care about `skip` or `error` content, so those never enter the prompt; they go to the cycle report/transcript and logs instead. Second change — the inter-script state file (`data/preflight-state.json`) becomes an in-memory per-run context object passed to each preflight: same behavior, no file. Capacity gating stays inside the preflights for the port. Lease locking stays out of the package entirely (dispatcher scope, REHOR-218).
- Migration is bundled with Hypershell adoption (decided): moving to Hypershell requires the OpenCode runtime and the TS preflight package together — an agent adopts both as one step, declaring its preflights in `instance.yaml`. Dual-running (Python preflights and TS preflights both available) exists only for the verification window under REHOR-232; once every agent is migrated, the old Python preflight system — the shared scripts, the in-runner path, and the dispatcher's Python stopgap — is removed.
- Shared helpers (`common.py`, `jira_mcp.py`) become internal shared modules of the package — one HTTP client, one memory-server client, one Jira client, one formatter set — so new central preflights reuse them by construction.
- Delivery contract unchanged (decided): the aggregated prompt (start contents only) flows to the sandbox through the existing prepared-input delivery from REHOR-226/233 — stdin→0600 file with per-exec `REHOR_INPUT_SOURCE=sandbox`/`REHOR_INPUT_FILE` via OpenShell. No new delivery mechanism is introduced; preflights already emit Markdown content, and prompt synthesis stays where it is today (in the preflights), not in a new layer.

### Example `instance.yaml` preflight entries

The following examples illustrate the settled entry syntax and semantics.

**1. Default agent — no preflight field at all.** The instance inherits the central default set registered for its workflow. That mapping is dispatcher-side data in the preflight package — it is *not* workflow content and is not baked into the runner image:

```ts
// packages/preflights/src/defaults.ts (central, proposed)
export const workflowDefaults: Record<string, string[]> = {
  // The jira-sprint preflight itself requires `label`, so agents declare it
  // explicitly; only no-required-input preflights live in the default set.
  "jira-sprint": ["gh-pr-status", "gl-mr-status"],
};
```

A custom workflow (`workflow: ./workflows/pilot-agent`) has no central default, so those agents must list preflights explicitly (example 2/3/4) — the entry shape is identical either way.

Default sets may only reference preflights with no required inputs. A preflight with required inputs must always be declared explicitly in `instance.yaml` — an inherited default must never hide a required value the agent cannot supply. In practice a `jira-sprint`-workflow agent declares `- id: jira-sprint` with its `label` explicitly and lists the two status-check shorthands alongside it.

The field follows the existing `envs` semantics of `instance.yaml`: omitted → the workflow's default set applies; `[]` → no preflights; an explicit list → exactly those entries (it replaces the default set, no merging).

**2. Shorthand list — override the selection, defaults for params:**

```yaml
# instance.yaml
preflights:
  - jira-triage
  - gh-pr-status
```

A shorthand entry (`- <id>`, no `with:`) means every input uses its declared default. It is valid only for preflights that declare no required inputs — `gh-pr-status`, `gl-mr-status`, and `jira-triage` have none. A preflight with required inputs (`jira-kanban` needs `project`/`label`) must use `id` + `with:`; shorthand for it fails validation with `missing required parameter`. Shorthand is unrelated to being extra to a workflow — any entry, in an explicit list or in the central default set, may be shorthand if its inputs are all optional.

**3. Parameterized entry — `id` + `with:` map:**

```yaml
# instance.yaml
preflights:
  - id: jira-kanban
    with:
      project: REHOR            # required
      label: rehor-pilot        # required
      statuses: [New, Backlog, "To Do"]   # optional, default shown
      jql_extra: 'AND priority not in ("Undefined")'   # optional
      email: rehor-bot@example.com        # optional, bot-assigned fallback
      interrupted_retry_minutes: 30        # optional cooldown override
  - gh-pr-status               # shorthand mixed with parameterized entries
```

**4. Coexistence with existing `instance.yaml` fields:**

```yaml
# instance.yaml
workflow: ./workflows/pilot-agent
envs: [browser]
runtime: opencode
provider: rehor-openai
model: gpt-6-luna
preflights:
  - id: jira-kanban
    with:
      project: REHOR
      label: rehor-pilot
  - gh-pr-status
```

The entry syntax is settled on `id` + `with:`, following the GitHub Actions `uses:`/`with:` convention already used throughout this repo's `.github/workflows/*`. It is not a new DSL: `with` is a plain YAML map whose keys are the inputs each preflight declares (its parameter schema in the package — the analogue of an action's `inputs:` block), and values are validated fail-closed against that schema.

**5. Invalid configuration — fails closed before any preflight runs:**

```yaml
# instance.yaml
preflights:
  - jira-kanban          # missing required `project` and `label`
  - gh-pr-statuss        # unknown preflight id (typo)
  - id: onboarding
    with:
      labels: rehor-pilot   # unknown parameter name (it is `label`)
```

Validation reports every failing entry with its reason, derived from the Zod issues (`jira-kanban: missing required parameter "project"`, `gh-pr-statuss: unknown preflight id`, `onboarding: unknown parameter "labels"`) and the dispatcher refuses to dispatch the instance — no partial execution, no silent "no work". Raw Zod error text is not surfaced verbatim; the dispatcher maps issue paths to the stable message format shown here so agent owners get actionable, predictable errors.

## Port inventory mapping (proposed ids)

| Python script | Preflight id (proposed) |
| --- | --- |
| `gh_pr_status.py` | `gh-pr-status` |
| `gl_mr_status.py` | `gl-mr-status` |
| `jira_sprint_preflight.py` | `jira-sprint` |
| `jira_kanban_preflight.py` | `jira-kanban` |
| `jira_triage.py` | `jira-triage` |
| `onboarding_preflight.py` | `onboarding` |

## Affected tickets

The spike must record a verdict for each of these; this input constrains the direction:

- [REHOR-231](https://redhat.atlassian.net/browse/REHOR-231) — declarative execution: shaped by the `instance.yaml` preflight schema above.
- [REHOR-230](https://redhat.atlassian.net/browse/REHOR-230) — helper port shape: providers/preflights in the central TS package, not importable author helpers.
- [REHOR-232](https://redhat.atlassian.net/browse/REHOR-232) — fleet migration epic: port inventory above is its backlog.
- [REHOR-219](https://redhat.atlassian.net/browse/REHOR-219) — broad preflight migration task: to be reconciled/absorbed by the spike verdicts.
- [REHOR-218](https://redhat.atlassian.net/browse/REHOR-218) — session vs task-scoped locking: stays dispatcher-side, out of the preflight package (see the aggregation bullet above).

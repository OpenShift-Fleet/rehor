# @rehor/preflights

Shared preflight implementations for Rehor agents: a private npm workspace package — consumed by `@rehor/agent-dispatcher` through its two declared public entrypoints, the package root and the `@rehor/preflights/preflights` subpath (see [Consuming the package](#consuming-the-package)) — never published to any registry. The dispatcher owns execution; agent configuration repositories never ship executable code. An agent's `instance.yaml` selects preflights by id and supplies plain literal parameters; every implementation lives in this package, registered centrally behind one registry. Inputs are validated fail-closed with Zod before anything executes, and a configuration failure (`invalid`) is distinct from an execution failure (`error`). External systems are reached exclusively through the auth proxy, which injects credentials on the upstream leg.

Design rationale: [`spikes/preflight-rework-input.md`](../../spikes/preflight-rework-input.md) (not published on the documentation site)

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
 - `registry.ts` — `definePreflight` and `createPreflightRegistry`; unknown lookups return `undefined` (fail closed), duplicate ids throw at construction.
  - `entry.ts` — the Zod shape of one `preflights:` entry: a shorthand string or `{ id, with }`.
 - `validate.ts` — `validateConfig`: whole-list validation before execution, stable per-entry messages; optional `deferValue` defers placeholder value checks to `validateResolvedParams` after rendering.
  - `results.ts` — the `start` / `skip` / `error` execution results plus the pre-execution `invalid` representation.
  - `defaults.ts` — `workflowDefaults` and `validateWorkflowDefaults`.
- **`src/shared/`** — internal modules the preflight implementations import directly: the HTTP client factory, the memory-server client, the Jira REST client, the GitHub client with its `defineGitHubPreflight` factory, the run context (`createPreflightRunContext`), the failure-evidence and deterministic task-key helpers, and the repos/time/format/strings helpers.
- **`src/preflights/`** — one directory per preflight plus `index.ts`, the registration barrel (`createPopulatedRegistry`). `jira-common/` holds the triage and candidate logic the Jira preflights share; it is not a registered preflight itself.

## Consuming the package

Two public entrypoints, both resolving to build output under `dist/` — `.js` at runtime, `.d.ts` for types, with declaration emit on and deep `dist/` imports refused by the exports map:

- `@rehor/preflights` — the core contract (`validateConfig`, the entry schemas, `definePreflight`, `createPreflightRegistry`, `workflowDefaults`, …) plus `createPreflightRunContext`.
- `@rehor/preflights/preflights` — `createPopulatedRegistry`, the zero-argument barrel with every registered preflight.

```ts
import { validateConfig } from "@rehor/preflights";
import { createPopulatedRegistry } from "@rehor/preflights/preflights";

const registry = createPopulatedRegistry;
const result = validateConfig(preflights, registry); // the parsed `preflights:` list
```

A consumer smoke test links the package by name from a scratch package outside the repository, imports both entrypoints at runtime, and typechecks a strict NodeNext consumer against the emitted declarations. The dispatcher imports these entrypoints, validates each agent's configuration against the populated registry, and executes registered checks; see the [dispatcher preflight reference](../agent-dispatcher/README.md#agent-work-preflights).

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

The registered ids — one registration line each in `createPopulatedRegistry` (`src/preflights/index.ts`):

| id           | purpose                                            | required inputs       | optional inputs (default)                                                       |
| ------------ | -------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| fabric-konflux-bot-prs | Konflux bot PR consolidation candidates per repo | —           | `bot_author` (`"red-hat-konflux[bot]"`)                                          |
| fabric-pr-label | labeled GitHub PRs awaiting the Jira claim step | —                  | `pr_label` (`"dev-bot"`), `gh_user_name` (`""`)                                  |
| fabric-project-state | coordinator project snapshot (Jira scope + PR-only changes) | `controlLabel`, `implementationLabel`, `teamFieldId` | `project` (`"RHCLOUD"`), `includeBacklog` (`false`)              |
| fabric-review-queue | one labeled PR needing review, resume, approval, or a feedback check | `review_label`, `bot_login` | —                                                              |
| gh-pr-status | GitHub PR status of the active tasks               | —                     | `suppress_terminal_if_addressed` (`false`), `task_key_prefix` (—), `review_bot_author` + `review_bot_markers` (pair, —) |
| gl-mr-status | GitLab MR status of the active tasks               | —                     | `suppress_terminal_if_addressed` (`false`)                                       |
| hcc-merged-pr-violations | merged PRs with failed non-security checks | —            | `scan_only_repos` (—), `lookback_hours` (24), `max_concurrent` (5), `max_prs_per_repo` (50), `task_prefix` (`"merge-violation"`) |
| hcc-quality-jira-feedback | new human Jira feedback on ongoing quality tasks | — | `task_prefixes` (`["merge-violation", "test-scan"]`) |
| hcc-test-anti-pattern-scan | test-file discovery for anti-pattern analysis | `scan_only_repos` | `max_repos_per_scan` (3), `max_files_per_repo` (20), `task_prefix` (`"test-scan"`), `patterns` (`["**/*.spec.ts", "**/*.test.ts"]`), `framework_indicators` (`["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]`), `exclude_substrings` (`["node_modules/", "dist/", "build/", ".playwright/", "playwright-report/", "test-results/"]`) |
| hcc-weekly-report | weekly-report task dispatch (generate / feedback / merge) | `repo` | `branch_pattern` (`"hcc-team-weekly-report"`), `merge_hour_utc` (10)             |
| jira-sprint  | active-task triage + sprint/backlog candidate search | `label`             | `include_backlog` (false), `email` (—), `interrupted_retry_minutes` (30)         |
| jira-kanban  | active-task triage + kanban candidate search        | `project`, `label`    | `statuses` (`["New", "Backlog", "To Do"]`), `jql_extra` (—), `email` (—), `interrupted_retry_minutes` (30) |
| jira-triage  | active-task triage only                            | —                     | `interrupted_retry_minutes` (30)                                                 |
| onboarding   | onboarding candidates + phase advancement          | `label`               | `project` (`"REHOR"`)                                                             |
| renovate-discover | failing Renovate PRs not yet tracked          | —                     | `task_key_prefix` (`"renovate-fix:"`), `repo_keys` (—), `bot_logins` (`["renovate[bot]", "renovate", "app/renovate"]`), `max_active` (10) |
| renovate-pr-status | Renovate workflow PR/CI/feedback status      | —                     | `task_key_prefix` (`"renovate-fix:"`)                                             |

### `fabric-review-queue`

Port of the Fabric review-only workflow preflight `01-review-queue.py` (parity reference: Fabric commit `37d5263`): scans the instance's GitHub repositories for the one labeled PR needing a review, resume, verification command, feedback check, contextual `/review-bot` reply, or lifecycle transition. `start` content is the JSON object `{"work": …, "discovery_errors": […]}` with the same fields and values the Python preflight emitted — the migrated agent runner parses it unchanged. Field insertion order follows the Python dict order, so the serialized form differs from `json.dumps` only in separator whitespace. Skip and error contents use the Python message formats verbatim (`No labeled PR needs review or feedback handling`, `Waiting for organization-member review approvals on <repo>#<n> (<state>)`, `Review instance at task capacity (<active>/10)`, `; `-joined per-PR discovery errors). All GitHub traffic rides the run context's proxy route; the memory-server task listing is instance-scoped and fully paginated. Requires `review_label` and `bot_login` (the proxy identity must match `bot_login`).

Deliberate deviations from the Python reference — every one of them fail-closed (skip/error outcomes only, never a different start shape):

- **Ledger hand-off** — Python decoded the tracked status review and wrote a runner-local `work.ledger_path` file. The dispatcher preflight cannot place a file in the runner's sandbox, so a restored ledger is signaled with `work.ledger_restore = "runner"` (plus `ledger_restore_pending` for a matching pending publication): the runner restores the same GitHub payload itself. `update_count`, `pr_summary`, and `risk_assessment` are still decoded in the preflight with Python's exact validation (`review_ledger.py`'s marker, zlib, schema, and public-ledger rules are ported in `fabric-review-queue/ledger.ts`), so their values match Python. A legacy `metadata.ledger_path` from the pre-migration runtime is not readable from the dispatcher and falls through to ledger recovery.
- **Revision-continuity gates** — approvals (`organization_member_approved`), ledger-recovery consent, same-SHA resumes, and matching pending publications never dispatch: neither PR snapshots nor the available REST label events prove the head/base pair never changed and returned between polls. Python's GraphQL-independent REST flow has the same evidence limit; the Python preflight nonetheless starts those paths, so this port reports them as per-PR discovery errors (`cannot verify revision continuity`) and keeps scanning. Relaxing the gate requires a durable revision-event epoch (a GraphQL timeline capability) that this port does not implement.
- **Hardened inputs** — malformed issue-comment feeds, malformed review-label events, unknown task statuses, and membership-verification failures are per-PR errors rather than soft skips; a PR comment scan that cannot complete drops the candidate instead of posting an approval request; approval and recovery comment copy states that consent does not start a review until continuity is verifiable, and carries an extra `review-approval-context` marker binding the request to the task state it was issued under (the `RA-`/`LR-` marker formats Python parses are unchanged).
- **Cross-instance guard** — a globally tracked task for the same PR key suppresses re-review even when it belongs to another instance (Python's instance-scoped listing could not see it).
- **Error repetition** — Python's multi-pass re-scan (after approval waits) re-appends cached per-PR scan errors on every pass, so its `discovery_errors` can repeat entries; this port scans once and reports each error once.

Deployment validation still required before rollout (these cannot be established by the mocked contract tests):

1. **Live PATCH through the stage proxy** — rebind one approval comment on a test PR: `PATCH /repos/{owner}/{repo}/issues/comments/{id}` with a `{"body": …}` JSON payload must return 200 through the `/github` proxy route (the upstream credential needs issue-comment write permission; PR conversation comments are issue comments, not pulls review comments). The mocked 403 contract test only proves the fail-closed handling.
2. **Live consent-comment writes** — one `POST /repos/{owner}/{repo}/issues/{n}/comments` and one approval-label add/remove, confirming the same credential's write scope end to end.
3. **Live membership semantics** — `GET /orgs/{org}/members/{user}` must answer 204/404 through the proxy for a known member/non-member pair (a private-membership 302 or any other status fails closed by design).
4. **GraphQL timeline capability** — not implemented; no `/graphql` request is made. If the revision-continuity gates are ever to be relaxed, first validate one GraphQL timeline query for `headRefOid`/`committedDate` revision events through the stage proxy, then add the capability behind its own contract tests.

### `gh-pr-status`

Checks the GitHub PRs of the instance's active tasks — state, mergeability, CI check rollup (including Konflux `detailsUrl` extraction), review decisions, and comments — and classifies them into merged / closed / ci_fail / conflict / feedback / clean buckets. `start` (with Markdown for the agent prompt) when any actionable bucket is non-empty, `skip` otherwise. GitHub is reached through the run context's proxy route; bare repo names resolve through the instance project-repos map.

- `suppress_terminal_if_addressed` (default `false`) — the onboarding mode: merged/closed PRs whose feedback was already addressed are not reported as terminal, so the onboarding agent keeps seeing them until it finishes.
- `task_key_prefix` (optional) — scope the active-task scan to external keys starting with this prefix (the Fabric pr-label workflow keeps only `pr-label:*` tasks). Unset keeps every task.
- `review_bot_author` + `review_bot_markers` (optional pair) — count a comment from that login whose body contains any marker (case-insensitive) as new feedback; supplying one without the other is an invalid parameter pair. Without the pair, bot comments are excluded exactly as before.

### `gl-mr-status`

The GitLab counterpart of `gh-pr-status`: checks the MRs of the instance's active tasks — state, pipelines, mergeability/conflicts, unresolved discussion threads, and notes — and classifies them into the same merged / closed / ci_fail / conflict / feedback / clean buckets, with the same addressed-CI and review-feedback rules. `start` when any actionable bucket is non-empty, `skip` otherwise. GitLab is reached through the run context's proxy route (`/gitlab` prefix, gitbeaker transport with a fail-fast custom requester); bare repo names resolve through the instance project-repos map.

- `suppress_terminal_if_addressed` (default `false`) — the onboarding mode: merged/closed MRs whose feedback was already addressed are not reported as terminal, so the onboarding agent keeps seeing them until it finishes.

### `hcc-merged-pr-violations`

Port of the hcc quality-monitor preflight `01-check-merged-prs.py`: scans the instance's GitHub-hosted repos for PRs merged within the lookback window whose check rollup contains `FAILURE` conclusions, excluding security scans (the `lib/security_scans.py` patterns, ported verbatim — a PR whose only failures are security scans is not a violation). `start` with the violation list (repo, PR, title, author, merge date, failed check names) when any exist, `skip` otherwise. Repos come from the instance project-repos map; bare names resolve to their GitHub upstreams, non-GitHub repos are skipped.

The scan runs Mon–Fri 09:00–23:00 Europe/Prague and respects capacity and `max_concurrent`. Each violation is independently gated by `${task_prefix}:{repo}:{pr_number}`; a matching Jira task in any status, including archived, suppresses only that finding. The start content names each untracked finding's task key.

Fetch failures follow the shared failure policy: a repo-listing or PR-detail failure skips that repo/PR and is reported as UNFETCHABLE evidence; when every attempted fetch of a class failed, the run is an `error` naming the required route — never a silent "no violations" skip.

- `scan_only_repos` (optional) — restrict the scan to these repo names; omitted scans every repo in the project-repos map. An empty match skips.
- `lookback_hours` (default `24`, positive int) — merges older than this are ignored; PRs with unparseable `mergedAt` are excluded like the Python.
- `max_concurrent` (default `5`, positive int) — skip while this many violation tasks are already active.
- `max_prs_per_repo` (default `50`, positive int) — merged PRs fetched per repo.
- `task_prefix` (default `"merge-violation"`) — prefix of the per-violation tasks the agent creates.

### `hcc-quality-jira-feedback`

Jira feedback channel for the quality workflow's ongoing tasks — the piece the two scans never had: `hcc-merged-pr-violations` and `hcc-test-anti-pattern-scan` only discover new findings, so once a finding becomes a tracked task, human feedback on its Jira issue had no preflight to pick it up. This preflight inspects the instance's active tasks whose `external_key` starts with one of `task_prefixes` (`merge-violation:{repo}:{pr}`, `test-scan:{repo}:{date}`), reads the linked Jira issue key from the task's `metadata.jira_key`, fetches the issue with every comment through the run context's Jira client, and `start`s when a comment newer than the task's `last_addressed` looks like human feedback. The start content names the original task (`Task ID`) and the Jira key and includes the triggering comments, so the agent resumes the existing task instead of creating a new one, with feedback to be handled before new scans.

The Jira key comes from `metadata.jira_key`, never from the `external_key` — for these tasks the external key is the finding identity (repo/pr or repo/date), not a Jira key, which is exactly why the `jira-triage` family (which treats `external_key` as the Jira key) cannot triage them. A tracked task with a missing or invalid `metadata.jira_key` is a named skip reason on that task — never an unrelated error, and never a link fabricated from the external key.

- Schedule gate: Mon–Fri 09:00–23:00 Europe/Prague — the instance's historical KEDA window — enforced before any fetch through the shared DST-aware schedule helper.
- Respects task state: only `in_progress`/`pr_open`/`pr_changes` tasks are fetched; paused, done, and archived tasks never start. Active tasks are read through one fully paginated status query per active status, so no newest-50 listing cap can hide an older active task. No interrupted/stale retry — a task without new feedback is clean, and there is no capacity or daily-marker gate.
- Legacy task pickup (user-approved): besides the instance's own attributed rows, active tasks with no `instance_id` at all — the original quality workflow's tasks — are also picked up, under a strict ownership constraint: the task's `external_key` must match a quality prefix and name, in its deterministic `{prefix}:{repo}:{suffix}` form, a repository that exists as an exact key of the instance's project-repos map with a resolvable upstream (metadata keys like `_config` or entries without an upstream never count), and a populated `task.repo` must agree with that key. A missing or empty repo map therefore selects no unattributed task — no broadening — while instance-attributed quality tasks stay selected without one, as before.
- Reading the unattributed half is a global read with an ambiguity: the fetch scans the global status-filtered listing (no `instance_id` query) and filters client-side, keeping only rows attributed to the run's instance or truly unassigned; rows naming another instance — and empty-string `instance_id`s, which are not "unassigned" — stay excluded however well their key matches. Ownership of an unattributed row is genuinely ambiguous, which is why the configured-repo match above is the admission gate, and why the memory client still refuses the fetch without a configured instance id. The two fetch scopes (instance-scoped and unattributed-including) are cached separately per run.
- Fail policy (the jira family's, not the scans' FetchTracker tolerance): any memory or Jira fetch failure is an `error` result — for a feedback check, a tolerated fetch failure would silently skip the very feedback this preflight exists to surface.
- Feedback detection is the jira triage family's heuristic plus the gh-pr-status author normalization: a comment counts when it is newer than `last_addressed`, does not carry the structured bot markers (`### `, `| `, `PR:`), and its author's display name is not an obvious bot account (`[bot]`, `*-bot`, `*-robot`, `github-actions`, `dependabot`, `renovate`). This is a heuristic, not robust human filtering: bot accounts with human-looking persona names — the instance's own Jira user among them — are indistinguishable from humans by these signals, so a marker-less comment from such an account still counts as feedback. Correctness also rests on the agent stamping `last_addressed` when it addresses feedback.
- `task_prefixes` (default `["merge-violation", "test-scan"]`) — external-key prefixes of the tracked per-finding tasks. The colon matters: the `${prefix}-${date}` daily scan-marker tasks are deliberately not matched.

### `hcc-test-anti-pattern-scan`

Port of the hcc quality-monitor preflight `02-scan-test-anti-patterns.py`: lists the file tree of the first `max_repos_per_scan` whitelisted GitHub-hosted repos, matches test files by suffix pattern (excluding configured path substrings, capped at `max_files_per_repo` per repo), detects the framework (`playwright` when any indicator file is present, else `generic`), and emits the compact per-repo file list the agent analyzes for anti-patterns. `start` when any test files were found, `skip` otherwise.

The scan runs Mon–Fri 09:00–23:00 Europe/Prague and respects capacity and a five-active-task limit. A task keyed `${task_prefix}:{repo}:{UTC date}` in any status suppresses that repository only. After analyzing a repository, the agent must record its scan even when no ticket is needed; a ticketed task remains active with `metadata.jira_key` for feedback. Repositories with no matching test files have no tracking task and are checked again on subsequent preflights.

Pattern matching follows the Python scanner's simplified suffix rules: recognized test suffixes match regardless of directory prefix (`e2e/**/*.test.ts` matches any `.test.ts` file). Other patterns match a literal suffix after removing `**/` and leading `*`. A file is excluded when any `exclude_substrings` entry is a substring of its path. Listing failures follow the same shared failure policy as `hcc-merged-pr-violations` (isolated with evidence; all attempted failing → `error`).

- `scan_only_repos` (required, nonempty) — the whitelist of repo names; this scan is intentionally scoped, never fleet-wide. An empty match against the project-repos map skips.
- `max_repos_per_scan` (default `3`, positive int) — repos scanned per run, in map order.
- `max_files_per_repo` (default `20`, positive int) — test files analyzed per repo.
- `task_prefix` (default `"test-scan"`) — prefix of the per-repository daily scan tasks the agent creates.
- `patterns` (default `["**/*.spec.ts", "**/*.test.ts"]`) — test file patterns, suffix-matched as above.
- `framework_indicators` (default `["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]`) — file-path substrings that mark a repo as using the framework.
- `exclude_substrings` (default `["node_modules/", "dist/", "build/", ".playwright/", "playwright-report/", "test-results/"]`) — path substrings that exclude a file.

Example quality-monitor preflight selection:

```yaml
preflights:
  - hcc-quality-jira-feedback
  - id: hcc-merged-pr-violations
    with:
      scan_only_repos: [insights-chrome, landing-page-frontend, astro-virtual-assistant-frontend]
  - id: hcc-test-anti-pattern-scan
    with:
      scan_only_repos: [insights-chrome, landing-page-frontend, astro-virtual-assistant-frontend]
```

The instance workflow must record each completed repository scan, including scans that need no Jira ticket, and store `metadata.jira_key` on ticketed tasks. Registering these preflights alone does not migrate or deploy the instance.

### `hcc-weekly-report`

Port of the hcc manager-tasks preflight `01-task-dispatch.py`: decides which weekly-report phase the cycle is in. It runs Monday and Tuesday 07:00–21:00 Europe/Prague; the reporting week is keyed `weekly-report-{friday}` using the UTC calendar. Monday without a task for the week starts the *generate* phase; a task with new PR feedback starts the *feedback* phase; Tuesday at or after `merge_hour_utc` UTC starts the *merge* phase; merged/closed/done/archived/paused tasks and everything else skip.

The task is looked up by `external_key` in the memory server; its PRs are enriched through the gh-pr-status machinery (`enrichGh`/`hasNewFeedback`) with the same failure policy — an isolated PR/comment fetch failure is tolerated with evidence, a total fetch failure is an `error` naming the required route.

- `repo` (required) — upstream repository of the weekly reports, `owner/repo` (the Python `UPSTREAM_REPO` constant).
- `branch_pattern` (default `"hcc-team-weekly-report"`) — the branch name pattern (Python `BRANCH_PATTERN`); the generate content names `{git_user}/{branch_pattern}-{friday}`.
- `merge_hour_utc` (default `10`, integer 0–23) — UTC hour from which the Tuesday merge step may run (Python `MERGE_HOUR_UTC`).

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

### `renovate-discover`

Port of the Renovate workflow's `01-renovate-discover.py`: scans the instance's GitHub-hosted repositories for open, non-draft Renovate-authored PRs whose check rollup has a `FAILURE` and whose branch is not conflicted, then separates untracked work from tasks already covered by the status preflight. `start` when at least one untracked PR is actionable; `skip` otherwise, so a quiet cycle creates no sandbox.

Tasks are keyed `renovate-fix:<repo-key>#<number>` (`task_key_prefix` configurable). A task with an active status (`in_progress`, `pr_open`, `pr_changes`), or a paused task whose `paused_reason` is neither empty nor `transient:*`, is treated as tracked and stays out of AUTO-FIX. Paused `transient:*` tasks (and tasks with no recorded reason, for backwards compatibility) re-enter AUTO-FIX with `resume:paused`; terminal `done` tasks re-enter with `resume:done` so the agent re-activates the existing task instead of duplicating it. The start content carries the head ref/owner/repo and cross-repository flag the agent stores in task metadata.

The task list is fetched once per run and shared with `renovate-pr-status` (declare discovery first). If the task API is unavailable, discovery `skip`s rather than risk treating tracked or paused work as new; memory authorization rejections remain `error`. Active capacity is counted from that same task list — not a separate capacity call that could fail open — and new work is withheld at `max_active`. Paused retries proceed at capacity because they do not consume a new slot. GitHub listing/detail failures follow the shared failure policy: isolated failures are skipped with UNFETCHABLE evidence, a run where every attempted fetch of a class failed is an `error` naming the required route.

- `task_key_prefix` (default `"renovate-fix:"`, nonblank) — external-key prefix of this workflow's tasks. Both Renovate preflights must use the same value.
- `repo_keys` (optional, nonempty) — restrict discovery to these keys of the instance `project-repos.json`; unset scans every mapped repo. Non-GitHub and unresolvable entries are skipped.
- `bot_logins` (default `["renovate[bot]", "renovate", "app/renovate"]`, nonempty) — GitHub logins treated as Renovate authors (case-insensitive exact match).
- `max_active` (default `10`, positive integer) — active-task capacity for new work.

### `renovate-pr-status`

Port of the Renovate workflow's `02-gh-pr-status.py`, the workflow-specific layer over the shared `gh-pr-status` view. Active tasks are classified into the same six buckets, with four Renovate rules on top:

- CI failures always retry, even when `last_addressed` would suppress them — a partially fixed CI run needs another session.
- A conflict on the Renovate PR alone is suppressed (Renovate rebases on its own), unless the task also has new human feedback. Once `metadata.fix_pr` exists, a fix-PR conflict stays visible because rebasing it is the bot's job.
- After `metadata.fix_pr` exists, CI, conflicts, reviews, and comments come from the fix PR; the Renovate PR remains the MERGED/CLOSED lifecycle signal. If the fix PR cannot be read, the task stays in CI FAILING instead of falling through to green Renovate checks.
- Paused tasks with new human feedback are promoted into a `### BLOCKED FEEDBACK` section (Priority 1), except when the Renovate PR is already merged/closed.

`start` when any active bucket is actionable or any blocked feedback exists; `skip` otherwise. The preflight does not create tasks or start work on its own; the workflow prompt decides which one item to claim.

- `task_key_prefix` (default `"renovate-fix:"`, nonblank) — must match `renovate-discover`.

Activating the workflow requires both ids declared explicitly in the instance profile; the workflow has no central default set. Example:

```yaml
preflights:
  - renovate-discover
  - renovate-pr-status
```

The order matters: `renovate-discover` populates the shared per-run task cache that `renovate-pr-status` reuses. A profile whose `preflights` list is empty runs no checks and dispatches no session.

## Differences from the Python implementation

The port preserves statuses, aggregation rules, formatting, and cooldowns. Beyond the transport switch — `gh`/`glab` CLI subprocesses and the Jira MCP client replaced by SDK clients on the auth-proxy route — these deliberate changes exist:

- The `hcc-*` preflights port custom instance workflows. Time windows and per-finding task keys replace runner-local cycle sleeps; instance settings become `with:` parameters. A separate Jira feedback check can resume ongoing quality tasks. The agent creates and updates tasks, not the preflight.

- The agent prompt is assembled from `start` results only; `skip` and `error` content goes to the cycle report and logs instead.
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

All new dispatcher checks must be contributed to this repository through a pull request. Instance repositories may select and configure registered checks, but must not contain executable preflight code.

1. Create a directory under `src/preflights/`.
2. Define the preflight with `definePreflight`: a stable string `id`, a Zod `strictObject` input schema (the typed single source of truth — `z.infer` derives the param types, and strict mode makes unknown parameter names fail closed), and a `run(ctx, params)` function.
3. Add exactly one registration line in `createPopulatedRegistry` in `src/preflights/index.ts`.
4. Add fixture-based tests (injectable `fetch`; no network).
5. Submit the change here for review; do not implement or register a check only in an instance repository.

This is the audit boundary: enterprise integrations and their credential use are reviewed centrally through the barrel. Sensitive credentials are never handled here — external systems are reached through the auth proxy, which injects credentials on the upstream leg. `definePreflight` throws on an empty id or a non-object input schema, and `createPreflightRegistry` throws on duplicate ids — central-author errors caught at construction, never at agent dispatch time.

## Building and testing

```sh
npm run build --workspace=@rehor/preflights
npm test --workspace=@rehor/preflights
```

`npm test` builds first, then runs `node --test test/*.test.mjs`. The tests are fixture-based and the clients take an injectable `fetch`, so no test touches the network.

Private package — not published to any registry.

# Preflight Reference

Registered checks available to dispatcher-managed agents, with their input parameters. Declare them in the `preflights:` field of `instance/<name>/agent/instance.yaml`; see [Dispatcher Preflights](custom-preflight.md) for declaration semantics and the contribution process.

This page documents the checks registered in this repository's `@rehor/preflights` package. A dispatcher image built from a different revision may register a different set; validation always fails closed on unknown ids.

## Registered checks

| id | Purpose | Required inputs |
|---|---|---|
| `gh-pr-status` | GitHub PR status of active tasks | — |
| `gl-mr-status` | GitLab MR status of active tasks | — |
| `jira-sprint` | Active-task triage + sprint/backlog candidate search | `label` |
| `jira-kanban` | Active-task triage + kanban candidate search | `project`, `label` |
| `jira-triage` | Active-task triage only | — |
| `onboarding` | Onboarding candidates + phase advancement | `label` |

Only checks with no required inputs may appear in a workflow's default set. Currently `jira-sprint` defaults to `gh-pr-status` and `gl-mr-status` when `preflights:` is omitted; an explicit list replaces the defaults entirely.

Parameters accept plain literals only: strings, numbers, booleans, and lists of those. Unknown parameter names, wrong types, and blank required values fail validation before anything executes, with a per-entry message naming the check, parameter, and reason. String parameters may instead carry a tier-2 secret reference — `"${{ secret('name', 'key') }}"` — rendered from a Kubernetes Secret immediately before the entry executes and re-validated against the check's schema; see [Dispatcher Credentials and Secrets](../dispatcher-secrets.md) for the tier rules, freshness, and fail-closed behavior.

## `gh-pr-status`

Checks the GitHub PRs of the instance's active tasks — state, mergeability and conflicts, CI check rollup (including Konflux `detailsUrl` extraction), review decisions, and comments — and classifies them into merged / closed / `ci_fail` / conflict / feedback / clean buckets. `start` when any actionable bucket is non-empty, `skip` otherwise. GitHub is reached through the configured services gateway; bare repo names resolve through the instance `project-repos.json` map.

```yaml
preflights:
  - gh-pr-status                          # shorthand: all defaults
  - id: gh-pr-status                      # parameterized: same check, explicit input
    with:
      suppress_terminal_if_addressed: true
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `suppress_terminal_if_addressed` | boolean | no | `false` | Onboarding mode: merged/closed PRs whose feedback was already addressed are not reported as terminal, so the onboarding agent keeps seeing them until it finishes. |

## `gl-mr-status`

The GitLab counterpart of `gh-pr-status`: MR state, pipelines, mergeability and conflicts, unresolved discussion threads, and notes, classified into the same buckets with the same start/skip decision. GitLab is reached through the configured services gateway (`/gitlab` route); bare repo names resolve through the instance `project-repos.json` map.

```yaml
preflights:
  - gl-mr-status                          # shorthand: all defaults
  - id: gl-mr-status                      # parameterized: same check, explicit input
    with:
      suppress_terminal_if_addressed: true
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `suppress_terminal_if_addressed` | boolean | no | `false` | Onboarding mode, same semantics as `gh-pr-status`. |

## `jira-sprint`

Triages active tasks (new human Jira feedback, interrupted work) and searches for new work candidates: the open sprint's unassigned tickets, then tickets assigned to the bot (when `email` is set), then the backlog (when `include_backlog` is true). Capacity-aware: later passes run only while fewer than ten candidates have been collected. `start` when active tasks need attention or new candidates exist, `skip` otherwise.

```yaml
preflights:
  - id: jira-sprint
    with:
      label: my-team-bot
      include_backlog: true
      email: my-team-bot@example.com
      interrupted_retry_minutes: 30
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `label` | string | **yes** | — | Team label; candidate queries filter on it. Must not be blank. |
| `include_backlog` | boolean | no | `false` | Also search the backlog when the open-sprint passes yield fewer than ten candidates. |
| `email` | string | no | — | The bot's Jira identity; when set, tickets already assigned to the bot are also collected as candidates. |
| `interrupted_retry_minutes` | integer | no | `30` | Cooldown a task blocked on external input waits out before it counts as interrupted again. |

## `jira-kanban`

The same active-task triage as `jira-sprint`, with a kanban candidate search instead of sprint queries: candidates are scoped to a project and a configurable not-started status list. Same start/skip decision.

```yaml
preflights:
  - id: jira-kanban
    with:
      project: MYPROJ
      label: my-team-bot
      statuses: ["New", "Backlog", "To Do"]
      jql_extra: 'AND priority not in ("Undefined")'
      email: my-team-bot@example.com
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | **yes** | — | Jira project the candidate search is scoped to. Must not be blank. |
| `label` | string | **yes** | — | Team label; candidate queries filter on it. Must not be blank. |
| `statuses` | string list | no | `["New", "Backlog", "To Do"]` | Nonempty list of nonblank statuses that count as not started. |
| `jql_extra` | string | no | — | Extra JQL appended to every candidate query. The expression without the leading `AND` also works; the join is normalized. |
| `email` | string | no | — | The bot's Jira identity; bot-assigned tickets are also collected. |
| `interrupted_retry_minutes` | integer | no | `30` | See `jira-sprint`. |

## `jira-triage`

Feedback and interrupted triage of active tasks only — no candidate search. With no active tasks it returns `start` pointing at new Jira work; otherwise `start` when any active task has feedback or was interrupted, `skip` when all are clean.

```yaml
preflights:
  - jira-triage                           # shorthand: all defaults
  - id: jira-triage                       # parameterized: explicit cooldown
    with:
      interrupted_retry_minutes: 60
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `interrupted_retry_minutes` | integer | no | `30` | Cooldown a task blocked on external input waits out before it counts as interrupted again. |

## `onboarding`

Finds new onboarding tickets by label and checks active onboarding tasks for new Jira feedback and phase advancement (PR/MR merged). `start` when any of that is actionable, `skip` otherwise. The PR/MR merge check runs through the services gateway; a missing PR/MR is advisory, while route, authentication, rate-limit, and upstream failures are `error` results.

```yaml
preflights:
  - id: onboarding
    with:
      label: rehor-ai-onboarding-bot
      project: REHOR
```

| Input | Type | Required | Default | Notes |
|---|---|---|---|---|
| `label` | string | **yes** | — | Onboarding label; restricted to `a-z A-Z 0-9 : _ -` because it is interpolated into JQL. |
| `project` | string | no | `"REHOR"` | Jira project for the candidate search. Must not be blank. |

## Result aggregation

Checks run sequentially in declared order, each bounded at 120 seconds. Any actionable `start` among non-errored checks starts a run, even when another check fails; all-`skip` is a skip; all-`error` is an error. The agent prompt contains `start` content only. A failed check is visible in dispatcher logs and the cycle report, never in the prompt.

Checks that reach Jira, GitHub, or GitLab always use the configured services gateway — the dispatcher never contacts those services directly, and credentials are injected by the proxy on the upstream leg.

# Task Outcome Data Spike

Status: proposal

For Fleet / Org Pulse implementation guidance, see the [task outcomes dashboard adoption guide](task-outcomes-dashboard-adoption.md). It documents the current API contract, category-aware counts, filters, compatibility, and rollout sequence.

## Goal

Report trustworthy Rehor success rates by canonical target repository. Task lifecycle (`archived`, `done`) is not an outcome: it does not prove work succeeded.

## Current State

Tasks contain lifecycle status, repository, Jira key, summary, metadata, and zero or more artifacts such as PRs, MRs, Jira issues, commits, or custom workflow references. A task may need evidence from several providers.

Current historical signals are useful for backfill but insufficient for reporting: terminal status, artifact URLs, and summary text do not consistently tell why work ended.

## Outcome Model

The agent LLM labels each evidence item with a bounded resolution. Memory Server reduces those evidence resolutions deterministically; callers do not submit a final task decision.

```json
{
  "artifacts": [
    {
      "type": "github_pr",
      "url": "https://github.com/project-kessel/insights-rbac/pull/3428",
      "baseRepo": "project-kessel/insights-rbac",
      "headRepo": "platex-rehor-bot/insights-rbac",
      "supersedes": []
    }
  ],
  "evidence": [
    {
      "source": "github",
      "reference": "https://github.com/project-kessel/insights-rbac/pull/3428",
      "kind": "state",
      "resolution": "accepted",
      "disposition": "MERGED",
      "reason": "The change is merged into the target repository."
    },
    {
      "source": "jira",
      "reference": "RHCLOUD-42232",
      "kind": "state",
      "disposition": "Release Pending / Done",
      "resolution": "accepted",
      "reason": "Jira resolution confirms completion."
    }
  ],
  "notes": null
}
```

- Every source uses the same evidence envelope with required `source`, `reference`, `resolution`, `disposition`, `reason`, and optional `kind` and `authorType`.
- `kind`: `Literal["state", "comment"]`, default `state`. New comment payloads must set `kind: "comment"`; provider/workflow facts use `kind: "state"`. Legacy payloads may omit it and are treated as state evidence.
- `authorType`: optional `human`, `workflow`, `agent`, or `automation`. Only `kind: "comment"` evidence with `authorType: "agent"` or `"automation"` is excluded from reduction. State facts remain valid regardless of author type. Comments without `authorType` continue to count for compatibility; this does not introduce a broader author filter.
- `resolution`: LLM evidence label, exactly `accepted`, `rejected`, or `unknown`.
- `disposition`: raw source value, not Rehor outcome (e.g. `MERGED`, `Won't Do`, comment text).
- `reason`: LLM explanation for evidence label, retained with evidence.
- `source`: provenance label only. Custom source names are supported; reducer does not branch on provider name.

Reducer is small and order-independent: any `rejected` evidence → `rejected`; else any `unknown` → `inconclusive`; else all relevant evidence `accepted` → `accepted`. LLM labels `Won't Do` disposition accepted/no-op by default unless human/workflow comment or other source evidence says otherwise. No evidence → `inconclusive`.

WIP and unreported are lifecycle-derived: active task → WIP; terminal task without selected report → unreported. A closed-unmerged PR/MR alone does not prove task rejection.

## Task Category

Task category is separate from lifecycle and outcome:

- `delivery` is the default and represents outcome-measured delivery work.
- `monitoring` represents watch-duty tasks whose purpose is observing or following up on external work.
- `grooming` represents ticket assessment and preparation: assessing requirements/actionability, correcting labels and repository mappings, assigning story points, and placing qualified work in the appropriate sprint.

Monitoring and grooming retain actual repository attribution and existing outcome history. Both count toward total tasks, but are excluded from delivery acceptance rate and outcome coverage. They are work categories, not fabricated repositories or terminal outcomes.

New tasks can set `category: "monitoring"` or `category: "grooming"` with `task_add`; existing tasks can be recategorized with `task_update(category="grooming")` or `task_update(category="monitoring")`. Schema rollout defaults existing rows to `delivery`; historical non-delivery tasks therefore need a category-only backfill after qualification. This changes no lifecycle status, timestamps, evidence, outcome report pointer, or append-only history, and can be safely repeated. Task-outcome APIs return category and accept `category=delivery|monitoring|grooming` filters.

### Grooming evidence and repeated checks

Grooming acceptance requires verified evidence of assessment and applicable preparation results: labels/repository mappings, points, and sprint placement. Record what was reviewed, what changed, and why an applicable field needed no change. Task existence, `done`/`archived` status, or a no-op summary alone never proves acceptance. Terminal grooming without a selected report stays `unreported`; missing/unknown evidence produces `inconclusive`; active grooming remains `wip` even with a staged report.

Repeated no-new-ticket checks need a separate no-op adjudication before accepted reporting. Verify the eligible-ticket search and current preparation state, retain the review reference and rationale, then label accepted evidence only if the human/workflow review supports that no-op. Until adjudicated, keep missing evidence unreported or report unknown evidence as inconclusive. The category does not automatically accept no-ops; the shared reducer still consumes explicit evidence resolutions.

## Provider Evidence

| Source | Evidence to retain | Accepted signal |
|---|---|---|
| GitHub | Artifact metadata: base/head repos, number, status, timestamps, URL | Same evidence envelope |
| GitLab | Artifact metadata: target/source projects, IID, status, timestamps, URL | Same evidence envelope |
| Jira | Key/URL, disposition, human/workflow comment evidence | Same evidence envelope; Won't Do defaults to no-op success |
| Custom workflow | Workflow-specific references and checks | Same evidence envelope |

Repository metrics use the same canonical normalization for SQL reads/rollups and report writes: explicit base/target repository → decoded PR/MR target URL → unambiguous legacy artifact `repo` → task `repo` fallback. Preserve nested GitLab subgroup paths when decoding URLs; normalize whitespace, surrounding slashes, `.git`, and query/fragment suffixes consistently. Use legacy artifact `repo` only when no head/source/fork marker makes it ambiguous. Fall back to task `repo` only when no artifact yields a canonical target; deduplicate and sort targets. Head/source forks remain traceability data and never supply a canonical target. With unchanged task/artifact data, staging a report must not move the task between repository groups.

### Jira evidence

Keep Jira workflow status/resolution in raw `disposition`. LLM labels each evidence item with common `resolution` (`accepted`, `rejected`, or `unknown`) and `reason`. `Won't Do` maps to accepted/no-op by default; authoritative human/workflow evidence can override it.

`Obsolete` is a task outcome only when evidence reference identifies the task itself and disposition explicitly says `Obsolete`. A PR/MR can be marked obsolete without making its task obsolete.

## Reporting Interfaces

### Archive MCP contract

Add `task_outcome_report` with required artifact/evidence/notes fields. Existing `task_remove` archives only when a staged report pointer exists. Set `correction=true` on `task_outcome_report` to append a correction without changing lifecycle:

- `artifacts`
- `evidence`: each item has `source`, `reference`, `resolution`, `disposition`, `reason`, and optional `kind` (default `state`) and `authorType`
- `notes`: required, string or null

The `task_remove` MCP tool fails closed when no report has been staged. The task's `outcome_report_id` points to the report selected for its current archive; corrections append a new report and move the pointer, leaving prior reports unchanged. Default REST DELETE also requires a staged report. Only explicit dashboard/manual DELETE with `manual=true` clears the pointer and remains unreported; agents must not use that bypass. Reported `task_remove` archive retries are idempotent and revalidate the selected task-owned report without clearing its pointer or changing its archive timestamp.

### Report freshness

Actual task status changes invalidate the staged pointer except completion to `done`; identical status writes preserve it. Reopening an `archived` task always invalidates its selected report, including reopening to `done`. Changed metadata values also invalidate the pointer, except bookkeeping keys `last_step`, `next_step`, and `status_before_pause`; identical metadata values preserve it. Invalidation leaves append-only report history intact.

Finish evidence-relevant task updates before staging the report, then archive immediately. If the archive freshness guard fails, stage a fresh report from the current work and retry archive only. Never restore or reuse a historical report pointer to satisfy the guard.

### Failed skill recovery

Archive errors must front-load actionable recovery instructions within the first 200 characters because legacy clients truncate error text: ignore misleading `DONE`, stage `task_outcome_report`, then retry archive only. Any tool/script error overrides `DONE` or a zero exit code. Older deployed scripts may already have transitioned Jira, notified Slack, and deleted branches despite a failed archive; inspect completed steps rather than blindly rerunning the skill.

The agent stages `artifacts`, uniform evidence (`source`, `reference`, bounded `resolution`, raw `disposition`, `reason`, optional `kind` and `authorType`), and required nullable `notes` from verified current input/context (`correction=true` if already archived), then retries `task_remove` for the same external key and source type. New comments must use `kind: "comment"`; state facts use `kind: "state"` or legacy omission. Missing or stale reports require fresh evidence from the current work, never a historical pointer. It never fabricates acceptance or submits a final task decision. Missing facts remain a blocker. Transport failures require inspecting task state before retrying.

If cleanup is pending after archive succeeds, sprint/kanban wrap-up scripts provide `--resume-cleanup`: load the archived task with `task_get`, skip Jira transition/comment, and use strict idempotent `task_remove` to verify the selected report before Slack/branch cleanup. Missing/corrupt state or an unreported archive blocks cleanup. `--skip-slack` avoids repeating an already-completed notification; branch deletion tolerates already-deleted branches. `--dry-run` performs read-only lookup and defers the report guard until a real run. Legacy cleanup already complete means retry archive only, with no cleanup rerun.

## Review Decisions

- `accepted`, `rejected`, `obsolete`, and `inconclusive` are effective outcome states derived from the report selected by the task's outcome pointer. `unreported` means terminal (`done` or `archived`) without a selected report; `wip` means lifecycle status is `in_progress`, `pr_open`, `pr_changes`, or `paused`. Lifecycle status and task category stay independent from outcome.
- MCP workflow completion archives require a report, including nullable `notes`. Manual/admin archive changes lifecycle only and remains unreported; it must not invent a decision.
- Agent does not provide final task decision. LLM labels each evidence record with `resolution: accepted|rejected|unknown`; reducer applies fixed priority `rejected > unknown > accepted/no-op`. Its reason comes from winning evidence and remains beside source facts.
- `source` is display/provenance metadata only; new/custom sources work without reducer changes. Source-specific status text stays raw in `disposition`, separate from evidence `resolution`.
- Human/workflow comments can override default Won't Do handling. Only comment evidence marked agent/automation is excluded; comments without `authorType` retain their existing counted behavior. State facts remain valid for every author type. Ambiguous comment intent maps to `unknown`.
- A replacement artifact explicitly lists `supersedes: [artifactIdOrUrl]`. Superseded artifact becomes `obsolete`; its resolution does not poison task outcome. Task-level obsolete is terminal and requires task reference plus explicit `Obsolete` disposition.
- Reports and corrections append to task outcome history. `tasks.outcome_report_id` selects the effective report for a terminal task; it points to an append-only report row. `reportedAt` is immutable server record time and defines report time; `verifiedAt` records provider verification time. For unreported archives and active WIP, `archivedAt` and `lastAddressed` respectively provide lifecycle activity time for date filters.
- Stable task identity is internal `taskId` plus external `(sourceType, externalKey)`. Artifact identity is `(type, URL)`; evidence identity is `(source, reference)` within a report. Canonical repository identity uses PR base repo or MR target project and excludes head/source forks.
- Runtime identity context prefers `external_key` over legacy `jira_key`. Only work-selection, status, and outcome tools (`task_add`, `task_update`, `task_remove`, `bot_status_update`, `task_outcome_report`) select that context; unrelated lookups such as `task_get` must not replace it. Jira-specific workflow names and compatibility aliases remain supported during gradual migration.
- Reports carry optional `runId`, `reportingCycleId`, `attempt`, `workflow`, and `instanceId` correlation fields. `reportingCycleId` identifies cycle that submitted the report; task detail exposes every `cycle_runs` row linked to the task through its stable `taskId` separately.
- Org Pulse consumes Rehor Memory Server summary, paginated task list, and single-task detail APIs through its backend proxy. Rehor owns task identity, outcomes, evidence, and repository rollups; Org Pulse owns caching, proxy errors, and browser presentation.
- Historical backfill is not implemented; summary reports `backfill.state: not_started`. A future runner must be restartable and idempotent per backfill version and stable `taskId`, so retry cannot append duplicate reports. Report creation, pointer update, and task checkpoint must commit atomically without changing lifecycle timestamps.
- Before implementation, define transient-failure retries and exhausted-failure handling. Provider/LLM unavailability must not become accepted or rejected; incomplete but successfully gathered evidence can produce `inconclusive`, while exhausted fetch failures remain visible for retry or manual review.
- Before selecting a backfill report, compare task identity, lifecycle, and evidence-relevant fields against the snapshot used for enrichment. If task changed during processing, discard stale result and requeue from fresh state; never overwrite newer report pointers or lifecycle changes.

### Workflow hook

Custom workflow maintainers can supply:

```text
evaluate_task_outcome(task, workflow_context) -> outcome report
```

The hook may inspect provider state, Jira comments, artifacts, and custom workflow data.

## Metrics

```text
 acceptance rate = delivery accepted /
                   (delivery accepted + delivery rejected + delivery obsolete)
```

Exclude monitoring- and grooming-category tasks, inconclusive, unreported, and WIP from the acceptance-rate denominator. Monitoring and grooming are counted separately; delivery obsolete stays in the denominator but is not acceptance. Outcome coverage uses reported delivery outcomes divided by non-WIP delivery tasks. Show total tasks, delivery tasks, monitoring tasks, grooming tasks, delivery outcomes, reason breakdown, and provider coverage. `groomingOutcomes` separately exposes grooming-only accepted, rejected, obsolete, inconclusive, unreported, and WIP counts at both global and repository levels. Reason/provider breakdowns remain delivery-only. Dashboard explanations distinguish watch-duty monitoring, ticket-preparation grooming, and delivery.

## Migration

1. Add append-only report storage, current-report pointer, API schema, and outcome APIs.
   - Task category defaults to `delivery` on fresh and existing schemas. Installation replaces the deployed `tasks_category_check` constraint to allow `delivery`, `monitoring`, and `grooming`; `ADD COLUMN IF NOT EXISTS` alone cannot widen an existing two-value CHECK. Replacement is atomic and safe to rerun, including after grooming rows exist. It does not recategorize rows or rewrite reports.
2. Add `task_outcome_report`; gate `task_remove` on a staged report.
3. Add cleanup hooks for workflow-specific evaluation.
4. After defining the checkpoint, retry, and concurrent-change rules above, run historical migration after schema deployment:
   - Enumerate every existing task and its artifacts.
   - Fetch deterministic GitHub, GitLab, and Jira facts where references exist.
   - Use an LLM to adjudicate multi-artifact or custom-workflow history from task summary, provider facts, comments, and changelog evidence.
   - Write one outcome report per task without changing original task lifecycle timestamps.
   - Mark insufficient or conflicting evidence `inconclusive` with reasons such as `artifact_missing`, `provider_unavailable`, `historical_state_unavailable`, or `evidence_conflict`.
5. Produce and retain a reconciliation report: accepted, rejected, inconclusive, conflicting, missing references, and LLM/manual-review candidates.

The backfill is one versioned operation, but execution can resume across process restarts to retry unfinished tasks. After backfill, new tasks use MCP reports and workflow hooks rather than later LLM reconstruction.

## Aggregation API

Compact rollup for Org Pulse:

```text
GET /api/task-outcomes/summary?from=&to=&repo=&category=
```

The response must include both holistic computation and repository breakdown:

```json
{
  "period": { "from": "2026-09-01", "to": "2026-09-30" },
  "summary": {
    "acceptanceRate": 0.82,
    "outcomeCoverage": 0.99,
    "taskCount": 939,
    "deliveryTaskCount": 900,
    "monitoringCount": 29,
    "groomingCount": 10,
    "groomingOutcomes": {
      "acceptedCount": 3,
      "rejectedCount": 1,
      "obsoleteCount": 1,
      "inconclusiveCount": 2,
      "unreportedCount": 2,
      "wipCount": 1
    },
    "repositoryCount": 132,
    "acceptedCount": 675,
    "acceptedNoOpCount": 0,
    "rejectedCount": 145,
    "obsoleteCount": 3,
    "inconclusiveCount": 12,
    "unreportedCount": 10,
    "wipCount": 55
  },
  "repositories": [
    {
      "repo": "project-kessel/insights-rbac",
      "acceptanceRate": 0.83,
      "outcomeCoverage": 0.97,
      "taskCount": 38,
      "deliveryTaskCount": 32,
      "monitoringCount": 2,
      "groomingCount": 4,
      "groomingOutcomes": {
        "acceptedCount": 1,
        "rejectedCount": 0,
        "obsoleteCount": 0,
        "inconclusiveCount": 1,
        "unreportedCount": 1,
        "wipCount": 1
      },
      "acceptedCount": 24,
      "acceptedNoOpCount": 0,
      "rejectedCount": 4,
      "obsoleteCount": 1,
      "inconclusiveCount": 1,
      "unreportedCount": 1,
      "wipCount": 1,
      "reasons": { "merged": 20, "duplicate": 4 },
      "providers": { "github": 27, "jira": 24 }
    }
  ],
  "metricDefinitions": {
    "acceptanceRate": "accepted / (accepted + rejected + obsolete) for delivery-category tasks; monitoring and grooming excluded",
    "outcomeCoverage": "reported delivery outcomes / (delivery tasks - delivery WIP); monitoring and grooming excluded",
    "monitoring": "Watch-duty tasks; counted separately and excluded from delivery outcome metrics.",
    "grooming": "Ticket assessment/preparation (labels/repository mappings, points, sprint); outcomes reported separately and excluded from delivery metrics. Task existence, done status, or a no-new-ticket check does not prove acceptance; repeated checks require separate no-op adjudication."
  },
  "freshness": { "generatedAt": "2026-09-23T10:00:00Z" },
  "backfill": { "state": "complete", "unknownCount": 9 }
}
```

`acceptanceRate` is delivery `accepted / (accepted + rejected + obsolete)`. Obsolete covers work superseded or handed off, so it must not count as acceptance. Monitoring and grooming are not delivery attempts: count them in `monitoringCount` and `groomingCount`, retain them in `taskCount`, and exclude them from acceptance rate and outcome coverage. `groomingOutcomes` contains grooming-category states only; its six counts sum to `groomingCount`. All top-level outcome counters, `acceptedNoOpCount`, reasons, and providers remain delivery-only. Multi-repository tasks count once globally and once per canonical repository. Inconclusive evidence remains outside the acceptance-rate denominator; unreported and WIP remain visible separately. `acceptedNoOpCount` counts accepted delivery reports with any evidence item whose disposition is `Won't Do`; it does not imply no other work or code change occurred. See the [dashboard adoption guide](task-outcomes-dashboard-adoption.md#what-the-no-op-counter-actually-measures) for its exact evidence matching rules. `outcomeCoverage` is `(delivery accepted + rejected + obsolete + inconclusive) / (deliveryTaskCount - delivery wipCount)` and shows how much non-WIP delivery work has any outcome report. The API's required `metricDefinitions.grooming` supplies the ticket-preparation explanation and no-op adjudication rule for dashboard notes. Category filters narrow rows before every rollup; a grooming-only summary has null delivery rates and zero delivery counters.

Filtered, paginated task details:

```text
GET /api/task-outcomes/tasks?repo=&category=&decision=&confidence=&reason=&source=&from=&to=&limit=50&offset=0
```

Return task lifecycle, outcome, artifacts, uniform evidence fields, canonical repositories, and report/verification timestamps. Provider-specific status lives in evidence.disposition. Use stable ordering and unchanged filters across pages.

Full history for one stable internal task identifier:

```text
GET /api/task-outcomes/tasks/{task_id}
```

The detail response includes every immutable outcome report in insertion order and all `cycle_runs` linked to the task. `reportingCycleId` identifies only the cycle that submitted each report. `acceptanceRate` is `null` when no accepted, rejected, or obsolete outcomes exist; `outcomeCoverage` is `null` when no non-WIP tasks exist. Date filters include both UTC date bounds and use the latest report timestamp, archive timestamp for unreported archives, or last-addressed timestamp for active work.

## Acceptance Criteria

- Existing tasks remain readable.
- Multiple artifacts and evidence records supported.
- Archive MCP outcome enforcement and custom workflow hook implemented.
- GitHub, GitLab, and Jira evidence paths normalized.
- Fork-to-base repository mapping retained.
- Inconclusive and conflicting evidence reported.
- Historical reconciliation and aggregation API available.

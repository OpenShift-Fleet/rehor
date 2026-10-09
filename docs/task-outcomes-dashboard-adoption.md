# Task outcomes: Fleet and Org Pulse dashboard adoption

This guide is for the Fleet / Org Pulse dashboard developer integrating the Memory Server task-outcome APIs. Use the server's category-aware rollups for delivery metrics and show monitoring and grooming separately. A task's category, lifecycle, effective state, and selected outcome report answer different questions.

The implementation contract is [task_outcomes.py](../memory-server/bot_memory_server/task_outcomes.py), with response shapes in [shared/openapi.yaml](../shared/openapi.yaml). The [task outcomes spike](task-outcomes-spike.md) covers evidence reduction, archival, and design history. This document describes adoption of the current implementation rather than asserting that it is already deployed.

## Ownership and integration surface

Memory Server owns task identity, evidence, outcome reports, effective states, and canonical repository rollups. Fleet / Org Pulse owns its backend proxy, caching, compatibility handling, and presentation.

| Endpoint | Dashboard use |
| --- | --- |
| `GET /api/task-outcomes/summary` | Global metrics and canonical repository rows. |
| `GET /api/task-outcomes/tasks` | Filtered task table, with `items`, `total`, `limit`, and `offset`. |
| `GET /api/task-outcomes/tasks/{task_id}` | Task detail, selected report, append-only `outcomeHistory`, and linked `taskCycles`. |

This change supplies the Memory Server contract and adoption documentation. It does not change instance configurations or the Fleet UI; those require separate integration and rollout work.

## Keep four concepts independent

| Concept | Field | Meaning |
| --- | --- | --- |
| Work category | `category` | What kind of work the task represents: `delivery`, `monitoring`, or `grooming`. |
| Lifecycle | `lifecycle.status` | Operational tracking status, such as `in_progress`, `pr_open`, `pr_changes`, `paused`, `done`, or `archived`. |
| Effective state | `state` | The API's current classification: `accepted`, `rejected`, `obsolete`, `inconclusive`, `unreported`, or `wip`. |
| Outcome report | `outcome` | The report selected for a terminal task, or `null`. It includes decision, confidence, reason, artifacts, evidence, timestamps, and correlation fields. |

`delivery` is the backend default. It represents delivery work measured by delivery outcome metrics. `monitoring` is watch-duty work that observes or follows up on external activity. `grooming` is ticket assessment and preparation, including actionability, labels and repository mappings, story points, and sprint placement as applicable. Neither non-delivery category is a synthetic repository or an outcome decision.

The effective-state rules in the SQL read model are:

1. `in_progress`, `pr_open`, `pr_changes`, and `paused` produce `wip`.
2. For `done` or `archived`, the task-owned selected report supplies the outcome. Inconclusive decision or confidence produces `inconclusive`; otherwise the report supplies `obsolete`, `accepted`, or `rejected`.
3. Without a usable selected report, the state is `unreported`. Other lifecycle statuses also fall through to `unreported`; do not infer acceptance from status text.

The API joins the selected report only for `done` and `archived` tasks. An active task can have a staged report in storage while its current response still has `state: "wip"` and `outcome: null`. Historical reports in detail are audit records, not a replacement for the current `outcome` or `state`.

Category does not rewrite the report. A monitoring task can retain an accepted outcome and appear in an accepted task search while contributing nothing to delivery acceptance counters.

## Counts and denominators

These rules apply to `summary` and each entry in `repositories`, after all request filters have been applied.

| Field | Population and interpretation |
| --- | --- |
| `taskCount` | All matching tasks, across all three categories. |
| `deliveryTaskCount` | Matching delivery tasks only. |
| `monitoringCount` | Matching monitoring tasks only. |
| `groomingCount` | Matching grooming tasks only. |
| `acceptedCount`, `rejectedCount`, `obsoleteCount`, `inconclusiveCount`, `unreportedCount`, `wipCount` | Delivery-only effective-state counts. |
| `groomingOutcomes` | The same six count fields, but grooming-only. |
| `acceptedNoOpCount` | A subset of delivery `acceptedCount`, not an additional state. See the evidence caveat below. |
| `repositoryCount` | Global count of distinct canonical repositories in the matching population. |
| Repository `reasons` and `providers` | Delivery-only breakdowns. Provider counts can overlap because one task can have evidence from multiple sources. |

Conservation rules:

```text
taskCount = deliveryTaskCount + monitoringCount + groomingCount

deliveryTaskCount = acceptedCount + rejectedCount + obsoleteCount
                  + inconclusiveCount + unreportedCount + wipCount

groomingCount = sum(the six counts in groomingOutcomes)

0 <= acceptedNoOpCount <= acceptedCount
```

There is no monitoring six-state breakdown in the summary schema. Use the filtered task list to inspect monitoring states; do not relabel delivery counters as monitoring outcomes.

```text
acceptanceRate = acceptedCount / (acceptedCount + rejectedCount + obsoleteCount)

reportedDelivery = acceptedCount + rejectedCount + obsoleteCount + inconclusiveCount
outcomeCoverage = reportedDelivery / (deliveryTaskCount - wipCount)
```

Both rates are fractions from 0 to 1, suitable for percentage formatting. Each is `null` when its denominator is zero. Display `null` as unavailable, not as 0% or 100%. Obsolete delivery outcomes remain in the acceptance denominator and do not count as acceptance. Inconclusive delivery reports count as reported coverage but stay outside the acceptance denominator. Unreported delivery tasks stay in the coverage denominator; delivery WIP does not.

Monitoring and grooming contribute to total tasks but to neither delivery rate. All-WIP delivery, monitoring-only, grooming-only, and empty populations have null coverage; monitoring-only, grooming-only, and empty populations also have null acceptance.

### What the no-op counter actually measures

The SQL counts a delivery task when its effective state is accepted and **any evidence item** in the selected report has `LOWER(disposition) = 'won''t do'`. This check does not require `source: "jira"`, does not restrict evidence `kind` or `authorType`, and is not a count of code changes or effort. It uses a case-insensitive exact disposition match, not free-text inference.

An accepted report may contain both `Won't Do` evidence and evidence of other completed work. Therefore `acceptedNoOpCount` does not prove zero work or zero code changes. Do not subtract it from `acceptedCount` when displaying the API's acceptance rate, and do not add it to state totals. A useful label is “Accepted with Won't Do evidence,” with the caveat in its tooltip.

### Repository rows are not additive

A task counts once in the global summary and once in each of its canonical repositories. A multi-repository task can therefore appear in several repository rows. Do not sum those rows to reconstruct global task counts, outcome counts, or rates; use `summary` directly. A task with no canonical repository can count globally without appearing in a repository row.

Canonical attribution prefers explicit artifact base/target repositories, then decoded PR/MR target URLs, then unambiguous legacy artifact repositories, and finally the task repository when no artifact supplies a target. Head/source forks remain traceability data. Use `canonicalRepositories` for outcome grouping rather than replacing it with `repo` or a fork name.

## Filters and task navigation

Summary and task-list endpoints accept `repo`, `category`, `decision`, `confidence`, `reason`, `source`, `from`, and `to`. Omit `category` to include all categories. Omit unused parameters rather than sending empty placeholder dates.

`category` and `decision` intersect: the server applies them with AND before computing every rollup. Despite its query name, `decision` filters the effective `state`, so it also accepts `unreported` and `wip`.

```text
GET /api/task-outcomes/summary?category=monitoring&decision=accepted
GET /api/task-outcomes/tasks?category=monitoring&decision=accepted&limit=50&offset=0
```

For the same matching population, the summary can have a positive `taskCount` and `monitoringCount` while all delivery counters, including `acceptedCount`, are zero and both rates are null. The task list can still contain `category: "monitoring"`, `state: "accepted"`, and an accepted `outcome`. This is expected, not a disagreement between endpoints. Grooming-only requests behave similarly for delivery counters, while their states populate `groomingOutcomes`.

Keep summary and drill-down filters aligned. A rate under `decision=accepted` describes only that filtered population; it is not the overall delivery acceptance rate. Either show the active filter prominently or fetch an unfiltered KPI population separately.

`repo` tests membership in canonical repositories. `reason` matches the report reason exactly. `source` matches evidence provenance case-insensitively. Confidence, reason, and source filters depend on the joined report and can exclude WIP or unreported rows.

Dates use inclusive UTC calendar bounds. The event timestamp is the selected report's `reportedAt`, then `archivedAt` for an unreported archive, then `lastAddressed`, then `createdAt`. It is not a task-creation cohort filter or a provider verification-time filter. `reportedAt` is server record time; `verifiedAt` records evidence verification time.

The task list defaults to `limit=50`, permits 1–100, and requires a nonnegative offset. Rows sort by event time descending, then task ID descending. Preserve filters across pages and use the returned `total`; a changing dataset is not a transactional snapshot. Open detail by stable `taskId`, with `(sourceType, externalKey)` shown as the external identity. `taskCycles` lists linked cycles; a report's `reportingCycleId` identifies only the reporting cycle.

## Schema-valid response example

The following is a synthetic `TaskOutcomeSummary` response for 13 tasks, all attributed to one canonical repository: 10 delivery, one monitoring, and two grooming. The delivery states are two accepted, one rejected, one obsolete, two inconclusive, two unreported, and two WIP. One accepted delivery report contains `Won't Do` evidence. Grooming has one accepted and one unreported task. The monitoring task's state does not affect delivery counts.

```json
{
  "period": { "from": "2026-10-01", "to": "2026-10-07" },
  "summary": {
    "acceptanceRate": 0.5,
    "outcomeCoverage": 0.75,
    "taskCount": 13,
    "deliveryTaskCount": 10,
    "monitoringCount": 1,
    "groomingCount": 2,
    "groomingOutcomes": {
      "acceptedCount": 1,
      "rejectedCount": 0,
      "obsoleteCount": 0,
      "inconclusiveCount": 0,
      "unreportedCount": 1,
      "wipCount": 0
    },
    "repositoryCount": 1,
    "acceptedCount": 2,
    "acceptedNoOpCount": 1,
    "rejectedCount": 1,
    "obsoleteCount": 1,
    "inconclusiveCount": 2,
    "unreportedCount": 2,
    "wipCount": 2
  },
  "repositories": [
    {
      "repo": "example/service",
      "acceptanceRate": 0.5,
      "outcomeCoverage": 0.75,
      "taskCount": 13,
      "deliveryTaskCount": 10,
      "monitoringCount": 1,
      "groomingCount": 2,
      "groomingOutcomes": {
        "acceptedCount": 1,
        "rejectedCount": 0,
        "obsoleteCount": 0,
        "inconclusiveCount": 0,
        "unreportedCount": 1,
        "wipCount": 0
      },
      "acceptedCount": 2,
      "acceptedNoOpCount": 1,
      "rejectedCount": 1,
      "obsoleteCount": 1,
      "inconclusiveCount": 2,
      "unreportedCount": 2,
      "wipCount": 2,
      "reasons": {
        "Merged change verified": 1,
        "Won't Do confirmed by review": 1,
        "Rejected by reviewer": 1,
        "Task explicitly obsolete": 1,
        "Verification incomplete": 2
      },
      "providers": { "workflow": 6 }
    }
  ],
  "metricDefinitions": {
    "acceptanceRate": "accepted / (accepted + rejected + obsolete) for delivery-category tasks; monitoring and grooming excluded",
    "outcomeCoverage": "reported delivery outcomes / (delivery tasks - delivery WIP); monitoring and grooming excluded",
    "monitoring": "Watch-duty tasks; counted separately and excluded from delivery outcome metrics.",
    "grooming": "Ticket assessment/preparation (labels/repository mappings, points, sprint); outcomes reported separately and excluded from delivery metrics. Task existence, done status, or a no-new-ticket check does not prove acceptance; repeated checks require separate no-op adjudication."
  },
  "freshness": { "generatedAt": "2026-10-07T15:00:00Z" },
  "backfill": { "state": "not_started", "unknownCount": 2 }
}
```

The rates are exactly `2 / (2 + 1 + 1) = 0.5` and `(2 + 1 + 1 + 2) / (10 - 2) = 0.75`. The global and repository counts match because this example has one repository per task. All six grooming counts sum to two. The six reported delivery tasks each have workflow evidence; the reasons partition those six tasks.

The current implementation always emits `backfill.state: "not_started"` and sets `unknownCount` to the filtered delivery `unreportedCount`. This is not proof that a migration ran, not the count of unknown evidence resolutions, and not a total across categories. `freshness.generatedAt` is response generation time, not proof that providers were recently checked.

## Dashboard presentation

- Render a category badge separately from the effective-state badge. Show lifecycle status as its own field in the table or detail. “Monitoring · Accepted · Archived” is a valid combination.
- Label total, delivery, monitoring, and grooming task counts explicitly. Label the six primary state counters as delivery outcomes. Present `groomingOutcomes` in a separate grooming breakdown.
- Use server rates and counts, not estimates from the current table page. Show an unavailable marker for null rates and include denominator details in tooltips.
- Explain acceptance as “Accepted delivery / (accepted + rejected + obsolete delivery).” Explain coverage as “Reported delivery / non-WIP delivery; inconclusive reports count as reported.”
- Surface `metricDefinitions.monitoring` and `metricDefinitions.grooming` as explanatory text or tooltips. Explain that category exclusions affect delivery metrics, not task visibility or retained outcomes.
- Keep “Accepted with Won't Do evidence” inside accepted delivery, with a tooltip explaining the evidence match and its inability to prove zero work.
- Show selected report evidence, raw disposition, evidence resolution, report reason, and verification/report times in detail. Preserve custom source labels; do not interpret raw source status as the task outcome.
- Keep category, state, repository, and date filters visible. Reset pagination when filters change and preserve filters on metric drill-down.

Grooming is not automatically accepted when a task exists, is done, or says “no new tickets.” Acceptance requires verified assessment and applicable preparation evidence, including why a field needed no change. Repeated checks need separate no-op adjudication of the eligible-ticket search and preparation state. Missing evidence stays unreported; unknown evidence can yield inconclusive. Neither a no-op summary nor the grooming badge grants acceptance.

## Team workflow integration gap

In the team workflow, `done` stops routine tracking, but a done task is not part of active capacity. Memory Server capacity counts only `in_progress`, `pr_open`, and `pr_changes`; the outcome API additionally treats `paused` as WIP. Consequently, neither delivery `wipCount` nor `taskCount` is an active-capacity counter, and an unreported done task is a reporting gap rather than a consumed capacity slot.

A team backport marked done may mean that a PR was opened or work was delegated, not that the result was accepted or merged. Dashboard code must not turn these completion conventions into accepted outcomes. Tracking completion and verified outcome completion need an explicit workflow integration.

The completion path is:

1. Finish evidence-relevant task updates and verify the current provider/workflow facts.
2. Call `task_outcome_report` for the exact external key and source type with artifacts, evidence, and required nullable notes. Every evidence item needs `source`, `reference`, `resolution` (`accepted`, `rejected`, or `unknown`), `disposition`, and `reason`. The backend derives the decision; callers do not submit a final task decision.
3. Call `task_remove` to archive using that staged report. Reporting alone does not archive the task. Missing or invalid reports block normal archival; explicit manual dashboard archival clears the pointer and remains unreported.

Actual status changes invalidate the staged pointer except completion to done; identical status writes preserve it. Reopening an archived task invalidates the report even when reopening to done. Changed evidence-relevant metadata also invalidates it, while unchanged values and bookkeeping keys `last_step`, `next_step`, and `status_before_pause` preserve it. Append-only history remains available, but a historical report cannot be reused after reopening. Verify fresh evidence and stage a new report before archival. An archived correction uses `correction=true` and appends a report rather than editing history.

The team workflow needs this integration separately; publishing dashboard documentation does not install those completion hooks or modify instance instructions.

## Rollout and older payloads

1. **Deploy the backend and schema first.** Ensure the API and proxy expose category fields, the category filter, delivery denominators, `groomingOutcomes`, and metric definitions. The database category defaults to delivery; its check constraint must allow all three categories, including when upgrading a deployed delivery/monitoring constraint. Schema installation does not assign historical categories.
2. **Deploy the dashboard next.** Update proxy/client schemas, counts, filters, badges, tooltips, null handling, and older-payload compatibility. Verify both global and repository views against the deployed contract before changing historical categories.
3. **Apply reviewed historical category assignments last.** Use category-only updates to delivery, monitoring, or grooming as reviewed. Preserve lifecycle, timestamps, repository attribution, evidence, the selected report pointer, and append-only history. Do not rerun outcome reports to recategorize tasks. Any historical outcome enrichment is a separate evidence-based operation.

An older payload may omit `category`, `deliveryTaskCount`, `monitoringCount`, `groomingCount`, `groomingOutcomes`, or metric definitions. Make the compatibility path explicit at the proxy/client boundary: display a legacy/unknown category when category is absent, and mark missing category-aware counts or rates unavailable or clearly legacy. Absence is not evidence of zero monitoring/grooming and is not proof that every task is delivery. Do not recompute delivery exclusions from titles, workflow names, lifecycle statuses, repositories, or review candidates, and do not silently present older server rates as the new category-aware metrics.

Backend defaulting existing database rows to delivery is distinct from a browser guessing the category of an old response. Even after deployment, reviewed historical non-delivery rows can remain delivery until category assignment occurs; label migration progress operationally rather than claiming all historical metrics are corrected.

Local review JSON files are review inputs, not committed dashboard resources. Exclude them from the PR and do not link or fetch them from this guide or the UI. They do not authorize live exclusions or accepted outcomes. Confirm deployed fields and complete the dashboard rollout before applying reviewed category-only assignments.

## Adoption checks

- Validate the example against the OpenAPI `TaskOutcomeSummary` schema, including required fields, enum values, nullable rates/dates, and forbidden extra properties. Check conservation and rate arithmetic separately because the schema does not enforce those relations.
- Verify empty and all-WIP delivery populations show null rates where denominators are zero, and verify monitoring-only and grooming-only populations have zero delivery counters.
- Verify `category=monitoring&decision=accepted` can return accepted monitoring tasks while summary delivery acceptance stays zero and rates stay null. Verify grooming states remain in `groomingOutcomes`.
- Verify multi-repository tasks count once globally and once per canonical repository, and that no-op counts remain a subset of accepted delivery.
- Verify a terminal task without a report remains unreported, active work remains WIP despite staged/history reports, and reopening requires fresh reporting.
- Verify older payloads render without invented category exclusions or zero-filled missing metrics. Verify local review files are absent from PR resources.

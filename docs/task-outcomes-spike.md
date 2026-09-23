# Task Outcome Data Spike

Status: proposal

## Goal

Report trustworthy Rehor success rates by canonical target repository. Task lifecycle (`archived`, `done`) is not an outcome: it does not prove work succeeded.

## Current State

Tasks contain lifecycle status, repository, Jira key, summary, metadata, and zero or more artifacts such as PRs, MRs, Jira issues, commits, or custom workflow references. A task may need evidence from several providers.

Current historical signals are useful for backfill but insufficient for reporting: terminal status, artifact URLs, and summary text do not consistently tell why work ended.

## Outcome Model

Agents report an outcome through the existing archive action. Provider checks and workflow hooks add evidence; neither replaces agent intent for custom workflows.

```json
{
  "status": "archived",
  "outcome": {
    "schemaVersion": 1,
    "decision": "accepted",
    "confidence": "conclusive",
    "reason": "merged",
    "reportedBy": "agent",
    "reportedAt": "2026-09-23T10:00:00Z",
    "verifiedAt": "2026-09-23T10:00:00Z",
    "artifacts": [
      {
        "type": "github_pr",
        "url": "https://github.com/project-kessel/insights-rbac/pull/3428",
        "number": 3428,
        "baseRepo": "project-kessel/insights-rbac",
        "headRepo": "platex-rehor-bot/insights-rbac"
      },
      {
        "type": "jira_issue",
        "key": "RHCLOUD-42232"
      }
    ],
    "evidence": [
      {
        "source": "github",
        "reference": "https://github.com/project-kessel/insights-rbac/pull/3428",
        "state": "MERGED",
        "mergedAt": "2026-09-23T09:58:00Z"
      },
      {
        "source": "jira",
        "reference": "RHCLOUD-42232",
        "statusName": "Release Pending",
        "statusCategory": "Done",
        "resolution": "Done"
      }
    ],
    "notes": null
  }
}
```

- `artifacts`: work references.
- `evidence`: facts used to decide outcome.
- `decision`: exactly `accepted` or `rejected`.
- `confidence`: `conclusive` or `inconclusive`.
- `reason`: extensible detail, not another outcome type.

Initial reasons: `merged`, `resolved`, `already_resolved`, `duplicate`, `obsolete`, `wont_do`, `no_action_needed`, `closed_unmerged`, `open_at_archive`, `blocked`, `failed_validation`, `evidence_conflict`, `other`.

An active task with an open PR/MR remains WIP. If archived with an open PR/MR and no accepted evidence, report `rejected` / `open_at_archive`.

Only merged PRs/MRs are accepted on their own. A closed-unmerged PR/MR can coexist with accepted evidence from a replacement PR/MR or resolved Jira issue. Conflicting evidence is `inconclusive` / `evidence_conflict`.

## Provider Evidence

| Source | Evidence to retain | Accepted signal |
|---|---|---|
| GitHub | Base/head repos, number, state, merged/closed timestamps, URL | PR merged |
| GitLab | Target/source projects, IID, state, merged/closed timestamps, URL | MR merged |
| Jira | Status name/category, resolution, resolution date, relevant comments/changelog | Agent validates terminal Jira outcome |
| Custom workflow | Workflow-specific references and checks | Defined by workflow maintainer |

Repository metrics use PR base repo or MR target project. Fork/source repository remains traceability data.

### Jira normalization

`status` is workflow position; `resolution` is why work ended. Preserve both. Status names are project-specific and never replace resolution.

```js
function normalizeJiraIssue(issue) {
  const statusName = issue.status?.name || null
  const statusCategory = issue.status?.category || null
  const resolution = issue.resolution?.name || null

  return {
    source: 'jira',
    reference: issue.key,
    terminal: statusCategory === 'Done' || Boolean(resolution),
    resolved: statusCategory === 'Done' && Boolean(resolution),
    disposition: resolution,
    evidence: { statusName, statusCategory, resolution, resolutionDate: issue.resolutiondate || null }
  }
}
```

`Release Pending` in RHCLOUD/OCPBUGS currently has category `Done`, resolution `Done`, and a resolution date. This is a project-specific completion mapping, not a company-wide Jira rule.

The default normalizer records raw Jira facts. Each workflow or project may configure which status/category/resolution combinations count as completion evidence.

Two observed normalized responses:

```json
{
  "source": "jira",
  "reference": "RHCLOUD-51513",
  "terminal": true,
  "resolved": true,
  "disposition": "Done"
}
```

```json
{
  "source": "jira",
  "reference": "O2R-6002",
  "terminal": true,
  "resolved": true,
  "disposition": "Won't Do"
}
```

`Won't Do`, `Obsolete`, and `Duplicate` are Jira dispositions, not automatic Rehor success. They are accepted only when agent intent says correct no-action, obsolescence, or duplicate detection; otherwise they are rejected or inconclusive.

## Reporting Interfaces

### Archive MCP contract

Extend existing `task_remove` / archive input with required outcome fields:

- `decision`: `accepted` or `rejected`
- `confidence`: `conclusive` or `inconclusive`
- `reason`
- `artifacts`
- `evidence`
- `notes`

The MCP schema rejects archival when outcome fields are absent or invalid. An explicit correction operation is required after archival.

### Workflow hook

Custom workflow maintainers can supply:

```text
evaluate_task_outcome(task, workflow_context) -> outcome report
```

The hook may inspect provider state, Jira comments, artifacts, and custom workflow data.

## Metrics

```text
success rate = conclusive accepted /
               (conclusive accepted + conclusive rejected)
```

Exclude inconclusive outcomes from denominator and report them as evidence gaps. Show total tasks, WIP, accepted, rejected, inconclusive, reason breakdown, and provider coverage.

## Migration

1. Add optional `outcome` to task storage, API schema, and task update path.
2. Extend the archive MCP schema with required outcome fields.
3. Add cleanup hooks for workflow-specific evaluation.
4. Run one historical migration after the schema is deployed:
   - Enumerate every existing task and its artifacts.
   - Fetch deterministic GitHub, GitLab, and Jira facts where references exist.
   - Use an LLM to adjudicate multi-artifact or custom-workflow history from task summary, provider facts, comments, and changelog evidence.
   - Write one outcome report per task without changing original task lifecycle timestamps.
   - Mark insufficient or conflicting evidence `inconclusive` with reasons such as `artifact_missing`, `provider_unavailable`, `historical_state_unavailable`, or `evidence_conflict`.
5. Produce and retain a reconciliation report: accepted, rejected, inconclusive, conflicting, missing references, and LLM/manual-review candidates.

The migration is one-shot. New tasks use the MCP report and workflow hooks; they do not depend on later LLM reconstruction.

## Aggregation API

Compact rollup for Org Pulse:

```text
GET /api/task-outcomes/summary?from=&to=&repo=
```

The response must include both holistic computation and repository breakdown:

```json
{
  "period": { "from": "2026-09-01", "to": "2026-09-30" },
  "summary": {
    "acceptanceRate": 0.82,
    "taskCount": 871,
    "repositoryCount": 132,
    "acceptedCount": 700,
    "rejectedCount": 150,
    "inconclusiveCount": 12,
    "unreportedCount": 9,
    "wipCount": 55
  },
  "repositories": [
    {
      "repo": "project-kessel/insights-rbac",
      "acceptanceRate": 0.86,
      "taskCount": 32,
      "acceptedCount": 24,
      "rejectedCount": 4,
      "inconclusiveCount": 2,
      "unreportedCount": 2,
      "wipCount": 6,
      "reasons": { "merged": 20, "duplicate": 4 },
      "providers": { "github": 27, "jira": 24 }
    }
  ],
  "freshness": { "generatedAt": "2026-09-23T10:00:00Z" },
  "backfill": { "state": "complete", "unknownCount": 9 }
}
```

`acceptanceRate` uses conclusive accepted and rejected outcomes only. Inconclusive, unreported, and WIP counts remain visible but do not silently inflate the rate.

Filtered, paginated task details:

```text
GET /api/task-outcomes/tasks?repo=&decision=&confidence=&reason=&source=&from=&to=&limit=50&offset=0
```

Return task lifecycle, outcome, artifacts, evidence, canonical repositories, provider states, and report/verification timestamps. Use stable ordering and unchanged filters across pages.

For a single task, provide a detail route that can return the complete evidence graph without list-size constraints:

```text
GET /api/task-outcomes/tasks/{taskKey}
```

The list endpoint may return compact records by default; callers can request full evidence with an explicit `include=evidence,artifacts` option. The single-task endpoint returns full task history, all artifacts, all evidence, provider responses, corrections, and outcome changes.

## Acceptance Criteria

- Existing tasks remain readable.
- Multiple artifacts and evidence records supported.
- Archive MCP outcome enforcement and custom workflow hook implemented.
- GitHub, GitLab, and Jira evidence paths normalized.
- Fork-to-base repository mapping retained.
- Inconclusive and conflicting evidence reported.
- Historical reconciliation and aggregation API available.

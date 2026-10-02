# Org Pulse Rehor Module Spike

Status: proposal

## Goal

Define Org Pulse module requirements for displaying Rehor task outcomes. Module ownership and target instances remain open until integration planning.

## Module Boundary

The module should:

- Fetch Rehor summary and task-detail APIs through the Org Pulse backend.
- Use repositories as the primary grouping; do not require an Org Pulse team model.
- Preserve accepted, rejected, inconclusive, unreported, WIP, and stale/backfill states.
- Display raw evidence links and provider states.
- Use canonical base repository as primary identity while retaining fork/source repositories.

The module should not:

- Infer success from prose or Jira status names.
- Download full task history for every page load.
- Bypass the Rehor Memory Server API; all data comes through its HTTP endpoints.
- Assume one artifact or one source of truth per task.

## API Integration

Backend routes proxy Rehor APIs:

```text
GET /api/modules/rehor-insights/summary
GET /api/modules/rehor-insights/tasks?...filters...
GET /api/modules/rehor-insights/tasks/:taskKey
```

The Org Pulse backend proxy calls the Rehor Memory Server API directly. The proxy owns the Rehor URL, timeout, caching, error handling, and future authentication. Current read-only API requires only `REHOR_API_URL`.

Required behavior:

- Cache compact summary responses briefly.
- Pass filters and pagination through to Rehor.
- Return `not_configured`, `unavailable`, and `stale` states.
- Never expose provider credentials to the browser.

## Frontend Surface

Initial views:

- Overview: acceptance rate, task count, repository count, WIP, evidence coverage, and freshness.
- Repository rollup: rate, accepted/rejected/inconclusive counts, reasons, provider coverage.
- Task details: lifecycle, outcome, artifacts, evidence, provider state, and timestamps.

Support loading, empty, stale, inconclusive, evidence-conflict, and API-error states. Repository drill-down is primary; team filters are optional future enrichment.

## Manifest and Tests

The module needs:

- `module.json` with unique slug and navigation.
- `requires: ["team-tracker"]` only if roster/team links are added.
- Lazy client routes and server entry.
- Optional settings for Rehor URL and refresh behavior.
- OpenAPI annotations for module routes.
- Backend route tests and Playwright coverage for main UI states.

For one task, expose full evidence without list-size limits:

```text
GET /api/modules/rehor-insights/tasks/:taskKey
```

List responses may be compact. Full records should be requested explicitly with `include=evidence,artifacts`.

## Distribution

Module source must be present in both backend startup module paths and frontend Vite build input. It may live in core or a deployment-specific repository:

- Core repository: use when module should ship to all Org Pulse deployments.
- Deployment repository: use when only selected instances need Rehor integration.
- Separate module repository: vendor or copy module into the image build; it does not appear automatically at runtime.

Org Pulse images are the distribution unit. Frontend modules are discovered at build time; backend modules are discovered from `module.json` at startup. The `git-static` feature serves synced static content and is not a replacement for executable frontend/backend modules.

Final repository placement is intentionally deferred until target instances are known.

## Acceptance Criteria

- Summary, paginated list, and single-task detail API contracts consumed.
- Repository-first UI works without team ownership data.
- Evidence links and provider states are visible.
- Stale, inconclusive, and API-error states are explicit.
- Module passes manifest validation, OpenAPI validation, unit tests, and integration tests.
- Packaging path is documented for each target deployment.

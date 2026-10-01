# Org Pulse Rehor Module Spike

Status: proposal

## Goal

Define Org Pulse module requirements for displaying Rehor task outcomes. Module ownership and target instances remain open until integration planning.

## Module Boundary

The module should:

- Fetch Rehor summary and task-detail APIs through the Org Pulse backend.
- Use repositories as the primary grouping; do not require an Org Pulse team model.
- Preserve accepted, rejected, obsolete, inconclusive, unreported, WIP, and stale/backfill states.
- Display raw evidence links with uniform source, resolution, disposition, reason, and author type.
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
GET /api/modules/rehor-insights/tasks/:taskId
```

The Org Pulse backend proxy calls these Rehor Memory Server endpoints:

```text
GET /api/task-outcomes/summary?from=&to=&repo=
GET /api/task-outcomes/tasks?repo=&decision=&confidence=&reason=&source=&from=&to=&limit=&offset=
GET /api/task-outcomes/tasks/{taskId}
```

Use stable numeric `taskId` from list results for detail lookup; keep `externalKey` for display and links. Rehor list responses currently include evidence and artifacts directly. The list endpoint has no `include` parameter; detail adds full outcome history and linked cycle runs.

The Org Pulse backend proxy calls Rehor directly. It owns the Rehor URL, timeout, caching, error handling, and future authentication. Current read-only API requires only server-side `REHOR_API_URL`.

Required behavior:

- Cache compact summary responses briefly.
- Pass filters and pagination through to Rehor.
- Return `not_configured`, `unavailable`, and `stale` states.
- Never expose provider credentials to the browser.

## Frontend Surface

Initial views:

- Overview: acceptance rate, task count, repository count, obsolete, inconclusive, unreported, WIP, evidence coverage, and freshness.
- Repository rollup: rate, accepted/rejected/obsolete/inconclusive/unreported/WIP counts, reasons, provider coverage.
- Task details: lifecycle, outcome, artifacts, uniform evidence, outcome history, cycle runs, and timestamps. Raw provider status appears in evidence `disposition`.

Support loading, empty, stale, inconclusive, evidence-conflict, and API-error states. Repository drill-down is primary; team filters are optional future enrichment.

## Manifest and Tests

The module needs:

- `module.json` with unique slug and navigation.
- `requires: ["team-tracker"]` only if roster/team links are added.
- Lazy client routes and server entry.
- Optional settings for Rehor URL and refresh behavior.
- OpenAPI annotations for module routes.
- Backend route tests and Playwright coverage for main UI states.

Org Pulse detail route uses the stable numeric `taskId` returned by Rehor list results:

```text
GET /api/modules/rehor-insights/tasks/:taskId
```

The current Rehor list already returns full evidence and artifacts. Do not send unsupported `include=evidence,artifacts`; Rehor detail endpoint returns report history and cycle runs.

## Distribution

Module source must be present in both backend startup module paths and frontend Vite build input. Repository placement and target deployments remain deferred decisions; no repository or instance has been selected:

- Core repository: use when module should ship to all Org Pulse deployments.
- Deployment repository: use when only selected instances need Rehor integration.
- Separate module repository: vendor or copy module into the image build; it does not appear automatically at runtime.

Org Pulse images are the distribution unit. Frontend modules are discovered at build time; backend modules are discovered from `module.json` at startup. The `git-static` feature serves synced static content and is not a replacement for executable frontend/backend modules.

Choose placement when target deployments are confirmed: core repository if all deployments should ship the module, deployment repository for selected instances, or separate repository only if image builds explicitly vendor/copy its source. Until then, this spike defines the API contract and packaging requirements, not a committed module location.

## Acceptance Criteria

- Summary, paginated list, and single-task detail API contracts consumed.
- Repository-first UI works without team ownership data.
- Acceptance rate uses conclusive accepted and rejected only; obsolete, inconclusive, unreported, and WIP remain separate visible counts.
- Evidence links and uniform resolution/disposition facts are visible.
- Stale, inconclusive, and API-error states are explicit.
- Module passes manifest validation, OpenAPI validation, unit tests, and integration tests.
- Packaging path is documented for each target deployment.

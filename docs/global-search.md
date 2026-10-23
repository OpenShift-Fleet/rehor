# Dashboard global search

The masthead searches tracked tasks directly in the list currently open: **Tasks** searches non-archived work, while **Archive** searches archived work only. It matches task key/title/summary/repository, associated cached PR/MR labels and assigned bot instance IDs. Label and bot matches return tasks, not separate entities or a dropdown. The dedicated **Search** page still searches semantic memories; its API and behavior are unchanged.

## Task-list filtering and navigation

Type at least two characters. Input is debounced by 200 ms; Enter applies immediately. Searching or clearing on Archive stays on Archive; searching on Tasks stays on Tasks. Search from other views opens Tasks only after at least two characters; one character, Enter below minimum, or clearing a draft does not leave the current view. Current Tasks status and selected instance scope are retained: **All instances** searches deployment-wide, while an instance view searches only its tasks. Instance scope is a convenience filter, not a new authorization boundary.

`GET /api/tasks?q=...` applies literal, case-insensitive matching **AND** status/excluded-status, instance and optional exact task identity filters before both counting and pagination. All matching rows participate; pages contain 20 cards, but there is no 30/50-result candidate cap. Multiple matching labels on one task do not duplicate it. Tasks sends `exclude_status=archived`, including when searching; selecting **In Progress** or **Done** intersects that non-archived scope. **All** means all non-archived matches, not a mixed list. Archive sends `status=archived`; there is no Archived option in the Tasks status menu. Old Tasks bookmarks with `status=archived` fall back to All non-archived work. The generic HTTP API's default remains compatible; scope is explicit in the list's request. Changing or clearing the query preserves its list and selected status, resets pagination and clears exact-task focus. Tasks use `created_at DESC, id DESC`; Archive uses `last_addressed DESC, id DESC` both with and without a query.

Queries use PostgreSQL `lower()` with the same database collation as indexed fields and stored bigrams, rather than Python's different Unicode mapping. The normalized character length selects the bigram or substring path; SQL wildcard characters remain literal. Query normalization is a database read included in the benchmark timings.

Query, Tasks status and each list's page are URL-backed (`q`, `status`, `page`) and survive reload/back/forward. Sidebar list links open the destination's normal URL; browser history restores its prior search. Superseded reads are cancelled and ignored. Loading, failed reads with retry, empty matches and input below the two-character minimum have distinct states. The enabled PatternFly field has one internal clear control; Tab/Enter and normal browser navigation remain available.

Search cards retain status badges, literal all-occurrence highlights, details and cycle history. Their key buttons select dashboard details rather than opening Jira. Archived details offer Restore, not active-task actions. Both filtered and unfiltered Tasks exclude archived work; use Archive to find archived matches. The trade-off is switching lists to discover work across both scopes. Existing source links in details remain available.

Canonical `task_id` links still resolve exact tasks independently of pagination, open details and survive reload. **Show all tasks** / **Show all archived tasks** clears exact focus; stale canonical locations follow the current archived/active status. The unshipped grouped endpoint, client and fixtures were removed; there is no demonstrated shipped-client compatibility requirement.

### Task-centered cycle history

Tasks remain the primary entry point. Task cards provide **View cycles**, and task details (including Archive) contain a **Cycle history** section with paginated runs, loading/empty/error states and retry. **Open cycle #…** opens the exact run and its existing transcript viewer. A tab presentation is a later refinement, not required for this PoC.

The global **Cycles** view remains available for investigation across tasks and bots, including unassociated runs. Task links open scoped history; **Show all cycles** returns to the global overview. Group titles, cycle cards and cycle details link internally back to the associated task or Archive. Unassociated runs have no fabricated task link. URL changes, reloads and browser back/forward resolve the current selection without requiring a manual refresh.

`GET /api/cycle-runs` supports an optional positive `run_id` filter for exact selection independent of pagination and an exact `external_key` filter for progress-key groups (empty value selects no key). Filters combine with task and instance scope. Task history includes legacy runs associated through a Jira progress key, matching the grouped view, while different task identities sharing a key remain separate. Deploy this backend before the updated frontend. No new schema migration is needed for this navigation change.

This enables **search → task → cycle history → transcript → task**, not global transcript search. Cycle contents are still searched only through **Search transcript** after loading a particular transcript; no cycle entries are added to the masthead merely for navigation.

## Coverage and access

- Search reads PostgreSQL only. It never calls Jira, GitHub, or GitLab per keystroke.
- Jira coverage is limited to issues already tracked as tasks, not the whole Jira instance. Search matches key, title, summary, and repository literally, ignoring case; SQL wildcard characters are not operators.
- A label match returns its associated task once, even if several PR/MRs or labels match. This is not historical label analytics. Removed labels disappear after the next successful refresh. Failed or incomplete provider responses preserve the last known snapshot.
- Bot names mean `instance_id`. Display aliases are not indexed.
- Existing deployment-level dashboard authentication remains the access boundary. This is cross-instance search, not a new per-instance authorization model. Keep the existing service/ingress restrictions; do not publish a previously private memory server.
- Resolvable PR/MR identities in task metadata/artifacts are backfilled once. An atomic `search_backfills` marker prevents later startups from rescanning/reclaiming newly discovered PRs; failed backfills roll back their marker. Labels are never invented. Label results appear only after a successful provider refresh. Prerequisite: a tracked task must already declare the PR/MR through metadata, artifacts or its direct source URL. Removing a declaration atomically deletes its cached parent/labels, so stale labels stop matching without a provider refresh. Delayed snapshots are rejected. An existing owner cannot be silently replaced: remove its declaration first, then explicitly ingest a declared snapshot for the new task. Simultaneous shared ownership remains unsupported.

## Snapshot ingestion configuration

**Release blocker: do not provision `UPLOAD_MEMORY_PASSWORD` to a runner that executes model/tools.** The current shared-UID container is not a credential-isolation boundary: a sanitized child can read the parent's initial environment through `/proc`. The unsafe sandbox secret example was removed. Enabling normal bot-runner ingestion requires a separate trusted runner/proxy design and security verification first; environment/reference filtering alone is insufficient.

The existing bearer protocol remains available to a genuinely isolated trusted producer using the server's shared upload credential. Keep values out of instance config, command lines, logs and frontend bundles. Use HTTPS outside a trusted pod network. The local sample intentionally leaves the writer disabled.

`POST /api/internal/pull-requests` accepts a bearer-authenticated complete snapshot: task external key/source type, provider (`github` or `gitlab`), repository, number, URL, and labels. See `shared/openapi.yaml` for the wire contract and validation bounds.

- Unset server secret disables the write route (404). Missing/incorrect credentials or browser-originated requests return 403. There is no anonymous snapshot-write fallback.
- This reuses the existing memory-upload credential: holders also retain its existing upload capability. Provision it only to trusted runners, not dashboard users or arbitrary provider/plugin configuration.
- Python removes the credential from the runner's ambient environment and restores it only for trusted preflight subprocesses. The TypeScript Claude runtime strips it from the SDK environment; OpenCode blocks it from configuration passthrough. MCP loaders reject the reserved key/references in bot, merged, persona and project configuration before interpolation or forwarding unresolved forms (arguments, env, URL and headers). These controls block accidental configuration/environment propagation; they do **not** prevent same-UID parent-environment reads.
- GitHub detail collection requests labels; GitLab uses the successful MR response's labels. Each successful write atomically replaces the entire label set, including an empty set. Conflicting ownership or a missing current task reference returns 409. Task-reference validation holds a row lock conflicting with metadata/artifact updates; a concurrent removal cannot resurrect stale labels. Concurrent snapshots cannot mix label sets.
- Ingestion has a two-second timeout, does not follow redirects, and is best effort. After a server/network failure, remaining writes in that preflight process are skipped; the next process retries normally. Task-specific validation, missing-task, and association-conflict responses do not suppress later valid snapshots. This bounds outage overhead instead of waiting once per PR/MR. Missing credentials and failures produce sanitized stderr warnings; they do not change preflight classification or task progress.

## Rollout and rollback

1. Before rollout, take the normal database backup and confirm the database role can enable `pg_trgm` (or have the operator install the extension). Existing `vector` prerequisites still apply. Test startup against a disposable copy first.
2. Deploy the memory server first (the standard image also contains the built dashboard). Its schema initialization adds PR/label tables, per-field multi-column trigram indexes and stored JSONB bigram keys/indexes for literal two-character matches across all task sources. Rich task fields remain separate, preventing cross-field false matches. Generated-column backfill **rewrites the task table** and uses additional storage; logical task fields/lifecycle are unchanged. Thin matching IDs/order values are evaluated once before count/page; no candidate cap is introduced. The one-time identity backfill also removes detached cached PRs. These are ordinary index builds and table alterations: schedule a maintenance window for a large existing database because startup DDL can block writes. Do not run destructive pytest database fixtures against staging/production.
3. Verify authenticated dashboard access and `/api/tasks?q=<known-key>&exclude_status=archived` for Tasks, plus `status=archived` instead of exclusion for Archive. Test a cached label, an assigned instance ID, status/instance intersections, accurate totals and later pages in both scopes. Check that uncredentialed and browser-originated internal writes fail. Verify memory search still works.
4. **Do not provision the shared secret to bot/model runners.** Resolve and verify the separate trusted ingestion boundary first. With an isolated producer, verify a normal refresh creates/replaces labels, source detachment removes matches, stale replay fails and cross-task ownership stays rejected. Do not force real actionable work merely to test search.
5. Verify the packaged dashboard through the actual ingress. If serving frontend assets separately, deploy them only after the new server is available. Test Tasks/Archive separation, search/clear staying in its list, status filters, later pages in both lists, reload/back/forward, archived details/Restore, keyboard navigation, error/retry, rapid query replacement, and narrow viewport layout.
6. Observe existing HTTP latency/error telemetry and sanitized ingestion warnings under realistic concurrent load. Synthetic local timings below are not a deployment acceptance test. The design target is API p95 below 200 ms and DB execution below 50 ms at 100k searchable entities.

To roll back, return the bot to its previous image first, then the memory server and its packaged dashboard. If serving frontend assets separately, roll them back before the memory server. Leave the additive tables, extension, and indexes in place: old code ignores them. Do not drop them or truncate tables as part of application rollback. Removing the shared upload secret disables both ingestion and the existing memory-upload feature; do not rotate/unset it without accounting for both consumers.

## Reproducible local benchmark

`memory-server/benchmark_search.py` refuses a database with existing public tables and never drops or truncates data. Use a separate disposable database, **not** the memory-server pytest database (whose fixtures drop public tables).

Example using an unused local port and the repository's pgvector image:

```sh
podman run -d --name rehor-search-benchmark \
  --cpus 4 --memory 1g \
  -p 127.0.0.1:55434:5432 \
  -e POSTGRES_USER=devbot_test -e POSTGRES_PASSWORD=devbot_test \
  -e POSTGRES_DB=devbot_search_benchmark pgvector/pgvector:pg17
podman exec rehor-search-benchmark pg_isready -U devbot_test -d devbot_search_benchmark
# Retry pg_isready until ready before running the benchmark.
uv sync --frozen --all-packages --all-extras
SEARCH_BENCHMARK_DATABASE_URL=postgresql://devbot_test:devbot_test@127.0.0.1:55434/devbot_search_benchmark \
  uv run --no-sync python memory-server/benchmark_search.py
podman rm -f rehor-search-benchmark
```

### Actual task-list endpoint measurement

The harness exercises `/api/tasks?q=...`, including full matching count, page and Slack-notification reads, in both Tasks and Archive scope. It seeds 60k tasks, 10k assigned bot identities and 30k labels on 15k declared PR/MRs, then runs `VACUUM (ANALYZE)` to measure steady-state reads rather than bulk-load GIN pending-list cleanup. Seven exact/prefix/substring/label/bot/missing/two-character queries receive 20 warm samples at concurrency 1 and 4.

Each report separates API p95, DB roundtrip p95 (including pool/transport), and summed SQL execution p95 from separate samples of the identical statements under `EXPLAIN (ANALYZE, BUFFERS)`, plus observed indexes. Selective task/label text and literal bigram queries are index-eligible; a cheap sequential scan is valid for broad matches. Two-character queries remain arbitrary literal substrings, not prefixes.

The corrected endpoint, including PostgreSQL query normalization, passed all 28 query/scope/concurrency cases on a **four-CPU/1GiB** PostgreSQL fixture: API p95 **1.89–35.37 ms**, SQL execution p95 **0.06–25.14 ms**. An earlier fresh run of the indexed implementation, before the query-normalization fix, on **two CPUs/1GiB** kept API p95 below 200 ms (maximum **61.09 ms**) but **failed** the 50 ms SQL target for concurrent broad `re` searches: **67.86 ms Tasks**, **51.13 ms Archive**. Do not claim the SQL target is met on two CPUs. Earlier failed prototypes are not acceptance evidence.

These are post-VACUUM warm local ASGI runs, excluding ingress/TLS, production contention and write-heavy/bulk-load GIN cleanup. CPU allocation is material, not an unspecified benchmark detail. Run without competing test/build workloads; no external API or embedding-model call is made. Deployment capacity/ingress/load acceptance and the isolated ingestion security boundary remain unresolved release gates.

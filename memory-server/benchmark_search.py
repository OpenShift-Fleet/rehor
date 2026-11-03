"""Measure the actual task-list HTTP path on an EMPTY disposable database.

Requires SEARCH_BENCHMARK_DATABASE_URL. Never drops/truncates tables, contacts
providers, or invokes embeddings. API timings include counts, page and Slack
reads. SQL execution p95 samples those same statements with EXPLAIN ANALYZE.
"""

import asyncio
import contextvars
import json
import math
import os
import time
from pathlib import Path

import asyncpg
from bot_memory_server import db as database
from httpx import ASGITransport, AsyncClient

QUERIES = ("BENCH-12345", "bench-123", "authentication", "awaiting-review", "worker-01", "missing-needle", "re")
SAMPLES = 20
_db_times = contextvars.ContextVar("db_times", default=None)


class MeasuredPool:
    def __init__(self, pool):
        self.pool = pool
        self.statements = {}

    async def execute_read(self, method, sql, args):
        start = time.perf_counter()
        result = await getattr(self.pool, method)(sql, *args)
        if (times := _db_times.get()) is not None:
            times.append((time.perf_counter() - start) * 1000)
        self.statements[sql] = args
        return result

    async def fetch(self, sql, *args):
        return await self.execute_read("fetch", sql, args)

    async def fetchval(self, sql, *args):
        return await self.execute_read("fetchval", sql, args)


def p95(values):
    return round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 2)


def indexes(node):
    result = {node["Index Name"]} if "Index Name" in node else set()
    for child in node.get("Plans", []):
        result.update(indexes(child))
    return result


async def benchmark():
    url = os.environ.get("SEARCH_BENCHMARK_DATABASE_URL")
    if not url:
        raise SystemExit("Set SEARCH_BENCHMARK_DATABASE_URL to an EMPTY disposable database")
    pool = await asyncpg.create_pool(url, min_size=4, max_size=4)
    failures = []
    try:
        async with pool.acquire() as conn:
            if await conn.fetchval("SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"):
                raise SystemExit("Refusing database with existing public tables; no fixture data written")
            await conn.execute((Path(__file__).parent / "bot_memory_server/schema.sql").read_text())
            await conn.execute("""
                INSERT INTO tasks (external_key, source_type, title, summary, repo, instance_id, status, metadata)
                SELECT 'BENCH-' || n, 'jira', 'Issue ' || n,
                    CASE WHEN n % 10 IN (0,1) THEN 'Fix authentication regression' ELSE 'Update cached workflow details' END,
                    'org/repo-' || (n % 100), 'worker-' || lpad((n % 10000)::text, 5, '0'),
                    CASE WHEN n % 5 = 0 THEN 'archived' ELSE 'in_progress' END::task_status,
                    CASE WHEN n <= 15000 THEN jsonb_build_object(
                        CASE WHEN n % 2 = 0 THEN 'prs' ELSE 'mrs' END,
                        jsonb_build_array(jsonb_build_object('host', CASE WHEN n % 2 = 0 THEN 'github' ELSE 'gitlab' END,
                            'repo', 'org/repo-' || (n % 100), 'number', n,
                            'url', 'https://example.test/org/repo-' || (n % 100) ||
                                CASE WHEN n % 2 = 0 THEN '/pull/' ELSE '/-/merge_requests/' END || n)))
                    ELSE '{}'::jsonb END
                FROM generate_series(1, 60000) n;
                INSERT INTO bot_instances (instance_id)
                SELECT 'worker-' || lpad(n::text, 5, '0') FROM generate_series(0, 9999) n;
                INSERT INTO pull_requests (task_id, host, repository, number, url)
                SELECT id, CASE WHEN id % 2 = 0 THEN 'github' ELSE 'gitlab' END,
                    'org/repo-' || (id % 100), id, 'https://example.test/org/repo-' || (id % 100) ||
                    CASE WHEN id % 2 = 0 THEN '/pull/' ELSE '/-/merge_requests/' END || id
                FROM tasks WHERE id <= 15000;
                INSERT INTO pull_request_labels (pull_request_id, label)
                SELECT id, CASE WHEN id % 3 = 0 THEN 'awaiting-review' ELSE 'work-in-progress' END FROM pull_requests
                UNION ALL SELECT id, 'area-' || (id % 100) FROM pull_requests;
            """)
            # Benchmark steady-state reads, not bulk-load GIN pending-list cleanup.
            for table in ("tasks", "bot_instances", "pull_requests", "pull_request_labels"):
                await conn.execute(f"VACUUM (ANALYZE) {table}")
        from bot_memory_server.server import build_app

        measured = MeasuredPool(pool)
        database._pool = measured
        app, _ = build_app()
        print(
            json.dumps(
                {
                    "endpoint": "/api/tasks",
                    "entities": 100000,
                    "tasks": 60000,
                    "bots": 10000,
                    "labels": 30000,
                    "samples": SAMPLES,
                    "method": "post-VACUUM warm ASGI; separate same-SQL EXPLAIN samples, not ingress acceptance",
                }
            ),
            flush=True,
        )
        async with AsyncClient(transport=ASGITransport(app), base_url="http://benchmark") as client:
            for scope, filters in (("tasks", {"exclude_status": "archived"}), ("archive", {"status": "archived"})):
                for concurrency in (1, 4):
                    for query in QUERIES:
                        params = {"q": query, "limit": 20, **filters}
                        for _ in range(2):
                            (await client.get("/api/tasks", params=params)).raise_for_status()
                        measured.statements.clear()
                        semaphore = asyncio.Semaphore(concurrency)

                        async def request(semaphore=semaphore, params=params, scope=scope):
                            async with semaphore:
                                times = []
                                token = _db_times.set(times)
                                try:
                                    start = time.perf_counter()
                                    response = await client.get("/api/tasks", params=params)
                                    response.raise_for_status()
                                    result = response.json()
                                    assert len(result["items"]) <= 20
                                    assert all(
                                        (t["status"] == "archived") == (scope == "archive") for t in result["items"]
                                    )
                                    return (time.perf_counter() - start) * 1000, sum(times)
                                finally:
                                    _db_times.reset(token)

                        timings = await asyncio.gather(*(request() for _ in range(SAMPLES)))
                        statements = list(measured.statements.items())

                        async def explain(semaphore=semaphore, statements=statements):
                            async with semaphore, pool.acquire() as conn:
                                execution = 0
                                used = set()
                                for sql, args in statements:
                                    plan = json.loads(
                                        await conn.fetchval("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, *args)
                                    )[0]
                                    execution += plan["Execution Time"]
                                    used.update(indexes(plan["Plan"]))
                                return execution, used

                        plans = await asyncio.gather(*(explain() for _ in range(SAMPLES)))
                        report = {
                            "scope": scope,
                            "q": query,
                            "concurrency": concurrency,
                            "api_p95_ms": p95([t[0] for t in timings]),
                            "db_roundtrip_p95_ms": p95([t[1] for t in timings]),
                            "sql_execution_p95_ms": p95([p[0] for p in plans]),
                            "indexes": sorted(set().union(*(p[1] for p in plans))),
                        }
                        if report["api_p95_ms"] >= 200 or report["sql_execution_p95_ms"] >= 50:
                            failures.append({k: report[k] for k in ("scope", "q", "concurrency")})
                        print(json.dumps(report), flush=True)
        print(json.dumps({"acceptance_passed": not failures, "failures": failures}), flush=True)
        if failures:
            raise SystemExit(1)
    finally:
        database._pool = None
        await pool.close()


if __name__ == "__main__":
    asyncio.run(benchmark())

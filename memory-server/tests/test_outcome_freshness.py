"""Staged outcomes must describe the task's current work, not an earlier attempt."""

import asyncio
import json
from contextlib import ExitStack, asynccontextmanager
from unittest.mock import AsyncMock, patch

import asyncpg
import pytest
import pytest_asyncio
from bot_memory_server.api import api_task_delete, api_task_pause, api_task_unpause
from bot_memory_server.tools.tasks import _metadata_changes_evidence, register_task_tools
from conftest import DB_CONFIG, SCHEMA_PATH
from fastmcp import FastMCP
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.routing import Route
from test_task_outcomes import NOW, FakeConnection, SQLiteArchivePool

KEY = "FRESHNESS-1"
IDENTITY = {"external_key": KEY, "source_type": "manual"}
PR = {"repo": "org/repo", "number": 1, "url": "https://github.com/org/repo/pull/1", "host": "github"}
REPLACEMENT_PR = {**PR, "number": 2, "url": "https://github.com/org/repo/pull/2"}
INITIAL_METADATA = {"prs": [PR], "repos": ["org/repo"], "workflow": {"result": "accepted"}}
app = Starlette(
    routes=[
        Route("/api/tasks/{key}/pause", api_task_pause, methods=["POST"]),
        Route("/api/tasks/{key}/unpause", api_task_unpause, methods=["POST"]),
        Route("/api/tasks/{key}", api_task_delete, methods=["DELETE"]),
    ]
)


async def _tools():
    mcp = FastMCP(name="outcome-freshness-tests")
    register_task_tools(mcp)
    return {tool.name: tool.fn for tool in await mcp.list_tools()}


async def _report(tools, *, reference=PR["url"]):
    return await tools["task_outcome_report"](
        **IDENTITY,
        artifacts=[{"type": "github_pr", "url": reference}],
        evidence=[
            {
                "source": "github",
                "reference": reference,
                "resolution": "accepted",
                "disposition": "Merged",
                "reason": "Provider confirms merge",
            }
        ],
        notes="Verified current work",
    )


def _patch_pool(pool):
    # API and MCP publish through the same bus singleton.
    stack = ExitStack()
    stack.enter_context(patch("bot_memory_server.tools.tasks.get_pool", return_value=pool))
    stack.enter_context(patch("bot_memory_server.api.get_pool", return_value=pool))
    stack.enter_context(patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock))
    return stack


@pytest.mark.parametrize(
    ("updates", "changed"),
    [
        ({}, False),
        ({"prs": [PR]}, False),
        ({"workflow": {"result": "accepted"}}, False),
        ({"last_step": "completed", "next_step": "archive", "status_before_pause": "pr_open"}, False),
        ({"prs": [REPLACEMENT_PR]}, True),
        ({"repos": ["org/other"]}, True),
        ({"related_items": []}, True),
        ({"workflow": {"result": "rejected"}}, True),
        ({"unknown_future_evidence": None}, True),
    ],
)
def test_metadata_freshness_compares_actual_values_and_limits_bookkeeping(updates, changed):
    assert _metadata_changes_evidence(INITIAL_METADATA, updates) is changed


@pytest.mark.parametrize(
    ("old", "new", "changed"),
    [
        ({"passed": True}, {"passed": 1}, True),
        ({"passed": False}, {"passed": 0}, True),
        ({"attempts": [1]}, {"attempts": [1.0]}, False),
        ({"passed": True, "result": "ok"}, {"result": "ok", "passed": True}, False),
    ],
)
def test_metadata_freshness_uses_json_value_semantics(old, new, changed):
    assert _metadata_changes_evidence({"ci": old}, {"ci": new}) is changed


@pytest.mark.asyncio
async def test_metadata_read_rebuild_and_invalidation_share_locked_transaction():
    class LockedConnection:
        locked = False
        in_transaction = False

        @asynccontextmanager
        async def acquire(self):
            yield self

        @asynccontextmanager
        async def transaction(self):
            self.in_transaction = True
            try:
                yield
            finally:
                self.in_transaction = False

        async def fetchrow(self, query, *args):
            assert self.in_transaction
            if query.startswith("SELECT"):
                assert "FOR UPDATE" in query
                self.locked = True
                return {**FakeConnection().existing, "metadata": json.dumps(INITIAL_METADATA)}
            assert self.locked
            assert "outcome_report_id = NULL" in query
            assert "metadata =" in query and "artifacts =" in query
            assert json.loads(args[1]) == {**INITIAL_METADATA, "prs": [REPLACEMENT_PR]}
            assert json.loads(args[2])[0]["url"] == REPLACEMENT_PR["url"]
            return {**FakeConnection().existing, "metadata": args[1], "artifacts": args[2]}

    pool = LockedConnection()
    with _patch_pool(pool):
        tools = await _tools()
        await tools["task_update"](**IDENTITY, metadata={"prs": [REPLACEMENT_PR]})
    assert pool.locked and not pool.in_transaction


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("previous_status", "updates", "invalidates"),
    [
        ("pr_open", {"status": "pr_changes"}, True),
        ("pr_changes", {"status": "pr_open"}, True),
        ("in_progress", {"status": "pr_open"}, True),
        ("pr_open", {"status": "paused"}, True),
        ("paused", {"status": "pr_open"}, True),
        ("done", {"status": "in_progress"}, True),
        ("pr_open", {"status": "pr_open"}, False),
        ("paused", {"status": "paused"}, False),
        ("pr_open", {"status": "done"}, False),
        ("done", {"status": "done"}, False),
        ("pr_open", {"last_addressed": NOW.isoformat()}, False),
        ("pr_open", {"title": "Renamed", "summary": "Bookkeeping"}, False),
        ("pr_open", {"metadata": INITIAL_METADATA}, False),
        ("pr_open", {"metadata": {"last_step": "completed", "next_step": "archive"}}, False),
        ("pr_open", {"metadata": {"prs": [REPLACEMENT_PR]}}, True),
        ("pr_open", {"metadata": {"workflow": {"result": "rejected"}}}, True),
        ("pr_open", {"status": "done", "metadata": {"repos": ["org/other"]}}, True),
    ],
)
async def test_staged_report_change_archive_and_fresh_report_recovery(previous_status, updates, invalidates):
    pool = SQLiteArchivePool(
        {
            **FakeConnection().existing,
            **IDENTITY,
            "status": previous_status,
            "metadata": json.dumps(INITIAL_METADATA),
        }
    )
    try:
        with _patch_pool(pool):
            tools = await _tools()
            original = await _report(tools)
            assert original["outcome"]["decision"] == "accepted"
            original_id = original["outcome"]["id"]
            await tools["task_update"](**IDENTITY, **updates)
            row = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
            assert row is not None
            assert row["outcome_report_id"] == (None if invalidates else original_id)
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as rest:
                archived = await rest.delete(f"/api/tasks/{KEY}")
                assert archived.status_code == (409 if invalidates else 200)
                if invalidates:
                    assert "task_outcome_report" in archived.json()["error"]
                    after_failure = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
                    assert after_failure is not None and after_failure["status"] != "archived"
                    fresh = await _report(tools, reference=REPLACEMENT_PR["url"])
                    assert fresh["outcome"]["id"] != original_id
                    assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 200
            history = pool.conn.execute("SELECT id FROM task_outcome_reports ORDER BY id").fetchall()
            assert len(history) == (2 if invalidates else 1)
            assert history[0][0] == original_id
    finally:
        pool.conn.close()


@pytest_asyncio.fixture
async def freshness_real_database_pool(db):
    """Destructive conftest db fixture: run only against an explicitly disposable DB."""
    await db.execute(SCHEMA_PATH.read_text())
    pool = await asyncpg.create_pool(**DB_CONFIG, min_size=1, max_size=4)
    try:
        await pool.execute(
            "INSERT INTO tasks (external_key, source_type, status, repo, branch, metadata) "
            "VALUES ($1, 'manual', 'pr_open', 'org/repo', 'bot/freshness', $2::jsonb)",
            KEY,
            json.dumps(INITIAL_METADATA),
        )
        yield pool
    finally:
        await pool.close()


async def _row(pool):
    return await pool.fetchrow("SELECT * FROM tasks WHERE external_key = $1", KEY)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "updates",
    [
        {"status": "pr_changes"},
        {"status": "paused"},
        {"metadata": {"prs": [REPLACEMENT_PR]}},
        {"metadata": {"related_items": [{"url": "https://example.test/result", "type": "related"}]}},
        {"metadata": {"repos": ["org/other"]}},
        {"metadata": {"workflow": {"result": "rejected"}}},
        {"metadata": {"ci_result": "failed"}},
    ],
)
async def test_evidence_change_requires_fresh_report_real_database(freshness_real_database_pool, updates):
    pool = freshness_real_database_pool
    with _patch_pool(pool):
        tools = await _tools()
        original = await _report(tools)
        original_history = await pool.fetch("SELECT * FROM task_outcome_reports")
        await tools["task_update"](**IDENTITY, **updates)
        current = await _row(pool)
        assert current["outcome_report_id"] is None
        assert await pool.fetch("SELECT * FROM task_outcome_reports") == original_history
        if "metadata" in updates:
            assert json.loads(current["metadata"]) == {**INITIAL_METADATA, **updates["metadata"]}
        if "prs" in updates.get("metadata", {}):
            assert [artifact["url"] for artifact in json.loads(current["artifacts"])] == [REPLACEMENT_PR["url"]]
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as rest:
            assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 409
            assert await _row(pool) == current
            fresh = await _report(tools, reference=REPLACEMENT_PR["url"])
            assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 200
        assert (await _row(pool))["outcome_report_id"] == fresh["outcome"]["id"]
        assert fresh["outcome"]["id"] != original["outcome"]["id"]
        assert await pool.fetchval("SELECT COUNT(*) FROM task_outcome_reports") == 2


@pytest.mark.asyncio
async def test_noop_bookkeeping_and_completion_preserve_report_real_database(freshness_real_database_pool):
    pool = freshness_real_database_pool
    with _patch_pool(pool):
        tools = await _tools()
        original = await _report(tools)
        for updates in (
            {"status": "pr_open"},
            {"last_addressed": NOW.isoformat()},
            {"summary": "Complete", "title": "New title"},
            {"metadata": INITIAL_METADATA},
            {"metadata": {}},
            {"metadata": {"last_step": "complete", "next_step": "archive"}},
            {"status": "done"},
            {"status": "done", "metadata": INITIAL_METADATA},
        ):
            await tools["task_update"](**IDENTITY, **updates)
            assert (await _row(pool))["outcome_report_id"] == original["outcome"]["id"]
        archived = await tools["task_remove"](**IDENTITY)
        assert archived["outcome"]["id"] == original["outcome"]["id"]
        assert await pool.fetchval("SELECT COUNT(*) FROM task_outcome_reports") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["pause", "unpause"])
async def test_rest_pause_resume_invalidate_staged_report_real_database(freshness_real_database_pool, action):
    pool = freshness_real_database_pool
    with _patch_pool(pool):
        tools = await _tools()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as rest:
            if action == "unpause":
                assert (await rest.post(f"/api/tasks/{KEY}/pause")).status_code == 200
            original = await _report(tools)
            assert (await rest.post(f"/api/tasks/{KEY}/{action}")).status_code == 200
            current = await _row(pool)
            assert current["status"] == ("paused" if action == "pause" else "pr_open")
            assert current["outcome_report_id"] is None
            assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 409
            fresh = await _report(tools)
            assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 200
        assert fresh["outcome"]["id"] != original["outcome"]["id"]
        assert await pool.fetchval("SELECT COUNT(*) FROM task_outcome_reports") == 2


@pytest.mark.asyncio
async def test_metadata_rebuild_locks_before_reading_real_database(freshness_real_database_pool):
    pool = freshness_real_database_pool
    related = [{"url": "https://example.test/concurrent", "type": "related"}]
    with _patch_pool(pool):
        tools = await _tools()
        await _report(tools)
        update = None
        try:
            async with pool.acquire() as blocker, blocker.transaction():
                await blocker.fetchrow("SELECT * FROM tasks WHERE external_key = $1 FOR UPDATE", KEY)
                blocker_pid = await blocker.fetchval("SELECT pg_backend_pid()")
                update = asyncio.create_task(tools["task_update"](**IDENTITY, metadata={"prs": [REPLACEMENT_PR]}))

                async def wait_for_lock():
                    while True:
                        query = await pool.fetchval(
                            "SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
                            blocker_pid,
                        )
                        if query:
                            return query
                        await asyncio.sleep(0.01)

                blocked_query = await asyncio.wait_for(wait_for_lock(), timeout=5)
                assert blocked_query.startswith("SELECT * FROM tasks")
                assert "FOR UPDATE" in blocked_query
                assert not update.done()
                # A concurrent writer commits new metadata while the updater waits.
                await blocker.execute(
                    "UPDATE tasks SET metadata = metadata || $1::jsonb WHERE external_key = $2",
                    json.dumps({"related_items": related}),
                    KEY,
                )
            await asyncio.wait_for(update, timeout=5)
            current = await _row(pool)
            assert json.loads(current["metadata"]) == {
                **INITIAL_METADATA,
                "prs": [REPLACEMENT_PR],
                "related_items": related,
            }
            assert {artifact["url"] for artifact in json.loads(current["artifacts"])} == {
                REPLACEMENT_PR["url"],
                related[0]["url"],
            }
            assert current["outcome_report_id"] is None
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as rest:
                assert (await rest.delete(f"/api/tasks/{KEY}")).status_code == 409
            assert await pool.fetchval("SELECT COUNT(*) FROM task_outcome_reports") == 1
        finally:
            if update is not None and not update.done():
                update.cancel()
                await asyncio.gather(update, return_exceptions=True)

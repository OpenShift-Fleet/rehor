"""Unit and API contract tests for task outcome reporting."""

import json
import re
import sqlite3
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.api import api_task_delete
from bot_memory_server.models import OutcomeArtifact, OutcomeEvidence
from bot_memory_server.outcome_classifier import classify_task_outcome
from bot_memory_server.task_outcomes import (
    ARCHIVE_RECOVERY,
    api_task_outcome_detail,
    api_task_outcomes,
    api_task_outcomes_summary,
    canonical_repositories,
    normalize_reason,
)
from bot_memory_server.tools.tasks import register_task_tools
from conftest import SCHEMA_PATH
from fastmcp import Client, FastMCP
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from starlette.applications import Starlette
from starlette.routing import Route

app = Starlette(
    routes=[
        Route("/api/task-outcomes/summary", api_task_outcomes_summary, methods=["GET"]),
        Route("/api/task-outcomes/tasks", api_task_outcomes, methods=["GET"]),
        Route("/api/task-outcomes/tasks/{task_id}", api_task_outcome_detail, methods=["GET"]),
    ]
)
manual_archive_app = Starlette(routes=[Route("/api/tasks/{key:path}", api_task_delete, methods=["DELETE"])])

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


def _task_row(**overrides):
    row = {
        "task_id": 7,
        "external_key": "REHOR-156",
        "source_type": "jira",
        "source_url": "https://redhat.atlassian.net/browse/REHOR-156",
        "task_status": "archived",
        "repo": "org/repo",
        "title": "Outcome API",
        "summary": "Add task outcome reporting",
        "created_at": NOW,
        "last_addressed": NOW,
        "archived_at": NOW,
        "task_artifacts": "[]",
        "outcome_id": 11,
        "decision": "accepted",
        "confidence": "conclusive",
        "reason": "merged",
        "reported_by": "agent",
        "reported_at": NOW,
        "verified_at": None,
        "outcome_artifacts": json.dumps([{"type": "github_pr", "url": "https://github.com/org/repo/pull/1"}]),
        "evidence": json.dumps(
            [
                {
                    "source": "github",
                    "reference": "https://github.com/org/repo/pull/1",
                    "resolution": "accepted",
                    "disposition": "Merged",
                    "reason": "PR merged",
                }
            ]
        ),
        "canonical_repositories": json.dumps(["org/repo"]),
        "notes": None,
        "run_id": "run-1",
        "reporting_cycle_id": 4,
        "attempt": 1,
        "workflow": "jira-sprint",
        "instance_id": "bot-1",
        "state": "accepted",
        "event_at": NOW,
    }
    row.update(overrides)
    return row


def _artifact(**values):
    return OutcomeArtifact.model_validate(values)


def _evidence(**values):
    return OutcomeEvidence.model_validate(values)


class FakePool:
    def __init__(self, *, row=None, scalar=None, rows=None, fetch_rows=None):
        self.row = row
        self.scalar = scalar
        self.rows = rows or []
        self.fetch_rows = list(fetch_rows or [])
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.row

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return self.scalar

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        if self.fetch_rows:
            return self.fetch_rows.pop(0)
        return self.rows


@pytest.mark.asyncio
async def test_summary_separates_outcome_states_and_excludes_unknowns_from_rate():
    pool = FakePool(
        row={
            "task_count": 5,
            "accepted_count": 1,
            "rejected_count": 1,
            "obsolete_count": 0,
            "inconclusive_count": 1,
            "unreported_count": 1,
            "wip_count": 1,
        },
        scalar=4,
        fetch_rows=[
            [
                {
                    "repo": "org/repo",
                    "task_count": 2,
                    "accepted_count": 1,
                    "rejected_count": 1,
                    "obsolete_count": 0,
                    "inconclusive_count": 0,
                    "unreported_count": 0,
                    "wip_count": 0,
                },
                {
                    "repo": "org/other",
                    "task_count": 1,
                    "accepted_count": 0,
                    "rejected_count": 0,
                    "obsolete_count": 0,
                    "inconclusive_count": 1,
                    "unreported_count": 0,
                    "wip_count": 0,
                },
            ],
            [
                {"repo": "org/repo", "reason": "merged", "task_count": 1},
                {"repo": "org/repo", "reason": "closed_unmerged", "task_count": 1},
            ],
            [
                {"repo": "org/repo", "source": "github", "task_count": 2},
                {"repo": "org/other", "source": "jira", "task_count": 1},
            ],
        ],
    )
    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/task-outcomes/summary?from=2026-10-01&to=2026-10-01")

    assert response.status_code == 200
    body = response.json()
    assert body["summary"] == {
        "acceptanceRate": 0.5,
        "taskCount": 5,
        "repositoryCount": 4,
        "acceptedCount": 1,
        "rejectedCount": 1,
        "obsoleteCount": 0,
        "inconclusiveCount": 1,
        "unreportedCount": 1,
        "wipCount": 1,
    }
    assert body["repositories"][0]["providers"] == {"github": 2}
    assert body["backfill"] == {"state": "not_started", "unknownCount": 1}
    assert body["period"] == {"from": "2026-10-01", "to": "2026-10-01"}
    assert len(pool.calls) == 5
    assert all("WITH task_outcomes AS" in query for _, query, _ in pool.calls)


@pytest.mark.asyncio
async def test_task_list_paginates_stably_and_applies_provider_filters():
    pool = FakePool(scalar=3, rows=[_task_row()])
    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/task-outcomes/tasks?decision=accepted&source=GITHUB&limit=1&offset=1")
            invalid = await client.get("/api/task-outcomes/tasks?limit=101")

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert body["items"][0]["taskId"] == 7
    assert body["items"][0]["evidence"][0]["resolution"] == "accepted"
    assert body["items"][0]["evidence"][0]["disposition"] == "Merged"
    query = next(query for kind, query, _ in pool.calls if kind == "fetch")
    assert "ORDER BY event_at DESC, task_id DESC" in query
    assert "lower(evidence_item.value->>'source')" in query
    assert invalid.status_code == 400


@pytest.mark.asyncio
async def test_detail_returns_full_append_only_outcome_history():
    latest = _task_row()
    history = [
        {
            "id": 10,
            "decision": "rejected",
            "confidence": "conclusive",
            "reason": "closed_unmerged",
            "reported_by": "agent",
            "reported_at": NOW,
            "verified_at": None,
            "artifacts": "[]",
            "evidence": "[]",
            "canonical_repositories": '["org/repo"]',
            "notes": None,
            "run_id": None,
            "reporting_cycle_id": None,
            "attempt": None,
            "workflow": None,
            "instance_id": None,
        },
        {
            "id": 11,
            "decision": "accepted",
            "confidence": "conclusive",
            "reason": "merged",
            "reported_by": "workflow",
            "reported_at": NOW,
            "verified_at": None,
            "artifacts": latest["outcome_artifacts"],
            "evidence": latest["evidence"],
            "canonical_repositories": latest["canonical_repositories"],
            "notes": None,
            "run_id": "run-1",
            "reporting_cycle_id": 4,
            "attempt": 1,
            "workflow": "jira-sprint",
            "instance_id": "bot-1",
        },
    ]
    pool = FakePool(fetch_rows=[[latest], history, []])
    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/task-outcomes/tasks/7")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "accepted"
    assert body["outcome"]["runId"] == "run-1"
    assert [item["decision"] for item in body["outcomeHistory"]] == ["rejected", "accepted"]
    assert [item["id"] for item in body["outcomeHistory"]] == [10, 11]


class FakeConnection:
    def __init__(self, *, archived=False):
        self.existing = {
            "id": 42,
            "external_key": "ARCHIVE-1",
            "source_type": "jira",
            "source_url": None,
            "artifacts": "[]",
            "status": "archived" if archived else "in_progress",
            "outcome_report_id": 100 if archived else None,
            "archived_at": NOW if archived else None,
            "repo": "org/repo",
            "branch": "bot/test",
            "title": "Archive test",
            "summary": "",
            "created_at": NOW,
            "last_addressed": NOW,
            "paused_reason": None,
            "instance_id": "bot-1",
            "metadata": "{}",
        }
        self.report_args = None
        self.report_row = None
        self.queries = []
        self.other_tasks = []

    @asynccontextmanager
    async def transaction(self):
        yield

    async def fetch(self, query, *args):
        self.queries.append((query, args))
        assert "SELECT * FROM tasks" in query and "FOR UPDATE" in query
        return [row for row in [self.existing, *self.other_tasks] if row["external_key"] == args[0]]

    async def fetchrow(self, query, *args):
        self.queries.append((query, args))
        if "SELECT id, status, outcome_report_id FROM tasks" in query:
            return {key: self.existing[key] for key in ("id", "status", "outcome_report_id")}
        if "SELECT * FROM tasks" in query:
            return next(
                (
                    row
                    for row in [self.existing, *self.other_tasks]
                    if row["external_key"] == args[0] and row["source_type"] == args[1]
                ),
                None,
            )
        if "INSERT INTO task_outcome_reports" in query:
            self.report_args = args
            self.report_row = {
                "id": 101,
                "task_id": args[0],
                "decision": args[1],
                "confidence": args[2],
                "reason": args[3],
                "reported_by": args[4],
                "reported_at": NOW,
                "verified_at": args[5],
                "artifacts": args[6],
                "evidence": args[7],
                "canonical_repositories": args[8],
                "notes": args[9],
                "run_id": args[10],
                "reporting_cycle_id": args[11],
                "attempt": args[12],
                "workflow": args[13],
                "instance_id": args[14],
            }
            return self.report_row
        if "UPDATE tasks SET outcome_report_id" in query:
            self.existing = {**self.existing, "outcome_report_id": args[0]}
            return self.existing
        if "SELECT * FROM task_outcome_reports" in query:
            return self.report_row
        if "UPDATE tasks SET status" in query:
            assert "WHERE id = $1" in query
            updated = {**self.existing, "status": "archived", "archived_at": self.existing["archived_at"] or NOW}
            if "outcome_report_id = NULL" in query:
                updated["outcome_report_id"] = None
            self.existing = updated
            return updated
        raise AssertionError(f"Unexpected query: {query}")


class FakeConnectionPool:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn


@pytest.mark.asyncio
async def test_mcp_archive_requires_staged_report_and_appends_run_context():
    mcp = FastMCP(name="task-outcome-tests")
    register_task_tools(mcp)
    tools = {tool.name: tool.fn for tool in await mcp.list_tools()}
    conn = FakeConnection()
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=FakeConnectionPool(conn)),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as client:
            failed_archive = await client.call_tool(
                "task_remove",
                {"external_key": "ARCHIVE-1"},
                raise_on_error=False,
            )
        error_text = getattr(failed_archive.content[0], "text", "")
        assert failed_archive.is_error
        assert ARCHIVE_RECOVERY in error_text[:200]
        assert "Call task_outcome_report first" in error_text
        assert "resolution: accepted|rejected|unknown" in error_text
        assert "then retry task_remove" in error_text
        report_result = await tools["task_outcome_report"](
            external_key="ARCHIVE-1",
            artifacts=[_artifact(type="github_pr", url="https://github.com/org/repo/pull/2")],
            evidence=[
                _evidence(
                    source="github",
                    reference="https://github.com/org/repo/pull/2",
                    resolution="accepted",
                    disposition="Merged",
                    reason="Merged PR",
                )
            ],
            notes=None,
            run_id="run-archive-1",
            reporting_cycle_id=12,
            attempt=1,
            workflow="jira-sprint",
        )
        assert report_result["status"] == "in_progress"
        result = await tools["task_remove"](external_key="ARCHIVE-1")

    assert result["status"] == "archived"
    assert result["outcome"]["decision"] == "accepted"
    assert result["outcome"]["canonicalRepositories"] == ["org/repo"]
    assert conn.report_args is not None
    assert conn.report_args[10:] == ("run-archive-1", 12, 1, "jira-sprint", "bot-1")
    assert len([query for query, _ in conn.queries if "INSERT INTO task_outcome_reports" in query]) == 1


@pytest.mark.asyncio
async def test_correction_appends_report_without_changing_task_lifecycle():
    mcp = FastMCP(name="task-outcome-correction-tests")
    register_task_tools(mcp)
    tool = next(tool for tool in await mcp.list_tools() if tool.name == "task_outcome_report")
    conn = FakeConnection(archived=True)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=FakeConnectionPool(conn)),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        result = await tool.fn(
            external_key="ARCHIVE-1",
            artifacts=[],
            evidence=[
                _evidence(
                    source="jira",
                    reference="https://jira.example/browse/ARCHIVE-1/comment/1",
                    resolution="rejected",
                    disposition="Still required",
                    reason="Human comment says work is still required",
                    authorType="human",
                )
            ],
            notes="Corrected after review",
            correction=True,
        )

    assert result["status"] == "archived"
    assert result["outcome"]["decision"] == "rejected"
    assert result["outcome"]["reportedBy"] == "agent"
    assert not any("UPDATE tasks SET status" in query for query, _ in conn.queries)


@pytest.mark.asyncio
async def test_task_add_and_update_cannot_bypass_outcome_required_archive():
    mcp = FastMCP(name="task-outcome-archive-guard-tests")
    register_task_tools(mcp)
    tools = {tool.name: tool.fn for tool in await mcp.list_tools()}

    with pytest.raises(ValueError, match="task_remove"):
        await tools["task_add"](
            external_key="ARCHIVE-GUARD-1",
            repo="org/repo",
            branch="bot/test",
            status="archived",
        )
    with pytest.raises(ValueError, match="task_remove"):
        await tools["task_update"](external_key="ARCHIVE-GUARD-1", status="archived")


def _report_arguments(source_type="jira", **overrides):
    return {
        "external_key": "ARCHIVE-1",
        "source_type": source_type,
        "artifacts": [],
        "evidence": [
            {
                "source": "custom",
                "reference": "ARCHIVE-1",
                "resolution": "accepted",
                "disposition": "Completed",
                "reason": "Verified completion",
            }
        ],
        "notes": "Verified after legacy script failed",
        **overrides,
    }


@pytest.mark.asyncio
async def test_legacy_rest_failure_recovers_via_mcp_report_and_archive_without_rerunning_skill():
    conn = FakeConnection()
    pool = FakeConnectionPool(conn)
    mcp = FastMCP(name="legacy-archive-recovery")
    register_task_tools(mcp)
    before = dict(conn.existing)
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", new_callable=AsyncMock) as publish,
    ):
        async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
            failure = await rest.delete("/api/tasks/ARCHIVE-1")
            assert failure.status_code == 409
            assert next(iter(failure.json())) == "error"
            assert ARCHIVE_RECOVERY in failure.text[:200]
            assert len(json.dumps({"error": ARCHIVE_RECOVERY})) <= 200
            assert failure.json()["source_type"] == "jira"
            assert failure.json()["external_key"] == "ARCHIVE-1"
            assert "resolution: accepted|rejected|unknown" in failure.json()["evidence"]
            assert conn.existing == before
            publish.assert_not_awaited()
            assert not any(query.lstrip().startswith("UPDATE") for query, _ in conn.queries)

            async with Client(mcp) as agent:
                report = await agent.call_tool("task_outcome_report", _report_arguments())
                assert not report.is_error
                assert conn.existing["status"] == "in_progress"
                archive = await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1"})
                assert not archive.is_error
                selected = dict(conn.existing)
                history = dict(conn.report_row)
                writes = len([q for q, _ in conn.queries if q.lstrip().startswith("UPDATE")])
                events = publish.await_count
                retry = await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1"})
                assert not retry.is_error
                rest_retry = await rest.delete("/api/tasks/ARCHIVE-1")
                assert rest_retry.status_code == 200
                assert conn.existing == selected
                assert conn.report_row == history
                assert len([q for q, _ in conn.queries if q.lstrip().startswith("UPDATE")]) == writes
                assert publish.await_count == events
    assert selected["outcome_report_id"] == history["id"]
    assert selected["last_addressed"] == before["last_addressed"]


@pytest.mark.asyncio
@pytest.mark.parametrize("source_type", ["jira", "manual"])
async def test_default_rest_archive_preserves_staged_report_and_scopes_identity(source_type):
    conn = FakeConnection()
    conn.existing["source_type"] = source_type
    pool = FakeConnectionPool(conn)
    mcp = FastMCP(name="staged-rest-archive")
    register_task_tools(mcp)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as agent:
            await agent.call_tool("task_outcome_report", _report_arguments(source_type))
        history = dict(conn.report_row)
        other = {**conn.existing, "id": 43, "source_type": "github", "outcome_report_id": 202}
        conn.other_tasks.append(other)
        async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
            ambiguous = await rest.delete("/api/tasks/ARCHIVE-1")
            assert ambiguous.status_code == 409
            assert "specify source_type" in ambiguous.json()["detail"]
            manual_ambiguous = await rest.delete("/api/tasks/ARCHIVE-1?manual=true")
            assert manual_ambiguous.status_code == 409
            assert (await rest.delete("/api/tasks/ARCHIVE-1?source_type=missing")).status_code == 404
            assert conn.existing["status"] == "in_progress"
            archived = await rest.delete(f"/api/tasks/ARCHIVE-1?source_type={source_type}")
            assert archived.status_code == 200
            assert archived.json()["task"]["source_type"] == source_type
    assert conn.existing["outcome_report_id"] == history["id"]
    assert conn.report_row == history
    assert conn.other_tasks == [other]
    assert other["status"] == "in_progress" and other["outcome_report_id"] == 202


@pytest.mark.asyncio
@pytest.mark.parametrize("staged", [False, True])
async def test_explicit_manual_archive_clears_only_selected_pointer_and_remains_unreported(staged):
    conn = FakeConnection()
    pool = FakeConnectionPool(conn)
    mcp = FastMCP(name="explicit-manual-archive")
    register_task_tools(mcp)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as agent:
            if staged:
                await agent.call_tool("task_outcome_report", _report_arguments())
            history = dict(conn.report_row) if staged else None
            async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
                archive = await rest.delete("/api/tasks/ARCHIVE-1?manual=true")
                assert archive.status_code == 200
                assert conn.existing["outcome_report_id"] is None
                selected = dict(conn.existing)
                assert (await rest.delete("/api/tasks/ARCHIVE-1?manual=true")).status_code == 200
                assert conn.existing == selected
                strict = await rest.delete("/api/tasks/ARCHIVE-1")
                assert strict.status_code == 409
                assert ARCHIVE_RECOVERY in strict.text[:200]
            strict_mcp = await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1"}, raise_on_error=False)
            assert strict_mcp.is_error
            assert ARCHIVE_RECOVERY in strict_mcp.content[0].text[:200]
            assert conn.existing == selected
            assert conn.report_row == history
            # Archived/unreported recovery explicitly appends a correction before strict retry.
            await agent.call_tool("task_outcome_report", _report_arguments(correction=True))
            await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1"})
            assert conn.existing["archived_at"] == selected["archived_at"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "corruption",
    [
        "missing_pointer",
        "missing_report",
        "wrong_task",
        "wrong_report",
        "invalid_json",
        "object_evidence",
        "null_artifacts",
        "bad_artifact",
        "bad_resolution",
        "empty_reason",
        "bad_decision",
        "bad_confidence",
        "bad_repositories",
        "missing_field",
    ],
)
@pytest.mark.parametrize("protocol", ["rest", "mcp"])
async def test_invalid_staged_reports_fail_before_mutation(corruption, protocol):
    conn = FakeConnection()
    pool = FakeConnectionPool(conn)
    mcp = FastMCP(name="corrupt-archive-guard")
    register_task_tools(mcp)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", new_callable=AsyncMock) as publish,
    ):
        async with Client(mcp) as agent:
            await agent.call_tool("task_outcome_report", _report_arguments())
            if corruption == "missing_pointer":
                conn.existing["outcome_report_id"] = None
            elif corruption == "missing_report":
                conn.report_row = None
            elif corruption == "missing_field":
                del conn.report_row["reported_at"]
            else:
                field, value = {
                    "wrong_task": ("task_id", 43),
                    "wrong_report": ("id", 102),
                    "invalid_json": ("evidence", "{"),
                    "object_evidence": ("evidence", "{}"),
                    "null_artifacts": ("artifacts", "null"),
                    "bad_artifact": ("artifacts", '[{"url":"x"}]'),
                    "bad_resolution": (
                        "evidence",
                        json.dumps([{**_report_arguments()["evidence"][0], "resolution": "bad"}]),
                    ),
                    "empty_reason": ("reason", " "),
                    "bad_decision": ("decision", "bad"),
                    "bad_confidence": ("confidence", "inconclusive"),
                    "bad_repositories": ("canonical_repositories", "{}"),
                }[corruption]
                conn.report_row[field] = value
            before = dict(conn.existing)
            report_before = dict(conn.report_row) if conn.report_row else None
            conn.queries.clear()
            publish.reset_mock()
            if protocol == "mcp":
                failure = await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1"}, raise_on_error=False)
                assert failure.is_error
                assert ARCHIVE_RECOVERY in failure.content[0].text[:200]
            else:
                async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
                    failure = await rest.delete("/api/tasks/ARCHIVE-1")
                    assert failure.status_code == 409
                    assert ARCHIVE_RECOVERY in failure.text[:200]
            assert conn.existing == before
            assert conn.report_row == report_before
            assert not any(query.lstrip().startswith("UPDATE") for query, _ in conn.queries)
            publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_task_update_archive_protocol_redirects_in_first_200_chars():
    mcp = FastMCP(name="task-update-archive-recovery")
    register_task_tools(mcp)
    async with Client(mcp) as agent:
        failure = await agent.call_tool(
            "task_update", {"external_key": "ARCHIVE-1", "status": "archived"}, raise_on_error=False
        )
    assert failure.is_error
    assert ARCHIVE_RECOVERY in failure.content[0].text[:200]
    assert "do not retry task_update" in failure.content[0].text


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["manual=1", "manual=yes", "source_type="])
async def test_invalid_archive_query_is_rejected_before_database_access(query):
    pool = FakeConnectionPool(FakeConnection())
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
            assert (await rest.delete(f"/api/tasks/ARCHIVE-1?{query}")).status_code == 400
    assert not pool.conn.queries


class SQLiteTaskPool:
    """Execute production task SQL, adapting PostgreSQL casts, row locks and RETURNING.

    This checks CASE/parameter/old-row semantics without simulating lifecycle logic.
    Writes use rowid lookups instead of requiring SQLite 3.35's RETURNING support.
    PostgreSQL enums, foreign keys and locking remain covered by real_database tests.
    """

    def __init__(self, row):
        self.conn = sqlite3.connect(":memory:", isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.create_function("NOW", 0, lambda: NOW.isoformat())
        columns = ", ".join(f"{key} {'INTEGER' if key in {'id', 'outcome_report_id'} else 'TEXT'}" for key in row)
        self.conn.execute(f"CREATE TABLE tasks ({columns})")
        self.conn.execute("CREATE TABLE task_outcome_reports (id INTEGER, task_id INTEGER, evidence TEXT)")
        self.conn.execute("INSERT INTO task_outcome_reports VALUES (101, 42, 'original evidence')")
        placeholders = ", ".join("?" for _ in row)
        for values in (row, {**row, "id": 43, "source_type": "manual"}):
            self.conn.execute(
                f"INSERT INTO tasks VALUES ({placeholders})",
                tuple(value.isoformat() if isinstance(value, datetime) else value for value in values.values()),
            )

    @asynccontextmanager
    async def acquire(self):
        yield self

    @asynccontextmanager
    async def transaction(self):
        self.conn.execute("BEGIN")
        with self.conn:
            yield

    async def fetchrow(self, query, *args):
        query = query.replace("::task_status", "").replace(" FOR UPDATE", "")
        params = {
            str(index): value.isoformat() if isinstance(value, datetime) else value
            for index, value in enumerate(args, 1)
        }
        statement, returning = re.subn(r"\s+RETURNING\s+\*\s*;?\s*$", "", query, flags=re.IGNORECASE)
        if returning:
            row = self._write_and_fetchrow(statement.strip(), params)
        else:
            assert not re.search(r"\bRETURNING\b", query, re.IGNORECASE), "Only RETURNING * is supported"
            row = self.conn.execute(query, params).fetchone()
        return dict(row) if row else None

    def _write_and_fetchrow(self, statement, params):
        """Adapt only single-row VALUES inserts and identity-filtered updates.

        Keep named $n bindings: WHERE placeholders need not start at $1 or appear
        in argument order. Capture UPDATE identities before executing the original
        SET expressions, since those expressions can change the lookup fields.
        Neither lookup nor write commits; transaction() retains rollback control.
        """
        insert = re.fullmatch(
            r"INSERT\s+INTO\s+(tasks|task_outcome_reports)\s*\([^()]+\)\s*VALUES\s*\([^()]+\)",
            statement,
            re.IGNORECASE | re.DOTALL,
        )
        if insert:
            table = insert[1]
            cursor = self.conn.execute(statement, params)
            rowid = cursor.lastrowid
        else:
            identity = r"(?:id|task_id|external_key|source_type)\s*=\s*\$\d+"
            update = re.fullmatch(
                rf"UPDATE\s+(tasks|task_outcome_reports)\s+SET\s+.+?\s+WHERE\s+({identity}(?:\s+AND\s+{identity})*)",
                statement,
                re.IGNORECASE | re.DOTALL,
            )
            assert update, f"Unsupported RETURNING SQL shape: {statement}"
            table, where = update.groups()
            matches = self.conn.execute(f"SELECT rowid FROM {table} WHERE {where} ORDER BY rowid", params).fetchall()
            self.conn.execute(statement, params)
            if not matches:
                return None
            rowid = matches[0][0]
        return self.conn.execute(f"SELECT * FROM {table} WHERE rowid = ?", (rowid,)).fetchone()


class SQLiteArchivePool(SQLiteTaskPool):
    """Execute report and archive SQL against isolated storage, never the db fixture."""

    def __init__(self, row):
        super().__init__(row)
        self.conn.execute("DELETE FROM tasks WHERE id = 43")
        self.conn.execute("DROP TABLE task_outcome_reports")
        columns = (
            "id INTEGER PRIMARY KEY, task_id INTEGER, decision TEXT, confidence TEXT, reason TEXT, "
            "reported_by TEXT, reported_at TEXT DEFAULT (NOW()), verified_at TEXT, artifacts TEXT, "
            "evidence TEXT, canonical_repositories TEXT, notes TEXT, run_id TEXT, reporting_cycle_id INTEGER, "
            "attempt INTEGER, workflow TEXT, instance_id TEXT"
        )
        self.conn.execute(f"CREATE TABLE task_outcome_reports ({columns})")
        self.queries = []
        self.conn.set_trace_callback(self.queries.append)

    async def fetchrow(self, query, *args):
        row = await super().fetchrow(query.replace("::jsonb", ""), *args)
        if row:
            for field in ("created_at", "last_addressed", "archived_at", "reported_at", "verified_at"):
                if row.get(field):
                    row[field] = datetime.fromisoformat(row[field])
        return row

    async def fetch(self, query, *args):
        row = await self.fetchrow(query, *args)
        return [row] if row else []


@pytest.mark.asyncio
@pytest.mark.parametrize("pool_type", [SQLiteTaskPool, SQLiteArchivePool])
async def test_sqlite_adapter_insert_returns_inserted_row_without_native_returning(pool_type):
    pool = pool_type(FakeConnection().existing)
    queries = []
    pool.conn.set_trace_callback(queries.append)
    try:
        # Duplicate external identity ensures retrieval uses the inserted rowid.
        row = await pool.fetchrow(
            "INSERT INTO tasks (id, external_key, source_type, status, last_addressed) "
            "VALUES ($10, $2, $3, $4::task_status, $5) RETURNING *;",
            None,
            "ARCHIVE-1",
            "jira",
            "done",
            NOW,
            None,
            None,
            None,
            None,
            100,
        )
        assert row["id"] == 100
        assert row["external_key"] == "ARCHIVE-1"
        assert row["status"] == "done"
        assert row["last_addressed"] == (NOW if pool_type is SQLiteArchivePool else NOW.isoformat())
        assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in queries)
        assert sum(query.startswith("INSERT") for query in queries) == 1
    finally:
        pool.conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("pool_type", [SQLiteTaskPool, SQLiteArchivePool])
@pytest.mark.parametrize("lookup", ["id = $1", "external_key = $3 AND source_type = $10"])
async def test_sqlite_adapter_update_preserves_old_row_sql_and_identity(pool_type, lookup):
    pool = pool_type({**FakeConnection().existing, "status": "done", "outcome_report_id": 101})
    queries = []
    pool.conn.set_trace_callback(queries.append)
    try:
        row = await pool.fetchrow(
            "UPDATE tasks SET status = $2::task_status, external_key = $4, "
            "outcome_report_id = CASE WHEN status = 'done'::task_status AND $2 != 'done' "
            f"THEN NULL ELSE outcome_report_id END WHERE {lookup} RETURNING *",
            42,
            "in_progress",
            "ARCHIVE-1",
            "RENAMED-1",
            None,
            None,
            None,
            None,
            None,
            "jira",
        )
        assert row["id"] == 42
        assert row["external_key"] == "RENAMED-1"
        assert row["status"] == "in_progress"
        assert row["outcome_report_id"] is None
        assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in queries)
        assert sum(query.startswith("UPDATE") for query in queries) == 1
        other = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 43)
        if pool_type is SQLiteTaskPool:
            assert other["external_key"] == "ARCHIVE-1"
            assert other["status"] == "done"
            assert other["outcome_report_id"] == 101
    finally:
        pool.conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("table", "lookup", "field", "first_id"),
    [
        ("tasks", "external_key = $1", "summary", 42),
        ("task_outcome_reports", "task_id = $1", "evidence", 101),
    ],
)
async def test_sqlite_adapter_update_returns_first_match_and_updates_all_matches(table, lookup, field, first_id):
    pool = SQLiteTaskPool(FakeConnection().existing)
    if table == "task_outcome_reports":
        pool.conn.execute("INSERT INTO task_outcome_reports VALUES (102, 42, 'other evidence')")
    queries = []
    pool.conn.set_trace_callback(queries.append)
    try:
        row = await pool.fetchrow(
            f"UPDATE {table} SET {field} = $2 WHERE {lookup} RETURNING *",
            "ARCHIVE-1" if table == "tasks" else 42,
            "updated",
        )
        assert row["id"] == first_id
        assert row[field] == "updated"
        assert [item[0] for item in pool.conn.execute(f"SELECT {field} FROM {table} ORDER BY rowid")] == [
            "updated",
            "updated",
        ]
        assert sum(query.startswith("UPDATE") for query in queries) == 1
        assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in queries)
    finally:
        pool.conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("pool_type", [SQLiteTaskPool, SQLiteArchivePool])
async def test_sqlite_adapter_no_match_returns_none_and_writes_rollback(pool_type):
    pool = pool_type(FakeConnection().existing)
    queries = []
    pool.conn.set_trace_callback(queries.append)
    try:
        before = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
        assert await pool.fetchrow("UPDATE tasks SET status = $2 WHERE id = $1 RETURNING *", 999, "done") is None
        assert await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42) == before
        with pytest.raises(RuntimeError, match="abort"):
            async with pool.transaction():
                updated = await pool.fetchrow("UPDATE tasks SET status = $2 WHERE id = $1 RETURNING *", 42, "done")
                assert updated["status"] == "done"
                inserted = await pool.fetchrow(
                    "INSERT INTO task_outcome_reports (task_id, evidence) VALUES ($1, $2) RETURNING *",
                    42,
                    "rolled back evidence",
                )
                assert inserted["task_id"] == 42
                assert inserted["evidence"] == "rolled back evidence"
                raise RuntimeError("abort")
        assert await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42) == before
        assert (
            await pool.fetchrow("SELECT * FROM task_outcome_reports WHERE evidence = $1", "rolled back evidence")
            is None
        )
        assert "ROLLBACK" in queries
        assert sum(query.startswith("UPDATE") for query in queries) == 2
        assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in queries)
    finally:
        pool.conn.close()


@pytest.mark.asyncio
async def test_report_and_strict_rest_archive_execute_sql_transaction_and_preserve_history():
    pool = SQLiteArchivePool({**FakeConnection().existing, "source_type": "manual"})
    mcp = FastMCP(name="strict-archive-sql")
    register_task_tools(mcp)
    try:
        with (
            patch("bot_memory_server.api.get_pool", return_value=pool),
            patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
            patch("bot_memory_server.api.bus.publish", new_callable=AsyncMock),
        ):
            async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as rest:
                before = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
                assert (await rest.delete("/api/tasks/ARCHIVE-1")).status_code == 409
                assert await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42) == before
                async with Client(mcp) as agent:
                    await agent.call_tool("task_outcome_report", _report_arguments("manual"))
                    staged = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
                    history = await pool.fetchrow("SELECT * FROM task_outcome_reports WHERE task_id = $1", 42)
                    assert staged["status"] == "in_progress"
                    assert staged["outcome_report_id"] == history["id"]
                    assert (await rest.delete("/api/tasks/ARCHIVE-1")).status_code == 200
                    archived = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
                    assert archived["status"] == "archived"
                    assert archived["outcome_report_id"] == history["id"]
                    assert archived["last_addressed"] == before["last_addressed"]
                    assert archived["archived_at"] == NOW
                    assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in pool.queries)
                    pool.queries.clear()
                    assert (await rest.delete("/api/tasks/ARCHIVE-1")).status_code == 200
                    await agent.call_tool("task_remove", {"external_key": "ARCHIVE-1", "source_type": "manual"})
                    assert await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42) == archived
                    assert await pool.fetchrow("SELECT * FROM task_outcome_reports WHERE task_id = $1", 42) == history
                    assert not any(query.startswith(("UPDATE", "INSERT")) for query in pool.queries)
    finally:
        pool.conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("previous_status", "status", "clears_report"),
    [
        ("done", "in_progress", True),
        ("done", "pr_open", True),
        ("done", "pr_changes", True),
        ("done", "paused", True),
        ("done", "done", False),
        ("done", None, False),
        ("in_progress", "done", False),
        ("pr_open", "done", False),
        ("pr_changes", "done", False),
        ("paused", "done", False),
        ("archived", "in_progress", True),
        ("archived", "paused", True),
        ("archived", "done", True),
    ],
)
async def test_mcp_update_executes_reopen_sql_and_rejects_stale_archive(previous_status, status, clears_report):
    row = {
        **FakeConnection().existing,
        "status": previous_status,
        "outcome_report_id": 101,
        "archived_at": NOW if previous_status == "archived" else None,
    }
    pool = SQLiteTaskPool(row)
    queries = []
    pool.conn.set_trace_callback(queries.append)
    mcp = FastMCP(name="task-outcome-reopen-sql-tests")
    register_task_tools(mcp)
    try:
        with (
            patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
            patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
        ):
            async with Client(mcp) as client:
                arguments = {
                    "external_key": "ARCHIVE-1",
                    "summary": "Work changed after review",
                    "last_addressed": NOW.isoformat(),
                }
                if status is not None:
                    arguments["status"] = status
                await client.call_tool("task_update", arguments)
                updated = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 42)
                assert updated is not None
                assert updated["status"] == (status or previous_status)
                assert updated["summary"] == "Work changed after review"
                assert updated["outcome_report_id"] == (None if clears_report else 101)
                assert updated["archived_at"] is None
                if clears_report:
                    archive = await client.call_tool("task_remove", {"external_key": "ARCHIVE-1"}, raise_on_error=False)
                    assert archive.is_error
                    assert "requires task_outcome_report" in getattr(archive.content[0], "text", "")
                    after_archive = await pool.fetchrow("SELECT status FROM tasks WHERE id = $1", 42)
                    assert after_archive is not None
                    assert after_archive["status"] == status

        other_source = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", 43)
        assert other_source is not None
        assert other_source["status"] == previous_status
        assert other_source["outcome_report_id"] == 101
        history = pool.conn.execute("SELECT * FROM task_outcome_reports").fetchall()
        assert [tuple(item) for item in history] == [(101, 42, "original evidence")]
        assert not any(re.search(r"\bRETURNING\b", query, re.IGNORECASE) for query in queries)
    finally:
        pool.conn.close()


def test_canonical_repo_normalization_prefers_target_over_fork():
    assert canonical_repositories(
        "fork/repo",
        [
            {
                "type": "gitlab_mr",
                "url": "https://gitlab.com/group/subgroup/repo/-/merge_requests/4",
                "headRepo": "fork/repo",
            }
        ],
    ) == ["group/subgroup/repo"]


def test_evidence_model_accepts_custom_sources_and_rejects_provider_fields():
    evidence = _evidence(
        source="Custom workflow",
        reference="https://workflow.example/evidence/2",
        resolution="unknown",
        disposition="Waiting for owner approval",
        reason="No final result is available yet",
    )
    assert evidence.model_dump(by_alias=True)["source"] == "Custom workflow"
    assert evidence.model_dump(by_alias=True)["disposition"] == "Waiting for owner approval"
    with pytest.raises(ValidationError):
        _evidence(
            source="GitHub",
            reference="https://github.com/acme/app/pull/1",
            resolution="accepted",
            disposition="MERGED",
            reason="Merged in target repository",
            statusName="Merged",
        )


def test_evidence_reducer_uses_rejected_unknown_accepted_priority():
    artifacts = []
    unknown_wins_over_acceptance = classify_task_outcome(
        artifacts=artifacts,
        evidence=[
            {"source": "custom-a", "reference": "A", "resolution": "accepted", "disposition": "ok", "reason": "done"},
            {
                "source": "custom-b",
                "reference": "B",
                "resolution": "unknown",
                "disposition": "pending",
                "reason": "ambiguous",
            },
        ],
        task_reference="TASK-1",
    )
    rejected_wins_over_unknown = classify_task_outcome(
        artifacts=artifacts,
        evidence=[
            {
                "source": "custom-a",
                "reference": "A",
                "resolution": "unknown",
                "disposition": "pending",
                "reason": "ambiguous",
            },
            {
                "source": "custom-b",
                "reference": "B",
                "resolution": "rejected",
                "disposition": "failed",
                "reason": "rejected",
            },
        ],
        task_reference="TASK-1",
    )
    assert unknown_wins_over_acceptance["decision"] == "inconclusive"
    assert unknown_wins_over_acceptance["reason"] == "ambiguous"
    assert rejected_wins_over_unknown["decision"] == "rejected"
    assert rejected_wins_over_unknown["reason"] == "rejected"
    assert classify_task_outcome(artifacts=[], evidence=[], task_reference="TASK-1")["decision"] == "inconclusive"


def test_wont_do_defaults_success_but_human_evidence_overrides():
    evidence = [
        {
            "source": "Jira",
            "reference": "TASK-1",
            "resolution": "accepted",
            "disposition": "Won't Do",
            "reason": "No work is needed; issue already resolved",
        }
    ]
    assert classify_task_outcome(artifacts=[], evidence=evidence, task_reference="TASK-1")["decision"] == "accepted"
    evidence.append(
        {
            "source": "Jira",
            "reference": "TASK-1/comment/22",
            "resolution": "rejected",
            "disposition": "This is still required",
            "reason": "Human comment says work is still required",
            "authorType": "human",
        }
    )
    assert classify_task_outcome(artifacts=[], evidence=evidence, task_reference="TASK-1")["decision"] == "rejected"


@pytest.mark.parametrize("supersedes_ref", ["pr-old", "https://github.com/acme/app/pull/1"])
@pytest.mark.parametrize("evidence_ref", ["pr-old", "https://github.com/acme/app/pull/1"])
def test_supersedes_marks_old_artifact_obsolete_without_failing_task(supersedes_ref, evidence_ref):
    artifacts = [
        {"id": "pr-old", "type": "github_pr", "url": "https://github.com/acme/app/pull/1"},
        {
            "id": "pr-new",
            "type": "github_pr",
            "url": "https://github.com/acme/app/pull/2",
            "supersedes": [supersedes_ref],
        },
    ]
    outcome = classify_task_outcome(
        artifacts=artifacts,
        evidence=[
            {
                "source": "custom-review",
                "reference": evidence_ref,
                "resolution": "rejected",
                "disposition": "Closed",
                "reason": "old PR closed",
            },
            {
                "source": "GitHub",
                "reference": "https://github.com/acme/app/pull/2",
                "resolution": "accepted",
                "disposition": "Merged",
                "reason": "replacement merged",
            },
        ],
        task_reference="TASK-1",
    )
    assert outcome["decision"] == "accepted"
    assert outcome["reason"] == "replacement merged"
    assert outcome["confidence"] == "conclusive"
    assert outcome["artifacts"][0]["artifactState"] == "obsolete"
    assert "artifactState" not in artifacts[0]


def test_supersedes_replaced_chain_excludes_all_old_id_and_url_evidence():
    artifacts = [
        {"id": "old", "url": "https://example.test/old"},
        {"id": "middle", "url": "https://example.test/middle", "supersedes": ["https://example.test/old"]},
        {"id": "new", "url": "https://example.test/new", "supersedes": ["middle"]},
    ]
    evidence = [
        {"source": "custom", "reference": reference, "resolution": "rejected", "reason": "replaced work rejected"}
        for reference in ("old", "https://example.test/old", "middle", "https://example.test/middle")
    ] + [{"source": "custom", "reference": "new", "resolution": "accepted", "reason": "replacement accepted"}]
    outcome = classify_task_outcome(artifacts=artifacts, evidence=evidence, task_reference="TASK-1")
    reordered = classify_task_outcome(artifacts=list(reversed(artifacts)), evidence=evidence, task_reference="TASK-1")

    assert outcome["decision"] == reordered["decision"] == "accepted"
    assert outcome["reason"] == reordered["reason"] == "replacement accepted"
    assert [item.get("artifactState") for item in outcome["artifacts"]] == ["obsolete", "obsolete", None]


def test_task_obsolete_requires_task_reference_disposition():
    outcome = classify_task_outcome(
        artifacts=[],
        evidence=[
            {
                "source": "jira",
                "reference": "TASK-1",
                "resolution": "accepted",
                "disposition": "Obsolete",
                "reason": "source says obsolete",
            }
        ],
        task_reference="TASK-1",
    )
    unrelated = classify_task_outcome(
        artifacts=[],
        evidence=[
            {
                "source": "custom",
                "reference": "ARTIFACT-1",
                "resolution": "accepted",
                "disposition": "Obsolete",
                "reason": "artifact old",
            }
        ],
        task_reference="TASK-1",
    )
    terminal_obsolete = classify_task_outcome(
        artifacts=[],
        evidence=[
            {
                "source": "custom",
                "reference": "TASK-1",
                "resolution": "accepted",
                "disposition": "Obsolete",
                "reason": "Task was replaced",
            },
            {
                "source": "custom",
                "reference": "ARTIFACT-1",
                "resolution": "rejected",
                "disposition": "Closed",
                "reason": "Artifact failed",
            },
        ],
        task_reference="TASK-1",
    )
    assert outcome["decision"] == "obsolete"
    assert unrelated["decision"] == "accepted"
    assert terminal_obsolete["decision"] == "obsolete"
    assert terminal_obsolete["reason"] == "Task was replaced"


@pytest.mark.asyncio
async def test_invalid_date_range_is_rejected_before_database_access():
    pool = FakePool()
    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/task-outcomes/summary?from=2026-10-02&to=2026-10-01")
    assert response.status_code == 400
    assert not pool.calls


@pytest.mark.asyncio
@pytest.mark.parametrize("reopened_status", ["in_progress", "pr_open", "pr_changes", "paused"])
async def test_done_reopen_requires_fresh_report_through_real_database(db, reopened_status):
    await db.execute(SCHEMA_PATH.read_text())
    task_id = await db.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) "
        "VALUES ('REOPEN-DB-1', 'manual', 'done', 'org/repo', 'bot/reopen') RETURNING id"
    )

    class ConnectionPool:
        @asynccontextmanager
        async def acquire(self):
            yield db

        async def fetchrow(self, query, *args):
            return await db.fetchrow(query, *args)

    mcp = FastMCP(name="task-outcome-reopen-db-tests")
    register_task_tools(mcp)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=ConnectionPool()),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as client:
            task = {"external_key": "REOPEN-DB-1", "source_type": "manual"}
            report = {
                **task,
                "artifacts": [],
                "evidence": [
                    {
                        "source": "custom-review",
                        "reference": "REOPEN-DB-1",
                        "resolution": "accepted",
                        "disposition": "Completed",
                        "reason": "Original work accepted",
                    }
                ],
                "notes": "Before reopening",
            }
            await client.call_tool("task_outcome_report", report)
            original = await db.fetchrow("SELECT * FROM task_outcome_reports WHERE task_id = $1", task_id)
            await client.call_tool("task_update", {**task, "status": "done"})
            assert await db.fetchval("SELECT outcome_report_id FROM tasks WHERE id = $1", task_id) == original["id"]

            await client.call_tool("task_update", {**task, "status": reopened_status, "summary": "New work needed"})
            assert await db.fetchval("SELECT outcome_report_id FROM tasks WHERE id = $1", task_id) is None
            failed_archive = await client.call_tool("task_remove", task, raise_on_error=False)
            assert failed_archive.is_error
            assert "requires task_outcome_report" in getattr(failed_archive.content[0], "text", "")
            assert await db.fetchval("SELECT status::text FROM tasks WHERE id = $1", task_id) == reopened_status
            assert await db.fetchrow("SELECT * FROM task_outcome_reports WHERE id = $1", original["id"]) == original

            report["notes"] = "Fresh verification after work changed"
            report["evidence"][0]["resolution"] = "rejected"
            report["evidence"][0]["reason"] = "Reopened work rejected"
            await client.call_tool("task_outcome_report", report)
            fresh_id = await db.fetchval("SELECT outcome_report_id FROM tasks WHERE id = $1", task_id)
            assert fresh_id != original["id"]
            await client.call_tool("task_update", {**task, "status": "done"})
            assert await db.fetchval("SELECT outcome_report_id FROM tasks WHERE id = $1", task_id) == fresh_id
            await client.call_tool("task_remove", task)
            archived = await db.fetchrow("SELECT status::text, outcome_report_id FROM tasks WHERE id = $1", task_id)
            assert dict(archived) == {"status": "archived", "outcome_report_id": fresh_id}
            assert await db.fetchval("SELECT COUNT(*) FROM task_outcome_reports WHERE task_id = $1", task_id) == 2
            assert await db.fetchrow("SELECT * FROM task_outcome_reports WHERE id = $1", original["id"]) == original

            await client.call_tool("task_update", {**task, "status": reopened_status})
            reopened = await db.fetchrow("SELECT outcome_report_id, archived_at FROM tasks WHERE id = $1", task_id)
            assert dict(reopened) == {"outcome_report_id": None, "archived_at": None}
            assert await db.fetchval("SELECT COUNT(*) FROM task_outcome_reports WHERE task_id = $1", task_id) == 2


@pytest.mark.asyncio
async def test_archive_report_flows_through_real_database_and_reporting_api(db):
    await db.execute(SCHEMA_PATH.read_text())
    task_id = await db.fetchval(
        """
        INSERT INTO tasks (external_key, source_type, status, repo, branch, title, summary, instance_id)
        VALUES ('OUTCOME-DB-1', 'jira', 'in_progress', 'fork/repo', 'bot/test', 'DB outcome', 'Integration', 'bot-1')
        RETURNING id
        """
    )
    task_cycle_ids = []
    for offset in (2, 1):
        task_cycle_ids.append(
            await db.fetchval(
                """
                INSERT INTO cycle_runs (task_id, cycle_type, instance_id, started_at, finished_at)
                VALUES ($1, 'task_work', 'bot-1', NOW() - $2::interval, NOW() - $2::interval + INTERVAL '10 minutes')
                RETURNING id
                """,
                task_id,
                timedelta(hours=offset),
            )
        )

    class ConnectionPool:
        @asynccontextmanager
        async def acquire(self):
            yield db

    mcp = FastMCP(name="task-outcome-db-tests")
    register_task_tools(mcp)
    tools = await mcp.list_tools()
    archive_tool = next(tool for tool in tools if tool.name == "task_remove")
    report_tool = next(tool for tool in tools if tool.name == "task_outcome_report")
    add_tool = next(tool for tool in tools if tool.name == "task_add")
    with patch("bot_memory_server.tools.tasks.get_pool", return_value=ConnectionPool()):
        with pytest.raises(ValueError, match="requires task_outcome_report"):
            await archive_tool.fn(external_key="OUTCOME-DB-1")
        staged = await report_tool.fn(
            external_key="OUTCOME-DB-1",
            artifacts=[_artifact(type="github_pr", url="https://github.com/org/repo/pull/12")],
            evidence=[
                _evidence(
                    source="GitHub",
                    reference="https://github.com/org/repo/pull/12",
                    resolution="accepted",
                    disposition="MERGED",
                    reason="PR merged",
                )
            ],
            notes=None,
            run_id="run-db-1",
            reporting_cycle_id=task_cycle_ids[0],
            workflow="jira-sprint",
        )
        assert staged["status"] == "in_progress"
        archived = await archive_tool.fn(external_key="OUTCOME-DB-1")
        corrected = await report_tool.fn(
            external_key="OUTCOME-DB-1",
            artifacts=[_artifact(type="github_pr", url="https://github.com/org/repo/pull/12")],
            evidence=[
                _evidence(
                    source="github",
                    reference="https://github.com/org/repo/pull/12",
                    resolution="rejected",
                    disposition="CLOSED_UNMERGED",
                    reason="The replacement was rejected by source review",
                )
            ],
            notes="Provider state updated",
            run_id="run-db-2",
            correction=True,
            reporting_cycle_id=task_cycle_ids[1],
        )

    manual_task_id = await db.fetchval(
        """
        INSERT INTO tasks (external_key, source_type, status, repo, branch, title, summary)
        VALUES ('MANUAL-DB-1', 'jira', 'in_progress', 'org/repo', 'bot/manual', 'Manual archive', 'No outcome claim')
        RETURNING id
        """
    )
    with patch("bot_memory_server.tools.tasks.get_pool", return_value=db):
        legacy_task = await add_tool.fn(
            external_key="LEGACY-OUTCOME-1",
            source_type="manual",
            repo="fork/legacy-app",
            branch="bot/legacy",
            status="done",
            title="Legacy done task",
            summary="PR already merged before outcome reports existed",
            metadata={
                "prs": [
                    {
                        "host": "github",
                        "repo": "fork/legacy-app",
                        "number": 801,
                        "url": "https://github.com/acme/legacy-app/pull/801",
                    }
                ]
            },
        )
        legacy_before = await db.fetchrow(
            "SELECT status::text, last_addressed, archived_at FROM tasks WHERE id = $1", legacy_task["id"]
        )
        with patch("bot_memory_server.task_outcomes.get_pool", return_value=db):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                legacy_detail_before = (await client.get(f"/api/task-outcomes/tasks/{legacy_task['id']}")).json()

    with patch("bot_memory_server.tools.tasks.get_pool", return_value=ConnectionPool()):
        migrated_legacy = await report_tool.fn(
            external_key="LEGACY-OUTCOME-1",
            source_type="manual",
            notes="Synthetic deterministic provider enrichment",
            artifacts=[OutcomeArtifact.model_validate(item) for item in legacy_task["artifacts"]],
            evidence=[
                _evidence(
                    source="github",
                    reference="https://github.com/acme/legacy-app/pull/801",
                    resolution="accepted",
                    disposition="MERGED",
                    reason="PR merged",
                )
            ],
            reported_by="migration",
        )
    with patch("bot_memory_server.api.get_pool", return_value=ConnectionPool()):
        async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as client:
            manual_archive = await client.delete("/api/tasks/MANUAL-DB-1?manual=true")

    with patch("bot_memory_server.task_outcomes.get_pool", return_value=db):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            summary = await client.get("/api/task-outcomes/summary")
            today = datetime.now(UTC).date().isoformat()
            listing = await client.get(f"/api/task-outcomes/tasks?repo=org/repo&source=github&from={today}&to={today}")
            detail = await client.get(f"/api/task-outcomes/tasks/{task_id}")
            legacy_detail = await client.get(f"/api/task-outcomes/tasks/{legacy_task['id']}")

    assert archived["status"] == "archived"
    assert summary.json()["summary"]["acceptedCount"] == 1
    assert summary.json()["summary"]["rejectedCount"] == 1
    assert summary.json()["summary"]["unreportedCount"] == 1
    assert summary.json()["summary"]["taskCount"] == 3
    assert summary.json()["summary"]["acceptanceRate"] == 0.5
    assert summary.json()["repositories"][0]["providers"] == {"github": 1}
    assert listing.json()["total"] == 1
    assert listing.json()["items"][0]["canonicalRepositories"] == ["org/repo"]
    assert listing.json()["items"][0]["state"] == "rejected"
    assert corrected["status"] == "archived"
    assert detail.json()["outcome"]["runId"] == "run-db-2"
    assert detail.json()["outcome"]["reportingCycleId"] == task_cycle_ids[1]
    assert [cycle["id"] for cycle in detail.json()["taskCycles"]] == task_cycle_ids
    assert [item["decision"] for item in detail.json()["outcomeHistory"]] == ["accepted", "rejected"]
    assert migrated_legacy["outcome"]["reportedBy"] == "migration"
    assert legacy_detail_before["state"] == "unreported"
    assert legacy_detail_before["canonicalRepositories"] == ["acme/legacy-app"]
    assert legacy_detail.json()["state"] == "accepted"
    assert legacy_detail.json()["repo"] == "fork/legacy-app"
    assert legacy_detail.json()["canonicalRepositories"] == ["acme/legacy-app"]
    assert any(repo["repo"] == "acme/legacy-app" for repo in summary.json()["repositories"])
    legacy_lifecycle = await db.fetchrow(
        "SELECT status::text, last_addressed, archived_at FROM tasks WHERE id = $1", legacy_task["id"]
    )
    assert legacy_lifecycle["status"] == "done"
    assert legacy_lifecycle["last_addressed"] == legacy_before["last_addressed"]
    assert legacy_lifecycle["archived_at"] is None
    assert manual_archive.status_code == 200
    manual_detail = await db.fetchrow("SELECT status::text, archived_at FROM tasks WHERE id = $1", manual_task_id)
    assert manual_detail["status"] == "archived"
    assert manual_detail["archived_at"] is not None
    assert await db.fetchval("SELECT COUNT(*) FROM task_outcome_reports WHERE task_id = $1", manual_task_id) == 0


# -- normalize_reason --


class TestNormalizeReason:
    """Unit tests for normalize_reason()."""

    def test_merged_keyword(self):
        assert normalize_reason("PR merged by maintainer") == "merged"

    def test_merged_case_insensitive(self):
        assert normalize_reason("MERGED by bot") == "merged"
        assert normalize_reason("Auto-Merged after CI") == "merged"

    def test_closed_keyword(self):
        assert normalize_reason("PR closed without merge") == "closed_unmerged"

    def test_closed_case_insensitive(self):
        assert normalize_reason("CLOSED by author") == "closed_unmerged"

    def test_unmerged_keyword(self):
        assert normalize_reason("left unmerged") == "closed_unmerged"

    def test_unmerged_case_insensitive(self):
        assert normalize_reason("PR was UNMERGED") == "closed_unmerged"

    def test_duplicate_keyword(self):
        assert normalize_reason("duplicate") == "duplicate"

    def test_duplicate_case_insensitive(self):
        assert normalize_reason("Duplicate PR") == "duplicate"
        assert normalize_reason("DUPLICATE submission") == "duplicate"

    def test_historical_backfill_prefix(self):
        reason = "Historical backfill: PR #3448 merged at 2026-09-28T10:18:56Z into project-kessel/insights-rbac."
        assert normalize_reason(reason) == "merged"  # "merged" takes priority

    def test_historical_backfill_without_merged(self):
        reason = "Historical backfill: task created at 2026-05-01"
        assert normalize_reason(reason) == "historical_backfill"

    def test_historical_backfill_with_closed(self):
        reason = "Historical backfill: PR closed at 2026-06-01"
        assert normalize_reason(reason) == "closed_unmerged"  # "closed" takes priority

    def test_historical_backfill_case_sensitive_prefix(self):
        """lowercase 'historical backfill:' does not match the prefix rule."""
        assert normalize_reason("historical backfill: something") == "other"

    def test_other_fallback(self):
        assert normalize_reason("some unknown reason") == "other"

    def test_other_empty_string(self):
        assert normalize_reason("") == "other"

    def test_priority_closed_over_merged(self):
        """'closed'/'unmerged' check comes before 'merged'."""
        assert normalize_reason("closed then merged") == "closed_unmerged"

    def test_priority_closed_over_duplicate(self):
        assert normalize_reason("duplicate was closed") == "closed_unmerged"

    def test_priority_merged_over_duplicate(self):
        assert normalize_reason("duplicate was merged") == "merged"

    @pytest.mark.parametrize(
        "reason, expected",
        [
            ("PR merged", "merged"),
            ("Superseded and closed", "closed_unmerged"),
            ("Marked as duplicate by reviewer", "duplicate"),
            ("Historical backfill: investigation completed", "historical_backfill"),
            ("Agent timed out", "other"),
            ("No response from reviewer", "other"),
        ],
    )
    def test_parametrized_buckets(self, reason, expected):
        assert normalize_reason(reason) == expected


@pytest.mark.anyio
async def test_summary_returns_normalized_reason_keys(db):
    """Integration: /api/task-outcomes/summary returns normalized reason buckets."""
    await db.execute(SCHEMA_PATH.read_text())
    # insert two archived tasks with different free-text reasons that map to the same bucket
    for reason_text in ("PR merged by maintainer", "Historical backfill: PR #1 merged at 2026-01-01"):
        task_id = await db.fetchval(
            """INSERT INTO tasks (external_key, source_type, status, repo, branch, title, summary)
            VALUES ($1, 'jira', 'archived', 'org/repo', 'bot/test', 'Test', 'Test')
            RETURNING id""",
            f"NORM-{reason_text[:10]}",
        )
        report_id = await db.fetchval(
            """INSERT INTO task_outcome_reports (
                task_id, decision, confidence, reason, reported_by,
                artifacts, evidence, canonical_repositories
            ) VALUES ($1, 'accepted', 'conclusive', $2, 'agent',
                '[]'::jsonb, '[]'::jsonb, '["org/repo"]'::jsonb)
            RETURNING id""",
            task_id,
            reason_text,
        )
        await db.execute("UPDATE tasks SET outcome_report_id = $1 WHERE id = $2", report_id, task_id)

    # insert a third task with a "closed" reason
    task_id = await db.fetchval(
        """INSERT INTO tasks (external_key, source_type, status, repo, branch, title, summary)
        VALUES ('NORM-closed', 'jira', 'archived', 'org/repo', 'bot/test', 'Test', 'Test')
        RETURNING id"""
    )
    report_id = await db.fetchval(
        """INSERT INTO task_outcome_reports (
            task_id, decision, confidence, reason, reported_by,
            artifacts, evidence, canonical_repositories
        ) VALUES ($1, 'rejected', 'conclusive', 'PR closed without merge', 'agent',
            '[]'::jsonb, '[]'::jsonb, '["org/repo"]'::jsonb)
        RETURNING id""",
        task_id,
    )
    await db.execute("UPDATE tasks SET outcome_report_id = $1 WHERE id = $2", report_id, task_id)

    with patch("bot_memory_server.task_outcomes.get_pool", return_value=db):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/task-outcomes/summary")

    data = resp.json()
    repo_entry = data["repositories"][0]
    reasons = repo_entry["reasons"]
    # both "PR merged by maintainer" and "Historical backfill: ...merged..." → "merged"
    assert reasons["merged"] == 2
    assert reasons["closed_unmerged"] == 1
    # no raw free-text keys should survive
    assert "PR merged by maintainer" not in reasons
    assert "PR closed without merge" not in reasons

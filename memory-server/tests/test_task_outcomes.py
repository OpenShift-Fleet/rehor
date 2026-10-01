"""Unit and API contract tests for task outcome reporting."""

import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.api import api_task_delete
from bot_memory_server.models import OutcomeArtifact, OutcomeEvidence
from bot_memory_server.outcome_classifier import classify_task_outcome
from bot_memory_server.task_outcomes import (
    api_task_outcome_detail,
    api_task_outcomes,
    api_task_outcomes_summary,
    canonical_repositories,
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

    @asynccontextmanager
    async def transaction(self):
        yield

    async def fetchrow(self, query, *args):
        self.queries.append((query, args))
        if "SELECT id, status, outcome_report_id FROM tasks" in query:
            return {key: self.existing[key] for key in ("id", "status", "outcome_report_id")}
        if "SELECT * FROM tasks" in query:
            return self.existing
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
            updated = {**self.existing, "status": "archived", "archived_at": NOW}
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


def test_supersedes_marks_old_artifact_obsolete_without_failing_task():
    artifacts = [
        {"id": "pr-old", "type": "github_pr", "url": "https://github.com/acme/app/pull/1"},
        {
            "id": "pr-new",
            "type": "github_pr",
            "url": "https://github.com/acme/app/pull/2",
            "supersedes": ["pr-old"],
        },
    ]
    outcome = classify_task_outcome(
        artifacts=artifacts,
        evidence=[
            {
                "source": "GitHub",
                "reference": "pr-old",
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
    assert outcome["artifacts"][0]["artifactState"] == "obsolete"


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
    with patch("bot_memory_server.api.get_pool", return_value=db):
        async with AsyncClient(transport=ASGITransport(app=manual_archive_app), base_url="http://test") as client:
            manual_archive = await client.delete("/api/tasks/MANUAL-DB-1")

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

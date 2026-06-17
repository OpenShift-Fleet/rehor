"""Migration 001 integrity tests — generic task system columns + backfill.

Tests run against real Postgres via the CI sidecar (or local instance).
"""

import json
import os
import sys
from pathlib import Path

import pytest

from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from migrations.m001_generic_tasks import _build_artifacts, run_migration  # noqa: E402


TABLES_WITH_GENERIC_COLS = [
    "tasks",
    "bot_status",
    "bot_instances",
    "cycles",
    "slack_notifications",
    "memories",
]


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


@pytest.mark.asyncio
async def test_migration_adds_columns(db):
    await _apply_schema(db)

    for table in TABLES_WITH_GENERIC_COLS:
        cols = await db.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = $1 AND column_name IN ('external_key', 'source_type')",
            table,
        )
        col_names = {c["column_name"] for c in cols}
        assert "external_key" in col_names, f"{table} missing external_key"
        assert "source_type" in col_names, f"{table} missing source_type"

    task_cols = await db.fetch(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'tasks' AND column_name IN ('source_url', 'artifacts')",
    )
    task_col_names = {c["column_name"] for c in task_cols}
    assert "source_url" in task_col_names
    assert "artifacts" in task_col_names


@pytest.mark.asyncio
async def test_backfill_simple_task(db):
    await _apply_schema(db)

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch) VALUES ($1, $2, $3, $4)",
        "RHCLOUD-100",
        "in_progress",
        "test-repo",
        "bot/RHCLOUD-100",
    )

    stats = await run_migration(db)
    assert stats["tasks"] == 1

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-100")
    assert task["external_key"] == "RHCLOUD-100"
    assert task["source_type"] == "jira"
    assert task["source_url"] == "https://redhat.atlassian.net/browse/RHCLOUD-100"
    assert json.loads(task["artifacts"]) == []


@pytest.mark.asyncio
async def test_backfill_single_pr(db):
    await _apply_schema(db)

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        "RHCLOUD-200",
        "pr_open",
        "insights-chrome",
        "bot/RHCLOUD-200",
        42,
        "https://github.com/RedHatInsights/insights-chrome/pull/42",
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-200")
    artifacts = json.loads(task["artifacts"])
    assert len(artifacts) == 1
    assert artifacts[0]["name"] == "PR #42"
    assert (
        artifacts[0]["url"]
        == "https://github.com/RedHatInsights/insights-chrome/pull/42"
    )
    assert artifacts[0]["type"] == "pull_request"


@pytest.mark.asyncio
async def test_backfill_multi_repo_prs(db):
    await _apply_schema(db)

    metadata = {
        "prs": [
            {
                "repo": "insights-chrome",
                "number": 10,
                "url": "https://github.com/RedHatInsights/insights-chrome/pull/10",
                "host": "github",
            },
            {
                "repo": "insights-rbac",
                "number": 20,
                "url": "https://github.com/RedHatInsights/insights-rbac/pull/20",
                "host": "github",
            },
        ]
    }

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, metadata) "
        "VALUES ($1, $2, $3, $4, $5)",
        "RHCLOUD-300",
        "pr_open",
        "insights-chrome",
        "bot/RHCLOUD-300",
        json.dumps(metadata),
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-300")
    artifacts = json.loads(task["artifacts"])
    assert len(artifacts) == 2
    urls = {a["url"] for a in artifacts}
    assert "https://github.com/RedHatInsights/insights-chrome/pull/10" in urls
    assert "https://github.com/RedHatInsights/insights-rbac/pull/20" in urls


@pytest.mark.asyncio
async def test_backfill_overlap_dedup(db):
    await _apply_schema(db)

    pr_url = "https://github.com/RedHatInsights/insights-chrome/pull/42"
    metadata = {
        "prs": [
            {"repo": "insights-chrome", "number": 42, "url": pr_url, "host": "github"},
        ]
    }

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url, metadata) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7)",
        "RHCLOUD-400",
        "pr_open",
        "insights-chrome",
        "bot/RHCLOUD-400",
        42,
        pr_url,
        json.dumps(metadata),
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-400")
    artifacts = json.loads(task["artifacts"])
    assert len(artifacts) == 1, f"Expected 1 artifact (deduped), got {len(artifacts)}"


@pytest.mark.asyncio
async def test_backfill_gitlab_type(db):
    await _apply_schema(db)

    metadata = {
        "prs": [
            {
                "repo": "some-gl-repo",
                "number": 5,
                "url": "https://gitlab.cee.redhat.com/some/repo/-/merge_requests/5",
                "host": "gitlab",
            },
        ]
    }

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, metadata) "
        "VALUES ($1, $2, $3, $4, $5)",
        "RHCLOUD-500",
        "pr_open",
        "some-gl-repo",
        "bot/RHCLOUD-500",
        json.dumps(metadata),
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-500")
    artifacts = json.loads(task["artifacts"])
    assert len(artifacts) == 1
    assert artifacts[0]["type"] == "merge_request"
    assert artifacts[0]["name"] == "MR #5"


@pytest.mark.asyncio
async def test_backfill_other_tables(db):
    await _apply_schema(db)

    await db.execute(
        "UPDATE bot_status SET jira_key = $1 WHERE id = 1",
        "RHCLOUD-600",
    )

    await db.execute(
        "INSERT INTO cycles (label, jira_key) VALUES ($1, $2)",
        "test-label",
        "RHCLOUD-601",
    )

    await db.execute(
        "INSERT INTO slack_notifications (jira_key, event_type, message) "
        "VALUES ($1, $2, $3)",
        "RHCLOUD-602",
        "pr_created",
        "test message",
    )

    await db.execute(
        "INSERT INTO memories (category, jira_key, title, content, embedding) "
        "VALUES ($1, $2, $3, $4, $5)",
        "learning",
        "RHCLOUD-603",
        "test memory",
        "test content",
        "[" + ",".join(["0"] * 384) + "]",
    )

    stats = await run_migration(db)

    bs = await db.fetchrow("SELECT * FROM bot_status WHERE id = 1")
    assert bs["external_key"] == "RHCLOUD-600"
    assert bs["source_type"] == "jira"

    cycle = await db.fetchrow("SELECT * FROM cycles WHERE jira_key = $1", "RHCLOUD-601")
    assert cycle["external_key"] == "RHCLOUD-601"
    assert cycle["source_type"] == "jira"

    slack = await db.fetchrow(
        "SELECT * FROM slack_notifications WHERE jira_key = $1", "RHCLOUD-602"
    )
    assert slack["external_key"] == "RHCLOUD-602"
    assert slack["source_type"] == "jira"

    mem = await db.fetchrow("SELECT * FROM memories WHERE jira_key = $1", "RHCLOUD-603")
    assert mem["external_key"] == "RHCLOUD-603"
    assert mem["source_type"] == "jira"


@pytest.mark.asyncio
async def test_backfill_idempotent(db):
    await _apply_schema(db)

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        "RHCLOUD-700",
        "pr_open",
        "test-repo",
        "bot/RHCLOUD-700",
        99,
        "https://github.com/org/repo/pull/99",
    )

    stats1 = await run_migration(db)
    assert stats1["tasks"] == 1

    stats2 = await run_migration(db)
    assert stats2["tasks"] == 0

    count = await db.fetchval("SELECT COUNT(*) FROM tasks")
    assert count == 1


@pytest.mark.asyncio
async def test_old_columns_untouched(db):
    await _apply_schema(db)

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url) "
        "VALUES ($1, $2, $3, $4, $5, $6)",
        "RHCLOUD-800",
        "pr_open",
        "my-repo",
        "bot/RHCLOUD-800",
        77,
        "https://github.com/org/repo/pull/77",
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-800")
    assert task["jira_key"] == "RHCLOUD-800"
    assert task["pr_number"] == 77
    assert task["pr_url"] == "https://github.com/org/repo/pull/77"
    assert task["repo"] == "my-repo"
    assert task["branch"] == "bot/RHCLOUD-800"
    assert task["status"] == "pr_open"


@pytest.mark.asyncio
async def test_source_url_format(db):
    await _apply_schema(db)

    await db.execute(
        "INSERT INTO tasks (jira_key, status, repo, branch) VALUES ($1, $2, $3, $4)",
        "RHCLOUD-12345",
        "in_progress",
        "test-repo",
        "bot/RHCLOUD-12345",
    )

    await run_migration(db)

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-12345")
    assert task["source_url"] == "https://redhat.atlassian.net/browse/RHCLOUD-12345"

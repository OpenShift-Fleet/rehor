"""Schema validation tests against real PostgreSQL with pgvector.

These run in CI via the Tekton pipeline's Postgres sidecar.
Future migration stages add tests here for ALTER TABLE + backfill scripts.
"""

import asyncpg
import pytest

from conftest import SCHEMA_PATH


@pytest.mark.asyncio
async def test_db_connection(db):
    result = await db.fetchval("SELECT 1")
    assert result == 1


@pytest.mark.asyncio
async def test_schema_applies(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)

    tables = await db.fetch(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    )
    table_names = {t["tablename"] for t in tables}

    expected = {
        "tasks",
        "memories",
        "bot_status",
        "cycles",
        "cycle_runs",
        "slack_notifications",
        "bot_instances",
    }
    missing = expected - table_names
    assert not missing, f"Missing tables: {missing}"


@pytest.mark.asyncio
async def test_schema_idempotent(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)
    await db.execute(schema)
    count = await db.fetchval("SELECT COUNT(*) FROM tasks")
    assert count == 0


@pytest.mark.asyncio
async def test_task_insert_read(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)

    await db.execute(
        """
        INSERT INTO tasks (external_key, source_type, status, repo, branch)
        VALUES ($1, $2, $3, $4, $5)
        """,
        "TEST-1",
        "jira",
        "in_progress",
        "test-repo",
        "bot/TEST-1",
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE external_key = $1", "TEST-1")
    assert task is not None
    assert task["status"] == "in_progress"
    assert task["repo"] == "test-repo"
    assert task["branch"] == "bot/TEST-1"


@pytest.mark.asyncio
async def test_task_unique_constraint(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)

    await db.execute(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) VALUES ($1, $2, $3, $4, $5)",
        "DUP-1",
        "jira",
        "in_progress",
        "repo",
        "bot/DUP-1",
    )

    with pytest.raises(asyncpg.UniqueViolationError):
        await db.execute(
            "INSERT INTO tasks (external_key, source_type, status, repo, branch) VALUES ($1, $2, $3, $4, $5)",
            "DUP-1",
            "jira",
            "pr_open",
            "repo2",
            "bot/DUP-1-2",
        )


@pytest.mark.asyncio
async def test_foreign_keys(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)

    await db.execute(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) VALUES ($1, $2, $3, $4, $5)",
        "FK-1",
        "jira",
        "in_progress",
        "repo",
        "bot/FK-1",
    )
    task_id = await db.fetchval("SELECT id FROM tasks WHERE external_key = $1", "FK-1")

    await db.execute(
        """
        INSERT INTO cycle_runs (task_id, cycle_type, instance_id)
        VALUES ($1, $2, $3)
        """,
        task_id,
        "task_work",
        "test-instance",
    )
    cycle = await db.fetchrow("SELECT * FROM cycle_runs WHERE task_id = $1", task_id)
    assert cycle is not None
    assert cycle["cycle_type"] == "task_work"

    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await db.execute(
            """
            INSERT INTO cycle_runs (task_id, cycle_type, instance_id)
            VALUES ($1, $2, $3)
            """,
            99999,
            "task_work",
            "test-instance",
        )

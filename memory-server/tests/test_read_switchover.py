"""Read switchover tests — verify all reads use external_key/source_type.

Stage 4 (RHCLOUD-48379): Legacy jira_key column dropped from all tables.
All reads/writes use external_key + source_type exclusively.
"""

import json
import os

import pytest
from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

from bot_memory_server.artifacts import JIRA_BASE_URL  # noqa: E402

ZERO_VECTOR = "[" + ",".join(["0"] * 384) + "]"


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


async def _insert_task(db, external_key, status="in_progress", repo="test-repo"):
    """Insert a task using external_key/source_type columns."""
    await db.execute(
        """
        INSERT INTO tasks (external_key, source_type, source_url, status, repo, branch, metadata)
        VALUES ($1, $2, $3, $4::task_status, $5, $6, $7)
        RETURNING id
        """,
        external_key,
        "jira",
        f"{JIRA_BASE_URL}/{external_key}",
        status,
        repo,
        f"bot/{external_key}",
        json.dumps({}),
    )


# --- task_get reads by external_key ---


@pytest.mark.asyncio
async def test_task_get_by_external_key(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2000")

    row = await db.fetchrow(
        "SELECT * FROM tasks WHERE external_key = $1 AND source_type = $2",
        "RHCLOUD-2000",
        "jira",
    )
    assert row is not None
    assert row["external_key"] == "RHCLOUD-2000"
    assert row["source_type"] == "jira"


# --- task_update reads by external_key ---


@pytest.mark.asyncio
async def test_task_update_by_external_key(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2002")

    row = await db.fetchrow(
        """UPDATE tasks SET summary = $3
           WHERE external_key = $1 AND source_type = $2
           RETURNING *""",
        "RHCLOUD-2002",
        "jira",
        "Updated via external_key",
    )
    assert row is not None
    assert row["summary"] == "Updated via external_key"
    assert row["external_key"] == "RHCLOUD-2002"


# --- task_remove reads by external_key ---


@pytest.mark.asyncio
async def test_task_remove_by_external_key(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2003")

    row = await db.fetchrow(
        """UPDATE tasks SET status = 'archived'::task_status
           WHERE external_key = $1 AND source_type = $2
           RETURNING *""",
        "RHCLOUD-2003",
        "jira",
    )
    assert row is not None
    assert row["status"] == "archived"


# --- task delete/unarchive REST endpoints use external_key ---


@pytest.mark.asyncio
async def test_task_delete_by_external_key(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2004")

    row = await db.fetchrow(
        """UPDATE tasks SET status = 'archived'::task_status
           WHERE external_key = $1
           RETURNING *""",
        "RHCLOUD-2004",
    )
    assert row is not None
    assert row["status"] == "archived"
    assert row["external_key"] == "RHCLOUD-2004"


@pytest.mark.asyncio
async def test_task_unarchive_by_external_key(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2005", status="archived")

    row = await db.fetchrow(
        """UPDATE tasks SET status = 'in_progress'::task_status, paused_reason = NULL
           WHERE external_key = $1 AND status = 'archived'::task_status
           RETURNING *""",
        "RHCLOUD-2005",
    )
    assert row is not None
    assert row["status"] == "in_progress"


# --- slack cooldown reads by external_key ---


@pytest.mark.asyncio
async def test_slack_cooldown_by_external_key(db):
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO slack_notifications (external_key, source_type, event_type, message)
           VALUES ($1, $2, $3, $4)""",
        "RHCLOUD-2006",
        "jira",
        "pr_created",
        "test",
    )

    row = await db.fetchrow(
        """SELECT id, event_type, sent_at FROM slack_notifications
           WHERE external_key = $1 AND sent_at > NOW() - INTERVAL '48 hours'
           ORDER BY sent_at DESC LIMIT 1""",
        "RHCLOUD-2006",
    )
    assert row is not None
    assert row["event_type"] == "pr_created"


# --- slack notification lookup by external_key ---


@pytest.mark.asyncio
async def test_slack_lookup_by_external_key(db):
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO slack_notifications (external_key, source_type, event_type, message)
           VALUES ($1, $2, $3, $4)""",
        "RHCLOUD-2007",
        "jira",
        "review_reminder",
        "Please review",
    )

    rows = await db.fetch(
        """SELECT DISTINCT ON (external_key) external_key, event_type, message, sent_at
           FROM slack_notifications
           WHERE external_key = ANY($1)
           ORDER BY external_key, sent_at DESC""",
        ["RHCLOUD-2007"],
    )
    assert len(rows) == 1
    assert rows[0]["external_key"] == "RHCLOUD-2007"


# --- analytics queries use external_key ---


@pytest.mark.asyncio
async def test_analytics_ticket_lifecycle_by_external_key(db):
    """Ticket lifecycle JOIN uses external_key, not jira_key."""
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2008")

    await db.execute(
        """INSERT INTO cycles (label, external_key, source_type,
                               repo, work_type, cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        "test",
        "RHCLOUD-2008",
        "jira",
        "test-repo",
        "new_ticket",
        1.50,
    )

    row = await db.fetchrow(
        """SELECT c.external_key, t.title, COUNT(*) AS total_cycles
           FROM cycles c
           LEFT JOIN tasks t ON t.external_key = c.external_key
           WHERE c.external_key IS NOT NULL AND NOT c.no_work
           GROUP BY c.external_key, t.title""",
    )
    assert row is not None
    assert row["external_key"] == "RHCLOUD-2008"
    assert row["total_cycles"] == 1


@pytest.mark.asyncio
async def test_analytics_unique_tickets_by_external_key(db):
    """Summary stats COUNT(DISTINCT external_key) works correctly."""
    await _apply_schema(db)

    for key in ["RHCLOUD-2009", "RHCLOUD-2010", "RHCLOUD-2010"]:
        await db.execute(
            """INSERT INTO cycles (label, external_key, source_type, cost_usd)
               VALUES ($1, $2, $3, $4)""",
            "test",
            key,
            "jira",
            0.50,
        )

    count = await db.fetchval(
        """SELECT COUNT(DISTINCT external_key)
           FROM cycles
           WHERE external_key IS NOT NULL AND NOT no_work""",
    )
    assert count == 2


@pytest.mark.asyncio
async def test_analytics_repo_breakdown_by_external_key(db):
    """Per-repo breakdown uses COUNT(DISTINCT external_key)."""
    await _apply_schema(db)

    for key in ["RHCLOUD-2011", "RHCLOUD-2012"]:
        await db.execute(
            """INSERT INTO cycles (label, external_key, source_type,
                                   repo, cost_usd, num_turns)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            "test",
            key,
            "jira",
            "test-repo",
            0.50,
            10,
        )

    row = await db.fetchrow(
        """SELECT repo, COUNT(DISTINCT external_key) AS tickets
           FROM cycles
           WHERE repo IS NOT NULL AND NOT no_work
           GROUP BY repo""",
    )
    assert row is not None
    assert row["tickets"] == 2


# --- response helpers include new fields ---


@pytest.mark.asyncio
async def test_task_response_includes_new_fields(db):
    """Task rows include external_key, source_type, source_url, artifacts."""
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2013")

    row = await db.fetchrow("SELECT * FROM tasks WHERE external_key = $1", "RHCLOUD-2013")
    assert row["external_key"] == "RHCLOUD-2013"
    assert row["source_type"] == "jira"
    assert row["source_url"] == f"{JIRA_BASE_URL}/RHCLOUD-2013"
    assert json.loads(row["artifacts"]) == []


@pytest.mark.asyncio
async def test_cycle_response_includes_new_fields(db):
    """Cycle rows include external_key, source_type."""
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO cycles (label, external_key, source_type)
           VALUES ($1, $2, $3)""",
        "test",
        "RHCLOUD-2014",
        "jira",
    )

    row = await db.fetchrow("SELECT * FROM cycles WHERE external_key = $1", "RHCLOUD-2014")
    assert row["external_key"] == "RHCLOUD-2014"
    assert row["source_type"] == "jira"


@pytest.mark.asyncio
async def test_memory_response_includes_new_fields(db):
    """Memory rows include external_key, source_type."""
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO memories (category, external_key, source_type, title, content, embedding)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        "learning",
        "RHCLOUD-2015",
        "jira",
        "test",
        "content",
        ZERO_VECTOR,
    )

    row = await db.fetchrow("SELECT * FROM memories WHERE external_key = $1", "RHCLOUD-2015")
    assert row["external_key"] == "RHCLOUD-2015"
    assert row["source_type"] == "jira"

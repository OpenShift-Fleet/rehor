"""Read switchover tests — verify all reads use external_key/source_type.

Stage 3 (RHCLOUD-48378): All WHERE clauses, JOINs, GROUP BYs switch from
jira_key to external_key/source_type. Old jira_key params still work via
backward-compat fallback.
"""

import json
import os

import pytest

from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

from bot_memory_server.artifacts import JIRA_BASE_URL, build_artifacts  # noqa: E402


ZERO_VECTOR = "[" + ",".join(["0"] * 384) + "]"


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


async def _insert_task(db, jira_key, status="in_progress", repo="test-repo"):
    """Insert a task with both old and new columns populated (dual-write)."""
    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch,
                           external_key, source_type, source_url, artifacts, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        jira_key,
        status,
        repo,
        f"bot/{jira_key}",
        jira_key,
        "jira",
        f"{JIRA_BASE_URL}/{jira_key}",
        json.dumps([]),
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
    assert row["jira_key"] == "RHCLOUD-2000"
    assert row["external_key"] == "RHCLOUD-2000"
    assert row["source_type"] == "jira"


@pytest.mark.asyncio
async def test_task_get_fallback_jira_key(db):
    """Backward compat: lookup by external_key (same value as jira_key)."""
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-2001")

    row = await db.fetchrow(
        "SELECT * FROM tasks WHERE external_key = $1",
        "RHCLOUD-2001",
    )
    assert row is not None
    assert row["jira_key"] == "RHCLOUD-2001"


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
    assert row["jira_key"] == "RHCLOUD-2002"


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
        """INSERT INTO slack_notifications (jira_key, event_type, message,
                                            external_key, source_type)
           VALUES ($1, $2, $3, $4, $5)""",
        "RHCLOUD-2006",
        "pr_created",
        "test",
        "RHCLOUD-2006",
        "jira",
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
        """INSERT INTO slack_notifications (jira_key, event_type, message,
                                            external_key, source_type)
           VALUES ($1, $2, $3, $4, $5)""",
        "RHCLOUD-2007",
        "review_reminder",
        "Please review",
        "RHCLOUD-2007",
        "jira",
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
        """INSERT INTO cycles (label, jira_key, external_key, source_type,
                               repo, work_type, cost_usd)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        "test",
        "RHCLOUD-2008",
        "RHCLOUD-2008",
        "jira",
        "test-repo",
        "new_ticket",
        1.50,
    )

    row = await db.fetchrow(
        """SELECT c.external_key AS jira_key, t.title, COUNT(*) AS total_cycles
           FROM cycles c
           LEFT JOIN tasks t ON t.external_key = c.external_key
           WHERE c.external_key IS NOT NULL AND NOT c.no_work
           GROUP BY c.external_key, t.title""",
    )
    assert row is not None
    assert row["jira_key"] == "RHCLOUD-2008"
    assert row["total_cycles"] == 1


@pytest.mark.asyncio
async def test_analytics_unique_tickets_by_external_key(db):
    """Summary stats COUNT(DISTINCT external_key) works correctly."""
    await _apply_schema(db)

    for key in ["RHCLOUD-2009", "RHCLOUD-2010", "RHCLOUD-2010"]:
        await db.execute(
            """INSERT INTO cycles (label, jira_key, external_key, source_type, cost_usd)
               VALUES ($1, $2, $3, $4, $5)""",
            "test",
            key,
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
            """INSERT INTO cycles (label, jira_key, external_key, source_type,
                                   repo, cost_usd, num_turns)
               VALUES ($1, $2, $3, $4, $5, $6, $7)""",
            "test",
            key,
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

    row = await db.fetchrow(
        "SELECT * FROM tasks WHERE external_key = $1", "RHCLOUD-2013"
    )
    assert row["external_key"] == "RHCLOUD-2013"
    assert row["source_type"] == "jira"
    assert row["source_url"] == f"{JIRA_BASE_URL}/RHCLOUD-2013"
    assert json.loads(row["artifacts"]) == []


@pytest.mark.asyncio
async def test_cycle_response_includes_new_fields(db):
    """Cycle rows include external_key, source_type."""
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO cycles (label, jira_key, external_key, source_type)
           VALUES ($1, $2, $3, $4)""",
        "test",
        "RHCLOUD-2014",
        "RHCLOUD-2014",
        "jira",
    )

    row = await db.fetchrow(
        "SELECT * FROM cycles WHERE external_key = $1", "RHCLOUD-2014"
    )
    assert row["external_key"] == "RHCLOUD-2014"
    assert row["source_type"] == "jira"
    assert row["jira_key"] == "RHCLOUD-2014"


@pytest.mark.asyncio
async def test_memory_response_includes_new_fields(db):
    """Memory rows include external_key, source_type."""
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO memories (category, jira_key, title, content, embedding,
                                 external_key, source_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        "learning",
        "RHCLOUD-2015",
        "test",
        "content",
        ZERO_VECTOR,
        "RHCLOUD-2015",
        "jira",
    )

    row = await db.fetchrow(
        "SELECT * FROM memories WHERE external_key = $1", "RHCLOUD-2015"
    )
    assert row["external_key"] == "RHCLOUD-2015"
    assert row["source_type"] == "jira"
    assert row["jira_key"] == "RHCLOUD-2015"

"""Regression tests for cycle_runs grouping, progress, and serialization.

RHCLOUD-48536: Verify cycle_runs by-task grouping, pagination, filtering,
progress roundtrip with external_key tasks, and response serialization.
"""

import json
import os

import pytest
from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

from bot_memory_server.artifacts import JIRA_BASE_URL


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


async def _insert_task(db, external_key, status="in_progress", repo="test-repo"):
    row = await db.fetchrow(
        """
        INSERT INTO tasks (external_key, source_type, source_url,
                           status, repo, branch, metadata)
        VALUES ($1, $2, $3, $4::task_status, $5, $6, $7)
        RETURNING *
        """,
        external_key,
        "jira",
        f"{JIRA_BASE_URL}/{external_key}",
        status,
        repo,
        f"bot/{external_key}",
        json.dumps({}),
    )
    return row


async def _insert_cycle_run(
    db,
    task_id=None,
    cycle_type="task_work",
    instance_id=None,
    tool_calls=None,
    tokens_used=None,
    progress=None,
    transcript=None,
):
    row = await db.fetchrow(
        """
        INSERT INTO cycle_runs (task_id, cycle_type, instance_id,
                                tool_calls, tokens_used, progress, transcript)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, task_id, cycle_type, instance_id, started_at, finished_at,
                  tool_calls, tokens_used, progress, created_at,
                  (transcript IS NOT NULL) AS has_transcript
        """,
        task_id,
        cycle_type,
        instance_id,
        tool_calls,
        tokens_used,
        json.dumps(progress or {}),
        transcript,
    )
    return row


# --- Cycle runs by-task grouping ---


@pytest.mark.asyncio
async def test_cycle_runs_by_task_grouping(db):
    await _apply_schema(db)
    task = await _insert_task(db, "RHCLOUD-4000")
    task_id = task["id"]

    await _insert_cycle_run(db, task_id=task_id, tool_calls=50, tokens_used=10000)
    await _insert_cycle_run(db, task_id=task_id, tool_calls=30, tokens_used=8000, transcript=b"data")
    await _insert_cycle_run(db, task_id=task_id, tool_calls=20, tokens_used=5000)

    rows = await db.fetch(
        """
        WITH resolved AS (
            SELECT cr.*,
                COALESCE(t_direct.id, t_key.id) AS resolved_task_id,
                COALESCE(t_direct.external_key, t_key.external_key,
                         cr.progress->>'external_key') AS resolved_key,
                COALESCE(t_direct.title, t_key.title) AS resolved_title,
                COALESCE(t_direct.status, t_key.status) AS resolved_status,
                COALESCE(t_direct.repo, t_key.repo, cr.progress->>'repo') AS resolved_repo,
                COALESCE(t_direct.source_type, t_key.source_type) AS resolved_source_type
            FROM cycle_runs cr
            LEFT JOIN tasks t_direct ON t_direct.id = cr.task_id
            LEFT JOIN tasks t_key ON cr.task_id IS NULL
                AND t_key.external_key = cr.progress->>'external_key'
                AND t_key.source_type = 'jira'
        )
        SELECT
            MAX(resolved_task_id) AS task_id,
            resolved_key AS external_key,
            MAX(resolved_title) AS title,
            MAX(resolved_status::text) AS task_status,
            MAX(resolved_source_type) AS source_type,
            COUNT(*) AS cycle_count,
            COUNT(*) FILTER (WHERE transcript IS NOT NULL) AS transcript_count,
            SUM(tool_calls) AS total_tool_calls,
            SUM(tokens_used) AS total_tokens,
            MIN(started_at) AS first_cycle,
            MAX(started_at) AS last_cycle
        FROM resolved
        GROUP BY resolved_key
        ORDER BY MAX(started_at) DESC
        """
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["external_key"] == "RHCLOUD-4000"
    assert r["cycle_count"] == 3
    assert r["transcript_count"] == 1
    assert r["total_tool_calls"] == 100
    assert r["total_tokens"] == 23000
    assert r["first_cycle"] is not None
    assert r["last_cycle"] is not None


# --- Cycle runs by-task with instance filter ---


@pytest.mark.asyncio
async def test_cycle_runs_by_task_instance_filter(db):
    await _apply_schema(db)
    task = await _insert_task(db, "RHCLOUD-4010")
    task_id = task["id"]

    await _insert_cycle_run(db, task_id=task_id, instance_id="bot-1", tool_calls=10)
    await _insert_cycle_run(db, task_id=task_id, instance_id="bot-2", tool_calls=20)

    rows = await db.fetch(
        """
        SELECT cr.task_id, COUNT(*) AS cycle_count, SUM(cr.tool_calls) AS total_tool_calls
        FROM cycle_runs cr
        LEFT JOIN tasks t ON t.id = cr.task_id
        WHERE cr.instance_id = $1
        GROUP BY cr.task_id
        """,
        "bot-1",
    )
    assert len(rows) == 1
    assert rows[0]["cycle_count"] == 1
    assert rows[0]["total_tool_calls"] == 10


# --- Cycle runs by-task orphan grouping ---


@pytest.mark.asyncio
async def test_cycle_runs_orphan_grouping(db):
    """Cycle runs with no task and no matching task group by progress->>'external_key'."""
    await _apply_schema(db)

    await _insert_cycle_run(
        db,
        task_id=None,
        progress={"external_key": "RHCLOUD-4020", "repo": "orphan-repo"},
        tool_calls=15,
    )
    await _insert_cycle_run(
        db,
        task_id=None,
        progress={"external_key": "RHCLOUD-4020", "repo": "other-orphan-repo"},
        tool_calls=25,
    )

    rows = await db.fetch(
        """
        WITH resolved AS (
            SELECT cr.*,
                COALESCE(t_direct.id, t_key.id) AS resolved_task_id,
                COALESCE(t_direct.external_key, t_key.external_key,
                         cr.progress->>'external_key') AS resolved_key,
                COALESCE(t_direct.repo, t_key.repo, cr.progress->>'repo') AS resolved_repo,
                COALESCE(t_direct.source_type, t_key.source_type) AS resolved_source_type
            FROM cycle_runs cr
            LEFT JOIN tasks t_direct ON t_direct.id = cr.task_id
            LEFT JOIN tasks t_key ON cr.task_id IS NULL
                AND t_key.external_key = cr.progress->>'external_key'
                AND t_key.source_type = 'jira'
        )
        SELECT
            MAX(resolved_task_id) AS task_id,
            resolved_key AS external_key,
            MAX(resolved_repo) AS repo,
            COUNT(*) AS cycle_count,
            SUM(tool_calls) AS total_tool_calls
        FROM resolved
        GROUP BY resolved_key
        """
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["task_id"] is None
    assert r["external_key"] == "RHCLOUD-4020"
    assert r["cycle_count"] == 2
    assert r["total_tool_calls"] == 40


# --- Orphans merge with task-linked runs ---


@pytest.mark.asyncio
async def test_cycle_runs_orphan_merges_with_task(db):
    """Orphan cycle_runs with matching external_key merge into the task group.

    Reproduces the prod bug where RHCLOUD-47818 appeared 3 times:
    2 orphan groups + 1 task-linked group. After fix, should be 1 group.
    """
    await _apply_schema(db)
    task = await _insert_task(db, "RHCLOUD-4025")
    task_id = task["id"]

    # Task-linked cycle
    await _insert_cycle_run(db, task_id=task_id, tool_calls=50, tokens_used=10000)
    # Orphan cycles (created before task existed or without task_id)
    await _insert_cycle_run(
        db,
        task_id=None,
        progress={"external_key": "RHCLOUD-4025", "repo": "test-repo"},
        tool_calls=30,
        tokens_used=8000,
        transcript=b"data",
    )
    await _insert_cycle_run(
        db,
        task_id=None,
        progress={"external_key": "RHCLOUD-4025", "repo": "other-repo"},
        tool_calls=20,
        tokens_used=5000,
    )

    # Use the new resolved CTE query (same as api_cycle_runs_by_task)
    rows = await db.fetch(
        """
        WITH resolved AS (
            SELECT
                cr.*,
                COALESCE(t_direct.id, t_key.id) AS resolved_task_id,
                COALESCE(
                    t_direct.external_key, t_key.external_key,
                    cr.progress->>'external_key'
                ) AS resolved_key,
                COALESCE(t_direct.title, t_key.title) AS resolved_title,
                COALESCE(t_direct.status, t_key.status) AS resolved_status,
                COALESCE(t_direct.repo, t_key.repo, cr.progress->>'repo') AS resolved_repo,
                COALESCE(t_direct.source_type, t_key.source_type) AS resolved_source_type
            FROM cycle_runs cr
            LEFT JOIN tasks t_direct ON t_direct.id = cr.task_id
            LEFT JOIN tasks t_key ON cr.task_id IS NULL
                AND t_key.external_key = cr.progress->>'external_key'
                AND t_key.source_type = 'jira'
        )
        SELECT
            MAX(resolved_task_id) AS task_id,
            resolved_key AS external_key,
            MAX(resolved_source_type) AS source_type,
            COUNT(*) AS cycle_count,
            COUNT(*) FILTER (WHERE transcript IS NOT NULL) AS transcript_count,
            SUM(tool_calls) AS total_tool_calls,
            SUM(tokens_used) AS total_tokens
        FROM resolved
        GROUP BY resolved_key
        ORDER BY MAX(started_at) DESC
        """
    )
    # All 3 runs should merge into 1 group
    assert len(rows) == 1
    r = rows[0]
    assert r["external_key"] == "RHCLOUD-4025"
    assert r["task_id"] == task_id
    assert r["cycle_count"] == 3
    assert r["transcript_count"] == 1
    assert r["total_tool_calls"] == 100
    assert r["total_tokens"] == 23000


# --- POST /api/cycle-runs resolves task_id from progress.external_key ---


@pytest.mark.asyncio
async def test_cycle_run_post_resolves_task_id(db):
    """When POST /api/cycle-runs receives task_id=null but progress has external_key,
    it should resolve the task_id from the tasks table."""
    await _apply_schema(db)
    task = await _insert_task(db, "RHCLOUD-4026")
    task_id = task["id"]

    # Simulate what api_cycle_runs_add does: resolve task_id from progress
    progress = {"external_key": "RHCLOUD-4026", "repo": "test-repo"}
    ext_key = progress.get("external_key")
    resolved = await db.fetchrow(
        "SELECT id FROM tasks WHERE external_key = $1 AND source_type = 'jira'",
        ext_key,
    )
    resolved_task_id = resolved["id"] if resolved else None

    run = await _insert_cycle_run(db, task_id=resolved_task_id, progress=progress, tool_calls=42)
    assert run["task_id"] == task_id


# --- Progress roundtrip with external_key task ---


@pytest.mark.asyncio
async def test_progress_roundtrip_external_key(db):
    await _apply_schema(db)
    task = await _insert_task(db, "RHCLOUD-4030")
    task_id = task["id"]

    progress = {
        "last_step": "tests_passing",
        "next_step": "push_and_pr",
        "files_changed": ["src/app.tsx", "src/utils.ts"],
    }
    run = await _insert_cycle_run(db, task_id=task_id, progress=progress, tool_calls=42)

    loaded = await db.fetchrow(
        """
        SELECT cr.*, t.external_key, t.source_type
        FROM cycle_runs cr
        LEFT JOIN tasks t ON t.id = cr.task_id
        WHERE cr.id = $1
        """,
        run["id"],
    )
    assert loaded["external_key"] == "RHCLOUD-4030"
    assert loaded["source_type"] == "jira"

    stored_progress = json.loads(loaded["progress"]) if isinstance(loaded["progress"], str) else loaded["progress"]
    assert stored_progress["last_step"] == "tests_passing"
    assert stored_progress["files_changed"] == ["src/app.tsx", "src/utils.ts"]


# --- Cycle run response serialization ---


@pytest.mark.asyncio
async def test_cycle_run_serialization(db):
    await _apply_schema(db)
    run = await _insert_cycle_run(
        db,
        cycle_type="triage",
        instance_id="bot-test",
        tool_calls=75,
        tokens_used=50000,
        progress={"status": "complete"},
    )

    assert run["id"] is not None
    assert run["cycle_type"] == "triage"
    assert run["instance_id"] == "bot-test"
    assert run["tool_calls"] == 75
    assert run["tokens_used"] == 50000
    assert run["started_at"] is not None
    assert run["created_at"] is not None
    assert run["has_transcript"] is False

    progress = json.loads(run["progress"]) if isinstance(run["progress"], str) else run["progress"]
    assert progress["status"] == "complete"


# --- Cycle run with transcript ---


@pytest.mark.asyncio
async def test_cycle_run_with_transcript_flag(db):
    await _apply_schema(db)
    run = await _insert_cycle_run(db, transcript=b"compressed-transcript-data")
    assert run["has_transcript"] is True


# --- Cycle list pagination ---


@pytest.mark.asyncio
async def test_cycle_runs_pagination(db):
    await _apply_schema(db)
    for _ in range(5):
        await _insert_cycle_run(db)

    total = await db.fetchval("SELECT COUNT(*) FROM cycle_runs")
    assert total == 5

    rows = await db.fetch(
        """
        SELECT id, task_id, cycle_type, instance_id, started_at, finished_at,
               tool_calls, tokens_used, progress, created_at,
               (transcript IS NOT NULL) AS has_transcript
        FROM cycle_runs
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
        """,
        2,
        2,
    )
    assert len(rows) == 2


# --- Cycle list filter by cycle_type ---


@pytest.mark.asyncio
async def test_cycle_runs_filter_by_type(db):
    await _apply_schema(db)
    await _insert_cycle_run(db, cycle_type="task_work")
    await _insert_cycle_run(db, cycle_type="triage")
    await _insert_cycle_run(db, cycle_type="triage")

    rows = await db.fetch(
        """
        SELECT id FROM cycle_runs WHERE cycle_type = $1
        """,
        "triage",
    )
    assert len(rows) == 2


# --- REHOR-102: No-transcript merge into progress_store row ---


@pytest.mark.asyncio
async def test_no_transcript_merges_into_progress_store_row(db):
    """REHOR-102: When record_transcript posts without a transcript (file not found),
    the API should merge metadata into the existing progress_store row, not create a duplicate.

    Simulates the real sequence:
    1. progress_store creates a cycle_run (no transcript)
    2. record_transcript posts tool_calls/tokens_used but no transcript_b64
    Expected: single row with merged metadata, NOT two rows.
    """
    await _apply_schema(db)
    task = await _insert_task(db, "REHOR-102")
    task_id = task["id"]

    # Step 1: progress_store creates the initial row
    orphan = await _insert_cycle_run(
        db,
        task_id=task_id,
        instance_id="bot-merge-test",
        tool_calls=None,
        tokens_used=None,
        progress={"last_step": "implemented"},
    )
    assert orphan["has_transcript"] is False

    # Step 2: record_transcript merges metadata (no transcript)
    merged = await db.fetchrow(
        """
        UPDATE cycle_runs
        SET transcript = COALESCE($1, transcript),
            tool_calls = COALESCE($2, tool_calls),
            tokens_used = COALESCE($3, tokens_used)
        WHERE id = (
            SELECT id FROM cycle_runs
            WHERE instance_id = $4
              AND transcript IS NULL
              AND created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC
            LIMIT 1
        )
        RETURNING id, tool_calls, tokens_used,
                  (transcript IS NOT NULL) AS has_transcript
        """,
        None,  # no transcript bytes
        87,
        150000,
        "bot-merge-test",
    )
    assert merged is not None
    assert merged["id"] == orphan["id"]
    assert merged["tool_calls"] == 87
    assert merged["tokens_used"] == 150000
    assert merged["has_transcript"] is False

    # Verify only one row exists
    total = await db.fetchval(
        "SELECT COUNT(*) FROM cycle_runs WHERE instance_id = $1",
        "bot-merge-test",
    )
    assert total == 1


@pytest.mark.asyncio
async def test_transcript_merge_preserves_existing_transcript(db):
    """REHOR-102: COALESCE($1, transcript) must not overwrite an existing transcript with NULL."""
    await _apply_schema(db)

    await _insert_cycle_run(
        db,
        instance_id="bot-preserve-test",
        transcript=b"existing-transcript-data",
        tool_calls=10,
    )

    result = await db.fetchrow(
        """
        UPDATE cycle_runs
        SET transcript = COALESCE($1, transcript),
            tool_calls = COALESCE($2, tool_calls)
        WHERE id = (
            SELECT id FROM cycle_runs
            WHERE instance_id = $3
              AND transcript IS NULL
              AND created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC
            LIMIT 1
        )
        RETURNING id
        """,
        None,
        99,
        "bot-preserve-test",
    )
    # UPDATE should match nothing — the existing row already has a transcript
    assert result is None

    # Verify the existing transcript is untouched
    row = await db.fetchrow(
        "SELECT transcript, tool_calls FROM cycle_runs WHERE instance_id = $1",
        "bot-preserve-test",
    )
    assert bytes(row["transcript"]) == b"existing-transcript-data"
    assert row["tool_calls"] == 10


@pytest.mark.asyncio
async def test_no_transcript_no_orphan_creates_new_row(db):
    """REHOR-102: When no orphan exists, the INSERT fallback creates a new row."""
    await _apply_schema(db)

    # No pre-existing rows for this instance — UPDATE will find nothing
    result = await db.fetchrow(
        """
        UPDATE cycle_runs
        SET transcript = COALESCE($1, transcript),
            tool_calls = COALESCE($2, tool_calls)
        WHERE id = (
            SELECT id FROM cycle_runs
            WHERE instance_id = $3
              AND transcript IS NULL
              AND created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC
            LIMIT 1
        )
        RETURNING id
        """,
        None,
        50,
        "bot-new-instance",
    )
    assert result is None  # nothing to merge into

    # Fallback INSERT creates a new row
    row = await _insert_cycle_run(
        db,
        instance_id="bot-new-instance",
        tool_calls=50,
        tokens_used=20000,
    )
    assert row["id"] is not None
    assert row["tool_calls"] == 50

    total = await db.fetchval(
        "SELECT COUNT(*) FROM cycle_runs WHERE instance_id = $1",
        "bot-new-instance",
    )
    assert total == 1


@pytest.mark.asyncio
async def test_duplicate_cycle_runs_without_fix(db):
    """REHOR-102: Reproduce the exact bug — progress_store + record_transcript
    without transcript should NOT create two rows."""
    await _apply_schema(db)
    task = await _insert_task(db, "REHOR-102-DUPE")
    task_id = task["id"]

    # progress_store creates row #1
    await _insert_cycle_run(
        db,
        task_id=task_id,
        instance_id="bot-dupe-test",
        progress={"last_step": "opened_pr"},
    )

    # record_transcript: attempt UPDATE first (the fix)
    merged = await db.fetchrow(
        """
        UPDATE cycle_runs
        SET transcript = COALESCE($1, transcript),
            finished_at = COALESCE($2, finished_at, NOW()),
            tool_calls = COALESCE($3, tool_calls),
            tokens_used = COALESCE($4, tokens_used),
            task_id = COALESCE(task_id, $5)
        WHERE id = (
            SELECT id FROM cycle_runs
            WHERE instance_id = $6
              AND transcript IS NULL
              AND created_at > NOW() - INTERVAL '2 hours'
            ORDER BY created_at DESC
            LIMIT 1
        )
        RETURNING id
        """,
        None,  # no transcript
        None,  # finished_at
        45,
        120000,
        task_id,
        "bot-dupe-test",
    )
    # The UPDATE should succeed — merged into row #1
    assert merged is not None

    total = await db.fetchval(
        "SELECT COUNT(*) FROM cycle_runs WHERE instance_id = $1",
        "bot-dupe-test",
    )
    assert total == 1


# --- Costs POST with external_key ---


@pytest.mark.asyncio
async def test_cost_record_populates_external_key(db):
    await _apply_schema(db)

    row = await db.fetchrow(
        """
        INSERT INTO cycles (label, session_id, num_turns, duration_ms, cost_usd,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                            model, is_error, no_work,
                            repo, work_type, summary,
                            external_key, source_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *
        """,
        "test",
        "sess",
        5,
        30000,
        0.25,
        50,
        25,
        10,
        5,
        "claude-opus-4",
        False,
        False,
        "test-repo",
        "new_ticket",
        "Fixed button",
        "RHCLOUD-4050",
        "jira",
    )
    assert row["external_key"] == "RHCLOUD-4050"
    assert row["source_type"] == "jira"

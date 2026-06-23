"""Regression tests for costs, analytics, task list, and stats endpoints.

RHCLOUD-48537: Verify dashboard cost analytics and task API query logic
against a real Postgres DB. Tests exercise the SQL queries and serialization
patterns used by api.py REST handlers.
"""

import json
import os
from datetime import datetime, timedelta, timezone

import pytest

from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

from bot_memory_server.artifacts import JIRA_BASE_URL  # noqa: E402

ZERO_VECTOR = "[" + ",".join(["0"] * 384) + "]"


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


async def _insert_task(
    db, external_key, status="in_progress", repo="test-repo", title=None
):
    await db.execute(
        """
        INSERT INTO tasks (external_key, source_type, source_url, status, repo, branch, title, metadata)
        VALUES ($1, $2, $3, $4::task_status, $5, $6, $7, $8) RETURNING id
        """,
        external_key,
        "jira",
        f"{JIRA_BASE_URL}/{external_key}",
        status,
        repo,
        f"bot/{external_key}",
        title,
        json.dumps({}),
    )


async def _insert_cycle(
    db,
    external_key=None,
    repo=None,
    work_type=None,
    cost_usd=0.50,
    num_turns=10,
    duration_ms=60000,
    is_error=False,
    no_work=False,
    summary=None,
    timestamp=None,
):
    params = [
        "test-label",
        "sess-1",
        num_turns,
        duration_ms,
        cost_usd,
        100,
        50,
        20,
        10,
        "claude-opus-4",
        is_error,
        no_work,
        external_key,
        "jira" if external_key else None,
    ]
    if timestamp:
        params.append(timestamp)
    params.extend([repo, work_type, summary])

    ek_idx = 13
    st_idx = 14
    ts_idx = 15 if timestamp else None
    repo_idx = 16 if timestamp else 15
    wt_idx = repo_idx + 1
    sum_idx = wt_idx + 1

    row = await db.fetchrow(
        f"""
        INSERT INTO cycles (label, session_id, num_turns, duration_ms, cost_usd,
                            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                            model, is_error, no_work, external_key, source_type,
                            {"timestamp," if timestamp else ""}
                            repo, work_type, summary)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${ek_idx}, ${st_idx},
                {"$" + str(ts_idx) + "," if timestamp else ""}
                ${repo_idx}, ${wt_idx}, ${sum_idx})
        RETURNING *
        """,
        *params,
    )
    return row


# --- Costs: record + list ---


@pytest.mark.asyncio
async def test_cycle_record_and_serialization(db):
    await _apply_schema(db)
    row = await _insert_cycle(
        db, external_key="RHCLOUD-3000", repo="test-repo", work_type="new_ticket"
    )

    assert row["external_key"] == "RHCLOUD-3000"
    assert row["source_type"] == "jira"
    assert row["repo"] == "test-repo"
    assert float(row["cost_usd"]) == 0.50
    assert row["num_turns"] == 10
    assert row["is_error"] is False
    assert row["no_work"] is False


@pytest.mark.asyncio
async def test_daily_aggregates(db):
    await _apply_schema(db)
    now = datetime.now(timezone.utc)
    yesterday = now - timedelta(days=1)

    await _insert_cycle(db, cost_usd=1.00, timestamp=now)
    await _insert_cycle(db, cost_usd=2.00, timestamp=now)
    await _insert_cycle(db, cost_usd=0.50, timestamp=yesterday)

    rows = await db.fetch(
        """
        SELECT DATE(timestamp) AS day,
               COUNT(*) AS cycles,
               SUM(cost_usd) AS total_cost,
               SUM(CASE WHEN no_work THEN 1 ELSE 0 END) AS idle_cycles,
               SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS error_cycles
        FROM cycles
        WHERE timestamp > NOW() - INTERVAL '7 days'
        GROUP BY DATE(timestamp)
        ORDER BY day DESC
        """
    )
    assert len(rows) == 2
    today_row = rows[0]
    assert today_row["cycles"] == 2
    assert float(today_row["total_cost"]) == 3.00

    yesterday_row = rows[1]
    assert yesterday_row["cycles"] == 1
    assert float(yesterday_row["total_cost"]) == 0.50


# --- Analytics: summary stats ---


@pytest.mark.asyncio
async def test_analytics_summary_stats(db):
    await _apply_schema(db)

    await _insert_cycle(
        db, external_key="RHCLOUD-3010", work_type="new_ticket", cost_usd=1.00
    )
    await _insert_cycle(
        db, external_key="RHCLOUD-3011", work_type="pr_review", cost_usd=2.00
    )
    await _insert_cycle(db, no_work=True, cost_usd=0.10)
    await _insert_cycle(db, is_error=True, cost_usd=0.05)

    row = await db.fetchrow(
        """
        SELECT
            COUNT(*) AS total_cycles,
            COUNT(DISTINCT external_key) FILTER (WHERE external_key IS NOT NULL AND NOT no_work) AS unique_tickets,
            ROUND(SUM(cost_usd)::numeric, 2) AS total_cost,
            ROUND(AVG(cost_usd) FILTER (WHERE NOT no_work)::numeric, 2) AS avg_cost_per_work_cycle,
            COUNT(*) FILTER (WHERE no_work) AS idle_cycles,
            COUNT(*) FILTER (WHERE is_error) AS error_cycles,
            COUNT(*) FILTER (WHERE NOT no_work AND NOT is_error) AS work_cycles
        FROM cycles
        WHERE timestamp > NOW() - INTERVAL '30 days'
        """
    )
    assert row["total_cycles"] == 4
    assert row["unique_tickets"] == 2
    assert row["idle_cycles"] == 1
    assert row["error_cycles"] == 1
    assert row["work_cycles"] == 2
    assert float(row["total_cost"]) == 3.15


# --- Analytics: work type breakdown ---


@pytest.mark.asyncio
async def test_analytics_work_type_breakdown(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-CVE-1", title="Fix CVE-2024-1234")

    await _insert_cycle(
        db,
        external_key="RHCLOUD-CVE-1",
        work_type="new_ticket",
        summary="Fix CVE-2024-1234",
    )
    await _insert_cycle(db, work_type="pr_review", external_key="RHCLOUD-3020")
    await _insert_cycle(
        db, summary="investigation of logging issue", external_key="RHCLOUD-3021"
    )
    await _insert_cycle(db, no_work=True)

    rows = await db.fetch(
        """
        SELECT
            CASE
                WHEN summary ILIKE '%%investigation%%' OR work_type = 'investigation' THEN 'investigation'
                WHEN external_key IS NOT NULL AND (
                    summary ILIKE '%%CVE%%' OR summary ILIKE '%%cve%%'
                    OR external_key IN (SELECT DISTINCT external_key FROM tasks WHERE title ILIKE '%%CVE%%')
                ) THEN 'cve'
                WHEN work_type = 'pr_review' THEN 'pr_review'
                WHEN work_type = 'new_ticket' THEN 'new_ticket'
                WHEN no_work THEN 'idle'
                WHEN is_error THEN 'error'
                ELSE 'other'
            END AS category,
            COUNT(*) AS cycles
        FROM cycles
        WHERE timestamp > NOW() - INTERVAL '30 days'
        GROUP BY category
        ORDER BY cycles DESC
        """
    )
    categories = {r["category"]: r["cycles"] for r in rows}
    assert categories.get("cve") == 1
    assert categories.get("pr_review") == 1
    assert categories.get("investigation") == 1
    assert categories.get("idle") == 1


# --- Analytics: repo breakdown ---


@pytest.mark.asyncio
async def test_analytics_repo_breakdown(db):
    await _apply_schema(db)

    await _insert_cycle(db, external_key="RHCLOUD-3030", repo="repo-a")
    await _insert_cycle(db, external_key="RHCLOUD-3031", repo="repo-a")
    await _insert_cycle(db, external_key="RHCLOUD-3032", repo="repo-b")

    rows = await db.fetch(
        """
        SELECT repo,
            COUNT(DISTINCT external_key) AS tickets,
            COUNT(*) AS cycles,
            ROUND(SUM(cost_usd)::numeric, 2) AS total_cost
        FROM cycles
        WHERE timestamp > NOW() - INTERVAL '30 days' AND repo IS NOT NULL AND NOT no_work
        GROUP BY repo
        ORDER BY cycles DESC
        """
    )
    repos = {r["repo"]: r for r in rows}
    assert repos["repo-a"]["tickets"] == 2
    assert repos["repo-a"]["cycles"] == 2
    assert repos["repo-b"]["tickets"] == 1


# --- Analytics: ticket lifecycle ---


@pytest.mark.asyncio
async def test_analytics_ticket_lifecycle(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3040", title="Fix button color")

    await _insert_cycle(
        db,
        external_key="RHCLOUD-3040",
        repo="test-repo",
        work_type="new_ticket",
        cost_usd=1.00,
    )
    await _insert_cycle(
        db,
        external_key="RHCLOUD-3040",
        repo="test-repo",
        work_type="pr_review",
        cost_usd=0.50,
    )
    await _insert_cycle(
        db,
        external_key="RHCLOUD-3040",
        repo="test-repo",
        work_type="pr_review",
        cost_usd=0.30,
    )

    rows = await db.fetch(
        """
        SELECT
            c.external_key,
            t.title,
            t.status::text AS task_status,
            COUNT(*) AS total_cycles,
            SUM(CASE WHEN c.work_type = 'new_ticket' THEN 1 ELSE 0 END) AS impl_cycles,
            SUM(CASE WHEN c.work_type = 'pr_review' THEN 1 ELSE 0 END) AS review_cycles,
            ROUND(SUM(c.cost_usd)::numeric, 2) AS total_cost
        FROM cycles c
        LEFT JOIN tasks t ON t.external_key = c.external_key
        WHERE c.external_key IS NOT NULL AND NOT c.no_work
            AND c.timestamp > NOW() - INTERVAL '30 days'
        GROUP BY c.external_key, t.title, t.status
        """
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["external_key"] == "RHCLOUD-3040"
    assert r["title"] == "Fix button color"
    assert r["total_cycles"] == 3
    assert r["impl_cycles"] == 1
    assert r["review_cycles"] == 2
    assert float(r["total_cost"]) == 1.80


# --- Analytics: review rounds ---


@pytest.mark.asyncio
async def test_analytics_review_rounds(db):
    await _apply_schema(db)

    # Ticket A: 0 review cycles
    await _insert_cycle(db, external_key="RHCLOUD-3050", work_type="new_ticket")
    # Ticket B: 1 review cycle
    await _insert_cycle(db, external_key="RHCLOUD-3051", work_type="new_ticket")
    await _insert_cycle(db, external_key="RHCLOUD-3051", work_type="pr_review")
    # Ticket C: 3 review cycles
    await _insert_cycle(db, external_key="RHCLOUD-3052", work_type="new_ticket")
    await _insert_cycle(db, external_key="RHCLOUD-3052", work_type="pr_review")
    await _insert_cycle(db, external_key="RHCLOUD-3052", work_type="pr_review")
    await _insert_cycle(db, external_key="RHCLOUD-3052", work_type="pr_review")

    row = await db.fetchrow(
        """
        SELECT
            ROUND(AVG(review_count)::numeric, 1) AS avg_review_rounds,
            COUNT(*) FILTER (WHERE review_count = 0) AS zero_review,
            COUNT(*) FILTER (WHERE review_count = 1) AS one_review,
            COUNT(*) FILTER (WHERE review_count > 1) AS multi_review
        FROM (
            SELECT external_key, COUNT(*) FILTER (WHERE work_type = 'pr_review') AS review_count
            FROM cycles
            WHERE timestamp > NOW() - INTERVAL '30 days' AND external_key IS NOT NULL AND NOT no_work
            GROUP BY external_key
        ) sub
        """
    )
    assert row["zero_review"] == 1
    assert row["one_review"] == 1
    assert row["multi_review"] == 1
    assert float(row["avg_review_rounds"]) == pytest.approx(1.3, abs=0.1)


# --- Task list: status filter ---


@pytest.mark.asyncio
async def test_task_list_status_filter(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3060", status="in_progress")
    await _insert_task(db, "RHCLOUD-3061", status="pr_open")
    await _insert_task(db, "RHCLOUD-3062", status="archived")

    rows = await db.fetch(
        "SELECT * FROM tasks WHERE status = $1::task_status ORDER BY created_at",
        "in_progress",
    )
    assert len(rows) == 1
    assert rows[0]["external_key"] == "RHCLOUD-3060"


# --- Task list: exclude_status filter ---


@pytest.mark.asyncio
async def test_task_list_exclude_status(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3070", status="in_progress")
    await _insert_task(db, "RHCLOUD-3071", status="archived")
    await _insert_task(db, "RHCLOUD-3072", status="pr_open")

    rows = await db.fetch(
        "SELECT * FROM tasks WHERE status != $1::task_status ORDER BY created_at",
        "archived",
    )
    assert len(rows) == 2
    keys = {r["external_key"] for r in rows}
    assert "RHCLOUD-3071" not in keys


# --- Task list: pagination ---


@pytest.mark.asyncio
async def test_task_list_pagination(db):
    await _apply_schema(db)
    for i in range(5):
        await _insert_task(db, f"RHCLOUD-308{i}")

    total = await db.fetchval("SELECT COUNT(*) FROM tasks")
    assert total == 5

    rows = await db.fetch(
        "SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1 OFFSET $2",
        2,
        2,
    )
    assert len(rows) == 2


# --- Task list: slack notification join ---


@pytest.mark.asyncio
async def test_task_list_slack_notification_join(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3090")

    await db.execute(
        """INSERT INTO slack_notifications (external_key, source_type, event_type, message)
           VALUES ($1, $2, $3, $4)""",
        "RHCLOUD-3090",
        "jira",
        "pr_created",
        "PR opened",
    )

    notif_rows = await db.fetch(
        """
        SELECT DISTINCT ON (external_key) external_key, event_type, message, sent_at
        FROM slack_notifications
        WHERE external_key = ANY($1)
        ORDER BY external_key, sent_at DESC
        """,
        ["RHCLOUD-3090"],
    )
    assert len(notif_rows) == 1
    assert notif_rows[0]["event_type"] == "pr_created"
    assert notif_rows[0]["external_key"] == "RHCLOUD-3090"


# --- Task delete ---


@pytest.mark.asyncio
async def test_task_delete_archives(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3100", status="in_progress")

    row = await db.fetchrow(
        "UPDATE tasks SET status = 'archived'::task_status WHERE external_key = $1 RETURNING *",
        "RHCLOUD-3100",
    )
    assert row is not None
    assert row["status"] == "archived"


# --- Task unarchive ---


@pytest.mark.asyncio
async def test_task_unarchive_restores(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3110", status="archived")
    await db.execute(
        "UPDATE tasks SET paused_reason = $2 WHERE external_key = $1",
        "RHCLOUD-3110",
        "blocked on dependency",
    )

    row = await db.fetchrow(
        """UPDATE tasks SET status = 'in_progress'::task_status, paused_reason = NULL
           WHERE external_key = $1 AND status = 'archived'::task_status
           RETURNING *""",
        "RHCLOUD-3110",
    )
    assert row is not None
    assert row["status"] == "in_progress"
    assert row["paused_reason"] is None


# --- Stats endpoint ---


@pytest.mark.asyncio
async def test_stats_counts(db):
    await _apply_schema(db)
    await _insert_task(db, "RHCLOUD-3120", status="in_progress")
    await _insert_task(db, "RHCLOUD-3121", status="pr_open")
    await _insert_task(db, "RHCLOUD-3122", status="archived")

    await db.execute(
        """INSERT INTO memories (category, repo, title, content, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        "learning",
        "test-repo",
        "test memory",
        "content",
        ZERO_VECTOR,
        json.dumps({}),
    )

    tasks_by_status = await db.fetch(
        "SELECT status::text, COUNT(*) as count FROM tasks GROUP BY status"
    )
    status_map = {r["status"]: r["count"] for r in tasks_by_status}
    assert status_map["in_progress"] == 1
    assert status_map["pr_open"] == 1
    assert status_map["archived"] == 1

    memory_count = await db.fetchval("SELECT COUNT(*) FROM memories")
    assert memory_count == 1

    memories_by_cat = await db.fetch(
        "SELECT category, COUNT(*) as count FROM memories GROUP BY category"
    )
    assert memories_by_cat[0]["category"] == "learning"
    assert memories_by_cat[0]["count"] == 1


# --- Tags endpoint ---


@pytest.mark.asyncio
async def test_tags_distinct_sorted(db):
    await _apply_schema(db)

    await db.execute(
        """INSERT INTO memories (category, title, content, tags, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        "learning",
        "mem1",
        "content",
        ["css", "patternfly"],
        ZERO_VECTOR,
        json.dumps({}),
    )
    await db.execute(
        """INSERT INTO memories (category, title, content, tags, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        "learning",
        "mem2",
        "content",
        ["css", "testing"],
        ZERO_VECTOR,
        json.dumps({}),
    )

    rows = await db.fetch(
        "SELECT DISTINCT unnest(tags) AS tag FROM memories ORDER BY tag"
    )
    tags = [r["tag"] for r in rows]
    assert tags == ["css", "patternfly", "testing"]

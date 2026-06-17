"""Dual-write tests — verify every write path populates both old and new columns.

Stage 2 (RHCLOUD-48377): All write paths must set external_key/source_type/source_url/artifacts
alongside the original jira_key/pr_number/pr_url columns.
"""

import json
import os

import pytest

from conftest import SCHEMA_PATH

os.environ.setdefault("JIRA_URL", "https://redhat.atlassian.net")

from bot_memory_server.artifacts import JIRA_BASE_URL, build_artifacts  # noqa: E402


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


ZERO_VECTOR = "[" + ",".join(["0"] * 384) + "]"


# --- task_add ---


@pytest.mark.asyncio
async def test_task_add_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        "RHCLOUD-1000",
        "in_progress",
        "test-repo",
        "bot/RHCLOUD-1000",
        "RHCLOUD-1000",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1000",
        json.dumps([]),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1000")
    assert task["jira_key"] == "RHCLOUD-1000"
    assert task["external_key"] == "RHCLOUD-1000"
    assert task["source_type"] == "jira"
    assert task["source_url"] == "https://redhat.atlassian.net/browse/RHCLOUD-1000"
    assert json.loads(task["artifacts"]) == []


@pytest.mark.asyncio
async def test_task_add_with_pr_artifacts(db):
    await _apply_schema(db)

    pr_url = "https://github.com/org/repo/pull/42"
    artifacts = build_artifacts(42, pr_url, {})

    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """,
        "RHCLOUD-1001",
        "pr_open",
        "test-repo",
        "bot/RHCLOUD-1001",
        42,
        pr_url,
        "RHCLOUD-1001",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1001",
        json.dumps(artifacts),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1001")
    parsed = json.loads(task["artifacts"])
    assert len(parsed) == 1
    assert parsed[0]["name"] == "PR #42"
    assert parsed[0]["url"] == pr_url
    assert parsed[0]["type"] == "pull_request"


@pytest.mark.asyncio
async def test_task_add_with_metadata_prs(db):
    await _apply_schema(db)

    metadata = {
        "prs": [
            {
                "repo": "r1",
                "number": 10,
                "url": "https://github.com/o/r1/pull/10",
                "host": "github",
            },
            {
                "repo": "r2",
                "number": 5,
                "url": "https://gitlab.cee.redhat.com/o/r2/-/merge_requests/5",
                "host": "gitlab",
            },
        ]
    }
    artifacts = build_artifacts(None, None, metadata)

    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch, metadata,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        """,
        "RHCLOUD-1002",
        "pr_open",
        "r1",
        "bot/RHCLOUD-1002",
        json.dumps(metadata),
        "RHCLOUD-1002",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1002",
        json.dumps(artifacts),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1002")
    parsed = json.loads(task["artifacts"])
    assert len(parsed) == 2
    types = {a["type"] for a in parsed}
    assert "pull_request" in types
    assert "merge_request" in types
    names = {a["name"] for a in parsed}
    assert "PR #10" in names
    assert "MR #5" in names


# --- task_update artifact rebuild ---


@pytest.mark.asyncio
async def test_task_update_pr_rebuilds_artifacts(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        "RHCLOUD-1003",
        "in_progress",
        "test-repo",
        "bot/RHCLOUD-1003",
        "RHCLOUD-1003",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1003",
        json.dumps([]),
    )

    pr_url = "https://github.com/org/repo/pull/99"
    new_artifacts = build_artifacts(99, pr_url, {})
    await db.execute(
        "UPDATE tasks SET pr_number = $2, pr_url = $3, artifacts = $4 WHERE jira_key = $1",
        "RHCLOUD-1003",
        99,
        pr_url,
        json.dumps(new_artifacts),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1003")
    parsed = json.loads(task["artifacts"])
    assert len(parsed) == 1
    assert parsed[0]["name"] == "PR #99"
    assert task["pr_number"] == 99
    assert task["pr_url"] == pr_url


@pytest.mark.asyncio
async def test_task_update_metadata_prs_rebuilds_artifacts(db):
    await _apply_schema(db)

    pr_url = "https://github.com/org/repo/pull/50"
    initial_artifacts = build_artifacts(50, pr_url, {})
    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        """,
        "RHCLOUD-1004",
        "pr_open",
        "test-repo",
        "bot/RHCLOUD-1004",
        50,
        pr_url,
        "RHCLOUD-1004",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1004",
        json.dumps(initial_artifacts),
    )

    new_meta = {
        "prs": [
            {
                "repo": "r2",
                "number": 60,
                "url": "https://github.com/o/r2/pull/60",
                "host": "github",
            },
        ]
    }
    merged_artifacts = build_artifacts(50, pr_url, new_meta)
    await db.execute(
        "UPDATE tasks SET metadata = $2, artifacts = $3 WHERE jira_key = $1",
        "RHCLOUD-1004",
        json.dumps(new_meta),
        json.dumps(merged_artifacts),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1004")
    parsed = json.loads(task["artifacts"])
    assert len(parsed) == 2
    urls = {a["url"] for a in parsed}
    assert pr_url in urls
    assert "https://github.com/o/r2/pull/60" in urls


# --- bot_status ---


@pytest.mark.asyncio
async def test_bot_status_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        UPDATE bot_status SET state = $1, message = $2, jira_key = $3, repo = $4,
            external_key = $5, source_type = $6, updated_at = NOW()
        WHERE id = 1
        """,
        "working",
        "test msg",
        "RHCLOUD-1005",
        "test-repo",
        "RHCLOUD-1005",
        "jira",
    )

    row = await db.fetchrow("SELECT * FROM bot_status WHERE id = 1")
    assert row["jira_key"] == "RHCLOUD-1005"
    assert row["external_key"] == "RHCLOUD-1005"
    assert row["source_type"] == "jira"


@pytest.mark.asyncio
async def test_bot_instances_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO bot_instances (instance_id, state, message, jira_key, repo,
                                    external_key, source_type, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        """,
        "test-instance",
        "working",
        "doing stuff",
        "RHCLOUD-1006",
        "test-repo",
        "RHCLOUD-1006",
        "jira",
    )

    row = await db.fetchrow(
        "SELECT * FROM bot_instances WHERE instance_id = $1", "test-instance"
    )
    assert row["jira_key"] == "RHCLOUD-1006"
    assert row["external_key"] == "RHCLOUD-1006"
    assert row["source_type"] == "jira"


# --- memory ---


@pytest.mark.asyncio
async def test_memory_store_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO memories (category, jira_key, title, content, embedding,
                              external_key, source_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        "learning",
        "RHCLOUD-1007",
        "test memory",
        "test content",
        ZERO_VECTOR,
        "RHCLOUD-1007",
        "jira",
    )

    row = await db.fetchrow(
        "SELECT * FROM memories WHERE jira_key = $1", "RHCLOUD-1007"
    )
    assert row["external_key"] == "RHCLOUD-1007"
    assert row["source_type"] == "jira"


# --- slack ---


@pytest.mark.asyncio
async def test_slack_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO slack_notifications (jira_key, event_type, message,
                                          external_key, source_type)
        VALUES ($1, $2, $3, $4, $5)
        """,
        "RHCLOUD-1008",
        "pr_created",
        "test notification",
        "RHCLOUD-1008",
        "jira",
    )

    row = await db.fetchrow(
        "SELECT * FROM slack_notifications WHERE jira_key = $1", "RHCLOUD-1008"
    )
    assert row["external_key"] == "RHCLOUD-1008"
    assert row["source_type"] == "jira"


# --- cycles (costs) ---


@pytest.mark.asyncio
async def test_costs_dual_write(db):
    await _apply_schema(db)

    await db.execute(
        """
        INSERT INTO cycles (label, jira_key, external_key, source_type)
        VALUES ($1, $2, $3, $4)
        """,
        "test-label",
        "RHCLOUD-1009",
        "RHCLOUD-1009",
        "jira",
    )

    row = await db.fetchrow("SELECT * FROM cycles WHERE jira_key = $1", "RHCLOUD-1009")
    assert row["external_key"] == "RHCLOUD-1009"
    assert row["source_type"] == "jira"


# --- full round-trip: old params → both columns ---


@pytest.mark.asyncio
async def test_old_params_still_work(db):
    await _apply_schema(db)

    pr_url = "https://github.com/org/repo/pull/77"
    metadata = {
        "last_step": "pr_opened",
        "prs": [
            {"repo": "repo", "number": 77, "url": pr_url, "host": "github"},
        ],
    }
    artifacts = build_artifacts(77, pr_url, metadata)

    await db.execute(
        """
        INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url,
                           title, summary, metadata,
                           external_key, source_type, source_url, artifacts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        """,
        "RHCLOUD-1010",
        "pr_open",
        "test-repo",
        "bot/RHCLOUD-1010",
        77,
        pr_url,
        "Test ticket",
        "Bot opened PR",
        json.dumps(metadata),
        "RHCLOUD-1010",
        "jira",
        f"{JIRA_BASE_URL}/RHCLOUD-1010",
        json.dumps(artifacts),
    )

    task = await db.fetchrow("SELECT * FROM tasks WHERE jira_key = $1", "RHCLOUD-1010")
    # Old columns untouched
    assert task["jira_key"] == "RHCLOUD-1010"
    assert task["pr_number"] == 77
    assert task["pr_url"] == pr_url
    assert task["repo"] == "test-repo"
    assert task["status"] == "pr_open"
    # New columns populated
    assert task["external_key"] == "RHCLOUD-1010"
    assert task["source_type"] == "jira"
    assert task["source_url"] == "https://redhat.atlassian.net/browse/RHCLOUD-1010"
    parsed = json.loads(task["artifacts"])
    assert len(parsed) == 1  # deduped: pr_url == metadata.prs[0].url
    assert parsed[0]["name"] == "PR #77"

"""Tests for instance idle tracking (api_instance_get, api_instance_idle_update)."""

from datetime import UTC, datetime

import pytest
from conftest import SCHEMA_PATH

UPSERT_IDLE_SQL = """
    INSERT INTO bot_instances (instance_id, idle_consecutive_cycles, last_idle_reminder_sent_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (instance_id) DO UPDATE SET
        idle_consecutive_cycles    = $2,
        last_idle_reminder_sent_at = $3
    RETURNING *
"""


async def _apply_schema(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)


async def _insert_instance(db, instance_id, **kwargs):
    await db.execute(
        """INSERT INTO bot_instances (instance_id, state, message, repo)
           VALUES ($1, $2, $3, $4)""",
        instance_id,
        kwargs.get("state", "idle"),
        kwargs.get("message", ""),
        kwargs.get("repo", "test-repo"),
    )


@pytest.mark.asyncio
async def test_idle_columns_exist_after_schema(db):
    await _apply_schema(db)
    await _insert_instance(db, "inst-1")
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-1")
    assert row["idle_consecutive_cycles"] == 0
    assert row["last_idle_reminder_sent_at"] is None


@pytest.mark.asyncio
async def test_update_idle_state_upsert_new(db):
    await _apply_schema(db)
    ts = datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)
    row = await db.fetchrow(UPSERT_IDLE_SQL, "new-inst", 2, ts)
    assert row["instance_id"] == "new-inst"
    assert row["idle_consecutive_cycles"] == 2
    assert row["last_idle_reminder_sent_at"] == ts


@pytest.mark.asyncio
async def test_update_idle_state_upsert_existing(db):
    await _apply_schema(db)
    await _insert_instance(db, "inst-2", state="working", message="doing stuff", repo="my-repo")
    ts = datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)
    row = await db.fetchrow(UPSERT_IDLE_SQL, "inst-2", 3, ts)
    assert row["state"] == "working"
    assert row["message"] == "doing stuff"
    assert row["repo"] == "my-repo"
    assert row["idle_consecutive_cycles"] == 3
    assert row["last_idle_reminder_sent_at"] == ts


@pytest.mark.asyncio
async def test_update_idle_state_reset(db):
    await _apply_schema(db)
    ts = datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)
    await db.fetchrow(UPSERT_IDLE_SQL, "inst-3", 5, ts)
    row = await db.fetchrow(UPSERT_IDLE_SQL, "inst-3", 0, None)
    assert row["idle_consecutive_cycles"] == 0
    assert row["last_idle_reminder_sent_at"] is None


@pytest.mark.asyncio
async def test_select_single_instance(db):
    await _apply_schema(db)
    cycle_start = datetime(2026, 1, 10, 8, 0, 0, tzinfo=UTC)
    await db.execute(
        """INSERT INTO bot_instances (instance_id, state, message, external_key, source_type, repo, cycle_start)
           VALUES ($1, $2, $3, $4, $5, $6, $7)""",
        "inst-4",
        "idle",
        "hello",
        "REHOR-25",
        "jira",
        "test-repo",
        cycle_start,
    )
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-4")
    assert row is not None
    assert row["instance_id"] == "inst-4"
    assert row["state"] == "idle"
    assert row["message"] == "hello"
    assert row["external_key"] == "REHOR-25"
    assert row["source_type"] == "jira"
    assert row["repo"] == "test-repo"
    assert row["cycle_start"] == cycle_start
    assert row["idle_consecutive_cycles"] == 0
    assert row["last_idle_reminder_sent_at"] is None
    assert row["updated_at"] is not None


@pytest.mark.asyncio
async def test_select_nonexistent_instance(db):
    await _apply_schema(db)
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "unknown")
    assert row is None

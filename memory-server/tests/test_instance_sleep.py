"""Tests for the instance last_seen column (schema and _instance_row serialization)."""

from datetime import UTC, datetime

import pytest
from bot_memory_server.api import _instance_row
from conftest import SCHEMA_PATH


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
async def test_last_seen_column_exists(db):
    await _apply_schema(db)
    await _insert_instance(db, "inst-1")
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-1")
    assert row["last_seen"] is None


@pytest.mark.asyncio
async def test_last_seen_in_instance_row(db):
    await _apply_schema(db)
    ts = datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC)
    await db.execute(
        """INSERT INTO bot_instances (instance_id, state, message, repo, last_seen)
           VALUES ($1, $2, $3, $4, $5)""",
        "inst-3",
        "idle",
        "",
        "test-repo",
        ts,
    )
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-3")
    result = _instance_row(row)
    assert result["last_seen"] == ts.isoformat()


@pytest.mark.asyncio
async def test_last_seen_null_when_not_set(db):
    await _apply_schema(db)
    await _insert_instance(db, "inst-4")
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-4")
    result = _instance_row(row)
    assert result["last_seen"] is None


@pytest.mark.asyncio
async def test_last_seen_schema_migration_idempotent(db):
    schema = SCHEMA_PATH.read_text()
    await db.execute(schema)
    await db.execute(schema)
    await _insert_instance(db, "inst-5")
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-5")
    assert row["last_seen"] is None

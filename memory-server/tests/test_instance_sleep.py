"""Tests that last_seen is dropped from bot_instances (schema and API)."""

import pytest
from bot_memory_server.api import _instance_row
from conftest import SCHEMA_PATH

LAST_SEEN_EXISTS_SQL = """
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'bot_instances' AND column_name = 'last_seen'
    )
"""


async def _apply_schema(db):
    await db.execute(SCHEMA_PATH.read_text())


@pytest.mark.asyncio
async def test_last_seen_column_absent_after_schema(db):
    await _apply_schema(db)
    assert await db.fetchval(LAST_SEEN_EXISTS_SQL) is False


@pytest.mark.asyncio
async def test_schema_drops_existing_last_seen_column(db):
    await _apply_schema(db)
    await db.execute("ALTER TABLE bot_instances ADD COLUMN last_seen TIMESTAMPTZ")
    await _apply_schema(db)
    assert await db.fetchval(LAST_SEEN_EXISTS_SQL) is False


@pytest.mark.asyncio
async def test_instance_row_omits_last_seen(db):
    await _apply_schema(db)
    await db.execute(
        """INSERT INTO bot_instances (instance_id, state, message, repo)
           VALUES ($1, $2, $3, $4)""",
        "inst-1",
        "idle",
        "",
        "test-repo",
    )
    row = await db.fetchrow("SELECT * FROM bot_instances WHERE instance_id = $1", "inst-1")
    result = _instance_row(row)
    assert "last_seen" not in result

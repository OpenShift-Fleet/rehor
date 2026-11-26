import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio

DB_CONFIG = {
    "host": os.getenv("PGSQL_HOSTNAME", "localhost"),
    "port": int(os.getenv("PGSQL_PORT", "5432")),
    "user": os.getenv("PGSQL_USER", "devbot_test"),
    "password": os.getenv("PGSQL_PASSWORD", "devbot_test"),
    "database": os.getenv("PGSQL_DATABASE", "devbot_migration_test"),
}

SCHEMA_PATH = Path(__file__).parent.parent / "bot_memory_server" / "schema.sql"

# Real-database tests are strictly opt-in: the db fixture below is destructive
# (drops all public tables). They run only with REHOR_REAL_DATABASE_TESTS=1 and
# PGSQL_* pointing at a disposable database (CI sets both).
requires_real_database = pytest.mark.skipif(
    os.environ.get("REHOR_REAL_DATABASE_TESTS") != "1",
    reason="opt-in: set REHOR_REAL_DATABASE_TESTS=1 and point PGSQL_* at a disposable database "
    "(the db fixture drops all public tables)",
)


class SingleConnectionPool:
    """Pool-shaped adapter over one asyncpg connection, mirroring test_task_outcomes."""

    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn

    async def fetchrow(self, query, *args):
        return await self.conn.fetchrow(query, *args)

    async def fetch(self, query, *args):
        return await self.conn.fetch(query, *args)


# Shared task-document test fixtures (mocked pool fakes build on these).
NOW = datetime(2026, 11, 26, 12, 0, tzinfo=UTC)
TASK_ROW = {"id": 42}


def document_row(name="bundle", revision=1, data='{"k": "v"}', id=7):
    return {"id": id, "name": name, "data": data, "revision": revision, "created_at": NOW, "updated_at": NOW}


@pytest_asyncio.fixture
async def db():
    conn = await asyncpg.connect(**DB_CONFIG)
    tables = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    for t in tables:
        await conn.execute(f"DROP TABLE IF EXISTS {t['tablename']} CASCADE")
    await conn.execute("DROP EXTENSION IF EXISTS vector CASCADE")
    yield conn
    await conn.close()

import os
from pathlib import Path

import asyncpg
import pytest_asyncio

DB_CONFIG = {
    "host": os.getenv("PGSQL_HOSTNAME", "localhost"),
    "port": int(os.getenv("PGSQL_PORT", "5432")),
    "user": os.getenv("PGSQL_USER", "devbot_test"),
    "password": os.getenv("PGSQL_PASSWORD", "devbot_test"),
    "database": os.getenv("PGSQL_DATABASE", "devbot_migration_test"),
}

SCHEMA_PATH = Path(__file__).parent.parent / "bot_memory_server" / "schema.sql"


@pytest_asyncio.fixture
async def db():
    conn = await asyncpg.connect(**DB_CONFIG)
    tables = await conn.fetch("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    for t in tables:
        await conn.execute(f"DROP TABLE IF EXISTS {t['tablename']} CASCADE")
    await conn.execute("DROP EXTENSION IF EXISTS vector CASCADE")
    yield conn
    await conn.close()

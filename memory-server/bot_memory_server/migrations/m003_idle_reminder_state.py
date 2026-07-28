"""Migration 003: Add idle reminder tracking columns to bot_instances.

Additive only — safe to run multiple times (uses IF NOT EXISTS).

Usage:
    python -m bot_memory_server.migrations.m003_idle_reminder_state
"""

import asyncio
import os

import asyncpg


def _build_dsn() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    host = os.environ.get("PGSQL_HOSTNAME", "localhost")
    port = os.environ.get("PGSQL_PORT", "5432")
    user = os.environ.get("PGSQL_USER", "devbot_test")
    password = os.environ.get("PGSQL_PASSWORD", "devbot_test")
    database = os.environ.get("PGSQL_DATABASE", "devbot_migration_test")
    return f"postgresql://{user}:{password}@{host}:{port}/{database}"


async def run_migration(conn: asyncpg.Connection) -> dict:
    stats = {}

    await conn.execute(
        "ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS idle_consecutive_cycles INTEGER NOT NULL DEFAULT 0"
    )
    stats["idle_consecutive_cycles"] = "added"

    await conn.execute("ALTER TABLE bot_instances ADD COLUMN IF NOT EXISTS last_idle_reminder_sent_at TIMESTAMPTZ")
    stats["last_idle_reminder_sent_at"] = "added"

    return stats


async def main():
    dsn = _build_dsn()
    conn = await asyncpg.connect(dsn)
    try:
        stats = await run_migration(conn)
        print("Migration 003 complete:")
        for key, val in stats.items():
            print(f"  {key}: {val}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

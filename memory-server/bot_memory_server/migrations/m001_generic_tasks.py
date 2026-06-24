"""Migration 001: Add generic task system columns and backfill from jira_key.

Additive only — no columns removed, no constraints changed.
Idempotent — safe to run multiple times (skips rows where external_key is already set).

Usage:
    python -m bot_memory_server.migrations.m001_generic_tasks
"""

import asyncio
import json
import os
from pathlib import Path

import asyncpg

from ..artifacts import JIRA_BASE_URL, build_artifacts

SCHEMA_PATH = Path(__file__).parent.parent / "schema.sql"

SIMPLE_TABLES = [
    "bot_status",
    "bot_instances",
    "cycles",
    "slack_notifications",
    "memories",
]


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
    schema = SCHEMA_PATH.read_text()
    await conn.execute(schema)

    stats = {"tasks": 0}

    rows = await conn.fetch(
        "SELECT id, jira_key, pr_number, pr_url, metadata "
        "FROM tasks WHERE external_key IS NULL AND jira_key IS NOT NULL"
    )
    for row in rows:
        meta = row["metadata"]
        if isinstance(meta, str):
            meta = json.loads(meta)

        artifacts = build_artifacts(row["pr_number"], row["pr_url"], meta)
        source_url = f"{JIRA_BASE_URL}/{row['jira_key']}" if row["jira_key"] else None

        await conn.execute(
            "UPDATE tasks SET external_key = $1, source_type = $2, source_url = $3, artifacts = $4 WHERE id = $5",
            row["jira_key"],
            "jira",
            source_url,
            json.dumps(artifacts),
            row["id"],
        )
        stats["tasks"] += 1

    # Backfill cycle_runs.task_id where NULL but progress has a matching task key
    cr_result = await conn.execute(
        """
        UPDATE cycle_runs cr
        SET task_id = t.id
        FROM tasks t
        WHERE cr.task_id IS NULL
          AND t.external_key = COALESCE(cr.progress->>'external_key', cr.progress->>'jira_key')
          AND t.source_type = 'jira'
          AND COALESCE(cr.progress->>'external_key', cr.progress->>'jira_key') IS NOT NULL
        """
    )
    stats["cycle_runs"] = int(cr_result.split()[-1]) if cr_result else 0

    for table in SIMPLE_TABLES:
        has_jira_key = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = $1 AND column_name = 'jira_key'"
            ")",
            table,
        )
        if not has_jira_key:
            stats[table] = 0
            continue

        result = await conn.execute(
            f"UPDATE {table} SET external_key = jira_key, source_type = 'jira' "  # noqa: S608
            f"WHERE external_key IS NULL AND jira_key IS NOT NULL"
        )
        count = int(result.split()[-1]) if result else 0
        stats[table] = count

    return stats


async def main():
    dsn = _build_dsn()
    conn = await asyncpg.connect(dsn)
    try:
        stats = await run_migration(conn)
        print("Migration 001 complete:")
        for table, count in stats.items():
            print(f"  {table}: {count} rows backfilled")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

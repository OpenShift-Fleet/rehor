"""Migration 002: Drop legacy columns (jira_key, pr_number, pr_url) and add constraints.

Final stage of the generic task system migration.
Validates all data is backfilled before dropping — aborts if not.

Usage:
    python -m bot_memory_server.migrations.m002_drop_legacy_columns
"""

import asyncio
import os

import asyncpg

TABLES_WITH_JIRA_KEY = [
    "tasks",
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


async def _validate(conn: asyncpg.Connection) -> list[str]:
    """Check that all data is backfilled. Returns list of errors."""
    errors = []

    for table in TABLES_WITH_JIRA_KEY:
        has_col = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = $1 AND column_name = 'jira_key'"
            ")",
            table,
        )
        if not has_col:
            continue

        has_ext = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = $1 AND column_name = 'external_key'"
            ")",
            table,
        )
        if not has_ext:
            errors.append(f"{table}: missing external_key column — run m001 first")
            continue

        orphans = await conn.fetchval(
            f"SELECT COUNT(*) FROM {table} WHERE jira_key IS NOT NULL AND external_key IS NULL",  # noqa: S608
        )
        if orphans:
            errors.append(f"{table}: {orphans} rows with jira_key but no external_key")

    null_ext = await conn.fetchval("SELECT COUNT(*) FROM tasks WHERE external_key IS NULL")
    if null_ext:
        errors.append(f"tasks: {null_ext} rows with NULL external_key")

    null_src = await conn.fetchval("SELECT COUNT(*) FROM tasks WHERE source_type IS NULL")
    if null_src:
        errors.append(f"tasks: {null_src} rows with NULL source_type")

    return errors


async def run_migration(conn: asyncpg.Connection) -> dict:
    errors = await _validate(conn)
    if errors:
        raise RuntimeError("Pre-drop validation failed:\n  " + "\n  ".join(errors))

    stats = {}

    for table in TABLES_WITH_JIRA_KEY:
        has_col = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = $1 AND column_name = 'jira_key'"
            ")",
            table,
        )
        if has_col:
            await conn.execute(f"ALTER TABLE {table} DROP COLUMN jira_key")  # noqa: S608
            stats[f"{table}.jira_key"] = "dropped"

    for col in ("pr_number", "pr_url"):
        has_col = await conn.fetchval(
            "SELECT EXISTS ("
            "  SELECT 1 FROM information_schema.columns "
            "  WHERE table_name = 'tasks' AND column_name = $1"
            ")",
            col,
        )
        if has_col:
            await conn.execute(f"ALTER TABLE tasks DROP COLUMN {col}")
            stats[f"tasks.{col}"] = "dropped"

    await conn.execute("ALTER TABLE tasks ALTER COLUMN external_key SET NOT NULL")
    await conn.execute("ALTER TABLE tasks ALTER COLUMN source_type SET NOT NULL")
    stats["tasks.external_key"] = "NOT NULL"
    stats["tasks.source_type"] = "NOT NULL"

    has_constraint = await conn.fetchval(
        "SELECT EXISTS ("
        "  SELECT 1 FROM information_schema.table_constraints "
        "  WHERE table_name = 'tasks' AND constraint_name = 'tasks_external_key_source_type_unique'"
        ")"
    )
    if not has_constraint:
        await conn.execute(
            "ALTER TABLE tasks ADD CONSTRAINT tasks_external_key_source_type_unique UNIQUE(external_key, source_type)"
        )
        stats["unique_constraint"] = "added"

    # Clean metadata.prs where artifacts already populated
    result = await conn.execute(
        "UPDATE tasks SET metadata = metadata - 'prs' WHERE metadata ? 'prs' AND artifacts != '[]'::jsonb"
    )
    cleaned = int(result.split()[-1]) if result else 0
    stats["metadata_prs_cleaned"] = cleaned

    return stats


async def main():
    dsn = _build_dsn()
    conn = await asyncpg.connect(dsn)
    try:
        stats = await run_migration(conn)
        print("Migration 002 complete:")
        for key, val in stats.items():
            print(f"  {key}: {val}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())

import os
from pathlib import Path

import asyncpg
from pgvector.asyncpg import register_vector

_pool: asyncpg.Pool | None = None


def _build_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    host = os.environ.get("PGSQL_HOSTNAME", "localhost")
    port = os.environ.get("PGSQL_PORT", "5432")
    user = os.environ["PGSQL_USER"]
    password = os.environ["PGSQL_PASSWORD"]
    database = os.environ["PGSQL_DATABASE"]
    sslmode = os.environ.get("PGSQL_SSLMODE")
    base = f"postgresql://{user}:{password}@{host}:{port}/{database}"
    if sslmode:
        base += f"?sslmode={sslmode}"
    return base


async def init_pool() -> asyncpg.Pool:
    global _pool
    url = _build_database_url()

    # First, run schema (creates the vector extension) using a direct connection
    conn = await asyncpg.connect(url)
    from .pull_requests import seed_pull_requests

    schema = (Path(__file__).parent / "schema.sql").read_text()
    try:
        await conn.execute(schema)
        async with conn.transaction():
            first_run = await conn.fetchval(
                "INSERT INTO search_backfills (name) VALUES ('pull-request-identities-v1') "
                "ON CONFLICT DO NOTHING RETURNING name"
            )
            if first_run:
                await seed_pull_requests(conn)
                await conn.execute(
                    "DELETE FROM pull_requests pr USING tasks t WHERE t.id = pr.task_id "
                    "AND NOT task_references_pr(t.metadata, t.artifacts, pr.host, pr.repository, "
                    "pr.number, pr.url, t.source_url)"
                )
    finally:
        await conn.close()

    # Now create the pool — _init_conn can register the vector type safely
    _pool = await asyncpg.create_pool(url, min_size=2, max_size=10, init=_init_conn)
    return _pool


async def _init_conn(conn: asyncpg.Connection):
    await register_vector(conn)


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool not initialized")
    return _pool


async def close_pool():
    global _pool
    if _pool:
        await _pool.close()
        _pool = None

"""Populated pre-search schema upgrades and bounded identity backfill."""

from pathlib import Path

import pytest
from bot_memory_server import db as database
from bot_memory_server.server import build_app
from conftest import DB_CONFIG
from httpx import ASGITransport, AsyncClient


def configure_database(monkeypatch):
    monkeypatch.setenv(
        "DATABASE_URL",
        f"postgresql://{DB_CONFIG['user']}:{DB_CONFIG['password']}@{DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['database']}",
    )
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "upgrade-test-token")


@pytest.mark.asyncio
async def test_populated_upstream_schema_upgrades_without_losing_work(db, monkeypatch):
    await db.execute("DROP EXTENSION IF EXISTS pg_trgm CASCADE")
    await db.execute((Path(__file__).parent / "fixtures/master-before-task-search.sql").read_text())
    await db.execute("""INSERT INTO tasks (external_key,source_type,title,repo,metadata)
        VALUES ('UPGRADE-1','jira','Existing quasar work','org/rehor',
            '{"prs":[{"url":"https://github.com/org/rehor/pull/1"}]}');
        INSERT INTO tasks (external_key,source_type,title,status,repo,archived_at)
        VALUES ('UPGRADE-2','jira','Archived quasar work','archived','org/rehor',NOW());
        INSERT INTO bot_instances (instance_id) VALUES ('upgrade-bot');
        INSERT INTO cycle_runs (task_id,cycle_type,instance_id) SELECT id,'task_work','upgrade-bot' FROM tasks;
    """)
    before = await db.fetchval("SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t")
    configure_database(monkeypatch)
    try:
        await database.init_pool()
        assert await db.fetchval("SELECT count(*) FROM pull_requests") == 1
        assert await db.fetchval("SELECT count(*) FROM pull_request_labels") == 0
        assert await db.fetchval("SELECT jsonb_agg(to_jsonb(t)-'search_bigrams' ORDER BY id) FROM tasks t") == before
        assert await db.fetchval("SELECT count(*) FROM cycle_runs") == 2
        app, _ = build_app()
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            active = (await client.get("/api/tasks", params={"q": "quasar", "exclude_status": "archived"})).json()
            archived = (await client.get("/api/tasks", params={"q": "quasar", "status": "archived"})).json()
            assert active["total"] == 1 and active["items"][0]["external_key"] == "UPGRADE-1"
            assert archived["total"] == 1 and archived["items"][0]["external_key"] == "UPGRADE-2"
            assert (await client.get("/api/tasks", params={"q": "up"})).json()["total"] == 2
            result = await client.post(
                "/api/internal/pull-requests",
                headers={"Authorization": "Bearer upgrade-test-token"},
                json={
                    "external_key": "UPGRADE-1",
                    "source_type": "jira",
                    "host": "github",
                    "repository": "org/rehor",
                    "number": 1,
                    "url": "https://github.com/org/rehor/pull/1",
                    "labels": ["upgrade-label"],
                },
            )
            assert result.status_code == 200
            assert (await client.get("/api/tasks", params={"q": "upgrade-label"})).json()["total"] == 1
            await database.close_pool()
            await database.init_pool()
            assert (await client.get("/api/tasks", params={"q": "upgrade-label"})).json()["total"] == 1
    finally:
        await database.close_pool()


@pytest.mark.asyncio
async def test_identity_backfill_does_not_repeat_on_every_startup(db, monkeypatch):
    configure_database(monkeypatch)
    try:
        await database.init_pool()
        await db.execute("""INSERT INTO tasks (external_key,source_type,metadata)
            VALUES ('LATER-A','jira','{"prs":[{"url":"https://github.com/org/rehor/pull/7"}]}'),
                   ('LATER-B','jira','{"prs":[{"url":"https://github.com/org/rehor/pull/7"}]}');""")
        await database.close_pool()
        await database.init_pool()
        app, _ = build_app()
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            response = await client.post(
                "/api/internal/pull-requests",
                headers={"Authorization": "Bearer upgrade-test-token"},
                json={
                    "external_key": "LATER-B",
                    "source_type": "jira",
                    "host": "github",
                    "repository": "org/rehor",
                    "number": 7,
                    "url": "https://github.com/org/rehor/pull/7",
                    "labels": ["later-label"],
                },
            )
            assert response.status_code == 200
            assert (await client.get("/api/tasks", params={"q": "later-label"})).json()["items"][0][
                "external_key"
            ] == "LATER-B"
    finally:
        await database.close_pool()

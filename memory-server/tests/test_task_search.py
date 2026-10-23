"""Global search behavior through the registered HTTP API and real PostgreSQL."""

import asyncpg
import pytest
import pytest_asyncio
from bot_memory_server import db as database
from bot_memory_server.server import build_app
from conftest import DB_CONFIG, SCHEMA_PATH
from httpx import ASGITransport, AsyncClient


@pytest_asyncio.fixture
async def search_client(db, monkeypatch):
    await db.execute(SCHEMA_PATH.read_text())
    async with asyncpg.create_pool(**DB_CONFIG, min_size=1, max_size=2) as pool:
        monkeypatch.setattr(database, "_pool", pool)
        monkeypatch.delenv("JIRA_URL", raising=False)
        app, _ = build_app()
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield client


@pytest.mark.asyncio
async def test_task_list_search_filters_all_pages_and_statuses_before_pagination(search_client, db):
    rows = await db.fetch("""
        INSERT INTO tasks (external_key, source_type, title, status, instance_id, created_at)
        SELECT 'FILTER-' || n, 'jira', 'Pagination needle ' || n,
            (CASE WHEN n <= 30 THEN 'in_progress' WHEN n <= 60 THEN 'done' ELSE 'archived' END)::task_status,
            CASE WHEN n = 62 THEN 'other-bot' ELSE 'demo-alpha' END, '2026-10-22T10:00:00Z'::timestamptz
        FROM generate_series(1,62) n RETURNING id
    """)
    await db.execute("INSERT INTO tasks (external_key, source_type, title) VALUES ('NOISE-1','jira','Unrelated task')")
    first = (await search_client.get("/api/tasks", params={"q": " NEEDLE ", "limit": 20})).json()
    assert first["total"] == 62
    assert len(first["items"]) == 20
    assert any(task["status"] == "archived" for task in first["items"])
    last = (await search_client.get("/api/tasks", params={"q": "needle", "limit": 20, "offset": 60})).json()
    assert last["total"] == 62
    assert [task["id"] for task in last["items"]] == [rows[1]["id"], rows[0]["id"]]
    done = (
        await search_client.get("/api/tasks", params={"q": "needle", "status": "done", "limit": 20, "offset": 20})
    ).json()
    assert done["total"] == 30 and len(done["items"]) == 10
    assert all(task["status"] == "done" for task in done["items"])
    assert (await search_client.get("/api/tasks", params={"q": "needle", "status": "in_progress"})).json()[
        "total"
    ] == 30
    assert (await search_client.get("/api/tasks", params={"q": "needle", "status": "archived"})).json()["total"] == 2
    assert (await search_client.get("/api/tasks", params={"q": "needle", "exclude_status": "archived"})).json()[
        "total"
    ] == 60
    assert (await search_client.get("/api/tasks", params={"q": "needle", "instance_id": "demo-alpha"})).json()[
        "total"
    ] == 61
    assert (await search_client.get("/api/tasks", params={"q": "missing"})).json()["items"] == []
    combined = await search_client.get("/api/tasks", params={"q": "needle", "status": "done", "exclude_status": "done"})
    assert combined.json()["total"] == 0
    archived_scope = (
        await search_client.get("/api/tasks", params={"q": "needle", "status": "archived", "instance_id": "demo-alpha"})
    ).json()
    assert archived_scope["total"] == 1 and archived_scope["items"][0]["id"] == rows[60]["id"]
    active_scope = (
        await search_client.get(
            "/api/tasks", params={"q": "needle", "exclude_status": "archived", "instance_id": "demo-alpha"}
        )
    ).json()
    assert active_scope["total"] == 60


@pytest.mark.asyncio
@pytest.mark.parametrize("title", ["İzmir", "ΚΟΣΜΟΣ", "İN", "ΟΣ"])
async def test_task_search_matches_identical_unicode_titles(search_client, db, title):
    task_id = await db.fetchval(
        "INSERT INTO tasks (external_key, source_type, title) VALUES ('UNICODE-1', 'jira', $1) RETURNING id",
        title,
    )
    response = await search_client.get("/api/tasks", params={"q": title})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [task["id"] for task in response.json()["items"]] == [task_id]


@pytest.mark.asyncio
@pytest.mark.parametrize("label", ["İzmir", "ΚΟΣΜΟΣ", "İN", "ΟΣ", "İ%_"])
async def test_task_search_matches_unicode_labels_and_literal_wildcards(search_client, db, monkeypatch, label):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    response = await search_client.post(
        "/api/internal/pull-requests",
        json=snapshot(labels=[label]),
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    await db.execute("INSERT INTO tasks (external_key, source_type, title) VALUES ('DECOY-1', 'jira', 'Ixx')")
    found = await search_client.get("/api/tasks", params={"q": label})
    assert found.status_code == 200
    assert found.json()["total"] == 1
    assert [task["external_key"] for task in found.json()["items"]] == ["TEST-1"]


@pytest.mark.asyncio
async def test_archive_search_and_clear_keep_the_same_order(search_client, db):
    await db.execute("""INSERT INTO tasks (external_key,source_type,title,status,created_at,last_addressed)
        VALUES ('ORDER-1','jira','Needle older creation','archived','2020-01-01','2026-01-01'),
               ('ORDER-2','jira','Needle newer creation','archived','2026-01-01','2020-01-01')""")
    for query in (None, "needle"):
        params = {"status": "archived", "limit": 1}
        if query:
            params["q"] = query
        first = (await search_client.get("/api/tasks", params=params)).json()
        assert first["total"] == 2 and first["items"][0]["external_key"] == "ORDER-1"
        second = (await search_client.get("/api/tasks", params={**params, "offset": 1})).json()
        assert second["items"][0]["external_key"] == "ORDER-2"


@pytest.mark.asyncio
async def test_task_list_search_matches_labels_bot_and_literal_fields_without_duplicates(search_client, db):
    first = await db.fetchval(
        """INSERT INTO tasks (external_key,source_type,title,summary,repo,instance_id,status)
        VALUES ('QUERY-101','jira',$1,'Summary-only comet','org/service','review-bot','archived') RETURNING id""",
        r"Literal %_ and \ symbols",
    )
    second = await db.fetchval(
        "INSERT INTO tasks (external_key,source_type,title) VALUES ('org/repo#88','github','Other') RETURNING id"
    )
    await db.execute(
        """INSERT INTO pull_requests (task_id,host,repository,number,url)
        VALUES ($1,'github','org/repo',1,'https://github.com/org/repo/pull/1'),
               ($1,'gitlab','org/repo',2,'https://gitlab.example/org/repo/-/merge_requests/2')""",
        first,
    )
    await db.execute(
        "INSERT INTO pull_request_labels (pull_request_id,label) SELECT id,'awaiting-review' FROM pull_requests"
    )
    for q in ("awaiting-review", "REVIEW-BOT", "review", "%_", r"\ symbols", "summary-only comet", "org/service"):
        result = (await search_client.get("/api/tasks", params={"q": q})).json()
        assert result["total"] == 1
        assert [task["id"] for task in result["items"]] == [first]
    assert (await search_client.get("/api/tasks", params={"q": "org/repo#88"})).json()["items"][0]["id"] == second
    for params in (
        {"q": "QUERY-101 Literal"},
        {"q": "review", "instance_id": "other-bot"},
        {"q": "review", "task_id": second},
    ):
        assert (await search_client.get("/api/tasks", params=params)).json()["total"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"q": ""},
        {"q": "r"},
        {"q": "r" * 201},
        {"q": "aa\x00b"},
        {"q": "review", "limit": "bad"},
        {"q": "review", "limit": 0},
        {"q": "review", "offset": -1},
        {"q": "review", "status": "invalid"},
    ],
)
async def test_task_list_search_rejects_invalid_inputs(search_client, params):
    assert (await search_client.get("/api/tasks", params=params)).status_code == 400


@pytest.mark.asyncio
async def test_task_search_uses_indexes_for_non_jira_text_and_literal_short_queries(search_client, db, monkeypatch):
    import json

    from benchmark_search import MeasuredPool, indexes

    await db.execute("""INSERT INTO tasks (external_key,source_type,title)
        SELECT 'INDEX-'||n, 'github', 'Filler' FROM generate_series(1,5000) n;
        UPDATE tasks SET title='Selective-quasar %_ 🪷a İX ΟΣ' WHERE external_key='INDEX-2500';
        ANALYZE tasks;""")
    measured = MeasuredPool(database.get_pool())
    monkeypatch.setattr(database, "_pool", measured)
    for query, expected_index in [
        ("selective-quasar", "idx_tasks_search_fields_trgm"),
        ("🪷a", "idx_tasks_search_bigrams"),
        ("%_", "idx_tasks_search_bigrams"),
        ("İX", "idx_tasks_search_bigrams"),
        ("ΟΣ", "idx_tasks_search_bigrams"),
    ]:
        measured.statements.clear()
        response = await search_client.get("/api/tasks", params={"q": query, "exclude_status": "archived"})
        assert response.json()["total"] == 1
        assert response.json()["items"][0]["external_key"] == "INDEX-2500"
        used_indexes = set()
        async with db.transaction():
            await db.execute("SET LOCAL enable_seqscan=off")
            for sql, args in measured.statements.items():
                plan = json.loads(await db.fetchval("EXPLAIN (FORMAT JSON) " + sql, *args))[0]
                used_indexes.update(indexes(plan["Plan"]))
        assert expected_index in used_indexes


@pytest.mark.asyncio
async def test_task_search_does_not_contact_remote_sources(search_client, db, monkeypatch):
    import socket

    await db.execute("INSERT INTO tasks (external_key,source_type,title) VALUES ('LOCAL-1','jira','Local-only lookup')")

    def no_connect(*args, **kwargs):
        raise AssertionError("Task search must not open remote connections")

    monkeypatch.setattr(socket.socket, "connect", no_connect)
    assert (await search_client.get("/api/tasks", params={"q": "local-only"})).json()["total"] == 1


@pytest.mark.asyncio
async def test_task_deep_link_resolves_exact_record_without_page_scanning(search_client, db):
    rows = await db.fetch(
        "INSERT INTO tasks (external_key, source_type) SELECT 'LINK-' || n, 'jira' FROM generate_series(1, 25) n RETURNING id"
    )
    task_id = rows[-1]["id"]
    response = await search_client.get("/api/tasks", params={"task_id": task_id})
    assert response.status_code == 200
    assert response.json()["total"] == 1
    assert [task["id"] for task in response.json()["items"]] == [task_id]
    await db.execute("UPDATE tasks SET status='archived' WHERE id=$1", task_id)
    result = (await search_client.get("/api/tasks", params={"q": "LINK-25"})).json()["items"][0]
    assert result["id"] == task_id
    assert result["status"] == "archived"
    assert (await search_client.get("/api/tasks", params={"task_id": task_id, "exclude_status": "archived"})).json()[
        "total"
    ] == 0
    assert (await search_client.get("/api/tasks", params={"task_id": task_id, "instance_id": "other-bot"})).json()[
        "total"
    ] == 0
    assert (await search_client.get("/api/tasks", params={"task_id": 999999})).json()["items"] == []
    for invalid in ("abc", "0", "-1"):
        assert (await search_client.get("/api/tasks", params={"task_id": invalid})).status_code == 400


@pytest.mark.asyncio
async def test_cycle_deep_link_resolves_exact_old_run_with_instance_scope(search_client, db):
    task_id = await db.fetchval(
        "INSERT INTO tasks (external_key, source_type) VALUES ('CYCLE-LINK', 'jira') RETURNING id"
    )
    rows = await db.fetch(
        """
        INSERT INTO cycle_runs (task_id, instance_id, created_at)
        SELECT $1, 'demo-alpha', NOW() - n * INTERVAL '1 minute'
        FROM generate_series(1, 60) n RETURNING id
    """,
        task_id,
    )
    old_id = rows[-1]["id"]
    first_page = (await search_client.get("/api/cycle-runs", params={"task_id": task_id})).json()
    assert old_id not in [run["id"] for run in first_page["items"]]
    exact = await search_client.get("/api/cycle-runs", params={"run_id": old_id, "task_id": task_id, "limit": 1})
    assert exact.status_code == 200
    assert exact.json()["total"] == 1
    assert [run["id"] for run in exact.json()["items"]] == [old_id]
    assert (await search_client.get("/api/cycle-runs", params={"run_id": old_id, "instance_id": "other-bot"})).json()[
        "items"
    ] == []
    for invalid in ("0", "-1", "abc", "2147483648"):
        for field in ("run_id", "task_id"):
            assert (await search_client.get("/api/cycle-runs", params={field: invalid})).status_code == 400


@pytest.mark.asyncio
async def test_task_cycle_history_resolves_legacy_keys_without_mixing_tasks(search_client, db):
    jira = await db.fetchval(
        "INSERT INTO tasks (external_key, source_type) VALUES ('CYCLE-ASSOCIATION', 'jira') RETURNING id"
    )
    github = await db.fetchval(
        "INSERT INTO tasks (external_key, source_type) VALUES ('CYCLE-ASSOCIATION', 'github') RETURNING id"
    )
    direct = await db.fetchval("INSERT INTO cycle_runs (task_id, instance_id) VALUES ($1, 'alpha') RETURNING id", jira)
    legacy = await db.fetchval(
        "INSERT INTO cycle_runs (progress, instance_id) VALUES ('{\"external_key\":\"CYCLE-ASSOCIATION\"}', 'alpha') RETURNING id"
    )
    other = await db.fetchval(
        "INSERT INTO cycle_runs (progress, instance_id) VALUES ('{\"external_key\":\"OTHER\"}', 'alpha') RETURNING id"
    )
    idle = await db.fetchval("INSERT INTO cycle_runs (progress, instance_id) VALUES ('{}', 'alpha') RETURNING id")
    git_run = await db.fetchval(
        "INSERT INTO cycle_runs (task_id, instance_id) VALUES ($1, 'alpha') RETURNING id", github
    )
    result = (await search_client.get("/api/cycle-runs", params={"task_id": jira})).json()
    assert {run["id"] for run in result["items"]} == {direct, legacy}
    assert result["total"] == 2
    groups = (await search_client.get("/api/cycle-runs/by-task")).json()["items"]
    by_id = {group["task_id"]: group for group in groups if group["task_id"] is not None}
    assert by_id[jira]["cycle_count"] == 2
    assert by_id[github]["cycle_count"] == 1
    assert [
        run["id"] for run in (await search_client.get("/api/cycle-runs", params={"task_id": github})).json()["items"]
    ] == [git_run]
    assert (await search_client.get("/api/cycle-runs", params={"task_id": jira, "instance_id": "other"})).json()[
        "items"
    ] == []
    assert [
        run["id"]
        for run in (
            await search_client.get("/api/cycle-runs", params={"task_id": "none", "external_key": "OTHER"})
        ).json()["items"]
    ] == [other]
    assert [
        run["id"]
        for run in (await search_client.get("/api/cycle-runs", params={"task_id": "none", "external_key": ""})).json()[
            "items"
        ]
    ] == [idle]
    assert (await search_client.get("/api/cycle-runs", params={"external_key": "%_"})).json()["total"] == 0


async def snapshot_task(db, key="TEST-1"):
    await db.execute(
        "INSERT INTO tasks (external_key, source_type, metadata) VALUES ($1, 'jira', $2::jsonb)",
        key,
        '{"prs":[{"url":"https://github.com/org/rehor/pull/1"}]}',
    )


def snapshot(**changes):
    return {
        "external_key": "TEST-1",
        "source_type": "jira",
        "host": "github",
        "repository": "org/rehor",
        "number": 1,
        "url": "https://github.com/org/rehor/pull/1",
        "labels": ["awaiting-review", "bug"],
        **changes,
    }


@pytest.mark.asyncio
async def test_authenticated_snapshots_replace_labels_without_changing_task_progress(search_client, db, monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    before = dict(await db.fetchrow("SELECT * FROM tasks WHERE external_key = 'TEST-1'"))
    headers = {"Authorization": "Bearer test-token"}
    for labels in (["awaiting-review", "bug", "bug"], ["ready-to-merge"], []):
        response = await search_client.post(
            "/api/internal/pull-requests", json=snapshot(labels=labels), headers=headers
        )
        assert response.status_code == 200
        assert response.json() == {"updated": True}
        found = await search_client.get("/api/tasks", params={"q": "awaiting-review"})
        assert len(found.json()["items"]) == (1 if "awaiting-review" in labels else 0)
    assert dict(await db.fetchrow("SELECT * FROM tasks WHERE external_key = 'TEST-1'")) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("secret", "headers", "status"),
    [
        (None, {}, 404),
        ("test-token", {}, 403),
        ("test-token", {"Authorization": "Bearer wrong"}, 403),
        ("test-token", {"Authorization": "Bearer test-token", "Origin": "https://dashboard.example"}, 403),
    ],
)
async def test_snapshot_write_is_disabled_or_forbidden_without_internal_credentials(
    monkeypatch, secret, headers, status
):
    if secret is None:
        monkeypatch.delenv("UPLOAD_MEMORY_PASSWORD", raising=False)
    else:
        monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", secret)
    monkeypatch.setattr(database, "_pool", None)
    app, _ = build_app()
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    assert response.status_code == status


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change",
    [
        {"labels": None},
        {"labels": [None]},
        {"labels": [""]},
        {"labels": ["x"] * 101},
        {"number": True},
        {"number": 0},
        {"url": "javascript:alert(1)"},
        {"url": "https://secret:password@github.com/org/rehor/pull/1"},
        {"repository": "../repo"},
        {"repository": "alias"},
        {"unexpected": True},
    ],
)
async def test_invalid_snapshot_preserves_previous_labels(search_client, db, monkeypatch, change):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    headers = {"Authorization": "Bearer test-token"}
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 200
    response = await search_client.post("/api/internal/pull-requests", json=snapshot(**change), headers=headers)
    assert response.status_code == 400
    response = await search_client.get("/api/tasks", params={"q": "awaiting-review"})
    assert len(response.json()["items"]) == 1


@pytest.mark.asyncio
async def test_snapshot_rejects_missing_labels_unknown_tasks_and_reassignment(search_client, db, monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    headers = {"Authorization": "Bearer test-token"}
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 404
    await snapshot_task(db)
    await snapshot_task(db, "TEST-2")
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 200
    for payload, expected in [(snapshot(external_key="TEST-2"), 409), (snapshot(source_type="github"), 404)]:
        assert (
            await search_client.post("/api/internal/pull-requests", json=payload, headers=headers)
        ).status_code == expected
    incomplete = snapshot()
    del incomplete["labels"]
    assert (
        await search_client.post("/api/internal/pull-requests", json=incomplete, headers=headers)
    ).status_code == 400
    response = await search_client.get("/api/tasks", params={"q": "awaiting-review"})
    assert response.json()["items"][0]["external_key"] == "TEST-1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "remaining_metadata", [{}, {"prs": []}, {"prs": [{"url": "https://github.com/org/rehor/pull/3"}]}]
)
async def test_removed_pr_reference_drops_labels_and_cannot_be_replayed(
    search_client, db, monkeypatch, remaining_metadata
):
    import json

    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await db.execute("""INSERT INTO tasks (external_key,source_type,metadata)
        VALUES ('TEST-1','jira','{"prs":[{"url":"https://github.com/org/rehor/pull/1"}]}'),
               ('TEST-2','jira','{"prs":[{"repo":"org/rehor","number":1}]}');""")
    headers = {"Authorization": "Bearer test-token"}
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 200
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(external_key="TEST-2"), headers=headers)
    ).status_code == 409
    await db.execute("UPDATE tasks SET metadata=metadata||'{\"unrelated\":true}'::jsonb WHERE external_key='TEST-1'")
    assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["total"] == 1
    await db.execute("UPDATE tasks SET metadata=$1::jsonb WHERE external_key='TEST-1'", json.dumps(remaining_metadata))
    assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["total"] == 0
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 409
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(external_key="TEST-2"), headers=headers)
    ).status_code == 200
    assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["items"][0][
        "external_key"
    ] == "TEST-2"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("metadata", "artifacts", "source_url"),
    [
        ({"prs": [{"repo": "rehor", "number": "01"}]}, [], None),
        ({"prs": [{"repository": "org/rehor", "number": 1, "host": "github"}]}, [], None),
        ({}, [{"type": "pull_request", "url": "https://github.com/org/rehor/pull/1/?view=files"}], None),
        ({}, [], "https://github.com/org/rehor/pull/1"),
        ({}, [], "https://github.com/org/rehor/pull/1/?view=files#comment"),
    ],
)
async def test_snapshot_respects_declared_alias_artifact_or_direct_task_reference(
    search_client, db, monkeypatch, metadata, artifacts, source_url
):
    import json

    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await db.execute(
        "INSERT INTO tasks (external_key,source_type,metadata,artifacts,source_url) VALUES ('TEST-1','jira',$1::jsonb,$2::jsonb,$3)",
        json.dumps(metadata),
        json.dumps(artifacts),
        source_url,
    )
    assert (
        await search_client.post(
            "/api/internal/pull-requests", json=snapshot(), headers={"Authorization": "Bearer test-token"}
        )
    ).status_code == 200
    assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["total"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reference",
    [{"repo": "group/sub/rehor", "number": 7}, {"url": "https://gitlab.example/group/sub/rehor/merge_requests/7#note"}],
)
async def test_gitlab_reference_and_url_variants_are_preserved(search_client, db, monkeypatch, reference):
    import json

    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await db.execute(
        "INSERT INTO tasks (external_key,source_type,metadata) VALUES ('TEST-1','jira',$1::jsonb)",
        json.dumps({"mrs": [reference]}),
    )
    response = await search_client.post(
        "/api/internal/pull-requests",
        headers={"Authorization": "Bearer test-token"},
        json=snapshot(
            host="gitlab",
            repository="group/sub/rehor",
            number=7,
            url="https://gitlab.example/group/sub/rehor/-/merge_requests/7",
        ),
    )
    assert response.status_code == 200
    assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["total"] == 1


@pytest.mark.asyncio
async def test_retired_grouped_route_is_not_exposed(search_client):
    assert (await search_client.get("/api/search", params={"q": "needle"})).status_code == 404


@pytest.mark.asyncio
async def test_snapshot_cannot_race_reference_removal(search_client, db, monkeypatch):
    import asyncio

    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    for _ in range(5):
        await db.execute(
            'UPDATE tasks SET metadata=\'{"prs":[{"repo":"org/rehor","number":1}]}\'::jsonb WHERE external_key=\'TEST-1\''
        )
        response, _ = await asyncio.gather(
            search_client.post(
                "/api/internal/pull-requests", json=snapshot(), headers={"Authorization": "Bearer test-token"}
            ),
            db.execute("UPDATE tasks SET metadata='{\"prs\":[]}'::jsonb WHERE external_key='TEST-1'"),
        )
        assert response.status_code in (200, 409)
        assert (await search_client.get("/api/tasks", params={"q": "awaiting-review"})).json()["total"] == 0


@pytest.mark.asyncio
async def test_snapshot_rolls_back_parent_and_labels_on_database_failure(search_client, db, monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    headers = {"Authorization": "Bearer test-token"}
    assert (
        await search_client.post("/api/internal/pull-requests", json=snapshot(), headers=headers)
    ).status_code == 200
    await db.execute("""
        CREATE OR REPLACE FUNCTION reject_test_label() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.label = 'explode' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_label BEFORE INSERT ON pull_request_labels
        FOR EACH ROW EXECUTE FUNCTION reject_test_label();
    """)
    with pytest.raises(asyncpg.RaiseError):
        await search_client.post(
            "/api/internal/pull-requests", json=snapshot(labels=["replacement", "explode"]), headers=headers
        )
    response = await search_client.get("/api/tasks", params={"q": "awaiting-review"})
    assert len(response.json()["items"]) == 1
    response = await search_client.get("/api/tasks", params={"q": "replacement"})
    assert response.json()["items"] == []


@pytest.mark.asyncio
async def test_concurrent_snapshots_never_mix_label_sets(search_client, db, monkeypatch):
    import asyncio

    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    await snapshot_task(db)
    headers = {"Authorization": "Bearer test-token"}
    responses = await asyncio.gather(
        *[
            search_client.post("/api/internal/pull-requests", json=snapshot(labels=labels), headers=headers)
            for labels in (["race-a", "race-b"], ["race-c", "race-d"])
        ]
    )
    assert [response.status_code for response in responses] == [200, 200]
    totals = [
        (await search_client.get("/api/tasks", params={"q": label})).json()["total"]
        for label in ("race-a", "race-b", "race-c", "race-d")
    ]
    assert totals in [[1, 1, 0, 0], [0, 0, 1, 1]]


@pytest.mark.asyncio
@pytest.mark.parametrize("gitlab_hostname", ["gitlab.example", "code.example"])
async def test_startup_seeds_metadata_without_inventing_or_replacing_labels(db, monkeypatch, gitlab_hostname):
    import json

    await db.execute(SCHEMA_PATH.read_text())
    await db.execute(
        "INSERT INTO tasks (external_key, source_type, metadata, artifacts) VALUES ('TEST-1', 'jira', $1::jsonb, $2::jsonb)",
        json.dumps(
            {
                "prs": [{"url": "https://github.com/org/rehor/pull/1", "labels": ["not-current"]}],
                "mrs": [{"url": f"https://{gitlab_hostname}/group/sub/rehor/-/merge_requests/2"}],
            }
        ),
        json.dumps([None, {"url": "javascript:alert(1)"}, {"url": "https://github.com/org/rehor/pull/1"}]),
    )
    monkeypatch.setenv(
        "DATABASE_URL",
        f"postgresql://{DB_CONFIG['user']}:{DB_CONFIG['password']}@{DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['database']}",
    )
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "test-token")
    try:
        await database.init_pool()
        assert await db.fetchval("SELECT count(*) FROM pull_requests") == 2
        app, _ = build_app()
        async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
            assert (await client.get("/api/tasks", params={"q": "not-current"})).json()["items"] == []
            assert (
                await client.post(
                    "/api/internal/pull-requests", json=snapshot(), headers={"Authorization": "Bearer test-token"}
                )
            ).status_code == 200
            # Exercise the real startup path again with an existing snapshot.
            await database.close_pool()
            await database.init_pool()
            found = await client.get("/api/tasks", params={"q": "awaiting-review"})
            assert len(found.json()["items"]) == 1
    finally:
        await database.close_pool()

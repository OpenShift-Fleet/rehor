"""Task document CRUD tools.

Two tiers:
- Protocol tests against an in-memory FastMCP server with a scripted pool fake
  (no database): tool schemas, parameterized SQL, clear error translation.
- Real-database integration tests, suffixed ``_real_database`` and strictly
  opt-in via REHOR_REAL_DATABASE_TESTS=1 (CI sets it with a disposable
  pgvector service). The ``db`` fixture is destructive — it drops all public
  tables — so point PGSQL_* at a disposable database and never at real data.
  Deselect with ``-k 'not real_database'`` or simply omit the opt-in variable;
  the skip is evaluated before fixture initialization, so a default run never
  connects. Covered: JSONB fidelity, archival persistence, source_type
  isolation, concurrent writers, and literal vs. escaped Unicode strings.

Concurrency contract under test:
- Without ``expected_revision``/``expected_id``: update/delete are atomic last-writer-wins.
- With ``expected_revision``: optimistic check fails with the current revision
  instead of silently replacing a concurrent writer's change.
- With ``expected_id``: generation guard fails when the record was deleted and
  recreated under the same name, even when the revision matches (ABA).
- Concurrent creates of the same (task, name): exactly one winner, the loser
  gets a clear duplicate error (UNIQUE(task_id, name) enforced by PostgreSQL).
"""

import asyncio
import json
from unittest.mock import patch

import asyncpg
import pytest
import pytest_asyncio
from bot_memory_server.tools.task_documents import _dump_data, register_task_document_tools
from conftest import (
    DB_CONFIG,
    NOW,
    SCHEMA_PATH,
    TASK_ROW,
    FakePool,
    SingleConnectionPool,
    document_row,
    requires_real_database,
)
from fastmcp import Client, FastMCP


async def call_tool(pool, tool, args):
    mcp = FastMCP(name=f"documents-{tool}-test")
    register_task_document_tools(mcp)
    with patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool):
        async with Client(mcp) as client:
            return await client.call_tool(tool, args, raise_on_error=False)


def error_text(result) -> str:
    return result.content[0].text


def payload(result):
    return result.data if result.data is not None else json.loads(result.content[0].text)


def queries(pool):
    return [call[1] for call in pool.calls]


# --- Tool schemas ---


@pytest.mark.asyncio
async def test_five_tools_registered_with_expected_parameters():
    mcp = FastMCP(name="documents-schema")
    register_task_document_tools(mcp)
    async with Client(mcp) as client:
        tools = {tool.name: tool for tool in await client.list_tools()}
    assert set(tools) >= {
        "task_document_create",
        "task_document_get",
        "task_document_list",
        "task_document_update",
        "task_document_delete",
    }
    create = tools["task_document_create"].inputSchema["properties"]
    assert set(create) == {"external_key", "name", "data", "source_type"}
    assert create["source_type"]["default"] == "jira"
    # data accepts any JSON value directly — no obligatory wrapper object.
    data_schema = create["data"]
    types = {entry.get("type") for entry in data_schema["anyOf"]}
    assert {"object", "array", "string", "number", "boolean", "null"} <= types
    for tool in ("task_document_update", "task_document_delete"):
        props = tools[tool].inputSchema["properties"]
        assert (
            set(props) == {"external_key", "name", "data", "source_type", "expected_revision", "expected_id"}
            if tool.endswith("update")
            else set(props) == {"external_key", "name", "source_type", "expected_revision", "expected_id"}
        )
    assert tools["task_document_get"].inputSchema["properties"]["source_type"]["default"] == "jira"
    assert tools["task_document_list"].inputSchema["required"] == ["external_key"]


# --- Create ---


@pytest.mark.asyncio
async def test_create_stores_document_with_parameterized_json():
    pool = FakePool(TASK_ROW, document_row())
    result = await call_tool(
        pool,
        "task_document_create",
        {"external_key": "ART-1", "name": "bundle", "data": {"k": "v"}},
    )
    assert not result.is_error
    record = payload(result)
    assert record["name"] == "bundle"
    assert record["revision"] == 1
    assert record["data"] == {"k": "v"}
    assert record["external_key"] == "ART-1"
    assert record["source_type"] == "jira"
    insert = pool.calls[1]
    assert "INSERT INTO task_documents" in insert[1]
    assert "$3::jsonb" in insert[1]
    assert insert[2] == (42, "bundle", '{"k": "v"}')  # JSON text, never interpolated into SQL
    lock = pool.calls[0]
    assert "FOR UPDATE" in lock[1]
    assert lock[2] == ("ART-1", "jira")


@pytest.mark.asyncio
async def test_create_duplicate_is_a_clear_error():
    pool = FakePool(TASK_ROW, asyncpg.UniqueViolationError("duplicate key value violates unique constraint"))
    result = await call_tool(
        pool, "task_document_create", {"external_key": "ART-1", "name": "bundle", "data": {"k": "v"}}
    )
    assert result.is_error
    text = error_text(result)
    assert "already exists" in text
    assert "task_document_update" in text
    assert "bundle" in text


@pytest.mark.asyncio
async def test_create_missing_task_is_a_clear_error():
    pool = FakePool(None)
    result = await call_tool(pool, "task_document_create", {"external_key": "MISSING-1", "name": "bundle", "data": {}})
    assert result.is_error
    assert "Task MISSING-1 not found" in error_text(result)


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["", "   "])
async def test_create_rejects_blank_name(name):
    pool = FakePool()
    result = await call_tool(pool, "task_document_create", {"external_key": "ART-1", "name": name, "data": {}})
    assert result.is_error
    assert "name must not be empty" in error_text(result)
    assert pool.calls == []  # validation happens before any database access


@pytest.mark.asyncio
async def test_create_rejects_overlong_name():
    pool = FakePool()
    result = await call_tool(pool, "task_document_create", {"external_key": "ART-1", "name": "x" * 201, "data": {}})
    assert result.is_error
    assert "at most 200 characters" in error_text(result)


@pytest.mark.asyncio
async def test_create_rejects_empty_external_key():
    pool = FakePool()
    result = await call_tool(pool, "task_document_create", {"external_key": "  ", "name": "bundle", "data": {}})
    assert result.is_error
    assert "external_key must not be empty" in error_text(result)


@pytest.mark.asyncio
async def test_create_null_data_is_valid_json_null():
    pool = FakePool(TASK_ROW, document_row(data="null"))
    result = await call_tool(pool, "task_document_create", {"external_key": "ART-1", "name": "bundle", "data": None})
    assert not result.is_error
    assert payload(result)["data"] is None
    assert pool.calls[1][2][2] == "null"


def test_json_serializer_rejects_non_json_values():
    with pytest.raises(ValueError, match="must be valid JSON"):
        _dump_data({"bad": float("nan")})
    with pytest.raises(ValueError, match="must be valid JSON"):
        _dump_data(float("inf"))
    with pytest.raises(ValueError, match="must be valid JSON"):
        _dump_data({"bad": object()})
    assert _dump_data(None) == "null"


def test_json_serializer_rejects_postgresql_invalid_strings_without_echoing_them():
    with pytest.raises(ValueError, match="NUL character"):
        _dump_data({"payload": "bo\x00ot"})
    with pytest.raises(ValueError, match="NUL character"):
        _dump_data(["\x00"])
    with pytest.raises(ValueError, match="NUL character"):
        _dump_data({"\x00key": "value"})
    with pytest.raises(ValueError, match="unpaired Unicode surrogate"):
        _dump_data({"s": "\ud800"})
    with pytest.raises(ValueError, match="unpaired Unicode surrogate"):
        _dump_data("\udc00")
    with pytest.raises(ValueError, match="unpaired Unicode surrogate"):
        _dump_data({"nested": ["pair-then-lone \U0001f600", "\udfff"]})
    # Valid surrogate pairs (astral characters) pass through.
    assert _dump_data("emoji \U0001f600 safe") == '"emoji \\ud83d\\ude00 safe"'
    # Literal backslash-u sequences are ordinary text, not escape sequences:
    # validation must inspect decoded values, never serialized JSON text.
    assert _dump_data(r"\u0000") == '"\\\\u0000"'
    assert _dump_data(r"\ud800") == '"\\\\ud800"'
    assert _dump_data({"note": r"contains \ud83d\ude00 literally"}) is not None
    # Rejection messages never contain the offending data.
    for bad in ({"payload": "bo\x00ot"}, {"s": "\ud800"}):
        try:
            _dump_data(bad)
        except ValueError as exc:
            assert "boot" not in str(exc)


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_data", [{"payload": "bo\x00ot"}, "\ud800 alone"])
async def test_invalid_strings_rejected_before_database_access(bad_data):
    pool = FakePool()
    result = await call_tool(
        pool, "task_document_create", {"external_key": "ART-1", "name": "bundle", "data": bad_data}
    )
    assert result.is_error
    text = error_text(result)
    assert "cannot be stored" in text
    assert "boot" not in text
    assert pool.calls == []


# --- Get / List ---


@pytest.mark.asyncio
async def test_get_returns_full_data():
    pool = FakePool(document_row(data='{"nested": [1, null, true]}'))
    result = await call_tool(pool, "task_document_get", {"external_key": "ART-1", "name": "bundle"})
    assert not result.is_error
    record = payload(result)
    assert record["data"] == {"nested": [1, None, True]}
    assert record["revision"] == 1
    select = pool.calls[0]
    assert "FROM task_documents" in select[1]
    assert select[2] == ("ART-1", "jira", "bundle")


@pytest.mark.asyncio
async def test_get_missing_document_and_missing_task_are_distinct_errors():
    missing_document = await call_tool(
        FakePool(None, TASK_ROW), "task_document_get", {"external_key": "ART-1", "name": "nope"}
    )
    assert missing_document.is_error
    assert "Task document 'nope' not found" in error_text(missing_document)

    missing_task = await call_tool(
        FakePool(None, None), "task_document_get", {"external_key": "MISS-1", "name": "nope"}
    )
    assert missing_task.is_error
    assert "Task MISS-1 not found" in error_text(missing_task)


@pytest.mark.asyncio
async def test_list_returns_metadata_only_without_data():
    rows = [document_row(name="a"), document_row(name="b")]
    pool = FakePool(TASK_ROW, fetch_results=[rows])
    result = await call_tool(pool, "task_document_list", {"external_key": "ART-1"})
    assert not result.is_error
    entries = payload(result)
    assert [entry["name"] for entry in entries] == ["a", "b"]
    assert all("data" not in entry for entry in entries)
    assert all("revision" in entry for entry in entries)
    assert all("created_at" in entry and "updated_at" in entry for entry in entries)


@pytest.mark.asyncio
async def test_list_missing_task_is_a_clear_error():
    result = await call_tool(FakePool(None), "task_document_list", {"external_key": "MISS-1"})
    assert result.is_error
    assert "Task MISS-1 not found" in error_text(result)


# --- Update ---


@pytest.mark.asyncio
async def test_update_replaces_data_and_increments_revision():
    pool = FakePool(TASK_ROW, document_row(revision=1), document_row(revision=2, data='{"k": 2}'))
    result = await call_tool(
        pool, "task_document_update", {"external_key": "ART-1", "name": "bundle", "data": {"k": 2}}
    )
    assert not result.is_error
    record = payload(result)
    assert record["revision"] == 2
    assert record["data"] == {"k": 2}
    update = pool.calls[2]
    assert "revision = revision + 1" in update[1]
    assert "$3::jsonb" in update[1]
    assert update[2] == (42, "bundle", '{"k": 2}')


@pytest.mark.asyncio
async def test_update_missing_document_is_a_clear_error():
    pool = FakePool(TASK_ROW, None)
    result = await call_tool(pool, "task_document_update", {"external_key": "ART-1", "name": "nope", "data": {"k": 2}})
    assert result.is_error
    assert "Task document 'nope' not found" in error_text(result)


@pytest.mark.asyncio
async def test_update_revision_conflict_reports_current_revision():
    pool = FakePool(TASK_ROW, document_row(revision=3))
    result = await call_tool(
        pool,
        "task_document_update",
        {"external_key": "ART-1", "name": "bundle", "data": {"k": 2}, "expected_revision": 1},
    )
    assert result.is_error
    text = error_text(result)
    assert "Revision conflict" in text
    assert "current revision is 3" in text
    assert no_write_queries(pool)


@pytest.mark.asyncio
async def test_update_with_matching_expected_revision_succeeds():
    pool = FakePool(TASK_ROW, document_row(revision=1), document_row(revision=2, data='{"k": 2}'))
    result = await call_tool(
        pool,
        "task_document_update",
        {"external_key": "ART-1", "name": "bundle", "data": {"k": 2}, "expected_revision": 1},
    )
    assert not result.is_error
    assert payload(result)["revision"] == 2


# --- Delete ---


@pytest.mark.asyncio
async def test_delete_removes_document_and_returns_metadata():
    pool = FakePool(TASK_ROW, document_row(), document_row())
    result = await call_tool(pool, "task_document_delete", {"external_key": "ART-1", "name": "bundle"})
    assert not result.is_error
    record = payload(result)
    assert record["deleted"] is True
    assert "data" not in record
    delete = pool.calls[2]
    assert delete[1].startswith("DELETE FROM task_documents")
    assert "RETURNING" in delete[1]
    assert delete[2] == (42, "bundle")


@pytest.mark.asyncio
async def test_delete_missing_document_is_a_clear_error():
    pool = FakePool(TASK_ROW, None)
    result = await call_tool(pool, "task_document_delete", {"external_key": "ART-1", "name": "nope"})
    assert result.is_error
    assert "Task document 'nope' not found" in error_text(result)


@pytest.mark.asyncio
async def test_delete_revision_conflict_reports_current_revision():
    pool = FakePool(TASK_ROW, document_row(revision=5))
    result = await call_tool(
        pool,
        "task_document_delete",
        {"external_key": "ART-1", "name": "bundle", "expected_revision": 1},
    )
    assert result.is_error
    text = error_text(result)
    assert "Revision conflict" in text
    assert "current revision is 5" in text
    assert no_write_queries(pool)


@pytest.mark.asyncio
async def test_update_stale_expected_id_fails_even_with_matching_revision():
    """Generation guard: a recreated record has a new id, so a stale id can
    never mutate it — even when the revision happens to match."""
    row = document_row(id=99, revision=1)
    pool = FakePool(TASK_ROW, row)
    result = await call_tool(
        pool,
        "task_document_update",
        {
            "external_key": "ART-1",
            "name": "bundle",
            "data": {"stale": True},
            "expected_revision": 1,
            "expected_id": 7,
        },
    )
    assert result.is_error
    text = error_text(result)
    assert "Document conflict" in text
    assert "expected id 7, current id is 99" in text
    assert "deleted and recreated" in text
    assert no_write_queries(pool)


@pytest.mark.asyncio
async def test_delete_stale_expected_id_fails_even_with_matching_revision():
    row = document_row(id=99, revision=1)
    pool = FakePool(TASK_ROW, row)
    result = await call_tool(
        pool,
        "task_document_delete",
        {"external_key": "ART-1", "name": "bundle", "expected_revision": 1, "expected_id": 7},
    )
    assert result.is_error
    assert "Document conflict" in error_text(result)
    assert no_write_queries(pool)


@pytest.mark.asyncio
async def test_matching_expected_id_and_revision_succeed():
    row = document_row(id=7, revision=1)
    pool = FakePool(TASK_ROW, row, document_row(id=7, revision=2, data='{"k": 2}'))
    result = await call_tool(
        pool,
        "task_document_update",
        {"external_key": "ART-1", "name": "bundle", "data": {"k": 2}, "expected_revision": 1, "expected_id": 7},
    )
    assert not result.is_error
    assert payload(result)["revision"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("param", ["expected_revision", "expected_id"])
async def test_update_rejects_invalid_expected_values_before_database_access(param):
    pool = FakePool()
    args = {"external_key": "ART-1", "name": "bundle", "data": {}}
    args[param] = 0
    result = await call_tool(pool, "task_document_update", args)
    assert result.is_error
    assert f"{param} must be a positive integer" in error_text(result)
    assert pool.calls == []


def no_write_queries(pool) -> bool:
    return not [query for query in queries(pool) if query.startswith(("INSERT", "UPDATE", "DELETE"))]


# --- Content containment: document data must not leak ---


@pytest.mark.asyncio
async def test_document_operations_publish_no_bus_events():
    """Document content must never reach dashboard event broadcasts.

    Every operation must first succeed (scripted pool); a silently failing
    call would make the no-event assertion vacuous.
    """
    from unittest.mock import AsyncMock

    from bot_memory_server import events

    row = document_row()
    pool = FakePool(
        # create: lock task, insert
        TASK_ROW,
        row,
        # get: select
        row,
        # list: task check (rows come from fetch_results)
        TASK_ROW,
        # update: lock task, select for update, update returning
        TASK_ROW,
        row,
        row,
        # delete: lock task, select for update, delete returning
        TASK_ROW,
        row,
        row,
        fetch_results=[[row]],
    )
    mcp = FastMCP(name="documents-no-events")
    register_task_document_tools(mcp)
    with (
        patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool),
        patch.object(events.bus, "publish", new_callable=AsyncMock) as publish,
    ):
        async with Client(mcp) as client:
            for tool, args in (
                ("task_document_create", {"external_key": "ART-1", "name": "b", "data": {"k": "v"}}),
                ("task_document_get", {"external_key": "ART-1", "name": "b"}),
                ("task_document_list", {"external_key": "ART-1"}),
                ("task_document_update", {"external_key": "ART-1", "name": "b", "data": {"k": 2}}),
                ("task_document_delete", {"external_key": "ART-1", "name": "b"}),
            ):
                result = await client.call_tool(tool, args)
                assert not result.is_error, f"{tool} failed: {result.content}"
    assert publish.await_count == 0


@pytest.mark.asyncio
async def test_document_content_never_logged(caplog):
    SENTINEL = "secret-free-payload-marker"
    row = document_row(data=f'{{"marker": "{SENTINEL}"}}')
    pool = FakePool(
        # create: lock task, insert
        TASK_ROW,
        row,
        # get: select
        row,
        # update: lock task, select for update, update returning
        TASK_ROW,
        row,
        row,
        # delete: lock task, select for update, delete returning
        TASK_ROW,
        row,
        row,
    )
    mcp = FastMCP(name="documents-no-logs")
    register_task_document_tools(mcp)
    with (
        patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool),
        caplog.at_level("DEBUG", logger="bot_memory_server"),
    ):
        async with Client(mcp) as client:
            for tool, args in (
                ("task_document_create", {"external_key": "ART-1", "name": "b", "data": {"marker": SENTINEL}}),
                ("task_document_get", {"external_key": "ART-1", "name": "b"}),
                ("task_document_update", {"external_key": "ART-1", "name": "b", "data": {"marker": SENTINEL}}),
                ("task_document_delete", {"external_key": "ART-1", "name": "b"}),
            ):
                await client.call_tool(tool, args, raise_on_error=False)
    assert SENTINEL not in caplog.text


@pytest.mark.asyncio
async def test_task_get_and_list_never_touch_task_documents_table():
    """task_get/task_list payloads stay unchanged: no join against task documents."""
    from bot_memory_server.tools.tasks import register_task_tools

    task_row = {
        "id": 1,
        "external_key": "ART-1",
        "source_type": "jira",
        "source_url": None,
        "artifacts": "[]",
        "status": "in_progress",
        "repo": "org/repo",
        "branch": "bot/x",
        "title": None,
        "summary": None,
        "created_at": NOW,
        "last_addressed": NOW,
        "paused_reason": None,
        "instance_id": None,
        "metadata": "{}",
    }
    mcp = FastMCP(name="documents-task-get-isolation")
    register_task_tools(mcp)
    pool = FakePool(task_row, fetch_results=[[task_row]])
    with patch("bot_memory_server.tools.tasks.get_pool", return_value=pool):
        async with Client(mcp) as client:
            got = await client.call_tool("task_get", {"external_key": "ART-1"})
            listed = await client.call_tool("task_list", {})
    assert not got.is_error and not listed.is_error
    assert "task_documents" not in got.data and "task_documents" not in listed.data[0]
    assert all("task_documents" not in query for query in queries(pool))


@pytest.mark.asyncio
async def test_error_messages_never_contain_document_data():
    pool = FakePool(TASK_ROW, document_row(revision=9))
    result = await call_tool(
        pool,
        "task_document_update",
        {"external_key": "ART-1", "name": "bundle", "data": {"secret": "leak-check"}, "expected_revision": 1},
    )
    assert result.is_error
    text = error_text(result)
    assert "Revision conflict" in text
    assert "leak-check" not in text
    assert "secret" not in text


# --- Real-database integration (db fixture drops public tables — disposable DB only) ---


async def seed_task(db, key, source_type="jira") -> int:
    return await db.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) "
        "VALUES ($1, $2, 'in_progress', 'org/repo', 'bot/x') RETURNING id",
        key,
        source_type,
    )


@pytest_asyncio.fixture
async def document_client(db):
    await db.execute(SCHEMA_PATH.read_text())
    mcp = FastMCP(name="documents-real-db")
    register_task_document_tools(mcp)
    with patch("bot_memory_server.tools.task_documents.get_pool", return_value=SingleConnectionPool(db)):
        async with Client(mcp) as client:
            yield client


FIDELITY_PAYLOAD = {
    "steps": [{"name": "clone", "ok": True}, {"name": "build", "ok": False}],
    "pr": 123,
    "ratio": 0.25,
    "label": "řehoř-安全",
    "nested": {"deep": [{"mixed": [1, 2.5, None, True, "x"]}]},
    "empty_obj": {},
    "empty_list": [],
}


@pytest.mark.asyncio
@requires_real_database
async def test_crud_roundtrip_preserves_nested_json_through_real_database(db, document_client):
    task_id = await seed_task(db, "ART-1")
    created = await document_client.call_tool(
        "task_document_create",
        {"external_key": "ART-1", "name": "retry-bundle", "data": FIDELITY_PAYLOAD},
    )
    assert not created.is_error
    assert created.data["revision"] == 1

    fetched = await document_client.call_tool("task_document_get", {"external_key": "ART-1", "name": "retry-bundle"})
    assert not fetched.is_error
    assert fetched.data["data"] == FIDELITY_PAYLOAD

    listed = await document_client.call_tool("task_document_list", {"external_key": "ART-1"})
    assert [entry["name"] for entry in listed.data] == ["retry-bundle"]
    assert all("data" not in entry for entry in listed.data)

    # Same task row, same document row: stored JSONB round-trips byte-for-byte
    # as a value (no SQL NULL, no stringification).
    raw = await db.fetchval("SELECT data FROM task_documents WHERE task_id = $1", task_id)
    assert isinstance(raw, str) is False or json.loads(raw) == FIDELITY_PAYLOAD

    updated = await document_client.call_tool(
        "task_document_update",
        {"external_key": "ART-1", "name": "retry-bundle", "data": {"next": True}, "expected_revision": 1},
    )
    assert not updated.is_error
    assert updated.data["revision"] == 2
    assert updated.data["data"] == {"next": True}

    deleted = await document_client.call_tool(
        "task_document_delete", {"external_key": "ART-1", "name": "retry-bundle", "expected_revision": 2}
    )
    assert not deleted.is_error
    assert deleted.data["deleted"] is True

    gone = await document_client.call_tool(
        "task_document_get", {"external_key": "ART-1", "name": "retry-bundle"}, raise_on_error=False
    )
    assert gone.is_error
    assert "not found" in gone.content[0].text


@pytest.mark.asyncio
async def test_get_does_not_double_decode_pre_parsed_jsonb():
    """If the driver/pool ever returns parsed JSONB (registered codec), it passes through as-is."""
    row = document_row()
    row["data"] = {"already": "parsed"}  # dict, not JSON text
    pool = FakePool(row)
    result = await call_tool(pool, "task_document_get", {"external_key": "ART-1", "name": "bundle"})
    assert not result.is_error
    assert payload(result)["data"] == {"already": "parsed"}


@pytest.mark.asyncio
@requires_real_database
async def test_json_null_data_round_trip_through_real_database(db, document_client):
    await seed_task(db, "ART-NULL")
    created = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-NULL", "name": "maybe", "data": None}
    )
    assert not created.is_error
    fetched = await document_client.call_tool("task_document_get", {"external_key": "ART-NULL", "name": "maybe"})
    assert fetched.data["data"] is None
    stored = await db.fetchval("SELECT data FROM task_documents WHERE name = 'maybe'")
    assert stored is not None  # JSON null, not SQL NULL


@pytest.mark.asyncio
@requires_real_database
async def test_scalar_and_astral_data_round_trip_through_real_database(db, document_client):
    """Top-level JSON scalars keep their exact type (no double decode) and
    astral characters (valid surrogate pairs) survive PostgreSQL JSONB."""
    await seed_task(db, "ART-SCALAR")
    scalars = {
        "text": "plain string",
        "number": 42,
        "float": 3.5,
        "boolean": False,
        "astral": "emoji \U0001f600 and 安全",
    }
    for name, value in scalars.items():
        created = await document_client.call_tool(
            "task_document_create", {"external_key": "ART-SCALAR", "name": name, "data": value}
        )
        assert not created.is_error
        fetched = await document_client.call_tool("task_document_get", {"external_key": "ART-SCALAR", "name": name})
        assert fetched.data["data"] == value
        assert fetched.data["data"].__class__ is value.__class__


@pytest.mark.asyncio
@requires_real_database
async def test_documents_persist_through_archival_and_stay_writable_through_real_database(db, document_client):
    task_id = await seed_task(db, "ART-ARCH")
    created = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-ARCH", "name": "bundle", "data": {"v": 1}}
    )
    assert not created.is_error

    await db.execute("UPDATE tasks SET status = 'archived', archived_at = NOW() WHERE id = $1", task_id)

    fetched = await document_client.call_tool("task_document_get", {"external_key": "ART-ARCH", "name": "bundle"})
    assert not fetched.is_error
    assert fetched.data["data"] == {"v": 1}

    # Archival neither deletes nor restricts documents: writes stay available.
    updated = await document_client.call_tool(
        "task_document_update", {"external_key": "ART-ARCH", "name": "bundle", "data": {"v": 2}}
    )
    assert not updated.is_error
    added = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-ARCH", "name": "post-archive", "data": [1, 2]}
    )
    assert not added.is_error

    listed = await document_client.call_tool("task_document_list", {"external_key": "ART-ARCH"})
    assert [entry["name"] for entry in listed.data] == ["bundle", "post-archive"]


@pytest.mark.asyncio
@requires_real_database
async def test_duplicate_create_fails_on_unique_constraint_through_real_database(db, document_client):
    await seed_task(db, "ART-DUP")
    first = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-DUP", "name": "bundle", "data": {"w": 1}}
    )
    assert not first.is_error
    second = await document_client.call_tool(
        "task_document_create",
        {"external_key": "ART-DUP", "name": "bundle", "data": {"w": 2}},
        raise_on_error=False,
    )
    assert second.is_error
    assert "already exists" in second.content[0].text
    assert await db.fetchval("SELECT COUNT(*) FROM task_documents") == 1


@pytest.mark.asyncio
@requires_real_database
async def test_missing_task_and_document_errors_through_real_database(db, document_client):
    await seed_task(db, "ART-ERR")
    missing_task = await document_client.call_tool(
        "task_document_create", {"external_key": "MISS-1", "name": "bundle", "data": {}}, raise_on_error=False
    )
    assert missing_task.is_error
    assert "Task MISS-1 not found" in missing_task.content[0].text

    missing_document = await document_client.call_tool(
        "task_document_get", {"external_key": "ART-ERR", "name": "nope"}, raise_on_error=False
    )
    assert missing_document.is_error
    assert "Task document 'nope' not found" in missing_document.content[0].text


@pytest.mark.asyncio
@requires_real_database
async def test_source_type_isolation_for_same_external_key_through_real_database(db, document_client):
    await seed_task(db, "ART-SAME", "jira")
    await seed_task(db, "ART-SAME", "github")
    created = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-SAME", "name": "bundle", "data": {"src": "jira"}}
    )
    assert not created.is_error

    cross = await document_client.call_tool(
        "task_document_get",
        {"external_key": "ART-SAME", "name": "bundle", "source_type": "github"},
        raise_on_error=False,
    )
    assert cross.is_error
    assert "Task document 'bundle' not found" in cross.content[0].text

    same = await document_client.call_tool(
        "task_document_get", {"external_key": "ART-SAME", "name": "bundle", "source_type": "jira"}
    )
    assert same.data["data"] == {"src": "jira"}


@pytest.mark.asyncio
@requires_real_database
async def test_recreate_same_name_new_id_blocks_stale_generation_guard_through_real_database(db, document_client):
    """Delete + recreate starts a fresh record: new id, revision restarts at 1.

    expected_revision alone cannot detect the recreate (revision 1 matches
    again — documented limitation). expected_id is the atomic generation
    guard: a stale id can never mutate the recreated record, even when the
    revision matches exactly.
    """
    await seed_task(db, "ART-ABA")
    first = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-ABA", "name": "bundle", "data": {"gen": 1}}
    )
    assert not first.is_error
    old_id = first.data["id"]

    bumped = await document_client.call_tool(
        "task_document_update", {"external_key": "ART-ABA", "name": "bundle", "data": {"gen": 1, "bump": True}}
    )
    assert bumped.data["revision"] == 2

    deleted = await document_client.call_tool(
        "task_document_delete", {"external_key": "ART-ABA", "name": "bundle", "expected_revision": 2}
    )
    assert not deleted.is_error

    recreated = await document_client.call_tool(
        "task_document_create", {"external_key": "ART-ABA", "name": "bundle", "data": {"gen": 2}}
    )
    assert not recreated.is_error
    new_id = recreated.data["id"]
    assert new_id != old_id  # new server-issued record
    assert recreated.data["revision"] == 1  # revision restarts

    # Stale generation with matching revision must not mutate (update).
    stale_update = await document_client.call_tool(
        "task_document_update",
        {
            "external_key": "ART-ABA",
            "name": "bundle",
            "data": {"gen": 2, "stale": True},
            "expected_revision": 1,
            "expected_id": old_id,
        },
        raise_on_error=False,
    )
    assert stale_update.is_error
    assert "Document conflict" in stale_update.content[0].text
    assert f"expected id {old_id}, current id is {new_id}" in stale_update.content[0].text

    # Stale generation with matching revision must not mutate (delete).
    stale_delete = await document_client.call_tool(
        "task_document_delete",
        {"external_key": "ART-ABA", "name": "bundle", "expected_revision": 1, "expected_id": old_id},
        raise_on_error=False,
    )
    assert stale_delete.is_error
    assert "Document conflict" in stale_delete.content[0].text

    # The recreated record is untouched by both stale attempts.
    survived = await document_client.call_tool("task_document_get", {"external_key": "ART-ABA", "name": "bundle"})
    assert survived.data["id"] == new_id
    assert survived.data["revision"] == 1
    assert survived.data["data"] == {"gen": 2}

    # Documented limitation: expected_revision alone still matches (ABA on the
    # version number). Clients wanting full protection pass expected_id too.
    revision_only = await document_client.call_tool(
        "task_document_update",
        {"external_key": "ART-ABA", "name": "bundle", "data": {"gen": 2, "bump": True}, "expected_revision": 1},
    )
    assert not revision_only.is_error
    assert revision_only.data["revision"] == 2

    # Correct id + revision from the latest read succeeds.
    guarded = await document_client.call_tool(
        "task_document_update",
        {
            "external_key": "ART-ABA",
            "name": "bundle",
            "data": {"gen": 3},
            "expected_revision": 2,
            "expected_id": new_id,
        },
    )
    assert not guarded.is_error
    assert guarded.data["revision"] == 3
    assert guarded.data["data"] == {"gen": 3}


@pytest.mark.asyncio
@requires_real_database
async def test_literal_backslash_u_strings_round_trip_through_real_database(db, document_client):
    """Literal backslash-u sequences are ordinary text, not JSON escapes:
    they must be stored and returned verbatim (validation checks decoded
    values, never serialized JSON text)."""
    await seed_task(db, "ART-LITERAL")
    literals = {
        "nul-lookalike": r"\u0000",
        "surrogate-lookalike": r"\ud800",
        "pair-lookalike": r"contains \ud83d\ude00 literally",
    }
    for doc_name, value in literals.items():
        created = await document_client.call_tool(
            "task_document_create", {"external_key": "ART-LITERAL", "name": doc_name, "data": value}
        )
        assert not created.is_error
        fetched = await document_client.call_tool(
            "task_document_get", {"external_key": "ART-LITERAL", "name": doc_name}
        )
        assert fetched.data["data"] == value


@pytest.mark.asyncio
@requires_real_database
async def test_concurrent_create_has_exactly_one_winner_through_real_database(db):
    await db.execute(SCHEMA_PATH.read_text())
    await seed_task(db, "RACE-CREATE")
    pool = await asyncpg.create_pool(**DB_CONFIG, min_size=2, max_size=4)
    try:
        mcp = FastMCP(name="documents-race-create")
        register_task_document_tools(mcp)
        with patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool):
            async with Client(mcp) as client:
                results = await asyncio.gather(
                    client.call_tool(
                        "task_document_create",
                        {"external_key": "RACE-CREATE", "name": "bundle", "data": {"w": 1}},
                        raise_on_error=False,
                    ),
                    client.call_tool(
                        "task_document_create",
                        {"external_key": "RACE-CREATE", "name": "bundle", "data": {"w": 2}},
                        raise_on_error=False,
                    ),
                )
    finally:
        await pool.close()

    successes = [result for result in results if not result.is_error]
    failures = [result for result in results if result.is_error]
    assert len(successes) == 1
    assert len(failures) == 1
    assert "already exists" in failures[0].content[0].text
    assert await db.fetchval("SELECT COUNT(*) FROM task_documents WHERE name = 'bundle'") == 1


@pytest.mark.asyncio
@requires_real_database
async def test_concurrent_update_with_same_expected_revision_single_winner_through_real_database(db):
    await db.execute(SCHEMA_PATH.read_text())
    await seed_task(db, "RACE-UPDATE")
    mcp = FastMCP(name="documents-race-update")
    register_task_document_tools(mcp)
    with patch("bot_memory_server.tools.task_documents.get_pool", return_value=SingleConnectionPool(db)):
        async with Client(mcp) as client:
            created = await client.call_tool(
                "task_document_create", {"external_key": "RACE-UPDATE", "name": "bundle", "data": {"v": 0}}
            )
            assert not created.is_error
            concurrent_pool = await asyncpg.create_pool(**DB_CONFIG, min_size=2, max_size=4)
            try:
                with patch("bot_memory_server.tools.task_documents.get_pool", return_value=concurrent_pool):
                    results = await asyncio.gather(
                        client.call_tool(
                            "task_document_update",
                            {
                                "external_key": "RACE-UPDATE",
                                "name": "bundle",
                                "data": {"v": "a"},
                                "expected_revision": 1,
                            },
                            raise_on_error=False,
                        ),
                        client.call_tool(
                            "task_document_update",
                            {
                                "external_key": "RACE-UPDATE",
                                "name": "bundle",
                                "data": {"v": "b"},
                                "expected_revision": 1,
                            },
                            raise_on_error=False,
                        ),
                    )
            finally:
                await concurrent_pool.close()

    successes = [result for result in results if not result.is_error]
    failures = [result for result in results if result.is_error]
    assert len(successes) == 1
    assert len(failures) == 1
    assert "Revision conflict" in failures[0].content[0].text
    revision = await db.fetchval("SELECT revision FROM task_documents WHERE name = 'bundle'")
    assert revision == 2

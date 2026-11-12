"""Tests for REHOR-218 phase 2: session registry REST API.

The memory server is dumb storage — the dispatcher owns the session
lifecycle and interprets state values. These tests verify the HTTP handlers
with a RecordingPool fake (no live PostgreSQL): SQL shape, parameter binding,
status codes, and JSON serialization.
"""

import json
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.api import (
    api_session_registry_list,
    api_session_registry_register,
    api_session_registry_update,
)
from starlette.requests import Request

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
LATER = datetime(2026, 11, 12, 12, 5, tzinfo=UTC)
TOKEN = uuid.uuid4()
RUN_ID = str(uuid.uuid4())


def _record_row(**overrides) -> dict:
    row = {
        "run_id": RUN_ID,
        "agent_id": "agent-1",
        "holder": "bot-a",
        "lock_token": str(TOKEN),
        "state": "open",
        "workspace_name": "ws-1",
        "sandbox_name": "sbx-1",
        "provider_name": "prov-1",
        "profile_name": "prof-1",
        "started_at": NOW,
        "updated_at": LATER,
        "detail": {"sandbox": "sbx-1"},
    }
    row.update(overrides)
    return row


SERIALIZED_RECORD = {
    "run_id": RUN_ID,
    "agent_id": "agent-1",
    "holder": "bot-a",
    "lock_token": str(TOKEN),
    "state": "open",
    "workspace_name": "ws-1",
    "sandbox_name": "sbx-1",
    "provider_name": "prov-1",
    "profile_name": "prof-1",
    "started_at": NOW.isoformat(),
    "updated_at": LATER.isoformat(),
    "detail": {"sandbox": "sbx-1"},
}


class RecordingPool:
    """Minimal asyncpg pool fake capturing every query and its parameters."""

    def __init__(self, fetchrow_results=None, fetch_rows=None):
        self.fetchrow_results = list(fetchrow_results or [])
        self.fetch_rows = list(fetch_rows or [])
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.fetchrow_results.pop(0) if self.fetchrow_results else None

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return self.fetch_rows.pop(0) if self.fetch_rows else []

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return 0

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return "OK"


def _post_request(path: str, body: dict) -> Request:
    async def receive():
        return {"type": "http.request", "body": json.dumps(body).encode()}

    return Request({"type": "http", "method": "POST", "path": path, "headers": []}, receive)


def _get_request(path: str, query_string: str = "") -> Request:
    return Request(
        {"type": "http", "method": "GET", "path": path, "query_string": query_string.encode(), "headers": []}
    )


def _body(response) -> dict:
    return json.loads(bytes(response.body))


REGISTER_BODY = {"run_id": RUN_ID, "agent_id": "agent-1", "holder": "bot-a", "lock_token": str(TOKEN)}


# --- register ---


@pytest.mark.asyncio
async def test_register_upserts_and_resets_to_open():
    pool = RecordingPool(fetchrow_results=[{"run_id": RUN_ID, "started_at": NOW}])
    publish = AsyncMock()
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", publish),
    ):
        response = await api_session_registry_register(_post_request("/api/session-registry/register", REGISTER_BODY))

    assert response.status_code == 200
    data = _body(response)
    assert data == {"registered": True, "run_id": RUN_ID, "started_at": NOW.isoformat()}

    # Single atomic statement: upsert that resets the record to open.
    assert len(pool.calls) == 1
    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert "INSERT INTO session_registry" in query
    assert "ON CONFLICT (run_id) DO UPDATE SET" in query
    assert "state = 'open'" in query
    assert "workspace_name = NULL" in query
    assert "sandbox_name = NULL" in query
    assert "provider_name = NULL" in query
    assert "profile_name = NULL" in query
    assert "detail = NULL" in query
    assert "started_at = NOW()" in query
    assert "updated_at = NOW()" in query
    assert "RETURNING run_id, started_at" in query
    assert args == (RUN_ID, "agent-1", "bot-a", str(TOKEN))
    publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_register_without_lock_token():
    pool = RecordingPool(fetchrow_results=[{"run_id": RUN_ID, "started_at": NOW}])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_register(
            _post_request(
                "/api/session-registry/register", {"run_id": RUN_ID, "agent_id": "agent-1", "holder": "bot-a"}
            )
        )

    assert response.status_code == 200
    assert _body(response)["registered"] is True
    assert pool.calls[0][2] == (RUN_ID, "agent-1", "bot-a", None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"agent_id": "agent-1", "holder": "bot-a"},  # missing run_id
        {"run_id": "not-a-uuid", "agent_id": "agent-1", "holder": "bot-a"},  # non-UUID run_id
        {"run_id": RUN_ID, "holder": "bot-a"},  # missing agent_id
        {"run_id": RUN_ID, "agent_id": "", "holder": "bot-a"},  # empty agent_id
        {"run_id": RUN_ID, "agent_id": "a" * 513, "holder": "bot-a"},  # agent_id too long
        {"run_id": RUN_ID, "agent_id": "agent-1"},  # missing holder
        {"run_id": RUN_ID, "agent_id": "agent-1", "holder": ""},  # empty holder
        {"run_id": RUN_ID, "agent_id": "agent-1", "holder": "h" * 257},  # holder too long
        {"run_id": RUN_ID, "agent_id": "agent-1", "holder": "bot-a", "lock_token": "nope"},  # non-UUID token
    ],
)
async def test_register_invalid_payloads_rejected(body):
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_register(_post_request("/api/session-registry/register", body))

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []


# --- update ---


@pytest.mark.asyncio
async def test_update_full_sets_present_fields_and_serializes_record():
    pool = RecordingPool(fetchrow_results=[_record_row()])
    publish = AsyncMock()
    body = {
        "run_id": RUN_ID,
        "state": "running",
        "workspace_name": "ws-1",
        "sandbox_name": "sbx-1",
        "provider_name": "prov-1",
        "profile_name": "prof-1",
        "detail": {"sandbox": "sbx-1"},
    }
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", publish),
    ):
        response = await api_session_registry_update(_post_request("/api/session-registry/update", body))

    assert response.status_code == 200
    data = _body(response)
    assert data == {"updated": True, "record": SERIALIZED_RECORD}

    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert query.startswith("UPDATE session_registry SET ")
    assert "state = $2" in query
    assert "workspace_name = $3" in query
    assert "sandbox_name = $4" in query
    assert "provider_name = $5" in query
    assert "profile_name = $6" in query
    assert "detail = $7" in query
    assert "updated_at = NOW()" in query
    assert "WHERE run_id = $1 RETURNING *" in query
    # detail is passed as a JSON string for JSONB binding.
    assert args == (RUN_ID, "running", "ws-1", "sbx-1", "prov-1", "prof-1", json.dumps({"sandbox": "sbx-1"}))
    publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_partial_only_state():
    pool = RecordingPool(fetchrow_results=[_record_row(state="completed")])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_update(
            _post_request("/api/session-registry/update", {"run_id": RUN_ID, "state": "completed"})
        )

    assert response.status_code == 200
    data = _body(response)
    assert data["updated"] is True
    assert data["record"]["state"] == "completed"

    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert query == "UPDATE session_registry SET state = $2, updated_at = NOW() WHERE run_id = $1 RETURNING *"
    assert args == (RUN_ID, "completed")


@pytest.mark.asyncio
async def test_update_null_clears_names_detail_and_lock_token():
    pool = RecordingPool(fetchrow_results=[_record_row(workspace_name=None, detail=None, lock_token=None)])
    body = {"run_id": RUN_ID, "workspace_name": None, "detail": None, "lock_token": None}
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_update(_post_request("/api/session-registry/update", body))

    assert response.status_code == 200
    record = _body(response)["record"]
    assert record["workspace_name"] is None
    assert record["detail"] is None
    assert record["lock_token"] is None
    _, query, args = pool.calls[0]
    assert "workspace_name = $2" in query
    assert "detail = $3" in query
    assert "lock_token = $4" in query
    assert args == (RUN_ID, None, None, None)


@pytest.mark.asyncio
async def test_update_unknown_run_id_is_404():
    pool = RecordingPool(fetchrow_results=[None])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_update(
            _post_request("/api/session-registry/update", {"run_id": RUN_ID, "state": "running"})
        )

    assert response.status_code == 404
    assert _body(response) == {"updated": False}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"state": "running"},  # missing run_id
        {"run_id": "not-a-uuid", "state": "running"},  # non-UUID run_id
        {"run_id": RUN_ID, "state": ""},  # empty state
        {"run_id": RUN_ID, "state": "s" * 33},  # state too long
        {"run_id": RUN_ID, "state": None},  # state cannot be null
        {"run_id": RUN_ID, "workspace_name": "w" * 65},  # name too long
        {"run_id": RUN_ID, "sandbox_name": "s" * 65},  # name too long
        {"run_id": RUN_ID, "provider_name": "p" * 65},  # name too long
        {"run_id": RUN_ID, "profile_name": "p" * 65},  # name too long
        {"run_id": RUN_ID, "lock_token": "nope"},  # non-UUID lock_token
        {"run_id": RUN_ID},  # no updatable fields
    ],
)
async def test_update_invalid_payloads_rejected(body):
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_update(_post_request("/api/session-registry/update", body))

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []


# --- list ---


@pytest.mark.asyncio
async def test_list_unfiltered_returns_all_rows_ordered():
    other = _record_row(run_id=str(uuid.uuid4()), holder="bot-b", started_at=LATER, updated_at=LATER, detail=None)
    pool = RecordingPool(fetch_rows=[[_record_row(), other]])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_list(_get_request("/api/session-registry"))

    assert response.status_code == 200
    data = _body(response)
    assert data == [
        SERIALIZED_RECORD,
        {
            **SERIALIZED_RECORD,
            **{
                "run_id": other["run_id"],
                "holder": "bot-b",
                "started_at": LATER.isoformat(),
                "updated_at": LATER.isoformat(),
                "detail": None,
            },
        },
    ]

    kind, query, args = pool.calls[0]
    assert kind == "fetch"
    assert "SELECT * FROM session_registry ORDER BY started_at" in query
    assert "WHERE" not in query
    assert args == ()


@pytest.mark.asyncio
async def test_list_filtered_by_state_binds_parameter():
    pool = RecordingPool(fetch_rows=[[_record_row()]])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_list(_get_request("/api/session-registry", query_string="state=open"))

    assert response.status_code == 200
    assert _body(response) == [SERIALIZED_RECORD]

    kind, query, args = pool.calls[0]
    assert kind == "fetch"
    assert "SELECT * FROM session_registry WHERE state = $1 ORDER BY started_at" in query
    assert args == ("open",)


@pytest.mark.asyncio
async def test_list_rejects_invalid_state_filter():
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_session_registry_list(
            _get_request("/api/session-registry", query_string="state=" + "s" * 33)
        )

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []

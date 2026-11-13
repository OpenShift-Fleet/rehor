"""Tests for REHOR-218: session lock REST API.

The memory server is storage + interface only — the dispatcher owns the
acquire/renew/release lifecycle. These tests verify the HTTP handlers with a
RecordingPool fake (no live PostgreSQL): SQL shape, parameter binding for the
Python-generated lock token, status codes, and JSON serialization.
"""

import json
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.api import api_locks_acquire, api_locks_list, api_locks_release, api_locks_renew
from starlette.requests import Request

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
EXPIRES = datetime(2026, 11, 12, 12, 5, tzinfo=UTC)
TOKEN = uuid.uuid4()

ACQUIRED_ROW = {
    "lock_token": TOKEN,
    "holder": "bot-a",
    "acquired_at": NOW,
    "expires_at": EXPIRES,
}

CURRENT_ROW = {
    "holder": "bot-b",
    "acquired_at": NOW,
    "expires_at": EXPIRES,
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


def _get_request(path: str) -> Request:
    return Request({"type": "http", "method": "GET", "path": path, "query_string": b"", "headers": []})


def _body(response) -> dict:
    return json.loads(bytes(response.body))


ACQUIRE_BODY = {"key": "rehor-218/session-1", "holder": "bot-a", "ttl_seconds": 300}


# --- acquire ---


@pytest.mark.asyncio
async def test_acquire_fresh_lock():
    pool = RecordingPool(fetchrow_results=[ACQUIRED_ROW])
    publish = AsyncMock()
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", publish),
    ):
        response = await api_locks_acquire(_post_request("/api/locks/acquire", ACQUIRE_BODY))

    assert response.status_code == 200
    data = _body(response)
    assert data["acquired"] is True
    assert data["key"] == "rehor-218/session-1"
    assert data["holder"] == "bot-a"
    assert data["lock_token"] == str(TOKEN)
    assert data["acquired_at"] == NOW.isoformat()
    assert data["expires_at"] == EXPIRES.isoformat()

    # Single atomic statement: takeable-when-expired upsert.
    assert len(pool.calls) == 1
    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert "INSERT INTO session_locks" in query
    assert "ON CONFLICT (lock_key) DO UPDATE SET" in query
    assert "WHERE session_locks.expires_at <= NOW()" in query
    # Lock token is generated in Python and passed as a parameter.
    assert isinstance(args[3], uuid.UUID)
    assert args[0] == "rehor-218/session-1"
    assert args[1] == "bot-a"
    assert args[2] == 300
    publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_acquire_contended_reports_current_holder():
    pool = RecordingPool(fetchrow_results=[None, CURRENT_ROW])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_acquire(_post_request("/api/locks/acquire", ACQUIRE_BODY))

    assert response.status_code == 409
    data = _body(response)
    assert data["acquired"] is False
    assert data["key"] == "rehor-218/session-1"
    assert data["holder"] == "bot-b"
    assert data["acquired_at"] == NOW.isoformat()
    assert data["expires_at"] == EXPIRES.isoformat()
    # The follow-up SELECT reads the current holder of the same key.
    assert "SELECT holder, acquired_at, expires_at FROM session_locks" in pool.calls[1][1]
    assert pool.calls[1][2] == ("rehor-218/session-1",)


@pytest.mark.asyncio
async def test_acquire_raced_away_reports_null_holder():
    pool = RecordingPool(fetchrow_results=[None, None])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_acquire(_post_request("/api/locks/acquire", ACQUIRE_BODY))

    assert response.status_code == 409
    data = _body(response)
    assert data == {"acquired": False, "key": "rehor-218/session-1", "holder": None}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"holder": "bot-a", "ttl_seconds": 300},  # missing key
        {"key": "k", "holder": "bot-a", "ttl_seconds": 0},  # ttl too small
        {"key": "k", "holder": "bot-a", "ttl_seconds": 86401},  # ttl too large
        {"key": "k", "holder": "bot-a", "ttl_seconds": "300"},  # non-int ttl
        {"key": "k", "holder": "bot-a", "ttl_seconds": True},  # bool is not an int
        {"key": "", "holder": "bot-a", "ttl_seconds": 300},  # empty key
        {"key": "k", "holder": "", "ttl_seconds": 300},  # empty holder
        {"key": "k" * 513, "holder": "bot-a", "ttl_seconds": 300},  # key too long
        {"key": "k", "holder": "h" * 257, "ttl_seconds": 300},  # holder too long
    ],
)
async def test_acquire_invalid_payloads_rejected(body):
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_acquire(_post_request("/api/locks/acquire", body))

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []


# --- renew ---


@pytest.mark.asyncio
async def test_renew_with_matching_token():
    pool = RecordingPool(fetchrow_results=[{"expires_at": EXPIRES}])
    publish = AsyncMock()
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", publish),
    ):
        response = await api_locks_renew(
            _post_request(
                "/api/locks/renew", {"key": "rehor-218/session-1", "lock_token": str(TOKEN), "ttl_seconds": 60}
            )
        )

    assert response.status_code == 200
    data = _body(response)
    assert data == {"renewed": True, "expires_at": EXPIRES.isoformat()}

    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert "UPDATE session_locks SET expires_at = NOW() + make_interval(secs => $2)" in query
    assert "WHERE lock_key = $1 AND lock_token = $3 AND expires_at > NOW()" in query
    assert args == ("rehor-218/session-1", 60, str(TOKEN))
    publish.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"lock_token": "t", "ttl_seconds": 300},  # missing key
        {"key": "k", "ttl_seconds": 300},  # missing token
        {"key": "k", "lock_token": "t", "ttl_seconds": 0},  # ttl too small
        {"key": "k", "lock_token": "t", "ttl_seconds": 86401},  # ttl too large
        {"key": "k", "lock_token": "t", "ttl_seconds": 30.5},  # non-int ttl
    ],
)
async def test_renew_invalid_payloads_rejected(body):
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_renew(_post_request("/api/locks/renew", body))

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []


@pytest.mark.asyncio
async def test_renew_wrong_token_or_expired_is_lost_lock():
    pool = RecordingPool(fetchrow_results=[None])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_renew(
            _post_request(
                "/api/locks/renew", {"key": "rehor-218/session-1", "lock_token": str(TOKEN), "ttl_seconds": 60}
            )
        )

    assert response.status_code == 409
    assert _body(response) == {"renewed": False}


# --- release ---


@pytest.mark.asyncio
async def test_release_with_matching_token():
    pool = RecordingPool(fetchrow_results=[{"lock_token": TOKEN}])
    publish = AsyncMock()
    with (
        patch("bot_memory_server.api.get_pool", return_value=pool),
        patch("bot_memory_server.api.bus.publish", publish),
    ):
        response = await api_locks_release(
            _post_request("/api/locks/release", {"key": "rehor-218/session-1", "lock_token": str(TOKEN)})
        )

    assert response.status_code == 200
    assert _body(response) == {"released": True}

    kind, query, args = pool.calls[0]
    assert kind == "fetchrow"
    assert "DELETE FROM session_locks WHERE lock_key = $1 AND lock_token = $2 RETURNING lock_token" in query
    assert args == ("rehor-218/session-1", str(TOKEN))
    publish.assert_awaited_once()


@pytest.mark.asyncio
async def test_release_unknown_or_mismatched_token_is_idempotent():
    pool = RecordingPool(fetchrow_results=[None])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_release(
            _post_request("/api/locks/release", {"key": "rehor-218/session-1", "lock_token": str(uuid.uuid4())})
        )

    assert response.status_code == 200
    assert _body(response) == {"released": False}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"lock_token": "t"},  # missing key
        {"key": "k"},  # missing token
        {"key": "", "lock_token": "t"},  # empty key
        {"key": "k", "lock_token": ""},  # empty token
    ],
)
async def test_release_invalid_payloads_rejected(body):
    pool = RecordingPool()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_release(_post_request("/api/locks/release", body))

    assert response.status_code == 400
    assert "error" in _body(response)
    assert pool.calls == []


# --- list ---


@pytest.mark.asyncio
async def test_list_serializes_rows_including_expired():
    later = datetime(2026, 11, 12, 12, 1, tzinfo=UTC)
    rows = [
        {"lock_key": "rehor-218/session-1", "holder": "bot-a", "acquired_at": NOW, "expires_at": EXPIRES},
        {"lock_key": "rehor-218/session-2", "holder": "bot-b", "acquired_at": later, "expires_at": NOW},
    ]
    pool = RecordingPool(fetch_rows=[rows])
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_locks_list(_get_request("/api/locks"))

    assert response.status_code == 200
    data = _body(response)
    assert data == [
        {
            "key": "rehor-218/session-1",
            "holder": "bot-a",
            "acquired_at": NOW.isoformat(),
            "expires_at": EXPIRES.isoformat(),
        },
        {
            "key": "rehor-218/session-2",
            "holder": "bot-b",
            "acquired_at": later.isoformat(),
            "expires_at": NOW.isoformat(),
        },
    ]
    kind, query, args = pool.calls[0]
    assert kind == "fetch"
    assert "SELECT lock_key, holder, acquired_at, expires_at FROM session_locks ORDER BY acquired_at" in query
    assert args == ()

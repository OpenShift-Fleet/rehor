"""Regression test: REST POST /api/bot-status must update the legacy
bot_status singleton's instance_id.

The MCP tool path (REHOR-235) updates bot_status.instance_id via
COALESCE(header, instance_id); the REST path historically omitted the
column, so the singleton kept a stale instance_id from an earlier writer
and GET /api/bot-status reported the wrong instance even though the
per-instance bot_instances record was correct.
"""

from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from bot_memory_server.api import api_bot_status_update
from starlette.requests import Request

NOW = datetime(2026, 11, 12, 9, 30, tzinfo=UTC)

STATUS_ROW = {
    "state": "idle",
    "message": "Cycle complete.",
    "external_key": "FM-162",
    "source_type": "jira",
    "repo": "org/repo",
    "instance_id": "Bořivoj Lodník z Plovoucího hradu",
    "cycle_start": NOW,
    "updated_at": NOW,
}


class RecordingPool:
    """Minimal asyncpg pool fake capturing every query and its parameters."""

    def __init__(self, row):
        self.row = row
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.row

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return "OK"


def _request_with_body(body: dict) -> Request:
    import json as jsonlib

    payload = jsonlib.dumps(body).encode()

    async def receive():
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "path": "/api/bot-status",
            "query_string": b"",
            "headers": [],
        },
        receive=receive,
    )


@pytest.mark.asyncio
async def test_rest_bot_status_updates_singleton_instance_id():
    pool = RecordingPool(STATUS_ROW)
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_bot_status_update(
            _request_with_body(
                {
                    "state": "idle",
                    "message": "Cycle complete.",
                    "external_key": "FM-162",
                    "repo": "org/repo",
                    "instance_id": "Bořivoj Lodník z Plovoucího hradu",
                }
            )
        )
    assert response.status_code == 200

    singleton_update = next(call for call in pool.calls if call[0] == "fetchrow")
    query, args = singleton_update[1], singleton_update[2]
    # The singleton UPDATE must refresh instance_id (COALESCE keeps the
    # previous value only when the payload omits it).
    assert "instance_id = COALESCE" in query
    assert args[-1] == "Bořivoj Lodník z Plovoucího hradu"

    instance_upsert = next(call for call in pool.calls if call[0] == "execute" and "bot_instances" in call[1])
    assert instance_upsert[2][0] == "Bořivoj Lodník z Plovoucího hradu"


@pytest.mark.asyncio
async def test_rest_bot_status_without_instance_id_keeps_singleton_value():
    pool = RecordingPool(STATUS_ROW)
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        response = await api_bot_status_update(
            _request_with_body(
                {
                    "state": "working",
                    "message": "Starting cycle...",
                }
            )
        )
    assert response.status_code == 200
    singleton_update = next(call for call in pool.calls if call[0] == "fetchrow")
    assert "instance_id = COALESCE" in singleton_update[1]
    assert singleton_update[2][-1] is None

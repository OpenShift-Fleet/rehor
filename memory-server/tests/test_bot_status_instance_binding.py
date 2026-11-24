"""Regression tests for REHOR-235: bot_status_update instance identity binding.

Instance identity must come from the X-Bot-Instance-Id HTTP header on the MCP
connection (injected by entrypoint.sh from BOT_INSTANCE_ID), never from an
LLM-supplied tool parameter. Client-supplied instance_id values — including
Unicode homoglyph typos — previously created phantom bot_instances rows via
the INSERT ... ON CONFLICT upsert.
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.tools.tasks import INSTANCE_ID_HEADER, register_task_tools, resolve_instance_id
from fastmcp import Client, FastMCP
from starlette.requests import Request

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)

STATUS_ROW = {
    "state": "working",
    "message": "Starting cycle...",
    "external_key": "REHOR-235",
    "source_type": "jira",
    "repo": "org/repo",
    "instance_id": None,
    "cycle_start": NOW,
    "updated_at": NOW,
}

# A homoglyph-corrupted echo of the real instance name (Cyrillic/Greek
# lookalikes for Ř/ě/ř/ý) — the exact failure mode behind REHOR-235.
HOMOGLYPH_INSTANCE_ID = "Рeнoř Нrиьý z Јеlеní"


class RecordingPool:
    """Minimal asyncpg pool fake capturing every query and its parameters."""

    def __init__(self, row):
        self.row = row
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append(("fetchrow", query, args))
        return self.row

    async def fetchval(self, query, *args):
        self.calls.append(("fetchval", query, args))
        return 0

    async def fetch(self, query, *args):
        self.calls.append(("fetch", query, args))
        return []

    async def execute(self, query, *args):
        self.calls.append(("execute", query, args))
        return "OK"


def _make_request(header_value):
    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "path": "/mcp",
            "query_string": b"",
            "headers": [(INSTANCE_ID_HEADER.encode("latin-1"), header_value.encode("utf-8"))],
        }
    )


def _header_requests():
    """Bind a synthetic HTTP request with the instance header to fastmcp's
    request context, mirroring what the streamable-HTTP transport provides."""
    from fastmcp.server.http import _current_http_request

    return _current_http_request


@pytest.mark.asyncio
async def test_mcp_schema_no_longer_exposes_instance_id():
    mcp = FastMCP(name="instance-binding-schema")
    register_task_tools(mcp)
    async with Client(mcp) as client:
        tools = await client.list_tools()
    tool = next(tool for tool in tools if tool.name == "bot_status_update")
    assert "instance_id" not in tool.inputSchema["properties"]
    assert set(tool.inputSchema["properties"]) == {"state", "message", "external_key", "repo"}
    assert "bound to the MCP connection" in tool.description


@pytest.mark.asyncio
async def test_client_supplied_instance_id_is_rejected():
    """Homoglyph regression: there is no schema path for client-supplied
    instance_id, so a corrupted echo cannot reach the bot_instances upsert."""
    mcp = FastMCP(name="instance-binding-reject")
    register_task_tools(mcp)
    pool = RecordingPool(STATUS_ROW)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as client:
            result = await client.call_tool(
                "bot_status_update",
                {"state": "working", "message": "hi", "instance_id": HOMOGLYPH_INSTANCE_ID},
                raise_on_error=False,
            )
    assert result.is_error
    assert pool.calls == []


@pytest.mark.asyncio
async def test_header_instance_id_drives_status_and_instance_upsert():
    mcp = FastMCP(name="instance-binding-header")
    register_task_tools(mcp)
    pool = RecordingPool(STATUS_ROW)
    contextvar = _header_requests()
    token = contextvar.set(_make_request("Řehoř Hrubý z Jelení"))
    try:
        with (
            patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
            patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
        ):
            async with Client(mcp) as client:
                result = await client.call_tool(
                    "bot_status_update",
                    {"state": "working", "message": "Starting cycle...", "external_key": "REHOR-235"},
                )
    finally:
        contextvar.reset(token)

    assert not result.is_error
    updates = [call for call in pool.calls if "UPDATE bot_status" in call[1]]
    upserts = [call for call in pool.calls if "INSERT INTO bot_instances" in call[1]]
    assert len(updates) == 1
    assert len(upserts) == 1
    # UTF-8 instance names survive the latin-1 ASGI header transport.
    assert updates[0][2][5] == "Řehoř Hrubý z Jelení"
    assert upserts[0][2][0] == "Řehoř Hrubý z Jelení"


@pytest.mark.asyncio
async def test_missing_header_updates_status_but_skips_instance_upsert():
    mcp = FastMCP(name="instance-binding-no-header")
    register_task_tools(mcp)
    pool = RecordingPool(STATUS_ROW)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with Client(mcp) as client:
            result = await client.call_tool(
                "bot_status_update",
                {"state": "idle", "message": "Cycle complete."},
            )

    assert not result.is_error
    updates = [call for call in pool.calls if "UPDATE bot_status" in call[1]]
    upserts = [call for call in pool.calls if "INSERT INTO bot_instances" in call[1]]
    assert len(updates) == 1
    # bot_status row keeps its current instance_id (COALESCE receives None).
    assert updates[0][2][5] is None
    assert upserts == []


@pytest.mark.asyncio
async def test_missing_header_warning_is_rate_limited(caplog):
    with (
        patch("bot_memory_server.tools.tasks._last_missing_header_warn", 0.0),
        patch("bot_memory_server.tools.tasks.time.monotonic", side_effect=[3600.0, 3600.0]),
    ):
        with caplog.at_level("WARNING", logger="bot_memory_server.tools.tasks"):
            assert resolve_instance_id() is None
            assert resolve_instance_id() is None
        assert len(caplog.records) == 1


def test_resolve_instance_id_reads_header_and_ignores_empty_values():
    contextvar = _header_requests()
    token = contextvar.set(_make_request("test-instance"))
    try:
        assert resolve_instance_id() == "test-instance"
    finally:
        contextvar.reset(token)
    token = contextvar.set(_make_request(""))
    try:
        assert resolve_instance_id() is None
    finally:
        contextvar.reset(token)


def test_resolve_instance_id_outside_http_context_returns_none():
    assert resolve_instance_id() is None

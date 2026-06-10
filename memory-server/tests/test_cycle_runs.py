"""Tests for cycle-runs REST API and MCP tools."""

import asyncio
import base64
import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.routing import Route

from src.api import api_cycle_runs, api_cycle_run_transcript


app = Starlette(
    routes=[
        Route("/api/cycle-runs", api_cycle_runs, methods=["GET", "POST"]),
        Route(
            "/api/cycle-runs/{id}/transcript",
            api_cycle_run_transcript,
            methods=["GET"],
        ),
    ]
)


def _fake_cycle_run_row(id=1, task_id=42, **kwargs):
    """Build a dict that looks like an asyncpg Record for cycle_runs."""
    now = datetime.now(timezone.utc)
    return {
        "id": id,
        "task_id": task_id,
        "cycle_type": kwargs.get("cycle_type", "task_work"),
        "instance_id": kwargs.get("instance_id", "test-instance"),
        "started_at": kwargs.get("started_at", now),
        "finished_at": kwargs.get("finished_at", now),
        "tool_calls": kwargs.get("tool_calls", 50),
        "tokens_used": kwargs.get("tokens_used", 100000),
        "progress": kwargs.get("progress", json.dumps({"last_step": "implemented"})),
        "created_at": kwargs.get("created_at", now),
        "transcript": kwargs.get("transcript"),
    }


@pytest.fixture
def mock_pool():
    pool = MagicMock()
    pool.fetchval = AsyncMock(return_value=1)
    pool.fetchrow = AsyncMock(
        side_effect=lambda q, *a: _fake_cycle_run_row(id=1, task_id=a[0])
    )
    pool.fetch = AsyncMock(return_value=[_fake_cycle_run_row()])
    pool.execute = AsyncMock()
    with patch("src.api.get_pool", return_value=pool):
        yield pool


# --- REST API: POST /api/cycle-runs ---


@pytest.mark.asyncio
async def test_post_cycle_run_basic(mock_pool):
    body = {
        "task_id": 42,
        "cycle_type": "task_work",
        "instance_id": "hcc-ai-framework",
        "progress": {"last_step": "pr_opened", "files_changed": ["src/foo.py"]},
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/cycle-runs", json=body)

    assert resp.status_code == 201
    data = resp.json()
    assert data["id"] == 1
    assert data["task_id"] == 42
    assert data["cycle_type"] == "task_work"
    mock_pool.fetchrow.assert_called_once()


@pytest.mark.asyncio
async def test_post_cycle_run_with_transcript(mock_pool):
    transcript_data = b'{"role": "assistant", "content": "hello"}\n'

    import zstandard as zstd

    compressor = zstd.ZstdCompressor(level=19)
    compressed = compressor.compress(transcript_data)

    body = {
        "task_id": 42,
        "cycle_type": "task_work",
        "instance_id": "test",
        "transcript_b64": base64.b64encode(compressed).decode(),
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/cycle-runs", json=body)

    assert resp.status_code == 201
    data = resp.json()
    assert data["has_transcript"] is True


@pytest.mark.asyncio
async def test_post_cycle_run_no_task(mock_pool):
    mock_pool.fetchrow = AsyncMock(
        side_effect=lambda q, *a: _fake_cycle_run_row(
            id=2, task_id=None, cycle_type="idle"
        )
    )
    body = {
        "cycle_type": "idle",
        "instance_id": "test",
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/cycle-runs", json=body)

    assert resp.status_code == 201
    data = resp.json()
    assert data["task_id"] is None
    assert data["cycle_type"] == "idle"


@pytest.mark.asyncio
async def test_post_cycle_run_with_timestamps(mock_pool):
    body = {
        "task_id": 42,
        "cycle_type": "task_work",
        "instance_id": "test",
        "started_at": "2026-06-10T12:00:00+00:00",
        "finished_at": "2026-06-10T12:05:00+00:00",
        "tool_calls": 87,
        "tokens_used": 150000,
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/cycle-runs", json=body)

    assert resp.status_code == 201
    call_args = mock_pool.fetchrow.call_args[0]
    assert call_args[6] == 87  # tool_calls
    assert call_args[7] == 150000  # tokens_used


# --- REST API: GET /api/cycle-runs ---


@pytest.mark.asyncio
async def test_get_cycle_runs_list(mock_pool):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs")

    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "total" in data
    assert len(data["items"]) == 1
    assert data["items"][0]["cycle_type"] == "task_work"


@pytest.mark.asyncio
async def test_get_cycle_runs_filter_by_task(mock_pool):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs?task_id=42")

    assert resp.status_code == 200
    call_args = mock_pool.fetch.call_args
    query = call_args[0][0]
    assert "task_id = $1" in query


@pytest.mark.asyncio
async def test_get_cycle_runs_filter_by_instance(mock_pool):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs?instance_id=hcc-ai-framework")

    assert resp.status_code == 200
    call_args = mock_pool.fetch.call_args
    query = call_args[0][0]
    assert "instance_id = $" in query


@pytest.mark.asyncio
async def test_get_cycle_runs_filter_by_cycle_type(mock_pool):
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs?cycle_type=idle")

    assert resp.status_code == 200
    call_args = mock_pool.fetch.call_args
    query = call_args[0][0]
    assert "cycle_type = $" in query


@pytest.mark.asyncio
async def test_get_cycle_runs_no_transcript_in_list(mock_pool):
    """Listing should never include transcript data."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs")

    data = resp.json()
    for item in data["items"]:
        assert "transcript" not in item
        assert "transcript_b64" not in item


# --- REST API: GET /api/cycle-runs/{id}/transcript ---


@pytest.mark.asyncio
async def test_get_transcript_not_found(mock_pool):
    mock_pool.fetchrow = AsyncMock(return_value=None)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs/999/transcript")

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_transcript_no_transcript_stored(mock_pool):
    mock_pool.fetchrow = AsyncMock(return_value={"transcript": None})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs/1/transcript")

    assert resp.status_code == 404
    assert "no transcript" in resp.json()["error"]


@pytest.mark.asyncio
async def test_get_transcript_raw(mock_pool):
    raw_bytes = b"compressed-data-here"
    mock_pool.fetchrow = AsyncMock(return_value={"transcript": raw_bytes})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get(
            "/api/cycle-runs/1/transcript",
            headers={"accept": "application/octet-stream"},
        )

    assert resp.status_code == 200
    assert "application/zstd" in resp.headers["content-type"]
    assert resp.content == raw_bytes


@pytest.mark.asyncio
async def test_get_transcript_decompressed(mock_pool):
    transcript_text = b'{"role": "assistant"}\n{"role": "user"}\n'

    import zstandard as zstd

    compressor = zstd.ZstdCompressor()
    compressed = compressor.compress(transcript_text)

    mock_pool.fetchrow = AsyncMock(return_value={"transcript": compressed})

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/cycle-runs/1/transcript?decompress=true")

    assert resp.status_code == 200
    assert resp.content == transcript_text
    assert resp.headers["content-type"] == "application/x-ndjson"


# --- MCP tools: progress_store / progress_load ---


async def _get_tool_fn(mcp_instance, tool_name):
    """Get the underlying function for an MCP tool by name."""
    tools = await mcp_instance.list_tools()
    for t in tools:
        if t.name == tool_name:
            return t.fn
    raise KeyError(f"Tool {tool_name} not found")


@pytest.fixture
def mock_pool_for_tools():
    pool = MagicMock()
    pool.fetchrow = AsyncMock(
        side_effect=lambda q, *a: _fake_cycle_run_row(id=1, task_id=a[0])
    )
    pool.fetch = AsyncMock(
        return_value=[
            _fake_cycle_run_row(id=1),
            _fake_cycle_run_row(
                id=2, progress=json.dumps({"last_step": "tests_passing"})
            ),
        ]
    )
    with patch("src.tools.cycles.get_pool", return_value=pool):
        yield pool


@pytest.fixture
def mcp_with_tools(mock_pool_for_tools):
    from src.tools.cycles import register_cycle_tools
    from fastmcp import FastMCP

    mcp = FastMCP(name="test")
    register_cycle_tools(mcp)
    return mcp


@pytest.mark.asyncio
async def test_progress_store(mock_pool_for_tools, mcp_with_tools):
    store_fn = await _get_tool_fn(mcp_with_tools, "progress_store")

    result = await store_fn(
        task_id=42,
        instance_id="test-instance",
        cycle_type="task_work",
        progress={"last_step": "implemented", "files_changed": ["a.py"]},
        tool_calls=50,
        tokens_used=100000,
    )

    assert result["id"] == 1
    assert result["task_id"] == 42
    mock_pool_for_tools.fetchrow.assert_called_once()
    query = mock_pool_for_tools.fetchrow.call_args[0][0]
    assert "INSERT INTO cycle_runs" in query


@pytest.mark.asyncio
async def test_progress_store_null_task(mock_pool_for_tools, mcp_with_tools):
    mock_pool_for_tools.fetchrow = AsyncMock(
        side_effect=lambda q, *a: _fake_cycle_run_row(id=3, task_id=None)
    )

    store_fn = await _get_tool_fn(mcp_with_tools, "progress_store")

    result = await store_fn(
        task_id=0,
        instance_id="test",
        cycle_type="idle",
    )

    assert result["task_id"] is None
    call_args = mock_pool_for_tools.fetchrow.call_args[0]
    assert call_args[1] is None  # resolved_task_id


@pytest.mark.asyncio
async def test_progress_load(mock_pool_for_tools, mcp_with_tools):
    load_fn = await _get_tool_fn(mcp_with_tools, "progress_load")

    results = await load_fn(task_id=42, limit=5)

    assert len(results) == 2
    assert results[0]["id"] == 1
    mock_pool_for_tools.fetch.assert_called_once()
    query = mock_pool_for_tools.fetch.call_args[0][0]
    assert "task_id = $1" in query
    assert "ORDER BY created_at DESC" in query


@pytest.mark.asyncio
async def test_progress_load_with_instance_filter(mock_pool_for_tools, mcp_with_tools):
    load_fn = await _get_tool_fn(mcp_with_tools, "progress_load")

    await load_fn(task_id=42, instance_id="hcc-ai-framework", limit=3)

    query = mock_pool_for_tools.fetch.call_args[0][0]
    assert "instance_id = $2" in query


@pytest.mark.asyncio
async def test_progress_load_limit_capped(mock_pool_for_tools, mcp_with_tools):
    load_fn = await _get_tool_fn(mcp_with_tools, "progress_load")

    await load_fn(task_id=42, limit=999)

    call_args = mock_pool_for_tools.fetch.call_args[0]
    assert call_args[2] == 50  # capped at 50

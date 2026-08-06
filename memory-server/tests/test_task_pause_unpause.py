"""Tests for task pause/unpause/unarchive REST API endpoints."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bot_memory_server.api import api_task_pause, api_task_unarchive, api_task_unpause
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.routing import Route

app = Starlette(
    routes=[
        Route("/api/tasks/{key:path}/pause", api_task_pause, methods=["POST"]),
        Route("/api/tasks/{key:path}/unpause", api_task_unpause, methods=["POST"]),
        Route("/api/tasks/{key:path}/unarchive", api_task_unarchive, methods=["POST"]),
    ]
)


def _fake_task_row(key="RHCLOUD-100", status="in_progress", **kwargs):
    now = datetime.now(UTC)
    return {
        "id": kwargs.get("id", 1),
        "external_key": key,
        "source_type": kwargs.get("source_type", "jira"),
        "source_url": kwargs.get("source_url"),
        "artifacts": kwargs.get("artifacts", "[]"),
        "status": status,
        "repo": kwargs.get("repo", "org/repo"),
        "branch": kwargs.get("branch"),
        "title": kwargs.get("title"),
        "summary": kwargs.get("summary"),
        "created_at": now,
        "updated_at": now,
        "last_addressed": now,
        "paused_reason": kwargs.get("paused_reason"),
        "instance_id": kwargs.get("instance_id", "dev-bot"),
        "metadata": kwargs.get("metadata", "{}"),
    }


@pytest.fixture
def mock_pool():
    pool = MagicMock()
    pool.fetchrow = AsyncMock()
    pool.fetchval = AsyncMock(return_value=0)
    pool.fetch = AsyncMock(return_value=[])
    pool.execute = AsyncMock()
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        yield pool


@pytest.fixture(autouse=True)
def _silence_bus():
    with patch("bot_memory_server.api.bus") as mock_bus:
        mock_bus.publish = AsyncMock()
        yield mock_bus


# --- Pause tests ---


@pytest.mark.asyncio
async def test_pause_active_task(mock_pool):
    mock_pool.fetchrow.return_value = _fake_task_row(status="paused", paused_reason="Paused via dashboard")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/pause")

    assert resp.status_code == 200
    data = resp.json()
    assert data["paused"] is True
    assert data["task"]["paused_reason"] == "Paused via dashboard"


@pytest.mark.asyncio
async def test_pause_with_custom_reason(mock_pool):
    mock_pool.fetchrow.return_value = _fake_task_row(status="paused", paused_reason="waiting on UX")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post(
            "/api/tasks/RHCLOUD-100/pause",
            json={"paused_reason": "waiting on UX"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["task"]["paused_reason"] == "waiting on UX"


@pytest.mark.asyncio
async def test_pause_default_reason(mock_pool):
    mock_pool.fetchrow.return_value = _fake_task_row(status="paused")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/pause", content=b"{}")

    assert resp.status_code == 200
    call_args = mock_pool.fetchrow.call_args[0]
    assert call_args[1] == "RHCLOUD-100"  # $1 = key
    assert call_args[2] == "Paused via dashboard"  # $2 = reason


@pytest.mark.asyncio
async def test_pause_saves_status_before_pause(mock_pool):
    mock_pool.fetchrow.return_value = _fake_task_row(status="paused")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/tasks/RHCLOUD-100/pause", content=b"{}")

    query = mock_pool.fetchrow.call_args[0][0]
    assert "jsonb_set" in query
    assert "status_before_pause" in query


@pytest.mark.asyncio
async def test_pause_non_active_task_404(mock_pool):
    mock_pool.fetchrow.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-999/pause")

    assert resp.status_code == 404
    assert "not found or not active" in resp.json()["error"]


# --- Unpause tests ---


@pytest.mark.asyncio
async def test_unpause_paused_task(mock_pool):
    select_row = _fake_task_row(
        status="paused",
        metadata=json.dumps({"status_before_pause": "in_progress"}),
    )
    updated_row = _fake_task_row(status="in_progress")
    mock_pool.fetchrow.side_effect = [select_row, updated_row]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/unpause")

    assert resp.status_code == 200
    data = resp.json()
    assert data["unpaused"] is True
    assert data["task"]["status"] == "in_progress"


@pytest.mark.asyncio
async def test_unpause_restores_pr_open(mock_pool):
    select_row = _fake_task_row(
        status="paused",
        metadata=json.dumps({"status_before_pause": "pr_open"}),
    )
    updated_row = _fake_task_row(status="pr_open")
    mock_pool.fetchrow.side_effect = [select_row, updated_row]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/unpause")

    assert resp.status_code == 200
    assert resp.json()["task"]["status"] == "pr_open"
    update_call_args = mock_pool.fetchrow.call_args_list[1][0]
    assert update_call_args[2] == "pr_open"


@pytest.mark.asyncio
async def test_unpause_non_paused_404(mock_pool):
    mock_pool.fetchrow.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/unpause")

    assert resp.status_code == 404


# --- Event bus assertions ---


@pytest.mark.asyncio
async def test_pause_publishes_event(mock_pool, _silence_bus):
    mock_pool.fetchrow.return_value = _fake_task_row(status="paused", paused_reason="blocked")

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post(
            "/api/tasks/RHCLOUD-100/pause",
            json={"paused_reason": "blocked"},
        )

    _silence_bus.publish.assert_awaited_once()
    event = _silence_bus.publish.call_args[0][0]
    assert event.type == "task_updated"
    assert event.data["external_key"] == "RHCLOUD-100"
    assert event.data["status"] == "paused"
    assert event.data["summary"] == "blocked"


@pytest.mark.asyncio
async def test_unpause_publishes_event(mock_pool, _silence_bus):
    select_row = _fake_task_row(
        status="paused",
        metadata=json.dumps({"status_before_pause": "pr_open"}),
    )
    updated_row = _fake_task_row(status="pr_open")
    mock_pool.fetchrow.side_effect = [select_row, updated_row]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        await client.post("/api/tasks/RHCLOUD-100/unpause")

    _silence_bus.publish.assert_awaited_once()
    event = _silence_bus.publish.call_args[0][0]
    assert event.type == "task_updated"
    assert event.data["external_key"] == "RHCLOUD-100"
    assert event.data["status"] == "pr_open"


# --- Unarchive tests ---


@pytest.mark.asyncio
async def test_unarchive_success(mock_pool):
    existing_row = _fake_task_row(status="archived")
    restored_row = _fake_task_row(status="in_progress")
    mock_pool.fetchrow.side_effect = [existing_row, restored_row]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-100/unarchive")

    assert resp.status_code == 200
    data = resp.json()
    assert data["unarchived"] is True
    assert data["external_key"] == "RHCLOUD-100"


@pytest.mark.asyncio
async def test_unarchive_not_archived_404(mock_pool):
    mock_pool.fetchrow.return_value = None

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.post("/api/tasks/RHCLOUD-999/unarchive")

    assert resp.status_code == 404
    assert "not found or not archived" in resp.json()["error"]

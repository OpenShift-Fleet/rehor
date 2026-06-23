"""Tests for the POST /api/memories/upload endpoint."""

import json
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.routing import Route

from bot_memory_server.api import api_memory_upload

app = Starlette(
    routes=[Route("/api/memories/upload", api_memory_upload, methods=["POST"])]
)


def _fake_row(id: int, title: str, category: str, **kwargs):
    """Build a dict that looks like an asyncpg Record."""
    return {
        "id": id,
        "title": title,
        "category": category,
        "content": kwargs.get("content", "test"),
        "repo": kwargs.get("repo"),
        "external_key": kwargs.get("external_key"),
        "source_type": kwargs.get("source_type"),
        "tags": kwargs.get("tags", []),
        "created_at": datetime.now(timezone.utc),
        "metadata": json.dumps(kwargs.get("metadata", {})),
        "embedding": [0.0] * 384,
    }


@pytest.fixture
def mock_pool():
    pool = MagicMock()
    pool.fetchval = AsyncMock(return_value=None)
    pool.fetchrow = AsyncMock(side_effect=lambda q, *a: _fake_row(1, a[3], a[0]))
    with patch("bot_memory_server.api.get_pool", return_value=pool):
        yield pool


@pytest.fixture
def mock_embed():
    with patch("bot_memory_server.api.embed", return_value=[0.0] * 384) as m:
        yield m


@pytest.mark.asyncio
async def test_returns_404_when_disabled(monkeypatch):
    monkeypatch.delenv("UPLOAD_MEMORY_PASSWORD", raising=False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/memories/upload", json={"memories": []})
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_returns_403_wrong_token(monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "correct-password")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": []},
            headers={"Authorization": "Bearer wrong"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_returns_403_missing_header(monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "correct-password")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/memories/upload", json={"memories": []})
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_upload_empty_list(monkeypatch):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "secret")
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": []},
            headers={"Authorization": "Bearer secret"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"uploaded": 0, "errors": []}


@pytest.mark.asyncio
async def test_upload_single_memory(monkeypatch, mock_pool, mock_embed):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "secret")
    memories = [
        {
            "category": "learning",
            "title": "Test",
            "content": "Some content",
            "tags": ["ci"],
        }
    ]

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": memories},
            headers={"Authorization": "Bearer secret"},
        )

    assert resp.status_code == 200
    data = resp.json()
    assert data["uploaded"] == 1
    assert data["errors"] == []
    mock_embed.assert_called_once_with("Test\nSome content")
    mock_pool.fetchrow.assert_called_once()


@pytest.mark.asyncio
async def test_skips_duplicates(monkeypatch, mock_pool, mock_embed):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "secret")
    mock_pool.fetchval = AsyncMock(return_value=42)

    memories = [
        {"category": "learning", "title": "Existing", "content": "Already there"}
    ]

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": memories},
            headers={"Authorization": "Bearer secret"},
        )

    data = resp.json()
    assert data["uploaded"] == 0
    assert len(data["errors"]) == 1
    assert data["errors"][0]["reason"] == "duplicate"
    mock_pool.fetchrow.assert_not_called()


@pytest.mark.asyncio
async def test_reports_missing_fields(monkeypatch, mock_pool, mock_embed):
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "secret")
    memories = [{"category": "learning"}]  # missing title and content

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": memories},
            headers={"Authorization": "Bearer secret"},
        )

    data = resp.json()
    assert data["uploaded"] == 0
    assert len(data["errors"]) == 1
    assert "missing field" in data["errors"][0]["reason"]


@pytest.mark.asyncio
async def test_upload_ignores_extra_fields(monkeypatch, mock_pool, mock_embed):
    """Memories exported from GET /api/memories include id and created_at — these should be ignored."""
    monkeypatch.setenv("UPLOAD_MEMORY_PASSWORD", "secret")
    memories = [
        {
            "id": 999,
            "category": "learning",
            "title": "From export",
            "content": "Exported content",
            "created_at": "2026-01-01T00:00:00Z",
            "tags": [],
        }
    ]

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post(
            "/api/memories/upload",
            json={"memories": memories},
            headers={"Authorization": "Bearer secret"},
        )

    data = resp.json()
    assert data["uploaded"] == 1
    assert data["errors"] == []

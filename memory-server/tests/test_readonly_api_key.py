"""Tests for readonly server API key middleware and route registration."""

from unittest.mock import AsyncMock, patch

import pytest
from bot_memory_server.readonly_server import ApiKeyMiddleware
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

# -- helpers --


async def _ok_handler(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


def _build_app(api_key: str) -> ApiKeyMiddleware:
    """Build a minimal Starlette app wrapped with ApiKeyMiddleware."""
    inner = Starlette(
        routes=[
            Route("/health", _ok_handler, methods=["GET"]),
            Route("/api/task-outcomes/summary", _ok_handler, methods=["GET"]),
            Route("/api/task-outcomes/trends", _ok_handler, methods=["GET"]),
            Route("/other", _ok_handler, methods=["GET"]),
        ]
    )
    return ApiKeyMiddleware(inner, api_key=api_key)


# -- middleware: key set --


@pytest.mark.anyio
async def test_correct_key_returns_200():
    app = _build_app("secret-key")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/task-outcomes/summary", headers={"X-API-Key": "secret-key"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_missing_key_returns_401():
    app = _build_app("secret-key")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/task-outcomes/summary")
    assert resp.status_code == 401
    assert resp.json() == {"error": "unauthorized"}


@pytest.mark.anyio
async def test_wrong_key_returns_401():
    app = _build_app("secret-key")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/task-outcomes/trends", headers={"X-API-Key": "wrong-key"})
    assert resp.status_code == 401


# -- middleware: fail-closed when key unset --


@pytest.mark.anyio
async def test_no_key_configured_returns_401():
    """Fail-closed: unset READONLY_API_KEY blocks protected endpoints."""
    app = _build_app("")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/task-outcomes/summary")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_no_key_configured_still_returns_401_with_header():
    """Even supplying a header doesn't help when no key is configured."""
    app = _build_app("")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/api/task-outcomes/summary", headers={"X-API-Key": "anything"})
    assert resp.status_code == 401


# -- middleware: scope (only /api/task-outcomes/) --


@pytest.mark.anyio
async def test_health_bypasses_auth():
    app = _build_app("secret-key")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_non_protected_path_bypasses_auth():
    """Paths outside /api/task-outcomes/ are not guarded (e.g. MCP tools)."""
    app = _build_app("secret-key")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/other")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


@pytest.mark.anyio
async def test_health_works_when_key_unset():
    app = _build_app("")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/health")
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_non_protected_path_works_when_key_unset():
    """Non-outcome paths work even when no key is configured."""
    app = _build_app("")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        resp = await client.get("/other")
    assert resp.status_code == 200


# -- route registration tests --


def _summary_row():
    """Minimal dict-like return for the summary fetchrow query."""
    fields = [
        "task_count",
        "delivery_task_count",
        "monitoring_count",
        "grooming_count",
        "grooming_accepted_count",
        "grooming_rejected_count",
        "grooming_obsolete_count",
        "grooming_inconclusive_count",
        "grooming_unreported_count",
        "grooming_wip_count",
        "accepted_count",
        "accepted_no_op_count",
        "rejected_count",
        "obsolete_count",
        "inconclusive_count",
        "unreported_count",
        "wip_count",
    ]
    return dict.fromkeys(fields, 0)


@pytest.mark.anyio
async def test_task_outcome_routes_registered():
    """Verify the readonly_mcp has the task-outcome endpoints registered."""
    mock_pool = AsyncMock()
    mock_pool.fetchrow = AsyncMock(return_value=_summary_row())
    mock_pool.fetch = AsyncMock(return_value=[])
    mock_pool.fetchval = AsyncMock(return_value=0)

    with patch("bot_memory_server.task_outcomes.get_pool", return_value=mock_pool):
        from bot_memory_server.readonly_server import readonly_mcp

        readonly_app = readonly_mcp.http_app(transport="streamable-http")
        async with AsyncClient(transport=ASGITransport(app=readonly_app), base_url="http://test") as client:
            resp = await client.get("/api/task-outcomes/summary")
            assert resp.status_code == 200
            assert "summary" in resp.json()

            resp = await client.get("/api/task-outcomes/trends")
            assert resp.status_code == 200
            assert "months" in resp.json()

            resp = await client.get("/api/task-outcomes/tasks")
            assert resp.status_code == 200
            data = resp.json()
            assert "items" in data
            assert "total" in data

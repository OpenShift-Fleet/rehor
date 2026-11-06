"""Read-only Team Memory MCP — memory_search, memory_list, and task-outcome metrics.

Exposes read-only task-outcome endpoints behind an API key so that
remote sites (e.g. EPD generators) can pull metrics without a cluster credential.

When the ApiKeyMiddleware is applied (external Route exposure):
  /health → always open (probes).
  /api/task-outcomes/* → require X-API-Key; fail-closed when key is unset.
  Everything else (MCP tools, etc.) → 404.

This ensures the Route only exposes the intended endpoints.
"""

import os

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .task_outcomes import (
    api_task_outcome_detail,
    api_task_outcomes,
    api_task_outcomes_summary,
    api_task_outcomes_trends,
)
from .tools.rag import register_rag_read_tools

_PROTECTED_PREFIX = "/api/task-outcomes/"
_HEALTH_PATH = "/health"
_UNAUTHORIZED = JSONResponse({"error": "unauthorized"}, status_code=401)
_NOT_FOUND = JSONResponse({"error": "not found"}, status_code=404)


class ApiKeyMiddleware:
    """Gate the readonly server for external exposure via Route.

    Only /health and /api/task-outcomes/* are allowed through.
    Task-outcome paths require a valid X-API-Key (fail-closed when unset).
    Everything else (including MCP tools) returns 404.
    """

    def __init__(self, app: ASGIApp, *, api_key: str) -> None:
        self.app = app
        self.api_key = api_key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope["path"]

        # /health — always open (probes)
        if path == _HEALTH_PATH:
            await self.app(scope, receive, send)
            return

        # /api/task-outcomes/* — require API key, fail-closed
        if path.startswith(_PROTECTED_PREFIX):
            if not self.api_key:
                await _UNAUTHORIZED(scope, receive, send)
                return
            request = Request(scope, receive)
            if request.headers.get("x-api-key") != self.api_key:
                await _UNAUTHORIZED(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        # everything else (MCP tools, etc.) — not exposed
        await _NOT_FOUND(scope, receive, send)


readonly_mcp = FastMCP(name="Team Memory")
register_rag_read_tools(readonly_mcp)


@readonly_mcp.custom_route("/health", methods=["GET"])
async def readonly_health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


# -- task-outcome read-only endpoints (same paths as main server) --
readonly_mcp.custom_route("/api/task-outcomes/summary", methods=["GET"])(api_task_outcomes_summary)
readonly_mcp.custom_route("/api/task-outcomes/trends", methods=["GET"])(api_task_outcomes_trends)
readonly_mcp.custom_route("/api/task-outcomes/tasks", methods=["GET"])(api_task_outcomes)
readonly_mcp.custom_route("/api/task-outcomes/tasks/{task_id}", methods=["GET"])(api_task_outcome_detail)


def get_readonly_api_key() -> str:
    """Return the configured API key (re-reads env for testability)."""
    return os.environ.get("READONLY_API_KEY", "")

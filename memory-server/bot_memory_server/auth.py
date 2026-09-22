"""Bearer-token auth for the public read-only MCP endpoint."""

import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


def get_memory_api_key() -> str | None:
    return os.environ.get("MEMORY_API_KEY") or None


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Require Authorization: Bearer <MEMORY_API_KEY> on all paths except /health.

    Fail closed: if MEMORY_API_KEY is unset, non-health requests get 503.
    Intended only for the public read-only port (:8081), not the internal bot MCP.
    """

    async def dispatch(self, request: Request, call_next):
        if request.url.path == "/health" and request.method == "GET":
            return await call_next(request)

        secret = get_memory_api_key()
        if not secret:
            return JSONResponse(
                {"error": "MEMORY_API_KEY not configured"},
                status_code=503,
            )

        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != secret:
            return JSONResponse({"error": "forbidden"}, status_code=403)

        return await call_next(request)

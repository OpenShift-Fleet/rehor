import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.routing import Mount, WebSocketRoute
from starlette.websockets import WebSocket

from .db import close_pool, init_pool
from .embeddings import load_model
from .events import bus

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app):
    logger.info("Loading embedding model...")
    load_model()
    logger.info("Connecting to database...")
    await init_pool()
    logger.info("Memory server ready")
    yield
    await close_pool()


mcp = FastMCP(
    name="Bot Memory",
)

# Register MCP tools
from .tools.tasks import register_task_tools  # noqa: E402
from .tools.rag import register_rag_tools  # noqa: E402
from .tools.slack import register_slack_tools  # noqa: E402
from .tools.org_members import register_org_member_tools  # noqa: E402

register_task_tools(mcp)
register_rag_tools(mcp)
register_slack_tools(mcp)
register_org_member_tools(mcp)


# Health check
@mcp.custom_route("/health", methods=["GET"])
async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


# Dashboard UI
@mcp.custom_route("/", methods=["GET"])
async def dashboard(request: Request) -> HTMLResponse:
    html = (STATIC_DIR / "index.html").read_text()
    return HTMLResponse(html)


# Static files
@mcp.custom_route("/static/{path:path}", methods=["GET"])
async def static_files(request: Request) -> FileResponse:
    file_path = STATIC_DIR / request.path_params["path"]
    return FileResponse(file_path)


# Static assets (Vite build output)
@mcp.custom_route("/assets/{path:path}", methods=["GET"])
async def asset_files(request: Request) -> FileResponse:
    file_path = STATIC_DIR / "assets" / request.path_params["path"]
    return FileResponse(file_path)


# REST API for the dashboard
from .api import (  # noqa: E402
    api_tasks,
    api_task_delete,
    api_task_unarchive,
    api_memories,
    api_memory_get,
    api_memory_search,
    api_memory_embeddings,
    api_memory_delete,
    api_memory_upload,
    api_tags,
    api_stats,
    api_bot_status,
    api_instances,
    api_costs,
    api_analytics,
)

mcp.custom_route("/api/tasks", methods=["GET"])(api_tasks)
mcp.custom_route("/api/tasks/{jira_key:path}", methods=["DELETE"])(api_task_delete)
mcp.custom_route("/api/tasks/{jira_key:path}/unarchive", methods=["POST"])(
    api_task_unarchive
)
mcp.custom_route("/api/memories", methods=["GET"])(api_memories)
mcp.custom_route("/api/memories/search", methods=["GET"])(api_memory_search)
mcp.custom_route("/api/memories/upload", methods=["POST"])(api_memory_upload)
mcp.custom_route("/api/memories/embeddings", methods=["GET"])(api_memory_embeddings)
mcp.custom_route("/api/memories/{id}", methods=["GET"])(api_memory_get)
mcp.custom_route("/api/memories/{id}", methods=["DELETE"])(api_memory_delete)
mcp.custom_route("/api/bot-status", methods=["GET", "POST"])(api_bot_status)
mcp.custom_route("/api/instances", methods=["GET"])(api_instances)
mcp.custom_route("/api/costs", methods=["GET", "POST"])(api_costs)
mcp.custom_route("/api/tags", methods=["GET"])(api_tags)
mcp.custom_route("/api/stats", methods=["GET"])(api_stats)
mcp.custom_route("/api/analytics", methods=["GET"])(api_analytics)


# WebSocket for live updates
async def ws_events(websocket: WebSocket):
    await websocket.accept()
    queue = bus.subscribe()
    try:
        while True:
            event = await queue.get()
            await websocket.send_text(event.to_sse_json())
    except Exception:
        pass
    finally:
        bus.unsubscribe(queue)


if __name__ == "__main__":
    # Build the MCP app (handles /mcp endpoint + custom routes)
    mcp_app = mcp.http_app(transport="streamable-http")

    @asynccontextmanager
    async def combined_lifespan(app):
        async with lifespan(app):
            async with mcp_app.lifespan(app):
                yield

    # Wrap in an outer Starlette app so we can add WebSocket + lifespan
    app = Starlette(
        lifespan=combined_lifespan,
        routes=[
            WebSocketRoute("/ws", ws_events),
            Mount("/", app=mcp_app),
        ],
    )
    uvicorn.run(app, host="0.0.0.0", port=8080)

import asyncio
import contextlib
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastmcp import FastMCP
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.routing import Mount, Route, WebSocketRoute
from starlette.websockets import WebSocket

from .db import close_pool, init_pool
from .embeddings import load_model
from .events import bus
from .metrics import PrometheusMiddleware, db_gauge_refresh_loop

logger = logging.getLogger(__name__)

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app):
    logger.info("Loading embedding model...")
    load_model()
    logger.info("Connecting to database...")
    await init_pool()
    gauge_task = asyncio.create_task(db_gauge_refresh_loop())
    logger.info("Memory server ready")
    yield
    gauge_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await gauge_task
    await close_pool()


def build_app() -> tuple[Starlette, Starlette]:
    """Construct FastMCP, register tools and routes, and return (app, metrics_app)."""
    mcp = FastMCP(
        name="Bot Memory",
    )

    # Register MCP tools
    from .tools.cycles import register_cycle_tools
    from .tools.konflux import register_konflux_tools
    from .tools.org_members import register_org_member_tools
    from .tools.rag import register_rag_tools
    from .tools.slack import register_slack_tools
    from .tools.tasks import register_task_tools

    register_task_tools(mcp)
    register_rag_tools(mcp)
    register_slack_tools(mcp)
    register_org_member_tools(mcp)
    register_cycle_tools(mcp)
    register_konflux_tools(mcp)

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
    from .api import (
        api_analytics,
        api_bot_status,
        api_costs,
        api_cycle_run_transcript,
        api_cycle_runs,
        api_cycle_runs_by_task,
        api_instance_get,
        api_instance_idle_update,
        api_instances,
        api_memories,
        api_memory_delete,
        api_memory_embeddings,
        api_memory_get,
        api_memory_search,
        api_memory_upload,
        api_stats,
        api_tags,
        api_task_delete,
        api_task_pause,
        api_task_unarchive,
        api_task_unpause,
        api_tasks,
    )

    mcp.custom_route("/api/tasks", methods=["GET"])(api_tasks)
    mcp.custom_route("/api/tasks/{key:path}", methods=["DELETE"])(api_task_delete)
    mcp.custom_route("/api/tasks/{key:path}/unarchive", methods=["POST"])(api_task_unarchive)
    mcp.custom_route("/api/tasks/{key:path}/pause", methods=["POST"])(api_task_pause)
    mcp.custom_route("/api/tasks/{key:path}/unpause", methods=["POST"])(api_task_unpause)
    mcp.custom_route("/api/memories", methods=["GET"])(api_memories)
    mcp.custom_route("/api/memories/search", methods=["GET"])(api_memory_search)
    mcp.custom_route("/api/memories/upload", methods=["POST"])(api_memory_upload)
    mcp.custom_route("/api/memories/embeddings", methods=["GET"])(api_memory_embeddings)
    mcp.custom_route("/api/memories/{id}", methods=["GET"])(api_memory_get)
    mcp.custom_route("/api/memories/{id}", methods=["DELETE"])(api_memory_delete)
    mcp.custom_route("/api/bot-status", methods=["GET", "POST"])(api_bot_status)
    mcp.custom_route("/api/instances", methods=["GET"])(api_instances)
    mcp.custom_route("/api/instances/{instance_id}", methods=["GET"])(api_instance_get)
    mcp.custom_route("/api/instances/{instance_id}/idle", methods=["PATCH"])(api_instance_idle_update)
    mcp.custom_route("/api/costs", methods=["GET", "POST"])(api_costs)
    mcp.custom_route("/api/tags", methods=["GET"])(api_tags)
    mcp.custom_route("/api/stats", methods=["GET"])(api_stats)
    mcp.custom_route("/api/analytics", methods=["GET"])(api_analytics)
    mcp.custom_route("/api/cycle-runs", methods=["GET", "POST"])(api_cycle_runs)
    mcp.custom_route("/api/cycle-runs/by-task", methods=["GET"])(api_cycle_runs_by_task)
    mcp.custom_route("/api/cycle-runs/{id}/transcript", methods=["GET"])(api_cycle_run_transcript)


# Static assets (Vite build output)
@mcp.custom_route("/assets/{path:path}", methods=["GET"])
async def asset_files(request: Request) -> FileResponse:
    file_path = STATIC_DIR / "assets" / request.path_params["path"]
    return FileResponse(file_path)


# REST API for the dashboard
from .api import (
    api_analytics,
    api_bot_status,
    api_costs,
    api_cycle_run_transcript,
    api_cycle_runs,
    api_cycle_runs_by_task,
    api_instance_get,
    api_instance_idle_update,
    api_instances,
    api_memories,
    api_memory_delete,
    api_memory_embeddings,
    api_memory_get,
    api_memory_search,
    api_memory_upload,
    api_stats,
    api_tags,
    api_task_delete,
    api_task_pause,
    api_task_unarchive,
    api_task_unpause,
    api_tasks,
)

mcp.custom_route("/api/tasks", methods=["GET"])(api_tasks)
mcp.custom_route("/api/tasks/{key:path}", methods=["DELETE"])(api_task_delete)
mcp.custom_route("/api/tasks/{key:path}/unarchive", methods=["POST"])(api_task_unarchive)
mcp.custom_route("/api/tasks/{key:path}/pause", methods=["POST"])(api_task_pause)
mcp.custom_route("/api/tasks/{key:path}/unpause", methods=["POST"])(api_task_unpause)
mcp.custom_route("/api/memories", methods=["GET"])(api_memories)
mcp.custom_route("/api/memories/search", methods=["GET"])(api_memory_search)
mcp.custom_route("/api/memories/upload", methods=["POST"])(api_memory_upload)
mcp.custom_route("/api/memories/embeddings", methods=["GET"])(api_memory_embeddings)
mcp.custom_route("/api/memories/{id}", methods=["GET"])(api_memory_get)
mcp.custom_route("/api/memories/{id}", methods=["DELETE"])(api_memory_delete)
mcp.custom_route("/api/bot-status", methods=["GET", "POST"])(api_bot_status)
mcp.custom_route("/api/instances", methods=["GET"])(api_instances)
mcp.custom_route("/api/instances/{instance_id}", methods=["GET"])(api_instance_get)
mcp.custom_route("/api/instances/{instance_id}/idle", methods=["PATCH"])(api_instance_idle_update)
mcp.custom_route("/api/costs", methods=["GET", "POST"])(api_costs)
mcp.custom_route("/api/tags", methods=["GET"])(api_tags)
mcp.custom_route("/api/stats", methods=["GET"])(api_stats)
mcp.custom_route("/api/analytics", methods=["GET"])(api_analytics)
mcp.custom_route("/api/cycle-runs", methods=["GET", "POST"])(api_cycle_runs)
mcp.custom_route("/api/cycle-runs/by-task", methods=["GET"])(api_cycle_runs_by_task)
mcp.custom_route("/api/cycle-runs/{id}/transcript", methods=["GET"])(api_cycle_run_transcript)


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
    # Build the MCP apps (handles /mcp endpoint + custom routes)
    mcp_app = mcp.http_app(transport="streamable-http")

    from .auth import BearerAuthMiddleware
    from .readonly_server import readonly_mcp

    readonly_mcp_app = readonly_mcp.http_app(transport="streamable-http")

    async def metrics_endpoint(request: Request) -> Response:
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    metrics_app = Starlette(routes=[Route("/metrics", metrics_endpoint)])

    from starlette.middleware import Middleware

    @asynccontextmanager
    async def main_lifespan(app):
        # Model + DB once, then start the full MCP session manager.
        async with lifespan(app), mcp_app.lifespan(app):
            yield

    @asynccontextmanager
    async def readonly_lifespan(app):
        # Session manager only — model/DB already loaded by main_lifespan.
        async with readonly_mcp_app.lifespan(app):
            yield

    app = Starlette(
        lifespan=main_lifespan,
        middleware=[Middleware(PrometheusMiddleware)],
        routes=[
            WebSocketRoute("/ws", ws_events),
            Mount("/", app=mcp_app),
        ],
    )
    return app, metrics_app

    # Public read-only MCP (:8081) — memory_search / memory_list + Bearer auth.
    readonly_app = Starlette(
        lifespan=readonly_lifespan,
        middleware=[Middleware(BearerAuthMiddleware)],
        routes=[Mount("/", app=readonly_mcp_app)],
    )

    async def serve():
        # Start main first so model/DB init completes before readonly accepts traffic.
        main_server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=8080))
        readonly_config = uvicorn.Config(readonly_app, host="0.0.0.0", port=8081)
        metrics_server = uvicorn.Server(uvicorn.Config(metrics_app, host="0.0.0.0", port=9091))

        main_task = asyncio.create_task(main_server.serve())
        metrics_task = asyncio.create_task(metrics_server.serve())

        # Wait until main has finished startup (model + DB ready).
        while not main_server.started:
            if main_task.done():
                await main_task  # re-raise startup failure
                return
            await asyncio.sleep(0.05)

        readonly_server = uvicorn.Server(readonly_config)
        await asyncio.gather(main_task, readonly_server.serve(), metrics_task)

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
    from .log import setup_logging

    setup_logging()

    try:
        app, metrics_app = build_app()

        async def serve():
            main_server = uvicorn.Server(uvicorn.Config(app, host="0.0.0.0", port=8080, log_config=None))
            metrics_server = uvicorn.Server(uvicorn.Config(metrics_app, host="0.0.0.0", port=9091, log_config=None))
            await asyncio.gather(main_server.serve(), metrics_server.serve())

        asyncio.run(serve())
    except Exception:
        logger.exception("Fatal error during memory server startup/execution")
        sys.exit(1)

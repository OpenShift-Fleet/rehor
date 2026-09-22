"""Read-only Team Memory MCP — memory_search and memory_list only."""

from fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

from .tools.rag import register_rag_read_tools

readonly_mcp = FastMCP(name="Team Memory")
register_rag_read_tools(readonly_mcp)


@readonly_mcp.custom_route("/health", methods=["GET"])
async def readonly_health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})

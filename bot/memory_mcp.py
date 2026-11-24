"""Shared bot-memory MCP client for skill scripts.

Uses the MCP Python SDK for proper session handling over streamable HTTP.

Usage:
    from memory_mcp import memory_call

    data = memory_call("slack_notify", {"external_key": "X", ...})
"""

import asyncio
import contextlib
import json
import os
import sys
from pathlib import Path

MEMORY_MCP_URL = os.environ.get("BOT_MEMORY_URL", "").rstrip("/")

_session = None
_read = None
_write = None
_cm_transport = None
_cm_session = None


def _headers(url):
    headers = {}
    instance = os.environ.get("BOT_INSTANCE_ID", "")
    if instance:
        # HTTPX accepts bytes; the server decodes these header bytes as UTF-8.
        headers["X-Bot-Instance-Id"] = instance.encode("utf-8")
    if os.environ.get("REHOR_INPUT_SOURCE") == "sandbox":
        sys.path.insert(0, str(Path(os.environ["HOME"]) / "app"))
        from bot.sandbox_transport import mcp_headers

        headers.update(mcp_headers("memory", url))
    return headers


def _no_redirect_client(headers=None, timeout=None, auth=None):
    from bot.sandbox_transport import no_redirect_client

    return no_redirect_client(headers=headers, timeout=timeout, auth=auth)


async def _ensure_session():
    global _session, _read, _write, _cm_transport, _cm_session
    if _session is not None:
        return _session

    if not MEMORY_MCP_URL:
        raise RuntimeError("BOT_MEMORY_URL not set")

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    headers = _headers(MEMORY_MCP_URL)
    options = {"httpx_client_factory": _no_redirect_client} if "Authorization" in headers else {}
    _cm_transport = streamablehttp_client(MEMORY_MCP_URL, headers=headers, **options)
    _read, _write, _ = await _cm_transport.__aenter__()
    _cm_session = ClientSession(_read, _write)
    _session = await _cm_session.__aenter__()
    await _session.initialize()
    return _session


async def _call(tool_name, arguments, timeout=30):
    session = await _ensure_session()
    result = await asyncio.wait_for(
        session.call_tool(tool_name, arguments),
        timeout=timeout,
    )
    if result.isError:
        text = result.content[0].text if result.content else "unknown error"
        print(f"  ERR MCP {tool_name}: {text[:200]}", file=sys.stderr)
        return None
    text = result.content[0].text
    return json.loads(text)


async def _cleanup():
    global _session, _cm_session, _cm_transport
    if _cm_session:
        with contextlib.suppress(Exception):
            await _cm_session.__aexit__(None, None, None)
    if _cm_transport:
        with contextlib.suppress(Exception):
            await _cm_transport.__aexit__(None, None, None)
    _session = _cm_session = _cm_transport = None


def memory_call(tool_name, arguments, timeout=30):
    """Synchronous wrapper for MCP tool calls."""
    if not MEMORY_MCP_URL:
        print("WARN: BOT_MEMORY_URL not set", file=sys.stderr)
        return None
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            raise RuntimeError("nested event loop")
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(_call(tool_name, arguments, timeout))
    except Exception as e:
        print(f"  ERR MCP {tool_name}: {e}", file=sys.stderr)
        return None


def memory_cleanup():
    """Close MCP session."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        return
    with contextlib.suppress(Exception):
        loop.run_until_complete(_cleanup())

"""Shared bot-memory MCP client for skill scripts.

Uses the MCP Python SDK for proper session handling over streamable HTTP.

Usage:
    from memory_mcp import memory_call

    data = memory_call("slack_notify", {"external_key": "X", ...})
"""

import asyncio
import json
import os
import sys

MEMORY_MCP_URL = os.environ.get("BOT_MEMORY_URL", "").rstrip("/")

_session = None
_read = None
_write = None
_cm_transport = None
_cm_session = None


async def _ensure_session():
    global _session, _read, _write, _cm_transport, _cm_session
    if _session is not None:
        return _session

    if not MEMORY_MCP_URL:
        raise RuntimeError("BOT_MEMORY_URL not set")

    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    _cm_transport = streamablehttp_client(MEMORY_MCP_URL)
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
        try:
            await _cm_session.__aexit__(None, None, None)
        except Exception:
            pass
    if _cm_transport:
        try:
            await _cm_transport.__aexit__(None, None, None)
        except Exception:
            pass
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
    try:
        loop.run_until_complete(_cleanup())
    except Exception:
        pass

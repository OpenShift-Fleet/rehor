"""Sandbox-only transport settings from the private bootstrap MCP configs."""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit


def _url(value, *, query=False):
    if not isinstance(value, str) or any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value:
        raise ValueError("invalid sandbox route")
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or (not query and "?" in value)
            or "#" in value
            or parsed.port == 0
        ):
            raise ValueError
        return parsed
    except ValueError:
        raise ValueError("invalid sandbox route") from None


def _server(kind):
    home = Path(os.environ.get("HOME", ""))
    if not home.is_absolute():
        raise RuntimeError("sandbox MCP config unavailable")
    root = home / "app"
    relative, name = (".mcp.json", "bot-memory") if kind == "memory" else ("bot/mcp.json", "mcp-atlassian")
    try:
        server = json.loads((root / relative).read_text(encoding="utf-8"))["mcpServers"][name]
        url = server["url"]
        parsed = _url(url)
        expected_path = "/mcp" if kind == "memory" else "/jira/mcp"
        if parsed.scheme == "https" and parsed.path != expected_path:
            raise ValueError
        headers = server.get("headers", {})
        auth = [value for key, value in headers.items() if key.lower() == "authorization"]
        if parsed.scheme == "https":
            if (
                len(auth) != 1
                or not isinstance(auth[0], str)
                or not re.fullmatch(r"Bearer openshell:resolve:env:[A-Za-z0-9_]+", auth[0])
            ):
                raise ValueError
            return url, parsed, auth[0]
        if auth:
            raise ValueError
        return url, parsed, None
    except (OSError, KeyError, TypeError, AttributeError, ValueError):
        raise RuntimeError("invalid sandbox MCP config") from None


def mcp_headers(kind, url):
    configured, _, auth = _server(kind)
    if url != configured.rstrip("/"):
        raise RuntimeError("sandbox MCP destination mismatch")
    return {"Authorization": auth} if auth else {}


def memory_api_headers(url, method):
    configured, source, auth = _server("memory")
    # Bind REST access to both the configured MCP endpoint and the requested
    # API path; query parameters select tasks and contain no credentials.
    if os.environ.get("BOT_MEMORY_URL", "").rstrip("/") != configured.rstrip("/"):
        raise RuntimeError("sandbox memory destination mismatch")
    try:
        target = _url(url, query=True)
        source_port = source.port or (443 if source.scheme == "https" else 80)
        target_port = target.port or (443 if target.scheme == "https" else 80)
        same_origin = (source.scheme, source.hostname, source_port) == (target.scheme, target.hostname, target_port)
        if method != "GET" or not same_origin or target.path != "/api/tasks":
            return {}
    except ValueError:
        return {}
    return {"Authorization": auth} if auth else {}


def no_redirect_client(headers=None, timeout=None, auth=None):
    from mcp.shared._httpx_utils import create_mcp_http_client

    client = create_mcp_http_client(headers=headers, timeout=timeout, auth=auth)
    client.follow_redirects = False
    # MCP 1.30 follows same-origin redirects independently of HTTPX.
    client.max_redirects = 0
    return client

"""Sandbox helper authentication and identity without live services."""

import asyncio
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
CLIENTS = (".claude/skills/jira_mcp.py", ".claude/skills/memory_mcp.py", "bot/memory_mcp.py")
MARKER = "openshell:resolve:env:v1_BOT_MEMORY_TOKEN"
INSTANCE = "fleetshift-bot-例-é"


def load(path):
    spec = importlib.util.spec_from_file_location("helper_under_test", ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("path", CLIENTS)
@pytest.mark.parametrize(
    "url,mode,token,authorized",
    [
        ("https://service.example/mcp", "sandbox", MARKER, True),
        ("http://service.example/mcp", "sandbox", MARKER, False),
        ("https://service.example/mcp", "legacy", MARKER, False),
        ("https://service.example/mcp", "sandbox", "raw-secret", False),
        ("https://service.example/mcp", "sandbox", MARKER + "\n", False),
        ("https://service.example:bad/mcp", "sandbox", MARKER, False),
        ("https://user@service.example/mcp", "sandbox", MARKER, False),
        ("https://service.example/mcp?credential=secret", "sandbox", MARKER, False),
        ("https://service.example\\@evil.example/mcp", "sandbox", MARKER, False),
    ],
)
def test_helper_transport_headers(path, url, mode, token, authorized, monkeypatch):
    monkeypatch.setenv("REHOR_INPUT_SOURCE", mode)
    monkeypatch.setenv("BOT_MEMORY_TOKEN", token)
    monkeypatch.setenv("BOT_INSTANCE_ID", INSTANCE)
    module = load(path)
    setattr(module, "JIRA_MCP_URL" if "jira" in path else "MEMORY_MCP_URL", url)
    captured = {}

    class Transport:
        async def __aenter__(self):
            return (None, None, None)

        async def __aexit__(self, *args):
            pass

    class Session:
        def __init__(self, *args):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def initialize(self):
            pass

    def transport(target, **kwargs):
        captured.update(url=target, **kwargs)
        return Transport()

    async def run():
        await module._ensure_session()
        await module._cleanup()

    with patch("mcp.ClientSession", Session), patch("mcp.client.streamable_http.streamablehttp_client", transport):
        asyncio.run(run())
    headers = captured["headers"]
    assert headers.get("Authorization") == (f"Bearer {MARKER}" if authorized else None)
    if authorized:
        assert captured["httpx_client_factory"] is module._no_redirect_client
    else:
        assert "httpx_client_factory" not in captured
    assert "raw-secret" not in repr(headers)
    if "jira" not in path:
        assert headers["X-Bot-Instance-Id"] == INSTANCE.encode("utf-8")
        # HTTPX preserves UTF-8 bytes for ASGI's latin-1-to-UTF-8 decoding.
        assert dict(httpx.Headers(headers).raw)[b"X-Bot-Instance-Id"].decode("utf-8") == INSTANCE
    else:
        assert "X-Bot-Instance-Id" not in headers


@pytest.mark.parametrize("path", CLIENTS)
def test_no_redirect_factory_preserves_sdk_options(path):
    module = load(path)
    timeout = httpx.Timeout(11, read=42)
    auth = httpx.BasicAuth("user", "pass")
    client = module._no_redirect_client(
        headers={"X-Bot-Instance-Id": INSTANCE.encode("utf-8")}, timeout=timeout, auth=auth
    )
    try:
        assert client.follow_redirects is False
        assert client.max_redirects == 0
        assert client.timeout == timeout
        assert client.auth is auth
        assert dict(client.headers.raw)[b"X-Bot-Instance-Id"] == INSTANCE.encode("utf-8")
    finally:
        asyncio.run(client.aclose())


@pytest.mark.parametrize("path", CLIENTS)
@pytest.mark.parametrize("location", ["https://service.example/other", "https://other.example/mcp"])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_sandbox_mcp_transport_never_follows_redirect(path, location, method, monkeypatch):
    import mcp.shared._httpx_utils as mcp_http

    module = load(path)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": location}, request=request)

    def factory(headers=None, timeout=None, auth=None):
        # Deliberately mimic an SDK factory with redirect following enabled.
        return httpx.AsyncClient(
            headers=headers, timeout=timeout, auth=auth, follow_redirects=True, transport=httpx.MockTransport(handle)
        )

    monkeypatch.setattr(mcp_http, "create_mcp_http_client", factory)

    async def run():
        async with module._no_redirect_client(headers={"Authorization": f"Bearer {MARKER}"}) as client:
            # MCP 1.30 performs its own same-origin redirects; older SDKs use
            # HTTPX directly. Exercise whichever transport is installed.
            stream = getattr(mcp_http, "stream_within_origin", None)
            context = (
                stream(client, method, "https://service.example/mcp")
                if stream
                else client.stream(method, "https://service.example/mcp")
            )
            async with context as response:
                assert response.status_code == 307

    asyncio.run(run())
    assert len(requests) == 1
    assert str(requests[0].url) == "https://service.example/mcp"
    assert requests[0].headers["Authorization"] == f"Bearer {MARKER}"


@pytest.mark.parametrize("path", CLIENTS)
@pytest.mark.parametrize("location", ["https://service.example/other", "https://other.example/mcp"])
def test_sandbox_mcp_session_redirect_fails_without_following(path, location, monkeypatch):
    import mcp.shared._httpx_utils as mcp_http
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    module = load(path)
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(307, headers={"Location": location}, request=request)

    def factory(headers=None, timeout=None, auth=None):
        return httpx.AsyncClient(
            headers=headers, timeout=timeout, auth=auth, follow_redirects=True, transport=httpx.MockTransport(handle)
        )

    monkeypatch.setattr(mcp_http, "create_mcp_http_client", factory)

    async def run():
        # Keep both async contexts and initialization in the same task: AnyIO
        # cancel scopes cannot be entered and exited from different tasks.
        with pytest.raises(ExceptionGroup) as exc_info:
            async with streamablehttp_client(
                "https://service.example/mcp",
                headers={"Authorization": f"Bearer {MARKER}"},
                httpx_client_factory=module._no_redirect_client,
            ) as (read, write, _):
                async with ClientSession(read, write) as session:
                    await session.initialize()
        errors = exc_info.value.exceptions
        assert len(errors) == 1
        assert isinstance(errors[0], httpx.HTTPStatusError)
        assert errors[0].response.status_code == 307
        assert errors[0].response.headers["Location"] == location
        assert str(errors[0].request.url) == "https://service.example/mcp"

    asyncio.run(run())
    assert len(requests) == 1
    assert str(requests[0].url) == "https://service.example/mcp"
    assert requests[0].headers["Authorization"] == f"Bearer {MARKER}"


@pytest.fixture
def bootstrap(tmp_path, monkeypatch):
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "sandbox")
    for name in (
        "BOT_MEMORY_URL",
        "JIRA_MCP_URL",
        "REHOR_MODEL_PROXY_URL",
        "EXECUTOR_HTTP_URL",
        "BOT_MEMORY_TOKEN",
        "BOT_INSTANCE_ID",
        "EXECUTOR_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / "bot").mkdir()
    (tmp_path / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"bot-memory": {"url": "http://memory/mcp", "headers": {"authorization": "old"}}}})
    )
    (tmp_path / "bot/mcp.json").write_text(
        json.dumps({"mcpServers": {"mcp-atlassian": {"url": "http://jira/mcp", "headers": {"authorization": "old"}}}})
    )
    return load("scripts/sandbox-bootstrap.py"), tmp_path


def test_bootstrap_configures_https_routes_and_unicode_identity(bootstrap, monkeypatch):
    module, app = bootstrap
    monkeypatch.setenv("BOT_MEMORY_TOKEN", MARKER)
    monkeypatch.setenv("BOT_INSTANCE_ID", INSTANCE)
    for name in ("BOT_MEMORY_URL", "JIRA_MCP_URL"):
        monkeypatch.setenv(name, "https://service.example/mcp")
    monkeypatch.setenv("EXECUTOR_HTTP_URL", "https://service.example/executor/execute")
    module.configure_routes(app)
    memory = json.loads((app / ".mcp.json").read_text())["mcpServers"]["bot-memory"]
    jira = json.loads((app / "bot/mcp.json").read_text())["mcpServers"]["mcp-atlassian"]
    assert memory["headers"] == {
        "Authorization": f"Bearer {MARKER}",
        "X-Bot-Instance-Id": INSTANCE.encode("utf-8").decode("latin-1"),
    }
    assert jira["headers"] == {"Authorization": f"Bearer {MARKER}"}
    assert os.environ["EXECUTOR_TOKEN"] == MARKER


def test_bootstrap_http_removes_stale_auth_and_executor_token(bootstrap, monkeypatch):
    module, app = bootstrap
    for name in ("BOT_MEMORY_URL", "JIRA_MCP_URL"):
        monkeypatch.setenv(name, "http://service.example/mcp")
    monkeypatch.setenv("EXECUTOR_HTTP_URL", "http://service.example/executor/execute")
    monkeypatch.setenv("BOT_INSTANCE_ID", "instance")
    monkeypatch.setenv("EXECUTOR_TOKEN", "raw-secret")
    module.configure_routes(app)
    assert "EXECUTOR_TOKEN" not in os.environ
    assert json.loads((app / ".mcp.json").read_text())["mcpServers"]["bot-memory"]["headers"] == {
        "X-Bot-Instance-Id": "instance"
    }
    assert json.loads((app / "bot/mcp.json").read_text())["mcpServers"]["mcp-atlassian"]["headers"] == {}


def test_bootstrap_sets_identity_without_memory_url_override(bootstrap, monkeypatch):
    module, app = bootstrap
    monkeypatch.setenv("BOT_INSTANCE_ID", INSTANCE)
    module.configure_routes(app)
    memory = json.loads((app / ".mcp.json").read_text())["mcpServers"]["bot-memory"]
    assert memory["url"] == "http://memory/mcp"
    assert memory["headers"] == {"X-Bot-Instance-Id": INSTANCE.encode("utf-8").decode("latin-1")}


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is required for HTTP header verification")
def test_bootstrap_identity_roundtrips_through_node_http_and_is_idempotent(bootstrap, monkeypatch):
    module, app = bootstrap
    monkeypatch.setenv("BOT_INSTANCE_ID", INSTANCE)
    module.configure_routes(app)
    first = (app / ".mcp.json").read_bytes()
    module.configure_routes(app)
    assert (app / ".mcp.json").read_bytes() == first

    # Use Node's actual undici fetch and HTTP server; the server returns the
    # Latin-1-decoded wire header exactly as an ASGI server would expose it.
    script = r"""
const http = require('node:http');
const fs = require('node:fs');
const header = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')).mcpServers['bot-memory'].headers['X-Bot-Instance-Id'];
const server = http.createServer((req, res) => {
  process.stdout.write(JSON.stringify(req.headers['x-bot-instance-id']));
  res.end('ok');
});
server.listen(0, '127.0.0.1', async () => {
  try {
    const headers = new Headers({ 'X-Bot-Instance-Id': header });
    await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
"""
    result = subprocess.run(
        ["node", "-e", script, str(app / ".mcp.json")], text=True, capture_output=True, timeout=20, check=True
    )
    asgi_value = json.loads(result.stdout)
    # Match resolve_instance_id's Latin-1-to-UTF-8 decoding logic.
    assert asgi_value.encode("latin-1").decode("utf-8") == INSTANCE


def test_bootstrap_legacy_mode_leaves_identity_and_environment_unchanged(bootstrap, monkeypatch):
    module, app = bootstrap
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "legacy")
    monkeypatch.setenv("BOT_INSTANCE_ID", INSTANCE)
    monkeypatch.setenv("EXECUTOR_TOKEN", "legacy-value")
    before = (app / ".mcp.json").read_bytes()
    with pytest.raises(RuntimeError, match="requires sandbox input"):
        module.configure_routes(app)
    assert (app / ".mcp.json").read_bytes() == before
    assert os.environ["BOT_INSTANCE_ID"] == INSTANCE
    assert os.environ["EXECUTOR_TOKEN"] == "legacy-value"


@pytest.mark.parametrize(
    "url,token,mode",
    [
        ("https://service/executor/execute", "raw-secret", "sandbox"),
        ("https://service/executor/execute", MARKER + "\n", "sandbox"),
        ("https://service:bad/executor/execute", MARKER, "sandbox"),
        ("https://user@service/executor/execute", MARKER, "sandbox"),
        ("https://service/executor/execute?", MARKER, "sandbox"),
        ("https://service/other", MARKER, "sandbox"),
        ("https://service/executor/execute", MARKER, "legacy"),
    ],
)
def test_bootstrap_rejects_invalid_routes_and_credentials_without_echo(bootstrap, monkeypatch, url, token, mode):
    module, app = bootstrap
    monkeypatch.setenv("EXECUTOR_HTTP_URL", url)
    monkeypatch.setenv("BOT_MEMORY_TOKEN", token)
    monkeypatch.setenv("REHOR_INPUT_SOURCE", mode)
    with pytest.raises(RuntimeError) as exc:
        module.configure_routes(app)
    assert token not in str(exc.value)

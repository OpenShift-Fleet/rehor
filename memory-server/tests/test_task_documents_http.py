"""Raw Streamable-HTTP regression tests for task_document tools.

These tests drive the real MCP streamable-http transport (JSON-RPC over HTTP
through the FastMCP ASGI app wrapped in the production McpEnvelopeGuard), not
the in-memory client, because the behaviors under test live at the
transport/validation boundary:

1. Argument-validation payload leakage (Sol reviews of #693): FastMCP 3.4.x
   echoes malformed-call arguments into the MCP error response (pydantic
   ``str(e)`` embeds ``input_value``) and the server warning log
   (``errors()`` entries carry ``input`` values); unknown argument keys leak
   through pydantic ``loc``. The mcp SDK additionally logs malformed JSON-RPC
   envelopes to the ROOT logger with full message reprs, and sse-starlette
   DEBUG-logs response chunks. One test pins the unsanitized FastMCP leak so
   the sanitization in ``mcp_validation_sanitizer`` stays justified; the rest
   verify the sanitizer and envelope guard remove every echo without
   weakening validation feedback or breaking valid calls.
2. JSON number semantics: integers are exact (arbitrary precision); float
   tokens that do not round-trip through IEEE 754 doubles (``1e400``,
   ``1e-400``, ``9007199254740993.0``) are rejected at the envelope-guard
   boundary with a sanitized error instead of being silently corrupted.
   Exact observed behavior is pinned; arbitrary numeric precision is
   explicitly NOT claimed.

Log capture notes: the ``fastmcp`` logger sets ``propagate=False`` (it owns
RichHandlers), so FastMCP records are captured via a handler on
``fastmcp.server.server`` directly; the mcp SDK logs through the ROOT logger,
captured the same way. The leak marker is placed in ``external_key`` because
pydantic truncates long ``input_value`` reprs in error strings.

The real-database test is opt-in like test_task_documents.py: suffixed
``_through_real_database`` and gated on REHOR_REAL_DATABASE_TESTS=1 because
the ``db`` fixture drops all public tables.
"""

import json
import logging
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import patch

import pytest
from bot_memory_server.mcp_validation_sanitizer import (
    FASTMCP_SERVER_LOGGER,
    McpEnvelopeGuard,
    RedactInvalidArgumentInputs,
    install_sanitized_validation,
)
from bot_memory_server.tools.task_documents import register_task_document_tools
from conftest import (
    NOW,
    SCHEMA_PATH,
    TASK_ROW,
    SingleConnectionPool,
    document_row,
    requires_real_database,
)
from fastmcp import FastMCP
from httpx import ASGITransport, AsyncClient

# Short and placed in external_key so it survives pydantic's input_value
# repr truncation in error strings.
LEAK_MARKER = "LEAKMARKER9"
LEAK_DATA = {"secret": "payload-must-not-leak"}
EXTRA_KEY_MARKER = "SECRETKEYLEAK7"


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@contextmanager
def capture_logs(logger_name: str = FASTMCP_SERVER_LOGGER):
    """Capture records from one logger (fastmcp does not propagate to root)."""
    handler = _ListHandler()
    logger = logging.getLogger(logger_name)
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)


@contextmanager
def capture_root_logs():
    """Capture ROOT-logger records (the mcp SDK logs there directly)."""
    handler = _ListHandler()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        yield handler
    finally:
        root.removeHandler(handler)


class _NoSanitizerFilter:
    """Detach the global log-redaction filters for the duration of a test.

    install_sanitized_validation attaches filters to the shared FastMCP and
    root loggers; the upstream-behavior pin must observe unsanitized logs."""

    def __enter__(self):
        self.fastmcp_logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
        self.root = logging.getLogger()
        self.saved_fastmcp = list(self.fastmcp_logger.filters)
        self.saved_root = list(self.root.filters)
        self.fastmcp_logger.filters = [f for f in self.saved_fastmcp if not isinstance(f, RedactInvalidArgumentInputs)]
        self.root.filters = [f for f in self.saved_root if not isinstance(f, RedactInvalidArgumentInputs)]
        return self

    def __exit__(self, *exc_info):
        self.fastmcp_logger.filters = self.saved_fastmcp
        self.root.filters = self.saved_root


class HttpPool:
    """Pool fake for the HTTP harness: records INSERT payloads, returns rows."""

    def __init__(self, row=None):
        self.row = row or document_row()
        self.insert_payloads = []

    @asynccontextmanager
    async def acquire(self):
        yield self

    @asynccontextmanager
    async def transaction(self):
        yield

    async def fetchrow(self, query, *args):
        if "INSERT INTO task_documents" in query:
            self.insert_payloads.append(args[2])
            return self.row
        return TASK_ROW if ("FOR UPDATE" in query and "FROM tasks" in query) else self.row

    async def fetch(self, query, *args):
        return [self.row]


def _parse_response(text: str) -> dict:
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(text)


class McpHttpClient:
    """Minimal JSON-RPC client over the real streamable-http ASGI app.

    ``lifespan_app`` is the Starlette app whose lifespan must run (the guard
    wrapper is plain ASGI and has no router)."""

    def __init__(self, app, lifespan_app=None):
        self._app = app
        self._lifespan_app = lifespan_app or app
        self._client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        self._lifespan = None
        self._session = None
        self._id = 0

    async def __aenter__(self):
        # The streamable-http session manager requires the app lifespan.
        self._lifespan = self._lifespan_app.router.lifespan_context(self._lifespan_app)
        await self._lifespan.__aenter__()
        try:
            await self._client.__aenter__()
            response = await self._client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "id": 0,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "regression", "version": "0"},
                    },
                },
                headers={"accept": "application/json, text/event-stream"},
            )
            assert response.status_code == 200, response.text
            self._session = response.headers.get("mcp-session-id")
            await self._client.post(
                "/mcp",
                json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                headers=self._headers(),
            )
        except BaseException:
            await self._lifespan.__aexit__(None, None, None)
            raise
        return self

    async def __aexit__(self, *exc_info):
        await self._client.__aexit__(*exc_info)
        await self._lifespan.__aexit__(*exc_info)

    def _headers(self):
        headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
        if self._session:
            headers["mcp-session-id"] = self._session
        return headers

    async def call_tool(self, name: str, arguments) -> dict:
        """Returns the tools/call result dict (content/isError)."""
        self._id += 1
        return await self.request(
            {"jsonrpc": "2.0", "id": self._id, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
        )

    async def request(self, payload: dict) -> dict:
        message = await self.request_raw(json.dumps(payload))
        return message.get("result", {})

    async def request_raw(self, body: str) -> dict:
        """Returns the full JSON-RPC response message (result or error)."""
        self._id += 1
        response = await self._client.post("/mcp", content=body, headers=self._headers())
        assert response.status_code == 200, response.text
        return _parse_response(response.text)


def _http_app(sanitized: bool, guarded: bool = True):
    """Returns (asgi_app, lifespan_app): the guard is plain ASGI, so the
    Starlette app is returned separately for lifespan management."""
    mcp = FastMCP(name=f"documents-http-{'sanitized' if sanitized else 'raw'}")
    register_task_document_tools(mcp)
    if sanitized:
        install_sanitized_validation(mcp)
    app = mcp.http_app(transport="streamable-http")
    return (McpEnvelopeGuard(app), app) if guarded else (app, app)


def _patch_pool(pool):
    return patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool)


def _log_text(handler: _ListHandler) -> str:
    return "\n".join(record.getMessage() for record in handler.records)


# --- Argument-validation payload leakage (FastMCP layer) ---


@pytest.mark.asyncio
async def test_unsanitized_fastmcp_leaks_arguments_in_errors_and_logs():
    """Pins upstream FastMCP 3.4.11 behavior: without the sanitizer, a
    malformed task_document_create call echoes the call arguments (including
    document payloads) into the MCP error response and the FastMCP warning
    log. Justifies mcp_validation_sanitizer; revisit if FastMCP fixes this
    upstream."""
    app, lifespan_app = _http_app(sanitized=False)
    pool = HttpPool()
    with (
        _patch_pool(pool),
        _NoSanitizerFilter(),
        capture_logs() as logs,
    ):
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool(
                "task_document_create",
                {**LEAK_DATA, "external_key": LEAK_MARKER},  # name missing
            )
    assert result["isError"] is True
    # Response text embeds pydantic's input_value (marker survives repr truncation).
    assert LEAK_MARKER in result["content"][0]["text"]
    assert "input_value" in result["content"][0]["text"]
    # Warning log embeds the full arguments, including the payload value.
    assert LEAK_MARKER in _log_text(logs)
    assert "payload-must-not-leak" in _log_text(logs)
    assert pool.insert_payloads == []  # handler never ran


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {"external_key": LEAK_MARKER, "data": LEAK_DATA},  # name missing
        {"external_key": LEAK_MARKER, "name": 123, "data": LEAK_DATA},  # name wrong type
        {"external_key": LEAK_MARKER, "name": "bundle"},  # data missing
    ],
)
async def test_sanitized_create_rejects_malformed_calls_without_echoing_payload(arguments):
    """With the sanitizer installed, malformed create calls fail with
    actionable validation errors but neither the MCP error output nor the
    FastMCP warning log contains the call arguments or document payload."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_logs() as logs:
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool("task_document_create", arguments)
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "Invalid arguments for tool 'task_document_create'" in text
    assert LEAK_MARKER not in text
    assert "payload-must-not-leak" not in text
    assert "input_value" not in text
    assert LEAK_MARKER not in _log_text(logs)
    assert "payload-must-not-leak" not in _log_text(logs)
    assert pool.insert_payloads == []  # handler never ran


@pytest.mark.asyncio
async def test_sanitized_update_rejects_malformed_calls_without_echoing_payload():
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_logs() as logs:
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool(
                "task_document_update",
                {"external_key": LEAK_MARKER, "data": LEAK_DATA},  # name missing
            )
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "Invalid arguments for tool 'task_document_update'" in text
    assert "name" in text
    assert LEAK_MARKER not in text
    assert "payload-must-not-leak" not in text
    assert LEAK_MARKER not in _log_text(logs)
    assert pool.insert_payloads == []


@pytest.mark.asyncio
async def test_unknown_argument_keys_do_not_leak_through_loc():
    """P3: unknown (caller-controlled) argument keys must not surface in the
    error text or the warning log; known parameter names stay actionable."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_logs() as logs:
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool(
                "task_document_create",
                {
                    "external_key": "ART-1",
                    "name": "bundle",
                    "data": {},
                    EXTRA_KEY_MARKER: "leak-check",
                },
            )
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "Unexpected" in text or "extra" in text
    assert EXTRA_KEY_MARKER not in text
    assert EXTRA_KEY_MARKER not in _log_text(logs)
    # Known parameter names are preserved for actionable feedback.
    assert pool.insert_payloads == []


@pytest.mark.asyncio
async def test_sanitized_validation_error_still_names_the_problem():
    """Sanitization must not weaken feedback: the failing parameter and its
    pydantic message/type survive in both the error and the warning log."""
    app, lifespan_app = _http_app(sanitized=True)
    with _patch_pool(HttpPool()), capture_logs() as logs:
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool("task_document_create", {"external_key": LEAK_MARKER, "data": LEAK_DATA})
    text = result["content"][0]["text"]
    assert "Invalid arguments for tool 'task_document_create'" in text
    assert "name" in text
    assert "Missing required argument" in text
    assert logs.records, "expected the FastMCP invalid-arguments warning"
    warning = next(record for record in logs.records if "Invalid arguments" in record.getMessage())
    assert "Missing required argument" in warning.getMessage()
    assert LEAK_MARKER not in warning.getMessage()


# --- Malformed JSON-RPC envelopes (mcp SDK ROOT-logger layer) ---


@pytest.mark.asyncio
async def test_arguments_array_is_rejected_by_envelope_guard_without_sdk_leak():
    """P2: `arguments` as an array previously reached the mcp SDK, which logs
    the full failed message to the ROOT logger. The envelope guard rejects it
    first with a sanitized -32602 error."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    body = (
        '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": '
        '{"name": "task_document_create", "arguments": ["' + LEAK_MARKER + '"]}}'
    )
    with _patch_pool(pool), capture_root_logs() as root_logs, capture_logs() as fastmcp_logs:
        async with McpHttpClient(app, lifespan_app) as client:
            message = await client.request_raw(body)
    assert message == {
        "jsonrpc": "2.0",
        "id": 2,
        "error": {"code": -32602, "message": "Invalid request parameters: arguments must be an object"},
    }
    assert LEAK_MARKER not in _log_text(root_logs)
    assert LEAK_MARKER not in _log_text(fastmcp_logs)
    assert pool.insert_payloads == []


@pytest.mark.asyncio
async def test_invalid_jsonrpc_id_is_rejected_by_envelope_guard_without_sdk_leak():
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    body = (
        '{"jsonrpc": "2.0", "id": {"bad": "' + LEAK_MARKER + '"}, "method": "tools/call", '
        '"params": {"name": "task_document_create", "arguments": {"external_key": "K", "name": "n", "data": {}}}}'
    )
    with _patch_pool(pool), capture_root_logs() as root_logs, capture_logs() as fastmcp_logs:
        async with McpHttpClient(app, lifespan_app) as client:
            message = await client.request_raw(body)
    assert message["error"]["code"] == -32602
    assert "id must be a string or a number" in message["error"]["message"]
    assert message["id"] is None
    assert LEAK_MARKER not in _log_text(root_logs)
    assert LEAK_MARKER not in _log_text(fastmcp_logs)
    assert pool.insert_payloads == []


@pytest.mark.asyncio
async def test_sdk_root_log_sanitizer_redacts_uncovered_malformed_shapes():
    """Envelope shapes the guard does not pre-empt (e.g. a typo'd method)
    still fail SDK validation; the ROOT-logger filter must strip the payload
    from those messages while keeping the record."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    body = (
        '{"jsonrpc": "2.0", "id": 5, "method": "tools/cal", '
        '"params": {"name": "task_document_create", "arguments": {"external_key": "' + LEAK_MARKER + '"}}}'
    )
    with _patch_pool(pool), capture_root_logs() as root_logs:
        async with McpHttpClient(app, lifespan_app) as client:
            await client.request_raw(body)
    validation_records = [r for r in root_logs.records if "validate" in r.getMessage()]
    assert validation_records, "expected SDK validation-failure records"
    assert LEAK_MARKER not in _log_text(root_logs)


# --- SSE response-body logging ---


@pytest.mark.asyncio
async def test_sse_response_bodies_are_not_logged_even_at_debug():
    """P2: sse-starlette DEBUG-logs every response chunk (full document
    payloads). install_sanitized_validation clamps that logger to INFO."""
    assert logging.getLogger("sse_starlette.sse").level == logging.INFO
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_logs("sse_starlette.sse") as sse_logs:
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool(
                "task_document_create",
                {"external_key": "ART-1", "name": "bundle", "data": {"secret": "SSE-BODY-LEAK"}},
            )
    assert result["isError"] is False
    assert "SSE-BODY-LEAK" not in _log_text(sse_logs)


# --- Valid calls pass through unchanged ---


@pytest.mark.asyncio
async def test_sanitizer_does_not_touch_valid_calls():
    """Successful document calls pass through the guard byte-for-byte."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool):
        async with McpHttpClient(app, lifespan_app) as client:
            ok = await client.call_tool(
                "task_document_create", {"external_key": "ART-1", "name": "bundle", "data": {"k": "v"}}
            )
    assert ok["isError"] is False
    assert pool.insert_payloads == ['{"k": "v"}']


@pytest.mark.asyncio
async def test_valid_unrelated_tool_still_works_through_the_guard():
    """The envelope guard must not break other tools: a valid task_get call
    (no document payload) flows through normally."""
    from bot_memory_server.tools.tasks import register_task_tools

    mcp = FastMCP(name="documents-http-unrelated")
    register_task_tools(mcp)
    register_task_document_tools(mcp)
    install_sanitized_validation(mcp)
    lifespan_app = mcp.http_app(transport="streamable-http")
    app = McpEnvelopeGuard(lifespan_app)
    task_row = {
        "id": 1,
        "external_key": "ART-1",
        "source_type": "jira",
        "source_url": None,
        "artifacts": "[]",
        "status": "in_progress",
        "repo": "org/repo",
        "branch": "bot/x",
        "title": None,
        "summary": None,
        "created_at": NOW,
        "last_addressed": NOW,
        "paused_reason": None,
        "instance_id": None,
        "metadata": "{}",
    }

    class TaskPool:
        async def fetchrow(self, query, *args):
            return task_row

        async def fetch(self, query, *args):
            return []

    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=TaskPool()),
        patch("bot_memory_server.tools.task_documents.get_pool", return_value=HttpPool()),
    ):
        async with McpHttpClient(app, lifespan_app) as client:
            result = await client.call_tool("task_get", {"external_key": "ART-1"})
    assert result["isError"] is False
    assert json.loads(result["content"][0]["text"])["external_key"] == "ART-1"


def test_build_app_installs_the_sanitizer_and_guard():
    """The production server wires the sanitizer into /mcp and mounts the
    MCP app behind the envelope guard."""
    from bot_memory_server.mcp_validation_sanitizer import RedactInvalidArgumentInputs, install_sanitized_validation
    from bot_memory_server.server import build_app
    from starlette.routing import Mount

    logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
    saved_filters = list(logger.filters)
    logger.filters = [f for f in saved_filters if not isinstance(f, RedactInvalidArgumentInputs)]
    try:
        app, _metrics_app = build_app()
        assert any(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters)
        mounts = [route for route in app.routes if isinstance(route, Mount)]
        assert any(isinstance(route.app, McpEnvelopeGuard) for route in mounts)
        # Idempotent: a second install does not stack filters.
        install_sanitized_validation(FastMCP(name="dup-check"))
        assert sum(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters) == 1
    finally:
        logger.filters = saved_filters


# --- JSON number semantics over the raw transport ---


@pytest.mark.asyncio
async def test_raw_http_number_semantics_exact_or_rejected():
    """Integers keep arbitrary precision and ordinary doubles pass; float
    tokens that would silently change (over/underflow, beyond-double
    precision) are rejected at the envelope guard with a sanitized error —
    never silently corrupted."""
    app, lifespan_app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool):
        async with McpHttpClient(app, lifespan_app) as client:
            accepted = [
                ("0.1", "0.1"),
                ("1e3", "1000.0"),
                ("2.5", "2.5"),
                ("-0.0", "-0.0"),
                ("9007199254740993", "9007199254740993"),  # exact integer, arbitrary precision
            ]
            for literal, expected_payload in accepted:
                body = (
                    '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                    '{"name": "task_document_create", "arguments": '
                    '{"external_key": "ART-1", "name": "n", "data": ' + literal + "}}}"
                )
                message = await client.request_raw(body)
                assert "error" not in message, (literal, message)
                assert message["result"]["isError"] is False, (literal, message)
                assert pool.insert_payloads[-1] == expected_payload

            rejected = ["1e400", "1e-400", "9007199254740993.0", "1.00000000000000000001", "NaN"]
            # Static examples in the rejection message mention 1e400/1e-400;
            # only caller-specific values must never be echoed.
            unechoed = ["9007199254740993.0", "1.00000000000000000001", "NaN"]
            for literal in rejected:
                body = (
                    '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                    '{"name": "task_document_create", "arguments": '
                    '{"external_key": "ART-1", "name": "n", "data": ' + literal + "}}}"
                )
                message = await client.request_raw(body)
                assert message["error"]["code"] == -32602, (literal, message)
                assert "IEEE 754" in message["error"]["message"]
                if literal in unechoed:
                    assert literal not in message["error"]["message"]
            assert pool.insert_payloads[-1] == "9007199254740993"  # no rejected write reached the pool


@pytest.mark.asyncio
@requires_real_database
async def test_number_semantics_through_real_database(db):
    """End-to-end pin (disposable PostgreSQL): accepted numbers round-trip
    value-exact (including the arbitrary-precision integer); rejected tokens
    never reach storage."""
    await db.execute(SCHEMA_PATH.read_text())
    await db.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) "
        "VALUES ('ART-NUM', 'jira', 'in_progress', 'org/repo', 'bot/x') RETURNING id"
    )
    mcp = FastMCP(name="documents-http-numbers")
    register_task_document_tools(mcp)
    install_sanitized_validation(mcp)
    lifespan_app = mcp.http_app(transport="streamable-http")
    app = McpEnvelopeGuard(lifespan_app)

    with patch("bot_memory_server.tools.task_documents.get_pool", return_value=SingleConnectionPool(db)):
        async with McpHttpClient(app, lifespan_app) as client:
            for name, literal, expected in [
                ("ordinary-double", "0.1", 0.1),
                ("exact-int", "9007199254740993", 9007199254740993),
            ]:
                body = (
                    '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                    '{"name": "task_document_create", "arguments": '
                    '{"external_key": "ART-NUM", "name": "' + name + '", "data": ' + literal + "}}}"
                )
                created = await client.request_raw(body)
                assert "error" not in created and created["result"]["isError"] is False, created
                fetched = await client.call_tool("task_document_get", {"external_key": "ART-NUM", "name": name})
                assert fetched["isError"] is False
                data = json.loads(fetched["content"][0]["text"])["data"]
                assert data == expected
                assert data.__class__ is expected.__class__

            body = (
                '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                '{"name": "task_document_create", "arguments": '
                '{"external_key": "ART-NUM", "name": "bad", "data": 1e400}}}'
            )
            rejected = await client.request_raw(body)
            assert rejected["error"]["code"] == -32602
    count = await db.fetchval("SELECT COUNT(*) FROM task_documents")
    assert count == 2  # only the two accepted documents were stored

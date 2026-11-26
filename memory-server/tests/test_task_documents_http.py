"""Raw Streamable-HTTP regression tests for task_document tools.

These tests drive the real MCP streamable-http transport (JSON-RPC over HTTP
through the FastMCP ASGI app), not the in-memory client, because the behaviors
under test live at the transport/validation boundary:

1. Argument-validation payload leakage (Sol review of #693): FastMCP 3.4.x
   echoes malformed-call arguments — including full document payloads — into
   both the MCP error response (pydantic ``str(e)`` embeds ``input_value``)
   and the server warning log (``Invalid arguments for tool ...`` logs
   ``errors()`` with ``input`` values). The first test pins that upstream
   behavior so the sanitization in ``mcp_validation_sanitizer`` stays
   justified; the remaining tests verify the sanitizer removes the echo
   without weakening the validation feedback.
2. JSON number semantics: numbers travel the transport as IEEE 754 doubles
   and change before the handler runs — ``9007199254740993.0`` rounds to
   ``9007199254740992.0``, ``1e-400`` underflows to ``0.0``, and ``1e400``
   arrives as ``null``. These tests pin the observed values; arbitrary numeric
   precision is explicitly NOT supported or claimed.

Log capture notes: the ``fastmcp`` logger sets ``propagate=False`` (it owns
RichHandlers), so pytest's root-logger caplog never sees FastMCP records —
tests attach a handler to the ``fastmcp.server.server`` logger directly. The
leak marker is placed in ``external_key`` because pydantic truncates long
``input_value`` reprs in error strings, keeping only the start and end.

The real-database test is opt-in like test_task_documents.py: suffixed
``_through_real_database`` and gated on REHOR_REAL_DATABASE_TESTS=1 because
the ``db`` fixture drops all public tables.
"""

import json
import logging
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, datetime
from unittest.mock import patch

import pytest
from bot_memory_server.mcp_validation_sanitizer import (
    FASTMCP_SERVER_LOGGER,
    RedactInvalidArgumentInputs,
    install_sanitized_validation,
)
from bot_memory_server.tools.task_documents import register_task_document_tools
from conftest import SCHEMA_PATH, SingleConnectionPool, requires_real_database
from fastmcp import FastMCP
from httpx import ASGITransport, AsyncClient

NOW = datetime(2026, 11, 26, 12, 0, tzinfo=UTC)
# Short and placed in external_key so it survives pydantic's input_value
# repr truncation in error strings.
LEAK_MARKER = "LEAKMARKER9"
LEAK_DATA = {"secret": "payload-must-not-leak"}


def document_row(name="bundle", revision=1, data='{"k": "v"}', id=7):
    return {"id": id, "name": name, "data": data, "revision": revision, "created_at": NOW, "updated_at": NOW}


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@contextmanager
def capture_fastmcp_logs():
    """Capture FastMCP server logs (the fastmcp logger does not propagate)."""
    handler = _ListHandler()
    logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)


class _NoSanitizerFilter:
    """Detach the global log-redaction filter for the duration of a test.

    install_sanitized_validation attaches the filter to the shared FastMCP
    logger; the upstream-behavior pin must observe the unsanitized log."""

    def __enter__(self):
        self.logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
        self.saved = list(self.logger.filters)
        self.logger.filters = [f for f in self.logger.filters if not isinstance(f, RedactInvalidArgumentInputs)]
        return self

    def __exit__(self, *exc_info):
        self.logger.filters = self.saved


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


TASK_ROW = {"id": 42}


def _parse_response(text: str) -> dict:
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(text)


class McpHttpClient:
    """Minimal JSON-RPC client over the real streamable-http ASGI app."""

    def __init__(self, app):
        self._app = app
        self._client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        self._lifespan = None
        self._session = None
        self._id = 0

    async def __aenter__(self):
        # The streamable-http session manager requires the app lifespan.
        self._lifespan = self._app.router.lifespan_context(self._app)
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
        return await self.request_raw(json.dumps(payload))

    async def request_raw(self, body: str) -> dict:
        self._id += 1
        response = await self._client.post("/mcp", content=body, headers=self._headers())
        assert response.status_code == 200, response.text
        return _parse_response(response.text).get("result", {})


def _http_app(sanitized: bool):
    mcp = FastMCP(name=f"documents-http-{'sanitized' if sanitized else 'raw'}")
    register_task_document_tools(mcp)
    if sanitized:
        install_sanitized_validation(mcp)
    return mcp.http_app(transport="streamable-http")


def _patch_pool(pool):
    return patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool)


def _log_text(handler: _ListHandler) -> str:
    return "\n".join(record.getMessage() for record in handler.records)


# --- Argument-validation payload leakage ---


@pytest.mark.asyncio
async def test_unsanitized_fastmcp_leaks_arguments_in_errors_and_logs():
    """Pins upstream FastMCP 3.4.11 behavior: without the sanitizer, a
    malformed task_document_create call echoes the call arguments (including
    document payloads) into the MCP error response and the FastMCP warning
    log. Justifies mcp_validation_sanitizer; revisit if FastMCP fixes this
    upstream."""
    app = _http_app(sanitized=False)
    pool = HttpPool()
    with (
        _patch_pool(pool),
        _NoSanitizerFilter(),
        capture_fastmcp_logs() as logs,
    ):
        async with McpHttpClient(app) as client:
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
    app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_fastmcp_logs() as logs:
        async with McpHttpClient(app) as client:
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
    app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool), capture_fastmcp_logs() as logs:
        async with McpHttpClient(app) as client:
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
async def test_sanitized_validation_error_still_names_the_problem():
    """Sanitization must not weaken feedback: the failing parameter and its
    pydantic message/type survive in both the error and the warning log."""
    app = _http_app(sanitized=True)
    with _patch_pool(HttpPool()), capture_fastmcp_logs() as logs:
        async with McpHttpClient(app) as client:
            result = await client.call_tool("task_document_create", {"external_key": LEAK_MARKER, "data": LEAK_DATA})
    text = result["content"][0]["text"]
    assert "Invalid arguments for tool 'task_document_create'" in text
    assert "name" in text
    assert "Missing required argument" in text
    assert logs.records, "expected the FastMCP invalid-arguments warning"
    warning = next(record for record in logs.records if "Invalid arguments" in record.getMessage())
    assert "Missing required argument" in warning.getMessage()
    assert LEAK_MARKER not in warning.getMessage()


@pytest.mark.asyncio
async def test_sanitizer_does_not_touch_valid_calls():
    """Successful calls pass through unchanged."""
    app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool):
        async with McpHttpClient(app) as client:
            ok = await client.call_tool(
                "task_document_create", {"external_key": "ART-1", "name": "bundle", "data": {"k": "v"}}
            )
    assert ok["isError"] is False
    assert pool.insert_payloads == ['{"k": "v"}']


def test_build_app_installs_the_sanitizer():
    """The production server wires the validation sanitizer into /mcp.

    install_sanitized_validation attaches both the middleware and the log
    filter in one call; the globally visible filter proves build_app ran it
    (the middleware itself is exercised by the sanitized-app tests above).
    """
    from bot_memory_server.mcp_validation_sanitizer import RedactInvalidArgumentInputs, install_sanitized_validation
    from bot_memory_server.server import build_app

    logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
    saved_filters = list(logger.filters)
    logger.filters = [f for f in saved_filters if not isinstance(f, RedactInvalidArgumentInputs)]
    try:
        build_app()
        assert any(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters)
        # Idempotent: a second install does not stack filters.
        install_sanitized_validation(FastMCP(name="dup-check"))
        assert sum(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters) == 1
    finally:
        logger.filters = saved_filters


# --- JSON number semantics over the raw transport ---


@pytest.mark.asyncio
async def test_raw_http_pins_double_precision_number_semantics():
    """Pins observed transport behavior: JSON numbers become IEEE 754 doubles
    before the handler runs. Not arbitrary precision — the exact values are
    pinned so the silent changes are at least visible."""
    app = _http_app(sanitized=True)
    pool = HttpPool()
    with _patch_pool(pool):
        async with McpHttpClient(app) as client:
            cases = [
                ("9007199254740993.0", "9007199254740992.0"),  # rounds to 2^53
                ("1e-400", "0.0"),  # underflows
                ("1e400", "null"),  # framework JSON handling collapses it to null
            ]
            for literal, expected_payload in cases:
                body = (
                    '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                    '{"name": "task_document_create", "arguments": '
                    '{"external_key": "ART-1", "name": "n", "data": ' + literal + "}}}"
                )
                result = await client.request_raw(body)
                assert result["isError"] is False, result
                assert pool.insert_payloads[-1] == expected_payload


@pytest.mark.asyncio
@requires_real_database
async def test_double_precision_numbers_round_trip_through_real_database(db):
    """End-to-end pin (disposable PostgreSQL): the double-rounded values are
    what PostgreSQL JSONB stores and returns."""
    await db.execute(SCHEMA_PATH.read_text())
    await db.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, branch) "
        "VALUES ('ART-NUM', 'jira', 'in_progress', 'org/repo', 'bot/x') RETURNING id"
    )
    mcp = FastMCP(name="documents-http-numbers")
    register_task_document_tools(mcp)
    install_sanitized_validation(mcp)
    app = mcp.http_app(transport="streamable-http")

    pool = SingleConnectionPool(db)

    with patch("bot_memory_server.tools.task_documents.get_pool", return_value=pool):
        async with McpHttpClient(app) as client:
            for name, literal, expected in [
                ("rounded", "9007199254740993.0", 9007199254740992.0),
                ("underflow", "1e-400", 0.0),
            ]:
                body = (
                    '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": '
                    '{"name": "task_document_create", "arguments": '
                    '{"external_key": "ART-NUM", "name": "' + name + '", "data": ' + literal + "}}}"
                )
                created = await client.request_raw(body)
                assert created["isError"] is False, created
                fetched = await client.call_tool("task_document_get", {"external_key": "ART-NUM", "name": name})
                assert fetched["isError"] is False
                data = json.loads(fetched["content"][0]["text"])["data"]
                assert data == expected

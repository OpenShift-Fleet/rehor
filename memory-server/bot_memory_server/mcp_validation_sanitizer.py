"""Sanitize FastMCP/MCP-SDK paths that echo tool-call payloads.

Three independent leak paths exist before (or beside) the tool handlers, all
confirmed against FastMCP 3.4.11 / mcp SDK / sse-starlette 3.3.4:

1. Tool argument validation (FastMCP): the MCP error response embeds
   pydantic's ``input_value=...`` and the ``Invalid arguments for tool``
   warning log carries ``errors()`` entries with ``input`` values. Unknown
   argument keys additionally leak through pydantic's ``loc`` (the key is
   caller-controlled, potentially data-derived).
2. JSON-RPC envelope validation (mcp SDK): malformed requests are echoed
   with full payloads in two places — the SDK's HTTP-layer
   ``JSONRPCMessage`` validation responses (e.g. a wrong ``jsonrpc``
   version returns ``Validation error: ...`` with pydantic ``input_value``
   including document data) and the ROOT-logger messages in
   ``mcp.shared.session`` (``Failed to validate request: ...`` WARNING,
   ``Message that failed validation: ...`` DEBUG with full message repr,
   ``Failed to validate notification: ... . Message was: ...`` WARNING).
3. SSE response transport (sse-starlette): with DEBUG logging enabled,
   ``sse_starlette.sse`` logs every response chunk (``chunk: ...``),
   including successful document read/write bodies.

The fixes sit at sanctioned framework/transport boundaries and only remove
payload echoes — validation feedback (parameter names, messages, types) is
preserved for schema-known fields:

- ``SanitizedValidationMiddleware`` catches ``fastmcp.exceptions.ValidationError``
  around ``tools/call`` and re-raises a ``ToolError`` built from pydantic's
  ``errors(include_input=False)``. Unknown-argument keys (error types
  ``extra_forbidden`` / ``unexpected_keyword_argument``) have their ``loc``
  replaced with ``<extra-key>`` so caller-controlled names never surface.
- ``RedactInvalidArgumentInputs`` is a ``logging.Filter`` on the FastMCP
  server logger stripping ``input``/``ctx``/``url`` keys (and extra-key
  locs) from the already-computed warning detail — it is logged inside
  FastMCP before the middleware can intercept the exception.
- ``SdkRootLogSanitizer`` is a ``logging.Filter`` on the ROOT logger
  rewriting the three mcp-SDK validation-failure messages to drop their
  payload-bearing detail.
- ``McpEnvelopeGuard`` is a pure-ASGI middleware around the MCP HTTP app
  that inspects ``POST /mcp`` bodies (only after mirroring the SDK's
  Accept/Content-Type pre-body checks) before the SDK parses them:
  - HTTP-layer envelope validity — non-object messages, ``jsonrpc`` values
    other than "2.0", non-string methods and invalid request ids are
    rejected with a sanitized 400 (the SDK's responses echo pydantic
    ``input_value``, including document data).
  - Session-layer ``tools/call`` parameters — non-object ``params``/
    ``arguments`` and non-string tool names are rejected with a sanitized
    ``-32602`` error (the SDK logs failed messages to the ROOT logger with
    full payloads).
  - ``task_document_create``/``task_document_update`` calls whose ``data``
    contains float tokens that do not round-trip through IEEE 754 doubles
    (``1e400``, ``1e-400``, ``9007199254740993.0``) are rejected instead of
    silently corrupted. Parser failures the SDK would turn into 500s
    (nesting depth beyond the JSON parser's recursion limit, integer
    literals beyond Python's digit limit) become sanitized parse errors.
  Valid requests pass through byte-for-byte with the buffered body replayed
  once and later receive() calls delegated to the original receive (real
  disconnects propagate); non-/mcp routes, other methods and requests with
  unacceptable media headers are untouched. The SDK itself reads the full
  body before session validation, so buffering adds no new unbounded-read
  exposure; no body-size or read-timeout limits are imposed (none exist
  elsewhere in the service — see the PR discussion before adding any).
- The ``sse_starlette.sse`` logger is clamped to INFO: its DEBUG records
  are pure response-body echoes with no operational value.

``install_sanitized_validation(mcp)`` wires the middleware and log filters;
``McpEnvelopeGuard`` is wrapped around the MCP HTTP app at mount time.
Both are idempotent.
"""

import json
import logging
import math
from decimal import Decimal, InvalidOperation

from fastmcp.exceptions import ToolError, ValidationError
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE
from pydantic import ValidationError as PydanticValidationError

FASTMCP_SERVER_LOGGER = "fastmcp.server.server"
SSE_LOGGER = "sse_starlette.sse"
_INVALID_ARGUMENTS_PREFIX = "Invalid arguments for tool "
_REDACTED_DETAIL_KEYS = frozenset({"input", "ctx", "url"})
# Error types whose `loc` is a caller-controlled unknown argument key.
_EXTRA_KEY_ERROR_TYPES = frozenset({"extra_forbidden", "unexpected_keyword_argument"})
_REDACTED_LOC = "<extra-key>"

# tools/call targets whose `data` accepts arbitrary JSON numbers: non-
# roundtrippable float tokens are rejected here instead of silently rounded.
DOCUMENT_DATA_TOOLS = frozenset({"task_document_create", "task_document_update"})

# mcp SDK (mcp.shared.session) logs these to the ROOT logger with full
# message reprs / pydantic details on validation failure.
_SDK_LEAK_PREFIXES = (
    "Failed to validate request: ",
    "Message that failed validation: ",
    "Failed to validate notification: ",
)


def _sanitize_errors(cause: PydanticValidationError) -> list[dict]:
    try:
        errors = cause.errors(include_url=False, include_context=False, include_input=False)
    except TypeError:  # older pydantic without include_input
        errors = [
            {key: value for key, value in error.items() if key not in _REDACTED_DETAIL_KEYS}
            for error in cause.errors(include_url=False)
        ]
    return [_sanitize_error(error) for error in errors]


def _sanitize_error(error: dict) -> dict:
    """Redact caller-controlled loc segments (unknown argument keys)."""
    if str(error.get("type", "")) in _EXTRA_KEY_ERROR_TYPES:
        error = {**error, "loc": (_REDACTED_LOC,)}
    return error


def _sanitized_message(tool_name: str, exc: ValidationError) -> str:
    cause = exc.__cause__
    if isinstance(cause, PydanticValidationError):
        details = "; ".join(
            "{loc}: {msg} [{type}]".format(
                loc=".".join(str(part) for part in error.get("loc", ())) or "<arguments>",
                msg=error.get("msg", ""),
                type=error.get("type", ""),
            )
            for error in _sanitize_errors(cause)
        )
        return f"{_INVALID_ARGUMENTS_PREFIX}{tool_name!r}: {details}"
    # Unknown cause shape — do not risk echoing it.
    return f"{_INVALID_ARGUMENTS_PREFIX}{tool_name!r}: arguments failed validation"


class SanitizedValidationMiddleware(Middleware):
    """Re-raise FastMCP argument-validation errors without the input echo."""

    async def on_call_tool(
        self,
        context: MiddlewareContext,
        call_next: CallNext,
    ):
        try:
            return await call_next(context)
        except ValidationError as exc:
            raise ToolError(_sanitized_message(context.message.name, exc)) from exc


class RedactInvalidArgumentInputs(logging.Filter):
    """Strip offending input values from FastMCP's invalid-argument warnings."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not str(record.msg).startswith(_INVALID_ARGUMENTS_PREFIX):
            return True
        args = record.args
        if isinstance(args, tuple) and len(args) == 2:
            record.args = (args[0], _redact_detail(args[1]))
        return True


def _redact_detail(detail) -> object:
    if isinstance(detail, list) and all(isinstance(item, dict) for item in detail):
        return [
            _sanitize_error({key: value for key, value in item.items() if key not in _REDACTED_DETAIL_KEYS})
            for item in detail
        ]
    return "<redacted>"


class SdkRootLogSanitizer(logging.Filter):
    """Rewrite mcp-SDK validation-failure messages that embed full payloads.

    The SDK logs these through the ROOT logger (``logging.warning(...)`` in
    ``mcp.shared.session``), so no named-logger filter can catch them. Only
    the three known message shapes are rewritten; everything else passes.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        message = str(record.getMessage())
        for prefix in _SDK_LEAK_PREFIXES:
            if message.startswith(prefix):
                record.msg = prefix.rstrip(": ") + ": <redacted payload>"
                record.args = None
                return True
        return True


def _clamp_sse_body_logging() -> None:
    """sse-starlette DEBUG records are raw response-body echoes."""
    logging.getLogger(SSE_LOGGER).setLevel(logging.INFO)


# --- Raw-envelope guard (runs before the SDK parses the request) ---

# The SDK's own cap (mcp.server.transport_security.DEFAULT_MAX_REQUEST_BODY_SIZE,
# 4 MiB) is enforced by RequestBodyLimitMiddleware *inside* the session manager;
# the guard applies the identical limit while buffering so it never holds more
# than the SDK would accept. This mirrors existing behavior — no new cap.
_MAX_BODY_BYTES = DEFAULT_MAX_REQUEST_BODY_SIZE


class _FloatToken:
    """Placeholder marking a JSON float token during envelope inspection."""

    __slots__ = ("token",)

    def __init__(self, token: str):
        self.token = token


def _float_token(token: str) -> _FloatToken:
    # Also receives NaN/Infinity constants via parse_constant.
    return _FloatToken(token)


def _float_roundtrips(token: str) -> bool:
    """True when the token survives the double conversion with the same value.

    The MCP transport delivers JSON numbers as Python floats, so a token is
    safe only when the nearest double converts back to the same numeric
    value: ``Decimal(repr(float(token))) == Decimal(token)``. This accepts
    ordinary doubles (``0.1``, ``1e3``) and rejects over/underflow
    (``1e400``, ``1e-400``) and decimals needing more than double precision
    (``9007199254740993.0``). JSON integers are arbitrary-precision and
    unaffected (up to the Python parser's integer digit limit). Acceptance
    is decimal round-trip, not exact binary representation: ``1e3`` is
    accepted and stored as ``1000.0``, and PostgreSQL JSONB normalizes
    spelling and signed zero (``-0`` becomes ``0``), so neither the textual
    form nor the zero sign survives storage.
    """
    try:
        value = float(token)
        return math.isfinite(value) and Decimal(repr(value)) == Decimal(token)
    except (ValueError, InvalidOperation):
        return False


_INVALID_REQUEST_PARAMS = "Invalid request parameters"
_NUMBERS_MESSAGE = (
    "{tool}: numbers in document data must round-trip exactly through IEEE 754 doubles "
    "as decimal values (values like 1e400, 1e-400 or beyond-double-precision decimals "
    "would be silently changed); send precision-sensitive values as strings"
)


def _id_is_valid(request_id) -> bool:
    return isinstance(request_id, str) or (isinstance(request_id, int) and not isinstance(request_id, bool))


def _request_id(message: dict):
    """Best-effort valid JSON-RPC id for a guard rejection response."""
    request_id = message.get("id")
    if _id_is_valid(request_id):
        return request_id
    return "server-error" if "method" in message else None


def _check_response_envelope(message: dict) -> tuple[int, int, str, object] | None:
    """Validate method-less client response/error envelopes.

    The SDK's ``JSONRPCMessage`` validation of these echoes pydantic
    ``input_value`` (the response payload) into its 400 responses; the guard
    rejects malformed shapes sanitized. Valid responses pass through.
    Mirrors mcp.types: ``id`` must be a strict string/integer, ``result``
    must be an object, ``error`` an object with integer ``code`` and string
    ``message``.
    """
    if not _id_is_valid(message.get("id")):
        return 400, -32602, "Invalid request: response id must be a string or a number", "server-error"
    if "error" in message:
        error = message["error"]
        if not isinstance(error, dict):
            return 400, -32602, "Invalid request: response error must be an object", "server-error"
        code = error.get("code")
        if not (isinstance(code, int) and not isinstance(code, bool)) or not isinstance(error.get("message"), str):
            return (
                400,
                -32602,
                "Invalid request: response error must contain an integer code and a string message",
                "server-error",
            )
    elif "result" in message:
        if not isinstance(message["result"], dict):
            return 400, -32602, "Invalid request: response result must be an object", "server-error"
    else:
        return 400, -32602, "Invalid request: a response must contain result or error", "server-error"
    return None


def _check_envelope(message) -> tuple[int, int, str, object] | None:
    """Validate a parsed POST /mcp body; return (http status, JSON-RPC error
    code, sanitized message, response id) for rejections, else None.

    SDK layers are mirrored, minus the payload leaks:

    - HTTP-layer envelope validity (the SDK's ``JSONRPCMessage`` validation
      echoes pydantic ``input_value`` — including document data — into its
      400 responses): the message must be an object with ``jsonrpc`` "2.0",
      a non-empty string ``method`` when present, a string/number ``id`` on
      requests, object ``params`` on requests/notifications (mcp.types
      ``dict[str, Any] | None``), and a well-formed response/error envelope
      on method-less messages.
    - Session-layer ``tools/call`` parameter validity (the SDK logs failed
      messages to the ROOT logger with full payloads): ``arguments`` must be
      an object, the tool name a string, document ``data`` float tokens must
      round-trip exactly through doubles, and CAS tokens
      (``expected_id``/``expected_revision``) must be integers — a float
      token like ``1e400`` would arrive as ``null`` and silently disable the
      guard.
    """
    if not isinstance(message, dict):
        return 400, -32602, "Invalid request: the JSON-RPC message must be an object", "server-error"
    if "method" not in message:
        return _check_response_envelope(message)
    if message.get("jsonrpc") != "2.0":
        return 400, -32602, 'Invalid request: jsonrpc must be "2.0"', _request_id(message)
    method = message.get("method")
    if not isinstance(method, str) or not method:
        return 400, -32602, "Invalid request: method must be a non-empty string", _request_id(message)
    if "id" in message and not _id_is_valid(message.get("id")):
        return 400, -32602, "Invalid request: id must be a string or a number", "server-error"
    params = message.get("params")
    if params is not None and not isinstance(params, dict):
        # mcp.types: params is dict[str, Any] | None — the SDK's JSONRPCMessage
        # validation rejects non-object params with a leaking 400.
        return 400, -32602, "Invalid request: params must be an object", _request_id(message)
    if method != "tools/call":
        return None  # Notifications and other methods: SDK path.
    if params is None:
        return None
    name = params.get("name")
    if not isinstance(name, str):
        return 200, -32602, f"{_INVALID_REQUEST_PARAMS}: tool name must be a string", _request_id(message)
    arguments = params.get("arguments")
    if arguments is not None and not isinstance(arguments, dict):
        return 200, -32602, f"{_INVALID_REQUEST_PARAMS}: arguments must be an object", _request_id(message)
    if name in DOCUMENT_DATA_TOOLS and isinstance(arguments, dict):
        for key in ("expected_id", "expected_revision"):
            if isinstance(arguments.get(key), _FloatToken):
                # A float token over/underflows to null/rounded before the
                # handler runs, silently disabling the CAS guard.
                return (
                    200,
                    -32602,
                    f"{_INVALID_REQUEST_PARAMS} for {name}: {key} must be an integer",
                    _request_id(message),
                )
        try:
            has_bad_float = _has_bad_float(arguments)
        except RecursionError:
            return 400, -32700, "Parse error: request nesting exceeds supported depth", _request_id(message)
        if has_bad_float:
            return (
                200,
                -32602,
                f"{_INVALID_REQUEST_PARAMS} for {name}: " + _NUMBERS_MESSAGE.format(tool=name),
                _request_id(message),
            )
    return None


def _has_bad_float(value) -> bool:
    if isinstance(value, _FloatToken):
        return not _float_roundtrips(value.token)
    if isinstance(value, dict):
        return any(_has_bad_float(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_bad_float(item) for item in value)
    return False


def _header(scope: dict, name: bytes) -> bytes:
    for key, value in scope.get("headers") or []:
        if key.lower() == name:
            return value
    return b""


def _passes_sdk_media_checks(scope: dict) -> bool:
    """Mirror the SDK's pre-body POST checks (Accept and Content-Type).

    Requests the SDK would reject with 406/415 without reading the body are
    passed through untouched so the guard never reads them either and the
    SDK responses stay authoritative. Content-Type handling mirrors both SDK
    checks: it must start with ``application/json`` (case-insensitive,
    ``TransportSecurity._validate_content_type``) and contain an exact
    ``application/json`` entry in the comma-separated list of the first
    semicolon segment (``_check_content_type``) — so
    ``application/json, text/plain`` is accepted, like the SDK accepts it.
    """
    accept_types = [entry.strip() for entry in _header(scope, b"accept").split(b",")]
    has_json = any(entry.startswith(b"application/json") for entry in accept_types)
    has_sse = any(entry.startswith(b"text/event-stream") for entry in accept_types)
    if not (has_json and has_sse):
        return False
    content_type = _header(scope, b"content-type").decode("latin-1", "replace")
    if not content_type.lower().startswith("application/json"):
        return False
    parts = [part.strip() for part in content_type.split(";")[0].split(",")]
    return any(part == "application/json" for part in parts)


def _default_session_manager_getter(app):
    """Locate the streamable-http session manager inside a FastMCP app."""

    def getter():
        for route in getattr(app, "routes", []):
            endpoint = getattr(route, "endpoint", None)
            manager = getattr(endpoint, "session_manager", None)
            if manager is not None:
                return manager
        return None

    return getter


class McpEnvelopeGuard:
    """ASGI middleware rejecting leaky/corrupting JSON-RPC envelopes early.

    Wraps the MCP HTTP app. Only ``POST /mcp`` requests whose Accept and
    Content-Type headers would pass the SDK's own pre-body checks are
    inspected. The SDK's body-size cap
    (``mcp.server.transport_security.DEFAULT_MAX_REQUEST_BODY_SIZE``, 4 MiB)
    is enforced identically while buffering — declared Content-Length and
    streamed chunks both answer 413 like the SDK's
    ``RequestBodyLimitMiddleware``, so the guard never holds more than the
    SDK would accept and no new limit is introduced. An upload interrupted
    by a client disconnect returns without replay or response. The parsed
    tree is released before downstream dispatch; the buffered body is
    replayed once and later receive() calls delegate to the original ASGI
    receive so real disconnects propagate.

    Session semantics mirror the SDK's routing: the session manager answers
    404 for unknown session ids *before* parsing the body, so when the
    request carries an unknown session the guard defers entirely (the SDK
    404 stays authoritative) and never echoes the untrusted session id on
    its own responses.
    """

    def __init__(self, app, session_manager_getter=None):
        self.app = app
        self._session_manager_getter = session_manager_getter or _default_session_manager_getter(app)

    def _session_is_known(self, scope: dict) -> bool:
        """True when the guard may answer (absent session id, or a known one).

        The SDK routes unknown session ids to a 404 without parsing the
        body; requests without a session id open a new session and are
        parsed, so they stay guardable.
        """
        manager = self._session_manager_getter()
        if manager is None:
            return False  # Manager unavailable (not running): defer to the SDK.
        session_id = _header(scope, b"mcp-session-id").decode("latin-1", "replace") or None
        if session_id is None:
            return True
        return session_id in getattr(manager, "_server_instances", {})

    async def __call__(self, scope, receive, send):
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or str(scope.get("path", "")).rstrip("/") != "/mcp"
            or not _passes_sdk_media_checks(scope)
        ):
            await self.app(scope, receive, send)
            return
        # Declared-size 413 before reading, mirroring the SDK middleware.
        content_length = _header(scope, b"content-length").decode("latin-1", "replace")
        if content_length:
            try:
                if int(content_length) > _MAX_BODY_BYTES:
                    await _send_plain(send, 413, b"Request body too large")
                    return
            except ValueError:
                pass
        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                # Interrupted upload (client disconnect): no replay, no response.
                return
            body += message.get("body", b"")
            if len(body) > _MAX_BODY_BYTES:
                await _send_plain(send, 413, b"Request body too large")
                return
            if not message.get("more_body"):
                break
        raw = bytes(body)
        body = None  # Release the mutable buffer; only the replay copy remains.
        try:
            message = json.loads(raw, parse_float=_float_token, parse_constant=_float_token)
        except UnicodeDecodeError:
            # The SDK's parse path answers invalid UTF-8 with a 500.
            await _send_rejection(
                send,
                scope,
                400,
                -32700,
                "Parse error: request body is not valid UTF-8",
                "server-error",
                echo_session=False,
            )
            return
        except json.JSONDecodeError:
            # The SDK's own parse-error path echoes no payload.
            await self.app(scope, _replay_body(raw, receive), send)
            return
        except RecursionError:
            rejection = (400, -32700, "Parse error: request nesting exceeds supported depth", "server-error")
        except ValueError:
            # e.g. integer literals beyond Python's digit limit; the SDK
            # turns these into a 500 instead of a clean client error.
            rejection = (
                400,
                -32700,
                "Parse error: request contains an unsupported numeric literal "
                "(e.g. an integer beyond the parser digit limit)",
                "server-error",
            )
        else:
            rejection = _check_envelope(message)
        message = None  # Release the parsed tree before downstream dispatch.
        session_is_known = self._session_is_known(scope)
        if rejection is None or not session_is_known:
            # Clean pass-through, or an unknown session where the SDK's own
            # 404 (issued before body parsing) stays authoritative.
            await self.app(scope, _replay_body(raw, receive), send)
            return
        await _send_rejection(send, scope, *rejection, echo_session=session_is_known)


async def _send_plain(send, status: int, payload: bytes) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"text/plain; charset=utf-8"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})


async def _send_rejection(
    send, scope, status: int, code: int, error_message: str, request_id, echo_session: bool
) -> None:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": error_message}}
    ).encode("utf-8")
    headers = [
        (b"content-type", b"application/json"),
        (b"content-length", str(len(payload)).encode()),
    ]
    if echo_session:
        session_id = _header(scope, b"mcp-session-id")
        if session_id:
            # Echoed only for known sessions (see McpEnvelopeGuard).
            headers.append((b"mcp-session-id", session_id))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": payload})


def _replay_body(raw: bytes, original_receive):
    """Return an ASGI receive() callable that replays the buffered body once,
    then delegates to the original receive so real disconnects propagate."""

    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": raw, "more_body": False}
        return await original_receive()

    return receive


def install_sanitized_validation(mcp) -> None:
    """Attach the validation sanitizer to a FastMCP server (idempotent)."""
    if not any(isinstance(mw, SanitizedValidationMiddleware) for mw in mcp.middleware):
        mcp.add_middleware(SanitizedValidationMiddleware())
    logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
    if not any(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters):
        logger.addFilter(RedactInvalidArgumentInputs())
    root = logging.getLogger()
    if not any(isinstance(f, SdkRootLogSanitizer) for f in root.filters):
        root.addFilter(SdkRootLogSanitizer())
    _clamp_sse_body_logging()

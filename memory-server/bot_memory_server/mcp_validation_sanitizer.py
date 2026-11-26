"""Sanitize FastMCP/MCP-SDK paths that echo tool-call payloads.

Three independent leak paths exist before (or beside) the tool handlers, all
confirmed against FastMCP 3.4.11 / mcp SDK / sse-starlette 3.3.4:

1. Tool argument validation (FastMCP): the MCP error response embeds
   pydantic's ``input_value=...`` and the ``Invalid arguments for tool``
   warning log carries ``errors()`` entries with ``input`` values. Unknown
   argument keys additionally leak through pydantic's ``loc`` (the key is
   caller-controlled, potentially data-derived).
2. JSON-RPC envelope validation (mcp SDK, ``mcp.shared.session``): malformed
   requests (e.g. ``arguments`` as an array, invalid JSON-RPC ``id``) are
   logged to the ROOT logger — ``Failed to validate request: ...`` (WARNING),
   ``Message that failed validation: ...`` (DEBUG, full message repr with
   payload) and ``Failed to validate notification: ... . Message was: ...``
   (WARNING, full message repr).
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
  that inspects ``POST /mcp`` bodies before the SDK parses them: JSON-RPC
  ``tools/call`` envelopes with non-object ``arguments`` or an invalid
  ``id`` are rejected with a sanitized ``-32602`` error (so the SDK's leaky
  validation-failure logging never runs), and ``task_document_create`` /
  ``task_document_update`` calls containing float tokens that do not
  round-trip exactly through IEEE 754 doubles (``1e400``, ``1e-400``,
  ``9007199254740993.0``) are rejected instead of silently corrupted.
  Valid requests pass through byte-for-byte; non-/mcp routes and other
  methods are untouched.
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


class _FloatToken:
    """Placeholder marking a JSON float token during envelope inspection."""

    __slots__ = ("token",)

    def __init__(self, token: str):
        self.token = token


def _float_token(token: str) -> _FloatToken:
    # Also receives NaN/Infinity constants via parse_constant.
    return _FloatToken(token)


def _float_roundtrips(token: str) -> bool:
    """True when the token survives the double conversion unchanged.

    The MCP transport delivers JSON numbers as Python floats, so a token is
    safe only when the nearest double converts back to the same numeric
    value: ``Decimal(repr(float(token))) == Decimal(token)``. This accepts
    ordinary doubles (``0.1``, ``1e3``) and rejects over/underflow
    (``1e400``, ``1e-400``) and decimals needing more than double precision
    (``9007199254740993.0``). JSON integers are arbitrary-precision and
    unaffected.
    """
    try:
        value = float(token)
        return math.isfinite(value) and Decimal(repr(value)) == Decimal(token)
    except (ValueError, InvalidOperation):
        return False


def _check_envelope(raw: bytes) -> tuple[str, object] | None:
    """Inspect a POST /mcp body; return (sanitized error message, response id)
    for shapes that must be rejected before SDK handling, else None.

    Only JSON-RPC ``tools/call`` envelopes are checked: non-object
    ``arguments`` and invalid ``id`` would otherwise be logged with full
    payloads by the mcp SDK; non-roundtrippable float tokens in document
    ``data`` would otherwise be silently corrupted.
    """
    try:
        message = json.loads(raw, parse_float=_float_token, parse_constant=_float_token)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None  # Malformed JSON: the SDK's own error path has no payload to echo.
    if not isinstance(message, dict) or message.get("method") != "tools/call":
        return None
    request_id = message.get("id")
    id_is_valid = request_id is None or (isinstance(request_id, str | int) and not isinstance(request_id, bool))
    if "id" in message and not id_is_valid:
        return "Invalid request parameters: JSON-RPC id must be a string or a number", None
    params = message.get("params")
    if params is None:
        return None
    if not isinstance(params, dict):
        return "Invalid request parameters: params must be an object", None
    arguments = params.get("arguments")
    if arguments is not None and not isinstance(arguments, dict):
        return "Invalid request parameters: arguments must be an object", request_id if id_is_valid else None
    if params.get("name") in DOCUMENT_DATA_TOOLS and isinstance(arguments, dict) and _has_bad_float(arguments):
        return (
            f"Invalid request parameters for {params['name']}: numbers in document data must be exactly "
            "representable as IEEE 754 doubles (values like 1e400, 1e-400 or beyond-double-precision decimals "
            "would be silently changed); send precision-sensitive values as strings",
            request_id if id_is_valid else None,
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


class McpEnvelopeGuard:
    """ASGI middleware rejecting leaky/corrupting tools/call envelopes early.

    Wraps the MCP HTTP app: only ``POST /mcp`` bodies are inspected; valid
    requests are forwarded byte-for-byte with replayed bodies, and everything
    else (other methods, other paths) passes through untouched.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or str(scope.get("path", "")).rstrip("/") != "/mcp":
            await self.app(scope, receive, send)
            return
        body = bytearray()
        while True:
            message = await receive()
            body += message.get("body", b"")
            if not message.get("more_body"):
                break
        raw = bytes(body)
        rejection = _check_envelope(raw)
        if rejection is not None:
            error_message, request_id = rejection
            payload = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": error_message},
                }
            ).encode("utf-8")
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(payload)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": payload})
            return
        await self.app(scope, _replay_body(raw), send)


def _replay_body(raw: bytes):
    """Return an ASGI receive() callable yielding the buffered body once.

    Mirrors httpx's ASGITransport: after the body, no further messages arrive
    (the pending wait is simply cancelled when the response completes)."""
    sent = False

    async def receive():
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": raw, "more_body": False}
        import asyncio

        await asyncio.Event().wait()  # block until cancelled
        return {"type": "http.disconnect"}

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

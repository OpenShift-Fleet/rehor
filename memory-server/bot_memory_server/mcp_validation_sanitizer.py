"""Sanitize FastMCP argument-validation failures.

FastMCP (3.4.x) leaks tool arguments on malformed calls in two places, both
before the tool handler runs:

1. The MCP error response: FunctionTool converts pydantic's call-validation
   error into ``fastmcp.exceptions.ValidationError(str(e))``, and pydantic's
   string form embeds ``input_value=...`` — the full arguments, including
   document payloads.
2. The server warning log: ``Invalid arguments for tool %r: %s`` logs
   ``pydantic ValidationError.errors()``, whose entries carry the offending
   ``input`` values.

For task_document tools the arguments include arbitrary JSONB payloads, so a
malformed call would echo document content into logs and error outputs. The
fixes here sit at the framework's sanctioned extension points and only remove
the offending input echo — error locations, messages and types are preserved
so callers still get actionable validation feedback:

- ``SanitizedValidationMiddleware`` catches ``fastmcp.exceptions.ValidationError``
  around ``tools/call`` and re-raises a ``ToolError`` built from pydantic's
  ``errors(include_input=False)``.
- ``RedactInvalidArgumentInputs`` is a ``logging.Filter`` on the FastMCP server
  logger that strips ``input``/``ctx``/``url`` keys from the already-computed
  warning detail (the warning is emitted inside FastMCP before the middleware
  can intercept the exception).

``install_sanitized_validation(mcp)`` wires both, idempotently.
"""

import logging

from fastmcp.exceptions import ToolError, ValidationError
from fastmcp.server.middleware import CallNext, Middleware, MiddlewareContext
from pydantic import ValidationError as PydanticValidationError

FASTMCP_SERVER_LOGGER = "fastmcp.server.server"
_INVALID_ARGUMENTS_PREFIX = "Invalid arguments for tool "
_REDACTED_DETAIL_KEYS = frozenset({"input", "ctx", "url"})


def _sanitized_errors(cause: PydanticValidationError) -> list[dict]:
    try:
        return cause.errors(include_url=False, include_context=False, include_input=False)
    except TypeError:  # older pydantic without include_input
        return [
            {key: value for key, value in error.items() if key not in _REDACTED_DETAIL_KEYS}
            for error in cause.errors(include_url=False)
        ]


def _sanitized_message(tool_name: str, exc: ValidationError) -> str:
    cause = exc.__cause__
    if isinstance(cause, PydanticValidationError):
        details = "; ".join(
            "{loc}: {msg} [{type}]".format(
                loc=".".join(str(part) for part in error.get("loc", ())) or "<arguments>",
                msg=error.get("msg", ""),
                type=error.get("type", ""),
            )
            for error in _sanitized_errors(cause)
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
        return [{key: value for key, value in item.items() if key not in _REDACTED_DETAIL_KEYS} for item in detail]
    return "<redacted>"


def install_sanitized_validation(mcp) -> None:
    """Attach the validation sanitizer to a FastMCP server (idempotent)."""
    if not any(isinstance(mw, SanitizedValidationMiddleware) for mw in mcp.middleware):
        mcp.add_middleware(SanitizedValidationMiddleware())
    logger = logging.getLogger(FASTMCP_SERVER_LOGGER)
    if not any(isinstance(f, RedactInvalidArgumentInputs) for f in logger.filters):
        logger.addFilter(RedactInvalidArgumentInputs())

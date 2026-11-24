"""Structured JSON logging for the memory server and uvicorn.

Note on correlation fields:
In the memory server, cycle-specific correlation keys (`run_id`, `task_key`, `model`,
`cost`) are intentionally emitted as JSON `null`. The memory server runs as an independent
HTTP/MCP service and does not execute runner cycles; maintaining identical schema fields
ensures uniform Kibana and AppSRE index mappings without requiring distributed HTTP
correlation headers across the service boundary.
"""

import datetime
import json
import logging
import os
import re
import sys
from contextvars import ContextVar
from typing import Any

MAX_FIELD_LENGTH = 8 * 1024  # 8 KiB cap per field

_CONTEXT: ContextVar[dict[str, Any] | None] = ContextVar("log_context", default=None)

# Scoped secret redaction patterns
_SECRET_PATTERNS = [
    (re.compile(r"(Bearer\s+)[A-Za-z0-9_\-\.~+/]+=*", re.IGNORECASE), r"\1[REDACTED]"),
    (re.compile(r"://([^:\s]+):([^@\s]+)@"), r"://\1:[REDACTED]@"),
    (re.compile(r"(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,})"), "[REDACTED]"),
    (re.compile(r"glpat-[A-Za-z0-9\-]{20,}"), "[REDACTED]"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "[REDACTED]"),
    (re.compile(r"sk-[A-Za-z0-9_\-]{20,}"), "[REDACTED]"),
    (re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_\-]+"), "[REDACTED_SLACK_WEBHOOK]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]{10,}"), "[REDACTED]"),
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
        "[REDACTED PRIVATE KEY]",
    ),
]

_SECRET_ENV_FRAGMENTS = ("TOKEN", "SECRET", "KEY", "PASSWORD", "AUTH", "CREDENTIAL")


def redact_text(text: str) -> str:
    """Redact sensitive patterns and matching environment values from text."""
    if not text:
        return text

    result = text
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)

    for k, v in os.environ.items():
        if any(frag in k.upper() for frag in _SECRET_ENV_FRAGMENTS):
            clean_v = v.strip()
            if len(clean_v) >= 6 and clean_v in result:
                result = result.replace(clean_v, "[REDACTED]")

    return result


def truncate_field(val: Any, max_len: int = MAX_FIELD_LENGTH) -> Any:
    """Truncate string values exceeding max_len."""
    if val is None or not isinstance(val, str):
        return val
    if len(val) > max_len:
        return val[: max_len - 15] + "...[TRUNCATED]"
    return val


def bind(**fields: Any) -> None:
    """Bind contextual fields to current context."""
    current = dict(_CONTEXT.get() or {})
    current.update(fields)
    _CONTEXT.set(current)


def clear() -> None:
    """Reset context to empty."""
    _CONTEXT.set(None)


def get_context() -> dict[str, Any]:
    """Return a copy of the current context fields."""
    return dict(_CONTEXT.get() or {})


class JsonFormatter(logging.Formatter):
    """Format log records as single-line JSON objects with standard correlation keys.

    `run_id`, `task_key`, `model`, and `cost` are intentionally null for memory-server logs
    to match the fleet Kibana schema without distributed HTTP trace propagation.
    """

    def format(self, record: logging.LogRecord) -> str:
        ctx = _CONTEXT.get() or {}
        dt = datetime.datetime.fromtimestamp(record.created, datetime.UTC)

        raw_msg = record.getMessage()
        msg = truncate_field(redact_text(raw_msg))

        data: dict[str, Any] = {
            "timestamp": dt.isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": msg,
            "run_id": truncate_field(ctx.get("run_id")),
            "task_key": truncate_field(ctx.get("task_key")),
            "model": truncate_field(ctx.get("model")),
            "cost": ctx.get("cost"),
        }
        if record.exc_info:
            raw_exc = self.formatException(record.exc_info)
            data["exc_info"] = truncate_field(redact_text(raw_exc))
        if record.stack_info:
            raw_stack = self.formatStack(record.stack_info)
            data["stack_info"] = truncate_field(redact_text(raw_stack))

        return json.dumps(data, ensure_ascii=False, default=str)


def setup_logging(stream: Any = None) -> None:
    """Configure structured JSON logging to stdout for root and uvicorn loggers.

    Honors DEBUG=true env var (exact string match for DEBUG; else INFO).
    Replaces existing handlers on root and uvicorn loggers to remain idempotent.
    """
    level = logging.DEBUG if os.environ.get("DEBUG") == "true" else logging.INFO
    formatter = JsonFormatter()

    root = logging.getLogger()
    root.setLevel(level)
    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()
    root_handler = logging.StreamHandler(stream or sys.stdout)
    root_handler.setFormatter(formatter)
    root.addHandler(root_handler)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.setLevel(level)
        for h in list(uv_logger.handlers):
            uv_logger.removeHandler(h)
            h.close()
        uv_handler = logging.StreamHandler(stream or sys.stdout)
        uv_handler.setFormatter(formatter)
        uv_logger.addHandler(uv_handler)
        uv_logger.propagate = False


def emit_sample_line() -> None:
    """Emit sample JSON log lines (info and exception) through setup_logging and real logger calls."""
    setup_logging()
    logger = logging.getLogger("bot_memory_server.sample")
    logger.info("Sample memory server log message with\nmultiline content")
    try:
        raise ValueError("Sample memory server exception")
    except ValueError:
        logger.exception("Sample error occurred")

"""Structured JSON logging, context tracking, and rotation for the bot runner."""

import contextlib
import datetime
import json
import logging
import os
import re
import sys
import tempfile
from contextvars import ContextVar
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

# Default file rotation: 10 MiB, 5 backups (~60 MiB total: active + 5 backups)
DEFAULT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_BACKUP_COUNT = 5
MAX_FIELD_LENGTH = 8 * 1024  # 8 KiB cap per field

DEFAULT_DATA_DIR = Path(__file__).parent.parent.resolve() / "data"
DEFAULT_LOG_FILE = DEFAULT_DATA_DIR / "bot.log"

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
    """Bind contextual fields (e.g. run_id, task_key, model, cost) to current context."""
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
    """Format log records as single-line JSON objects with standard correlation keys."""

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


class SecureRotatingFileHandler(RotatingFileHandler):
    """RotatingFileHandler ensuring restrictive 0600 file permissions."""

    def _open(self):
        prev_umask = os.umask(0o077)
        try:
            stream = super()._open()
            with contextlib.suppress(OSError):
                os.chmod(self.baseFilename, 0o600)
            return stream
        finally:
            os.umask(prev_umask)

    def doRollover(self):
        super().doRollover()
        with contextlib.suppress(OSError):
            os.chmod(self.baseFilename, 0o600)


def setup_logging(
    log_file: Path | str | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    backup_count: int = DEFAULT_BACKUP_COUNT,
) -> None:
    """Configure logging to stdout and rotating file using JsonFormatter.

    Set DEBUG=true env var to enable DEBUG-level logging.
    Second call replaces existing handlers to prevent duplicate log lines.
    """
    level = logging.DEBUG if os.environ.get("DEBUG") == "true" else logging.INFO
    formatter = JsonFormatter()

    if log_file is None:
        raw_env = os.environ.get("BOT_LOG_FILE")
        data_dir = DEFAULT_DATA_DIR.resolve()
        if raw_env:
            candidate = Path(raw_env)
            resolved = candidate.resolve() if candidate.is_absolute() else (data_dir / candidate).resolve()
            try:
                resolved.relative_to(data_dir)
            except ValueError:
                raise ValueError(f"BOT_LOG_FILE path jail violation: {raw_env} must reside under {data_dir}") from None
            log_path = resolved
        else:
            log_path = DEFAULT_LOG_FILE
    else:
        log_path = Path(log_file)

    log_path.parent.mkdir(parents=True, exist_ok=True)
    if not log_path.exists():
        with contextlib.suppress(OSError):
            log_path.touch(mode=0o600, exist_ok=True)
    with contextlib.suppress(OSError):
        os.chmod(log_path, 0o600)

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(formatter)

    file_handler = SecureRotatingFileHandler(
        str(log_path),
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)

    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()

    root.addHandler(stream_handler)
    root.addHandler(file_handler)


def emit_sample_line() -> None:
    """Emit sample JSON log lines (info and exception) through setup_logging and real logger calls."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_log = Path(tmpdir) / "sample.log"
        setup_logging(log_file=tmp_log)
        logger = logging.getLogger("bot.sample")
        logger.info("Sample log message with\nmultiline content")
        try:
            raise ValueError("Sample exception for verification")
        except ValueError:
            logger.exception("Sample error occurred")
        root = logging.getLogger()
        for h in list(root.handlers):
            root.removeHandler(h)
            h.close()

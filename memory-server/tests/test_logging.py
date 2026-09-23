"""Tests for memory-server structured JSON logging."""

import datetime
import io
import json
import logging
import sys

import pytest
from bot_memory_server.log import (
    JsonFormatter,
    clear,
    emit_sample_line,
    setup_logging,
)


@pytest.fixture(autouse=True)
def _clean_context():
    clear()
    yield
    clear()


@pytest.fixture
def clean_loggers():
    """Save and restore root and uvicorn loggers state."""
    loggers_to_save = [
        logging.getLogger(),
        logging.getLogger("uvicorn"),
        logging.getLogger("uvicorn.error"),
        logging.getLogger("uvicorn.access"),
    ]
    saved_state = [
        (target_logger, list(target_logger.handlers), target_logger.level, target_logger.propagate)
        for target_logger in loggers_to_save
    ]
    yield
    for target_logger, handlers, level, propagate in saved_state:
        for h in list(target_logger.handlers):
            target_logger.removeHandler(h)
            h.close()
        for h in handlers:
            target_logger.addHandler(h)
        target_logger.setLevel(level)
        target_logger.propagate = propagate


def _make_record(
    msg: str = "Test message",
    level: int = logging.INFO,
    name: str = "bot_memory_server.test",
    args: tuple = (),
    exc_info=None,
) -> logging.LogRecord:
    return logging.LogRecord(
        name=name,
        level=level,
        pathname=__file__,
        lineno=10,
        msg=msg,
        args=args,
        exc_info=exc_info,
    )


# =============================================================================
# Layer 4 — Formatter and setup_logging tests for memory-server
# =============================================================================


def test_formatter_required_keys():
    formatter = JsonFormatter()
    record = _make_record("Memory server startup", level=logging.INFO)
    line = formatter.format(record)

    data = json.loads(line)
    for req in [
        "timestamp",
        "level",
        "logger",
        "message",
        "run_id",
        "task_key",
        "model",
        "cost",
    ]:
        assert req in data

    assert data["level"] == "INFO"
    assert data["logger"] == "bot_memory_server.test"
    assert data["message"] == "Memory server startup"
    assert data["run_id"] is None
    assert data["task_key"] is None
    assert data["model"] is None
    assert data["cost"] is None


def test_formatter_levels():
    formatter = JsonFormatter()
    for level, level_str in [
        (logging.DEBUG, "DEBUG"),
        (logging.INFO, "INFO"),
        (logging.WARNING, "WARNING"),
        (logging.ERROR, "ERROR"),
    ]:
        record = _make_record("msg", level=level)
        data = json.loads(formatter.format(record))
        assert data["level"] == level_str


def test_formatter_timestamp_iso8601():
    formatter = JsonFormatter()
    record = _make_record("msg")
    data = json.loads(formatter.format(record))

    ts = datetime.datetime.fromisoformat(data["timestamp"])
    assert ts.tzinfo is not None
    assert ts.utcoffset() == datetime.timedelta(0)


def test_formatter_single_line_escaped():
    formatter = JsonFormatter()
    record = _make_record("First\nSecond\r\nThird")
    line = formatter.format(record)

    assert "\n" not in line
    assert "\r" not in line
    data = json.loads(line)
    assert data["message"] == "First\nSecond\r\nThird"


def test_formatter_non_ascii():
    formatter = JsonFormatter()
    msg = "Memory server: test ñ ø ü 日本語"
    record = _make_record(msg)
    data = json.loads(formatter.format(record))
    assert data["message"] == msg


def test_formatter_exception_traceback():
    formatter = JsonFormatter()
    try:
        raise RuntimeError("database unavailable")
    except RuntimeError:
        exc_info = sys.exc_info()

    record = _make_record("DB connection failed", exc_info=exc_info)
    line = formatter.format(record)

    data = json.loads(line)
    assert data["message"] == "DB connection failed"
    assert "exc_info" in data or "database unavailable" in data["message"]
    if "exc_info" in data:
        assert "RuntimeError: database unavailable" in data["exc_info"]


def test_emit_sample_line(capsys, clean_loggers):
    emit_sample_line()
    out = capsys.readouterr().out
    lines = out.strip().splitlines()
    assert len(lines) == 2

    data1 = json.loads(lines[0])
    for req in [
        "timestamp",
        "level",
        "logger",
        "message",
        "run_id",
        "task_key",
        "model",
        "cost",
    ]:
        assert req in data1
    assert data1["level"] == "INFO"
    assert "Sample memory server log message" in data1["message"]

    data2 = json.loads(lines[1])
    assert data2["level"] == "ERROR"
    assert "exc_info" in data2
    assert "ValueError: Sample memory server exception" in data2["exc_info"]


def test_redaction_memory_server(monkeypatch):
    monkeypatch.setenv("PGSQL_PASSWORD", "super-secret-db-pass-999")
    formatter = JsonFormatter()
    record = _make_record("Connected with super-secret-db-pass-999 and Bearer my-secret-token-12345")
    data = json.loads(formatter.format(record))
    assert "super-secret-db-pass-999" not in data["message"]
    assert "my-secret-token-12345" not in data["message"]
    assert "[REDACTED]" in data["message"]


def test_field_capping_memory_server():
    formatter = JsonFormatter()
    huge = "X" * 12000
    record = _make_record(huge)
    data = json.loads(formatter.format(record))
    assert len(data["message"]) <= 8192
    assert data["message"].endswith("...[TRUNCATED]")


def test_build_app_callable():
    from bot_memory_server.server import build_app

    app, metrics_app = build_app()
    assert app is not None
    assert metrics_app is not None


def test_setup_logging_defaults(clean_loggers, monkeypatch):
    monkeypatch.delenv("DEBUG", raising=False)
    stream = io.StringIO()
    setup_logging(stream=stream)

    root = logging.getLogger()
    assert root.level == logging.INFO
    assert len(root.handlers) == 1
    assert isinstance(root.handlers[0].formatter, JsonFormatter)


def test_setup_logging_debug_contract(clean_loggers, monkeypatch):
    stream = io.StringIO()

    monkeypatch.setenv("DEBUG", "true")
    setup_logging(stream=stream)
    assert logging.getLogger().level == logging.DEBUG

    monkeypatch.setenv("DEBUG", "false")
    setup_logging(stream=stream)
    assert logging.getLogger().level == logging.INFO

    monkeypatch.setenv("DEBUG", "1")
    setup_logging(stream=stream)
    assert logging.getLogger().level == logging.INFO


def test_setup_logging_idempotent(clean_loggers):
    stream = io.StringIO()
    setup_logging(stream=stream)
    assert len(logging.getLogger().handlers) == 1

    setup_logging(stream=stream)
    assert len(logging.getLogger().handlers) == 1


def test_setup_logging_uvicorn_loggers_attached(clean_loggers):
    stream = io.StringIO()
    setup_logging(stream=stream)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        assert len(uv_logger.handlers) == 1
        assert isinstance(uv_logger.handlers[0].formatter, JsonFormatter)
        assert uv_logger.propagate is False

    # Emit access log line
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.info('%s - "%s" %d', "127.0.0.1:50000", "GET /metrics HTTP/1.1", 200)

    lines = stream.getvalue().strip().splitlines()
    assert len(lines) == 1
    data = json.loads(lines[0])
    assert data["logger"] == "uvicorn.access"
    assert data["level"] == "INFO"
    assert data["message"] == '127.0.0.1:50000 - "GET /metrics HTTP/1.1" 200'
    for req in [
        "timestamp",
        "level",
        "logger",
        "message",
        "run_id",
        "task_key",
        "model",
        "cost",
    ]:
        assert req in data

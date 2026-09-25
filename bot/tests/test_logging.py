"""Tests for bot.log: JsonFormatter, contextvars, and setup_logging."""

import asyncio
import datetime
import json
import logging
import sys
from logging.handlers import RotatingFileHandler
from unittest.mock import MagicMock

import pytest

from bot.log import (
    DEFAULT_BACKUP_COUNT,
    DEFAULT_MAX_BYTES,
    JsonFormatter,
    bind,
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
def clean_root_logger(monkeypatch):
    """Save and restore root logger state and env DEBUG."""
    root = logging.getLogger()
    old_handlers = list(root.handlers)
    old_level = root.level
    yield root
    # Restore original handlers and level
    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()
    for h in old_handlers:
        root.addHandler(h)
    root.setLevel(old_level)


def _make_record(
    msg: str = "Test message",
    level: int = logging.INFO,
    name: str = "bot.test",
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
# Layer 1 — Formatter tests
# =============================================================================


def test_formatter_happy_info_line():
    formatter = JsonFormatter()
    record = _make_record("Hello world", level=logging.INFO)
    line = formatter.format(record)

    data = json.loads(line)
    expected_keys = {
        "timestamp",
        "level",
        "logger",
        "message",
        "run_id",
        "task_key",
        "model",
        "cost",
    }
    assert expected_keys.issubset(data.keys())
    assert data["level"] == "INFO"
    assert data["logger"] == "bot.test"
    assert data["message"] == "Hello world"


def test_formatter_level_mapping():
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


def test_formatter_unbound_context_null():
    formatter = JsonFormatter()
    record = _make_record("msg")
    data = json.loads(formatter.format(record))

    assert data["run_id"] is None
    assert data["task_key"] is None
    assert data["model"] is None
    assert data["cost"] is None


def test_formatter_bound_context():
    bind(
        run_id="run-123",
        task_key="REHOR-41",
        model="claude-3-7-sonnet-20250219",
        cost=0.0425,
    )
    formatter = JsonFormatter()
    record = _make_record("Cycle step")
    data = json.loads(formatter.format(record))

    assert data["run_id"] == "run-123"
    assert data["task_key"] == "REHOR-41"
    assert data["model"] == "claude-3-7-sonnet-20250219"
    assert data["cost"] == 0.0425
    assert isinstance(data["cost"], float)


def test_formatter_timestamp_iso8601():
    formatter = JsonFormatter()
    record = _make_record("msg")
    data = json.loads(formatter.format(record))

    ts_str = data["timestamp"]
    # Verify ISO-8601 UTC parseable
    ts = datetime.datetime.fromisoformat(ts_str)
    assert ts.tzinfo is not None
    # UTC offset should be 0
    assert ts.utcoffset() == datetime.timedelta(0)


def test_formatter_newlines_in_message_single_line():
    formatter = JsonFormatter()
    record = _make_record("Multi\nline\nlog\r\nmessage")
    line = formatter.format(record)

    assert "\n" not in line
    assert "\r" not in line
    data = json.loads(line)
    assert data["message"] == "Multi\nline\nlog\r\nmessage"


def test_formatter_non_ascii_message():
    formatter = JsonFormatter()
    msg = "Unicode test: üñîçødé 🚀 日本語"
    record = _make_record(msg)
    line = formatter.format(record)

    data = json.loads(line)
    assert data["message"] == msg


def test_formatter_exception_valid_json():
    formatter = JsonFormatter()
    try:
        raise ValueError("boom")
    except ValueError:
        exc_info = sys.exc_info()

    record = _make_record("An error occurred", exc_info=exc_info)
    line = formatter.format(record)

    data = json.loads(line)
    assert data["message"] == "An error occurred"
    # Exception traceback is captured and remains valid JSON
    assert "exc_info" in data or "ValueError: boom" in data["message"]
    if "exc_info" in data:
        assert isinstance(data["exc_info"], str)
        assert "ValueError: boom" in data["exc_info"]


def test_formatter_two_records_separate_objects():
    formatter = JsonFormatter()
    rec1 = _make_record("first")
    rec2 = _make_record("second")

    line1 = formatter.format(rec1)
    line2 = formatter.format(rec2)

    assert json.loads(line1)["message"] == "first"
    assert json.loads(line2)["message"] == "second"


def test_emit_sample_line(capsys, clean_root_logger):
    emit_sample_line()
    captured = capsys.readouterr().out
    lines = captured.strip().splitlines()
    assert len(lines) == 2, f"Expected exactly two lines, got: {captured}"

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
    assert "Sample log message" in data1["message"]

    data2 = json.loads(lines[1])
    assert data2["level"] == "ERROR"
    assert "exc_info" in data2
    assert "ValueError: Sample exception for verification" in data2["exc_info"]


# =============================================================================
# Layer 2 — setup_logging in isolation
# =============================================================================


def test_setup_logging_defaults(tmp_path, clean_root_logger, monkeypatch):
    monkeypatch.delenv("DEBUG", raising=False)
    log_file = tmp_path / "bot.log"

    setup_logging(log_file=log_file)
    assert clean_root_logger.level == logging.INFO

    handlers = clean_root_logger.handlers
    assert len(handlers) == 2
    stream_handlers = [
        h for h in handlers if isinstance(h, logging.StreamHandler) and not isinstance(h, RotatingFileHandler)
    ]
    file_handlers = [h for h in handlers if isinstance(h, RotatingFileHandler)]

    assert len(stream_handlers) == 1
    assert stream_handlers[0].stream == sys.stdout
    assert len(file_handlers) == 1
    assert file_handlers[0].baseFilename == str(log_file.resolve())
    assert file_handlers[0].maxBytes == DEFAULT_MAX_BYTES
    assert file_handlers[0].backupCount == DEFAULT_BACKUP_COUNT
    assert file_handlers[0].encoding == "utf-8"

    # Formatter on both handlers must be JsonFormatter
    assert isinstance(stream_handlers[0].formatter, JsonFormatter)
    assert isinstance(file_handlers[0].formatter, JsonFormatter)


def test_setup_logging_debug_env_contract(tmp_path, clean_root_logger, monkeypatch):
    log_file = tmp_path / "bot.log"

    # DEBUG=true -> DEBUG
    monkeypatch.setenv("DEBUG", "true")
    setup_logging(log_file=log_file)
    assert clean_root_logger.level == logging.DEBUG

    # DEBUG=false -> INFO
    monkeypatch.setenv("DEBUG", "false")
    setup_logging(log_file=log_file)
    assert clean_root_logger.level == logging.INFO

    # DEBUG=1 -> INFO (exact string "true" contract)
    monkeypatch.setenv("DEBUG", "1")
    setup_logging(log_file=log_file)
    assert clean_root_logger.level == logging.INFO


def test_setup_logging_idempotent_replace(tmp_path, clean_root_logger):
    log_file = tmp_path / "bot.log"
    setup_logging(log_file=log_file)
    assert len(clean_root_logger.handlers) == 2

    # Second call replaces rather than appends
    setup_logging(log_file=log_file)
    assert len(clean_root_logger.handlers) == 2


def test_setup_logging_writes_json_to_file_and_stdout(tmp_path, clean_root_logger, capsys):
    log_file = tmp_path / "nested" / "bot.log"
    setup_logging(log_file=log_file)

    logger = logging.getLogger("test.logger")
    logger.info("Testing setup_logging write")

    # Verify stdout
    captured = capsys.readouterr().out
    stdout_lines = captured.strip().splitlines()
    assert len(stdout_lines) == 1
    stdout_data = json.loads(stdout_lines[0])
    assert stdout_data["message"] == "Testing setup_logging write"
    assert stdout_data["level"] == "INFO"

    # Verify file
    assert log_file.exists()
    file_content = log_file.read_text().strip().splitlines()
    assert len(file_content) == 1
    file_data = json.loads(file_content[0])
    assert file_data["message"] == "Testing setup_logging write"
    assert file_data["level"] == "INFO"


def test_setup_logging_rotation(tmp_path, clean_root_logger):
    log_file = tmp_path / "rotating" / "bot.log"
    # Use tiny max_bytes=200 to force rotation
    setup_logging(log_file=log_file, max_bytes=200, backup_count=3)

    logger = logging.getLogger("test.rotation")
    # Emit enough lines to rotate
    for i in range(20):
        logger.info("Rotation test record index %d", i)

    rotated_file = tmp_path / "rotating" / "bot.log.1"
    assert log_file.exists()
    assert rotated_file.exists(), "Expected rotated log file bot.log.1 to exist"

    # Every line in active file must parse as JSON
    for line in log_file.read_text().strip().splitlines():
        data = json.loads(line)
        assert "message" in data

    # Every line in rotated file must parse as JSON
    for line in rotated_file.read_text().strip().splitlines():
        data = json.loads(line)
        assert "message" in data


# =============================================================================
# Layer 3 — Context bind / clear (cycle correlation)
# =============================================================================


def test_context_bind_and_clear_no_leak():
    formatter = JsonFormatter()

    # Cycle 1: bound context
    bind(run_id="cycle-1", task_key="REHOR-1", model="model-1", cost=0.50)
    line1 = formatter.format(_make_record("Cycle 1 log"))
    data1 = json.loads(line1)
    assert data1["run_id"] == "cycle-1"
    assert data1["task_key"] == "REHOR-1"
    assert data1["model"] == "model-1"
    assert data1["cost"] == 0.50

    # Cycle boundary: clear()
    clear()

    # Cycle 2: unbound context must be null (no leak)
    line2 = formatter.format(_make_record("Cycle 2 log"))
    data2 = json.loads(line2)
    assert data2["run_id"] is None
    assert data2["task_key"] is None
    assert data2["model"] is None
    assert data2["cost"] is None


def test_context_incremental_binding():
    formatter = JsonFormatter()

    # Bind initial cycle context
    bind(run_id="run-456", model="model-x")
    line1 = formatter.format(_make_record("Preflight done"))
    data1 = json.loads(line1)
    assert data1["run_id"] == "run-456"
    assert data1["task_key"] is None
    assert data1["cost"] is None

    # Mid-cycle ticket extraction binds task_key
    bind(task_key="TICKET-42")
    line2 = formatter.format(_make_record("Tool execution"))
    data2 = json.loads(line2)
    assert data2["run_id"] == "run-456"
    assert data2["task_key"] == "TICKET-42"
    assert data2["cost"] is None

    # Cycle result binds cost
    bind(cost=0.1234)
    line3 = formatter.format(_make_record("Cycle done"))
    data3 = json.loads(line3)
    assert data3["run_id"] == "run-456"
    assert data3["task_key"] == "TICKET-42"
    assert data3["cost"] == 0.1234


def test_context_async_task_propagation():
    formatter = JsonFormatter()
    bind(run_id="async-run", task_key="ASYNC-1")

    async def worker():
        record = _make_record("Worker log")
        return json.loads(formatter.format(record))

    data = asyncio.run(worker())
    assert data["run_id"] == "async-run"
    assert data["task_key"] == "ASYNC-1"


# =============================================================================
# Follow-up Review Tests (P1 & P2): Redaction, Capping, 0600, Jail, Boundaries
# =============================================================================


def test_redaction_sensitive_env_values(monkeypatch):
    monkeypatch.setenv("TEST_AUTH_TOKEN", "super-secret-token-value-999")
    formatter = JsonFormatter()
    record = _make_record("Connected with token super-secret-token-value-999 to API")
    line = formatter.format(record)

    data = json.loads(line)
    assert "super-secret-token-value-999" not in data["message"]
    assert "[REDACTED]" in data["message"]


def test_redaction_regex_patterns():
    formatter = JsonFormatter()
    test_cases = [
        ("Authorization: Bearer my-secret-bearer-token-12345", "Authorization: Bearer [REDACTED]"),
        ("Token ghp_abcdefghijklmnopqrstuvwxyz123456", "Token [REDACTED]"),
        ("Anthropic key sk-ant-api03-abcdefghijklmnopqrstuvwxyz12345", "Anthropic key [REDACTED]"),
        ("Slack https://hooks.slack.com/services/T123/B456/7890abc", "Slack [REDACTED_SLACK_WEBHOOK]"),
        (
            "Repo https://bot:secretpass123@gitlab.cee.redhat.com/repo.git",
            "Repo https://bot:[REDACTED]@gitlab.cee.redhat.com/repo.git",
        ),
    ]
    for raw, expected in test_cases:
        record = _make_record(raw)
        data = json.loads(formatter.format(record))
        assert data["message"] == expected


def test_redaction_on_exc_info_and_stack():
    formatter = JsonFormatter()
    try:
        raise ValueError("Failed connecting to https://user:secretpassword@internal.db:5432")
    except ValueError:
        exc_info = sys.exc_info()

    record = _make_record("Database failure", exc_info=exc_info)
    data = json.loads(formatter.format(record))

    assert "secretpassword" not in data["exc_info"]
    assert "[REDACTED]" in data["exc_info"]


def test_field_capping_8kib():
    formatter = JsonFormatter()
    huge_msg = "A" * 15000
    record = _make_record(huge_msg)
    line = formatter.format(record)

    assert "\n" not in line
    data = json.loads(line)
    assert len(data["message"]) <= 8192
    assert data["message"].endswith("...[TRUNCATED]")


def test_setup_logging_file_permissions_0600(tmp_path, clean_root_logger):
    log_file = tmp_path / "secure_bot.log"
    setup_logging(log_file=log_file)

    logger = logging.getLogger("test.perm")
    logger.info("Checking permissions")

    assert log_file.exists()
    mode = log_file.stat().st_mode & 0o777
    assert mode == 0o600


def test_bot_log_file_jail(tmp_path, clean_root_logger, monkeypatch):
    monkeypatch.setenv("BOT_LOG_FILE", "../../evil.log")
    with pytest.raises(ValueError, match="path jail violation"):
        setup_logging()


def test_top_level_exception_boundary_logs_structured_error(monkeypatch):
    import bot.run

    monkeypatch.setattr("sys.argv", ["run.py", "--label", "test-label", "--instance-id", "test-inst"])
    monkeypatch.setattr("bot.run.setup_git", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "bot.run.load_config",
        lambda *args: (_ for _ in ()).throw(RuntimeError("Config explode")),
    )

    mock_logger = MagicMock()
    monkeypatch.setattr("bot.run.logging.getLogger", lambda *args: mock_logger)

    with pytest.raises(SystemExit) as excinfo:
        bot.run.main()

    assert excinfo.value.code == 1
    mock_logger.exception.assert_called_with("Fatal error during bot execution")


def test_cycle_body_exception_logged_and_does_not_exit(monkeypatch):
    import bot.run

    monkeypatch.setattr("sys.argv", ["run.py", "--label", "test-label", "--instance-id", "test-inst"])
    monkeypatch.setattr("bot.run.setup_git", lambda *args, **kwargs: None)
    mock_config = MagicMock()
    mock_config.interval = 5
    mock_config.idle_interval = 10
    mock_config.model_tiers = {}
    monkeypatch.setattr("bot.run.load_config", lambda *args: mock_config)
    monkeypatch.setattr("bot.run.load_mcp_servers", lambda *args: {})
    monkeypatch.setattr("bot.run.sync_config_repo", lambda *args: (None, None))
    monkeypatch.setattr(
        "bot.run.load_instance_config",
        lambda *args: MagicMock(workflow="jira-sprint"),
    )
    monkeypatch.setattr("bot.run.install_skills", lambda *args, **kwargs: None)
    monkeypatch.setattr("bot.run.validate_manifest", lambda *args, **kwargs: None)
    monkeypatch.setattr("bot.run.validate_instance_config", lambda *args, **kwargs: None)
    monkeypatch.setattr("bot.run.sanitize_env", lambda *args: None)
    monkeypatch.setattr("bot.run.FileLock", MagicMock())
    monkeypatch.setattr("bot.run.start_http_server", lambda *args: None)

    mock_logger = MagicMock()
    monkeypatch.setattr("bot.run.logging.getLogger", lambda *args: mock_logger)

    calls = []

    def fake_slack_digest():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("Transient cycle error")
        raise SystemExit(0)

    monkeypatch.setattr("bot.run._try_slack_digest", fake_slack_digest)
    monkeypatch.setattr("bot.run._write_sleep_signal", lambda *args: None)
    monkeypatch.setattr("bot.run._read_sleep_signal", lambda *args: None)
    monkeypatch.setattr("bot.run.cleanup_between_cycles", lambda *args: None)

    with pytest.raises(SystemExit) as excinfo:
        bot.run.main()

    assert excinfo.value.code == 0
    assert len(calls) == 2
    mock_logger.exception.assert_any_call("Cycle failed with unhandled exception")

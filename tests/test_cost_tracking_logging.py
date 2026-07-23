"""Tests proving cost tracking failures and verifying fixes.

These tests demonstrate the issues identified in the cost-tracking-fix-plan:
1. Timeout loses cost data
2. HTTP push failures are silent
3. Status push failures are completely silent

Tests marked with _BEFORE_ prove the original issue exists.
Tests marked with _FIXED_ verify the fix works.
"""

import json
import logging
from unittest.mock import AsyncMock, Mock, patch

import httpx
import pytest

import bot.agent
from bot.agent import _push_status
from bot.costs import record_cost


@pytest.fixture(autouse=True)
def _reset_status_fail_count():
    """Reset module-level failure counter between tests."""
    bot.agent._status_fail_count = 0
    yield
    bot.agent._status_fail_count = 0


@pytest.fixture
def mock_result():
    """Mock SDK ResultMessage with typical usage data."""
    result = Mock()
    result.usage = {
        "input_tokens": 1000,
        "output_tokens": 500,
        "cache_read_input_tokens": 200,
        "cache_creation_input_tokens": 100,
    }
    result.model_usage = {"claude-opus-4": {"input_tokens": 1000, "output_tokens": 500}}
    result.session_id = "test-session-123"
    result.num_turns = 5
    result.duration_ms = 30000
    result.total_cost_usd = 0.25
    result.result = "Task completed successfully"
    result.subtype = "success"
    return result


@pytest.fixture
def tmp_costs_file(tmp_path):
    """Temporary costs.jsonl file."""
    return tmp_path / "costs.jsonl"


@pytest.fixture
def mock_ctx():
    """Mock CycleContext."""
    from bot.agent import CycleContext

    ctx = CycleContext()
    ctx.jira_key = "RHCLOUD-1234"
    ctx.repo = "test-repo"
    ctx.work_type = "new_ticket"
    ctx.summary = "Fix button color"
    return ctx


# --- Test 1: HTTP push failures are logged at DEBUG (invisible in prod) ---


def test_cost_push_failure_now_visible_at_warning(tmp_costs_file, mock_result, caplog):
    """FIXED: HTTP push failures now logged at WARNING level, visible in production."""
    caplog.set_level(logging.INFO)

    with patch("bot.costs.httpx.post") as mock_post:
        mock_post.side_effect = httpx.ConnectError("Connection refused")

        record_cost(tmp_costs_file, "test-label", mock_result)

    # Now visible at INFO level
    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == "WARNING"
    assert "Cost push failed" in caplog.text


def test_cost_push_http_error_now_detected(tmp_costs_file, mock_result, caplog):
    """FIXED: HTTP 500 responses now detected and logged."""
    caplog.set_level(logging.INFO)

    with patch("bot.costs.httpx.post") as mock_post:
        mock_resp = Mock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_resp.is_success = False
        mock_post.return_value = mock_resp

        record_cost(tmp_costs_file, "test-label", mock_result)

    # Now logged
    assert len(caplog.records) == 1
    assert "HTTP 500" in caplog.text
    assert "Internal Server Error" in caplog.text


# --- Test 2: Status push failures are completely silent ---


@pytest.mark.asyncio
async def test_status_push_failure_now_logged(caplog):
    """FIXED: _push_status logs DEBUG per failure, WARNING once at threshold, then silent."""
    caplog.set_level(logging.DEBUG)

    mock_client = AsyncMock()
    mock_client.post.side_effect = httpx.ConnectError("Connection refused")

    # First failure: DEBUG only
    await _push_status(mock_client, "working", "Processing RHCLOUD-1234")
    assert len(caplog.records) == 1
    assert caplog.records[0].levelname == "DEBUG"
    assert "Dashboard push failed" in caplog.text

    # Failures 2-4: still DEBUG only
    caplog.clear()
    for _ in range(3):
        await _push_status(mock_client, "working", "Test")
    warning_logs = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warning_logs) == 0

    # 5th failure: WARNING fires exactly once
    caplog.clear()
    await _push_status(mock_client, "working", "Test")
    warning_logs = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warning_logs) == 1
    assert "Dashboard unreachable" in caplog.text

    # 6th+ failures: no more warnings (silenced)
    caplog.clear()
    for _ in range(5):
        await _push_status(mock_client, "working", "Test")
    warning_logs = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warning_logs) == 0


# --- Test 3: Timeout loses all cost data ---


def test_timeout_logs_cost_data_loss_warning(caplog):
    """FIXED: Timeout path now warns that cost data is lost."""
    from bot.run import handle_cycle_timeout

    caplog.set_level(logging.WARNING)

    result, ctx = handle_cycle_timeout(timeout_seconds=600)

    assert result is None
    assert ctx is None
    assert any("Cost data for timed-out cycle lost" in r.message for r in caplog.records)
    assert any(r.levelname == "WARNING" for r in caplog.records)


# --- Test 4: Local file write is resilient ---


def test_cost_local_write_happens_before_http(tmp_costs_file, mock_result):
    """Verify: Local jsonl write happens even if HTTP push fails."""
    with patch("bot.costs.httpx.post") as mock_post:
        mock_post.side_effect = Exception("Network error")

        record_cost(tmp_costs_file, "test-label", mock_result)

    # Local file still written
    assert tmp_costs_file.exists()
    entries = [json.loads(line) for line in tmp_costs_file.read_text().strip().split("\n")]
    assert len(entries) == 1
    assert entries[0]["session_id"] == "test-session-123"


# --- Test 5: Field name mismatch (jira_key vs external_key) ---


def test_cost_entry_now_uses_external_key_field(tmp_costs_file, mock_result, mock_ctx):
    """FIXED: Cost entries now use 'external_key' matching dashboard expectation."""
    with patch("bot.costs.httpx.post") as mock_post:
        mock_resp = Mock()
        mock_resp.is_success = True
        mock_post.return_value = mock_resp

        record_cost(tmp_costs_file, "test-label", mock_result, ctx=mock_ctx)

    # Check what was sent to API
    call_args = mock_post.call_args
    sent_data = call_args.kwargs["json"]

    # Now sends external_key (correct)
    assert "external_key" in sent_data
    assert sent_data["external_key"] == "RHCLOUD-1234"

    # Old jira_key field removed
    assert "jira_key" not in sent_data


# --- Test 6: Model usage only captures first model ---


def test_model_usage_now_captures_all_models(tmp_costs_file, mock_result):
    """FIXED: Full model_usage dict now stored alongside scalar model field."""
    # Simulate multi-model usage (e.g., subagents with different models)
    mock_result.model_usage = {
        "claude-opus-4": {"input_tokens": 1000, "output_tokens": 500},
        "claude-sonnet-4": {"input_tokens": 2000, "output_tokens": 1000},
    }

    with patch("bot.costs.httpx.post") as mock_post:
        mock_resp = Mock()
        mock_resp.is_success = True
        mock_post.return_value = mock_resp

        record_cost(tmp_costs_file, "test-label", mock_result)

    entries = [json.loads(line) for line in tmp_costs_file.read_text().strip().split("\n")]
    entry = entries[0]

    # Scalar model field still present (backward compat)
    assert entry["model"] == "claude-opus-4"

    # Full model_usage dict now stored
    assert "model_usage" in entry
    assert entry["model_usage"]["claude-opus-4"]["input_tokens"] == 1000
    assert entry["model_usage"]["claude-sonnet-4"]["input_tokens"] == 2000

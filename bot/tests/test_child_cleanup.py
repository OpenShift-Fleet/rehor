"""Tests for SDK transport ownership and explicit cleanup on cycle exit.

run_cycle creates the SubprocessCLITransport itself so the finally block can
call transport.close() even when the stream was cancelled mid-read (cycle
timeout). The SDK close() lets the CLI flush its session file and escalates
SIGTERM → SIGKILL.
"""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

from claude_agent_sdk import ResultMessage, SystemMessage

from bot.agent import run_cycle
from bot.config import Config

_DEFAULT_USAGE = {
    "input_tokens": 1000,
    "output_tokens": 500,
    "cache_read_input_tokens": 200,
    "cache_creation_input_tokens": 100,
}


class _FakeTransport:
    def __init__(self):
        self.close_calls = 0

    async def close(self):
        self.close_calls += 1


def _config(cycle_timeout: int = 600) -> Config:
    return Config(
        model="claude-opus-4",
        max_turns=10,
        interval=60,
        idle_interval=300,
        cycle_timeout=cycle_timeout,
        board_key="TEST",
    )


def _result() -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=30000,
        duration_api_ms=1000,
        is_error=False,
        num_turns=5,
        session_id="sess",
        total_cost_usd=0.25,
        usage=_DEFAULT_USAGE,
        model_usage={"claude-opus-4": {"input_tokens": 1000}},
        result="ok",
    )


def _run_cycle(transport, fake_query, config):
    with (
        patch("bot.agent.query", fake_query),
        patch("bot.agent._push_status", AsyncMock()),
        patch("bot.agent._make_sdk_transport", return_value=transport),
    ):
        return asyncio.run(run_cycle("test-label", config, {}, [], cwd="."))


def test_timeout_closes_transport():
    """A stream cancelled mid-read by the cycle timeout must still close the transport."""

    async def hanging_query(*, prompt, options, transport=None):
        yield SystemMessage(subtype="init", data={"session_id": "sess-clean", "mcp_servers": []})
        await asyncio.sleep(10)

    fake_transport = _FakeTransport()
    result, ctx = _run_cycle(fake_transport, hanging_query, _config(cycle_timeout=1))

    assert result is None
    assert ctx.timed_out is True
    assert ctx.session_id == "sess-clean"
    assert fake_transport.close_calls == 1


def test_completed_cycle_closes_transport():
    """The transport backstop close also runs on graceful completion."""

    async def fake_query(*, prompt, options, transport=None):
        yield SystemMessage(subtype="init", data={"session_id": "sess-ok", "mcp_servers": []})
        yield _result()

    fake_transport = _FakeTransport()
    result, ctx = _run_cycle(fake_transport, fake_query, _config())

    assert result is not None
    assert ctx.timed_out is False
    assert fake_transport.close_calls == 1


def test_no_transport_uses_default_query_call():
    """When the transport cannot be created, query() is called without the kwarg."""

    seen: dict[str, Any] = {}

    async def fake_query(**kwargs):
        seen.update(kwargs)
        yield _result()

    with (
        patch("bot.agent.query", fake_query),
        patch("bot.agent._push_status", AsyncMock()),
        patch("bot.agent._make_sdk_transport", return_value=None),
    ):
        result, ctx = asyncio.run(run_cycle("test-label", _config(), {}, [], cwd="."))

    assert result is not None
    assert "transport" not in seen

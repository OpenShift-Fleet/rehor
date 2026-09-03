"""Cycle / tool / cost log signals (REHOR-42)."""

import asyncio
import logging
from unittest.mock import AsyncMock, patch

from claude_agent_sdk import AssistantMessage, ResultMessage, ToolResultBlock, ToolUseBlock, UserMessage

from bot.agent import run_cycle
from bot.config import Config
from bot.costs import summarize_result


def _config() -> Config:
    return Config(
        model="claude-opus-4",
        max_turns=10,
        interval=60,
        idle_interval=300,
        cycle_timeout=600,
        board_key="TEST",
    )


def _result(**kwargs) -> ResultMessage:
    defaults = {
        "subtype": "success",
        "duration_ms": 30000,
        "duration_api_ms": 1000,
        "is_error": False,
        "num_turns": 5,
        "session_id": "sess",
        "total_cost_usd": 0.25,
        "usage": {
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_read_input_tokens": 200,
            "cache_creation_input_tokens": 100,
        },
        "model_usage": {"claude-opus-4": {"input_tokens": 1000}},
        "result": "ok",
    }
    defaults.update(kwargs)
    return ResultMessage(**defaults)


async def _run(messages):
    async def fake_query(*, prompt, options):
        for message in messages:
            yield message

    with (
        patch("bot.agent.query", fake_query),
        patch("bot.agent._push_status", AsyncMock()),
    ):
        return await run_cycle("test-label", _config(), {}, [], cwd=".")


def test_summarize_result_ratio():
    summary = summarize_result(_result())
    assert summary["model"] == "claude-opus-4"
    assert summary["cache_read_tokens"] == 200
    assert summary["cache_write_tokens"] == 100
    assert summary["input_tokens"] == 1000
    assert summary["output_tokens"] == 500
    assert summary["cache_ratio"] == "2.00"


def test_summarize_result_ratio_na_when_no_write():
    summary = summarize_result(
        _result(
            usage={
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_read_input_tokens": 200,
                "cache_creation_input_tokens": 0,
            }
        )
    )
    assert summary["cache_ratio"] == "n/a"
    assert summary["cache_read_tokens"] == 200
    assert summary["cache_write_tokens"] == 0


def test_cycle_logs_tool_duration_and_model_cache(caplog):
    caplog.set_level(logging.INFO)
    tool = ToolUseBlock(id="tool_1", name="Bash", input={"command": "gh pr checks 123"})
    tool_result = ToolResultBlock(tool_use_id="tool_1", content="ok")
    asyncio.run(
        _run(
            [
                AssistantMessage(content=[tool], model="claude-opus-4"),
                AssistantMessage(content=[tool_result], model="claude-opus-4"),
                _result(),
            ]
        )
    )
    assert "[tool] Bash: gh pr checks 123" in caplog.text
    assert "[tool] Bash: gh pr checks 123 completed in" in caplog.text
    assert "ms" in caplog.text
    assert "Cycle done: success" in caplog.text
    assert "model=claude-opus-4" in caplog.text
    assert "cache_read=200" in caplog.text
    assert "cache_write=100" in caplog.text
    assert "ratio=2.00" in caplog.text
    assert "tokens in=1000 out=500" in caplog.text


def test_cycle_logs_ratio_na_when_no_cache_write(caplog):
    caplog.set_level(logging.INFO)
    asyncio.run(
        _run(
            [
                _result(
                    usage={
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "cache_read_input_tokens": 200,
                        "cache_creation_input_tokens": 0,
                    }
                )
            ]
        )
    )
    assert "model=claude-opus-4" in caplog.text
    assert "cache_read=200" in caplog.text
    assert "cache_write=0" in caplog.text
    assert "ratio=n/a" in caplog.text


def test_cycle_logs_unknown_model_when_usage_empty(caplog):
    caplog.set_level(logging.INFO)
    asyncio.run(_run([_result(model_usage={}, usage={})]))
    assert "model=unknown" in caplog.text
    assert "ratio=n/a" in caplog.text


def test_parallel_tools_pair_by_id(caplog):
    caplog.set_level(logging.INFO)
    first = ToolUseBlock(id="a", name="Bash", input={"command": "one"})
    second = ToolUseBlock(id="b", name="Bash", input={"command": "two"})
    asyncio.run(
        _run(
            [
                AssistantMessage(content=[first, second], model="claude-opus-4"),
                AssistantMessage(
                    content=[
                        ToolResultBlock(tool_use_id="b", content="ok"),
                        ToolResultBlock(tool_use_id="a", content="ok"),
                    ],
                    model="claude-opus-4",
                ),
                _result(),
            ]
        )
    )
    assert "[tool] Bash: one completed in" in caplog.text
    assert "[tool] Bash: two completed in" in caplog.text


def test_tool_result_on_user_message_logs_duration(caplog):
    caplog.set_level(logging.INFO)
    tool = ToolUseBlock(id="tool_1", name="Read", input={"file_path": "/tmp/x"})
    asyncio.run(
        _run(
            [
                AssistantMessage(content=[tool], model="claude-opus-4"),
                UserMessage(content=[ToolResultBlock(tool_use_id="tool_1", content="ok")]),
                _result(),
            ]
        )
    )
    assert "[tool] Read: /tmp/x" in caplog.text
    assert "[tool] Read: /tmp/x completed in" in caplog.text

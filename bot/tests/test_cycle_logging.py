"""Tests for cycle, tool, and cost logging"""

import asyncio
import io
import json
import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, ToolResultBlock, ToolUseBlock

from bot.agent import CycleContext, _extract_context, _extract_task_id_from_result, run_cycle
from bot.config import Config
from bot.costs import summarize_result

_DEFAULT_USAGE = {
    "input_tokens": 1000,
    "output_tokens": 500,
    "cache_read_input_tokens": 200,
    "cache_creation_input_tokens": 100,
}
_DEFAULT_MODEL_USAGE = {"claude-opus-4": {"input_tokens": 1000}}


def _config() -> Config:
    return Config(
        model="claude-opus-4",
        max_turns=10,
        interval=60,
        idle_interval=300,
        cycle_timeout=600,
        board_key="TEST",
    )


def _result(
    usage: dict[str, Any] | None = None,
    model_usage: dict[str, Any] | None = None,
) -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=30000,
        duration_api_ms=1000,
        is_error=False,
        num_turns=5,
        session_id="sess",
        total_cost_usd=0.25,
        usage=_DEFAULT_USAGE if usage is None else usage,
        model_usage=_DEFAULT_MODEL_USAGE if model_usage is None else model_usage,
        result="ok",
    )


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


def test_cycle_done_json_formatter_keys():
    from bot.log import JsonFormatter, bind, clear

    clear()
    bind(run_id="test-run-uuid", model="claude-opus-4")

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    agent_logger = logging.getLogger("bot.agent")
    old_level = agent_logger.level
    agent_logger.addHandler(handler)
    agent_logger.setLevel(logging.INFO)

    tool = ToolUseBlock(
        id="tool_1",
        name="mcp__bot-memory__bot_status_update",
        input={"external_key": "ACTIVE", "repo": "active-repo", "summary": "Active work"},
    )
    tool_result = ToolResultBlock(tool_use_id="tool_1", content="ok")
    lookup = ToolUseBlock(
        id="tool_2",
        name="mcp__bot-memory__task_get",
        input={"external_key": "OTHER", "repo": "other-repo", "summary": "Other work"},
    )

    try:
        _, context = asyncio.run(
            _run(
                [
                    AssistantMessage(content=[tool], model="claude-opus-4"),
                    AssistantMessage(content=[tool_result], model="claude-opus-4"),
                    AssistantMessage(content=[lookup], model="claude-opus-4"),
                    AssistantMessage(
                        content=[ToolResultBlock(tool_use_id="tool_2", content='{"id":99,"external_key":"OTHER"}')],
                        model="claude-opus-4",
                    ),
                    _result(),
                ]
            )
        )
    finally:
        agent_logger.setLevel(old_level)
        agent_logger.removeHandler(handler)
        handler.close()
        clear()

    lines = [line for line in stream.getvalue().strip().splitlines() if line.strip()]
    cycle_done_lines = []
    for line in lines:
        data = json.loads(line)
        if "Cycle done:" in data["message"]:
            cycle_done_lines.append(data)

    assert len(cycle_done_lines) == 1
    record = cycle_done_lines[0]
    assert record["run_id"] == "test-run-uuid"
    assert record["task_key"] == "ACTIVE"
    assert context.jira_key == "ACTIVE"
    assert context.repo == "active-repo"
    assert context.summary == "Active work"
    assert context.task_id is None
    lookup_done = next(json.loads(line) for line in lines if "task_get" in line and "completed in" in line)
    assert lookup_done["task_key"] == "ACTIVE"
    assert record["model"] == "claude-opus-4"
    assert record["cost"] == 0.25
    assert record["level"] == "INFO"


def test_task_outcome_report_context_uses_generic_external_key():
    context = CycleContext(jira_key="OLD", task_id=12)
    _extract_context(
        SimpleNamespace(
            name="mcp__bot-memory__task_outcome_report",
            input={"external_key": "DEMO-OUTCOME-1", "jira_key": "LEGACY", "repo": "org/demo"},
        ),
        context,
    )
    assert context.jira_key == "DEMO-OUTCOME-1"
    assert context.repo == "org/demo"
    assert context.task_id is None


@pytest.mark.parametrize("tool", ["task_get", "task_list", "slack_notify", "memory_search"])
def test_unrelated_memory_calls_preserve_selected_work(tool):
    context = CycleContext(jira_key="ACTIVE", repo="org/active", summary="Active work", task_id=7)
    _extract_context(
        SimpleNamespace(
            name=f"mcp__bot-memory__{tool}",
            input={
                "external_key": "OTHER",
                "repo": "org/other",
                "summary": "Other work",
                "progress": {"external_key": "OTHER", "repo": "org/other"},
            },
        ),
        context,
    )
    assert (context.jira_key, context.repo, context.summary, context.task_id) == (
        "ACTIVE",
        "org/active",
        "Active work",
        7,
    )


@pytest.mark.parametrize("tool", ["bot_status_update", "task_add", "task_update", "task_outcome_report", "task_remove"])
def test_work_selection_accepts_legacy_key(tool):
    context = CycleContext(jira_key="OLD", task_id=7)
    _extract_context(
        SimpleNamespace(
            name=f"mcp__bot-memory__{tool}",
            input={"jira_key": "LEGACY", "repo": "org/legacy", "summary": "Selected work"},
        ),
        context,
    )
    assert (context.jira_key, context.repo, context.summary, context.task_id) == (
        "LEGACY",
        "org/legacy",
        "Selected work",
        None,
    )


@pytest.mark.parametrize("key_field", ["external_key", "jira_key"])
def test_progress_fills_missing_context_and_preserves_selected_work(key_field):
    context = CycleContext()
    _extract_context(
        SimpleNamespace(
            name="mcp__bot-memory__progress_store",
            input={"progress": {key_field: "ACTIVE", "repo": "org/active"}},
        ),
        context,
    )
    assert (context.jira_key, context.repo) == ("ACTIVE", "org/active")
    context.repo = None
    _extract_context(
        SimpleNamespace(
            name="mcp__bot-memory__progress_store",
            input={
                "external_key": "OTHER",
                "repo": "org/other",
                "summary": "Other work",
                "progress": {"external_key": "OTHER", "jira_key": "ACTIVE", "repo": "org/other"},
            },
        ),
        context,
    )
    assert (context.jira_key, context.repo, context.summary) == ("ACTIVE", None, None)


def test_progress_prefers_external_key_over_legacy_alias():
    context = CycleContext()
    _extract_context(
        SimpleNamespace(
            name="mcp__bot-memory__progress_store",
            input={"progress": {"external_key": "GENERIC", "jira_key": "LEGACY"}},
        ),
        context,
    )
    assert context.jira_key == "GENERIC"


@pytest.mark.parametrize("key_field", ["external_key", "jira_key"])
@pytest.mark.parametrize("id_field", ["id", "task_id"])
def test_task_result_correlates_with_selected_key(key_field, id_field):
    context = CycleContext(jira_key="ACTIVE", task_id=7)
    for key, task_id, expected in [("OTHER", 99, 7), ("ACTIVE", 8, 8)]:
        _extract_task_id_from_result(
            ToolResultBlock(tool_use_id="lookup", content=json.dumps({key_field: key, id_field: task_id})),
            context,
        )
        assert context.task_id == expected


def test_progress_result_without_identity_keeps_existing_task_id_contract():
    context = CycleContext(jira_key="ACTIVE")
    _extract_task_id_from_result(
        ToolResultBlock(tool_use_id="progress", content='{"task_id":7,"cycle_type":"pr_review"}'),
        context,
    )
    assert context.task_id == 7

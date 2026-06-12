"""Tests for bot.transcripts and bot.agent task_id extraction."""

import base64
import json
import sys
from dataclasses import dataclass
from types import ModuleType
from unittest.mock import MagicMock, patch


# Mock claude_agent_sdk before importing bot modules
_mock_sdk = ModuleType("claude_agent_sdk")
for name in [
    "AssistantMessage",
    "ClaudeAgentOptions",
    "HookMatcher",
    "ResultMessage",
    "SystemMessage",
    "TextBlock",
    "ToolResultBlock",
    "query",
]:
    setattr(_mock_sdk, name, MagicMock)
sys.modules["claude_agent_sdk"] = _mock_sdk

from bot.agent import CycleContext, _extract_task_id_from_result  # noqa: E402
from bot.transcripts import _find_transcript, _resolve_cycle_type, record_transcript  # noqa: E402


# --- _extract_task_id_from_result ---


@dataclass
class FakeToolResultBlock:
    tool_use_id: str = "tool_1"
    content: str | list | None = None
    is_error: bool | None = None


class TestExtractTaskId:
    def test_extracts_from_string_content(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(
            content=json.dumps(
                {"id": 42, "jira_key": "RHCLOUD-123", "status": "in_progress"}
            )
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id == 42

    def test_extracts_from_list_content(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(
            content=[{"text": json.dumps({"id": 99, "jira_key": "OME-50"})}]
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id == 99

    def test_ignores_non_task_result(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(
            content=json.dumps({"active": 3, "max": 10, "has_capacity": True})
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None

    def test_ignores_result_without_jira_key(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(
            content=json.dumps({"id": 42, "name": "not a task"})
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None

    def test_ignores_none_content(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(content=None)
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None

    def test_ignores_empty_string(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(content="")
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None

    def test_ignores_invalid_json(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(content="not json at all")
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None

    def test_overwrites_with_latest_task(self):
        ctx = CycleContext(task_id=10)
        block = FakeToolResultBlock(
            content=json.dumps({"id": 42, "jira_key": "RHCLOUD-999"})
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id == 42

    def test_ignores_string_id(self):
        ctx = CycleContext()
        block = FakeToolResultBlock(
            content=json.dumps({"id": "not-int", "jira_key": "RHCLOUD-1"})
        )
        _extract_task_id_from_result(block, ctx)
        assert ctx.task_id is None


# --- _resolve_cycle_type ---


class TestResolveCycleType:
    def test_error_takes_precedence(self):
        assert _resolve_cycle_type("new_ticket", is_error=True) == "error"

    def test_new_ticket(self):
        assert _resolve_cycle_type("new_ticket", is_error=False) == "task_work"

    def test_pr_review(self):
        assert _resolve_cycle_type("pr_review", is_error=False) == "task_work"

    def test_ci_fix(self):
        assert _resolve_cycle_type("ci_fix", is_error=False) == "task_work"

    def test_idle(self):
        assert _resolve_cycle_type("idle", is_error=False) == "idle"

    def test_memory_housekeeping(self):
        assert _resolve_cycle_type("memory_housekeeping", is_error=False) == "idle"

    def test_none_work_type(self):
        assert _resolve_cycle_type(None, is_error=False) == "triage_only"

    def test_unknown_maps_to_task_work(self):
        assert _resolve_cycle_type("something_new", is_error=False) == "task_work"


# --- _find_transcript ---


class TestFindTranscript:
    def test_finds_transcript_at_expected_path(self, tmp_path):
        project_dir = tmp_path / ".claude" / "projects" / "-home-botuser-app"
        project_dir.mkdir(parents=True)
        transcript = project_dir / "abc-123.jsonl"
        transcript.write_text('{"role": "assistant"}\n')

        with patch("bot.transcripts.Path.home", return_value=tmp_path):
            result = _find_transcript("abc-123", "/home/botuser/app")

        assert result == transcript

    def test_returns_none_when_missing(self, tmp_path):
        with patch("bot.transcripts.Path.home", return_value=tmp_path):
            result = _find_transcript("nonexistent", "/home/botuser/app")

        assert result is None

    def test_fallback_scan_finds_transcript(self, tmp_path):
        other_dir = tmp_path / ".claude" / "projects" / "-some-other-path"
        other_dir.mkdir(parents=True)
        transcript = other_dir / "xyz-789.jsonl"
        transcript.write_text('{"role": "user"}\n')

        with patch("bot.transcripts.Path.home", return_value=tmp_path):
            result = _find_transcript("xyz-789", "/wrong/path")

        assert result == transcript


# --- record_transcript ---


@dataclass
class FakeResult:
    session_id: str = "test-session-id"
    subtype: str = "success"
    duration_ms: int = 5000
    num_turns: int = 10
    usage: dict | None = None

    def __post_init__(self):
        if self.usage is None:
            self.usage = {"input_tokens": 50000, "output_tokens": 10000}


class TestRecordTranscript:
    def test_posts_cycle_run(self, tmp_path):
        project_dir = tmp_path / ".claude" / "projects" / "-test-cwd"
        project_dir.mkdir(parents=True)
        transcript = project_dir / "test-session-id.jsonl"
        transcript.write_text('{"role": "assistant", "content": "hello"}\n')

        result = FakeResult()
        ctx = CycleContext(jira_key="RHCLOUD-123", task_id=42, work_type="new_ticket")

        with (
            patch("bot.transcripts.Path.home", return_value=tmp_path),
            patch("bot.transcripts.httpx.post") as mock_post,
        ):
            record_transcript(
                label="test-label",
                result=result,
                ctx=ctx,
                cwd="/test/cwd",
                instance_id="test-instance",
            )

        mock_post.assert_called_once()
        call_kwargs = mock_post.call_args
        body = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")

        assert body["task_id"] == 42
        assert body["cycle_type"] == "task_work"
        assert body["instance_id"] == "test-instance"
        assert body["tool_calls"] == 10
        assert body["tokens_used"] == 60000
        assert body["progress"]["jira_key"] == "RHCLOUD-123"
        assert "transcript_b64" in body

        # Verify transcript round-trips
        import zstandard as zstd

        compressed = base64.b64decode(body["transcript_b64"])
        decompressor = zstd.ZstdDecompressor()
        decompressed = decompressor.decompress(compressed)
        assert b"hello" in decompressed

    def test_posts_without_transcript_when_missing(self):
        result = FakeResult()
        ctx = CycleContext(work_type="idle")

        with (
            patch("bot.transcripts._find_transcript", return_value=None),
            patch("bot.transcripts.httpx.post") as mock_post,
        ):
            record_transcript(
                label="test-label",
                result=result,
                ctx=ctx,
                cwd="/test/cwd",
            )

        mock_post.assert_called_once()
        body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get(
            "json"
        )
        assert "transcript_b64" not in body
        assert body["cycle_type"] == "idle"

    def test_skips_when_no_session_id(self):
        result = FakeResult(session_id="")

        with patch("bot.transcripts.httpx.post") as mock_post:
            record_transcript(label="test", result=result)

        mock_post.assert_not_called()

    def test_handles_api_failure_gracefully(self, tmp_path):
        result = FakeResult()
        ctx = CycleContext()

        with (
            patch("bot.transcripts._find_transcript", return_value=None),
            patch(
                "bot.transcripts.httpx.post",
                side_effect=Exception("connection refused"),
            ),
        ):
            record_transcript(label="test", result=result, ctx=ctx, cwd="/test")

    def test_null_task_id_for_idle(self):
        result = FakeResult()
        ctx = CycleContext(work_type="idle", task_id=None)

        with (
            patch("bot.transcripts._find_transcript", return_value=None),
            patch("bot.transcripts.httpx.post") as mock_post,
        ):
            record_transcript(label="test", result=result, ctx=ctx, cwd="/test")

        body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get(
            "json"
        )
        assert body["task_id"] is None
        assert body["cycle_type"] == "idle"

    def test_error_cycle_type_on_failure(self):
        result = FakeResult(subtype="error")
        ctx = CycleContext(work_type="new_ticket")

        with (
            patch("bot.transcripts._find_transcript", return_value=None),
            patch("bot.transcripts.httpx.post") as mock_post,
        ):
            record_transcript(label="test", result=result, ctx=ctx, cwd="/test")

        body = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1].get(
            "json"
        )
        assert body["cycle_type"] == "error"

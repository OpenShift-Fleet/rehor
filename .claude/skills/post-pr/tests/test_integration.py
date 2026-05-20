"""Integration tests for post-PR workflow."""

import json
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from scripts.post_pr_operations import OperationStatus, execute_post_pr_workflow


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def env_vars(temp_dir):
    """Set up environment variables for testing."""
    original_env = os.environ.copy()

    os.environ["POST_PR_JIRA_URL"] = "https://test-jira.example.com"
    os.environ["POST_PR_SLACK_WEBHOOK"] = "https://hooks.slack.com/test"
    os.environ["POST_PR_MEMORY_STORE"] = str(temp_dir / "memory.json")

    yield

    os.environ.clear()
    os.environ.update(original_env)


def _make_gh_side_effect():
    """Create a subprocess.run side_effect for gh CLI calls."""

    def side_effect(args, **kwargs):
        result = Mock(spec=subprocess.CompletedProcess)
        result.returncode = 0
        result.stderr = ""
        args_str = " ".join(args) if isinstance(args, list) else args

        if "labels" in args_str and "POST" in args_str:
            result.stdout = json.dumps([{"name": "code-review"}, {"name": "awaiting-review"}])
        elif "pulls/" in args_str and "PATCH" not in args_str and "requested_reviewers" not in args_str:
            result.stdout = json.dumps({"body": "Existing PR description"})
        elif "PATCH" in args_str:
            result.stdout = json.dumps({"body": "Updated"})
        elif "requested_reviewers" in args_str:
            result.stdout = json.dumps({"requested_reviewers": [{"login": "user1"}]})
        else:
            result.stdout = "{}"
        return result

    return side_effect


@pytest.fixture
def mock_apis():
    """Mock gh CLI (subprocess) and Jira MCP calls."""
    with (
        patch("scripts.post_pr_operations.subprocess.run") as mock_run,
        patch("scripts.post_pr_operations.jira_call") as mock_jira_call,
        patch("scripts.post_pr_operations.httpx.Client") as mock_client_class,
    ):
        mock_run.side_effect = _make_gh_side_effect()

        mock_jira_call.side_effect = [
            {"transitions": [{"id": "21", "to": {"name": "Code Review"}}]},
            {"success": True},
            {"id": "12345"},
        ]

        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client
        mock_post_response = Mock()
        mock_post_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_post_response

        yield mock_run, mock_jira_call


def _reset_jira_mock(mock_jira_call):
    """Reset jira_call mock with fresh side_effect for a new workflow run."""
    mock_jira_call.side_effect = [
        {"transitions": [{"id": "21", "to": {"name": "Code Review"}}]},
        {"success": True},
        {"id": "12345"},
    ]


class TestFullWorkflow:
    """Test complete post-PR workflow."""

    def test_successful_workflow(self, env_vars, temp_dir, mock_apis):
        """Test successful execution of all operations."""
        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/123",
            pr_number=123,
            ticket_id="TICKET-456",
            summary="Add vector search caching",
            slack_channel="#hcc-ai-assistant",
            reviewers=["user1", "user2"],
        )

        assert result.success is True
        assert result.pr_url == "https://github.com/RedHatInsights/hcc-ai-assistant/pull/123"
        assert result.pr_number == 123
        assert result.ticket_id == "TICKET-456"
        assert len(result.operations) == 6

        for op in result.operations:
            assert op.status == OperationStatus.SUCCESS

        expected_operations = [
            "task_update",
            "jira_transition_issue",
            "jira_add_comment",
            "slack_notify",
            "memory_store",
            "bot_status_update",
        ]
        actual_operations = [op.operation for op in result.operations]
        assert actual_operations == expected_operations

    def test_workflow_with_skip_operations(self, env_vars, mock_apis):
        """Test workflow with some operations skipped."""
        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/124",
            pr_number=124,
            ticket_id="TICKET-457",
            summary="Fix timeout",
            skip_operations=["slack", "memory"],
        )

        assert result.success is True

        slack_op = next(op for op in result.operations if op.operation == "slack_notify")
        assert slack_op.status == OperationStatus.SKIPPED

        memory_op = next(op for op in result.operations if op.operation == "memory_store")
        assert memory_op.status == OperationStatus.SKIPPED

        for op in result.operations:
            if op.operation not in ["slack_notify", "memory_store"]:
                assert op.status == OperationStatus.SUCCESS

    def test_workflow_dry_run(self, env_vars, temp_dir, mock_apis):
        """Test workflow in dry-run mode."""
        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/125",
            pr_number=125,
            ticket_id="TICKET-458",
            summary="Update dependencies",
            dry_run=True,
        )

        assert result.success is True

        for op in result.operations:
            assert op.status == OperationStatus.SUCCESS

        memory_store = Path(os.environ["POST_PR_MEMORY_STORE"])
        assert not memory_store.exists()

    def test_workflow_fails_fast_on_error(self, temp_dir, monkeypatch):
        """Test that workflow stops on first error (fail-fast)."""
        monkeypatch.delenv("POST_PR_SLACK_WEBHOOK", raising=False)
        monkeypatch.setenv("POST_PR_MEMORY_STORE", str(temp_dir / "memory.json"))

        with patch("scripts.post_pr_operations.subprocess.run") as mock_run:
            mock_run.side_effect = lambda args, **kwargs: Mock(returncode=1, stdout="", stderr="gh: command not found")

            result = execute_post_pr_workflow(
                pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/126",
                pr_number=126,
                ticket_id="TICKET-459",
                summary="Test failure",
            )

        assert result.success is False

        failed_ops = [op for op in result.operations if op.status == OperationStatus.FAILED]
        assert len(failed_ops) > 0
        assert failed_ops[0].operation == "task_update"

        assert len(result.operations) == 1

    def test_workflow_result_serialization(self, env_vars, mock_apis):
        """Test that workflow result can be serialized to JSON."""
        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/127",
            pr_number=127,
            ticket_id="TICKET-460",
            summary="Test serialization",
        )

        result_dict = result.to_dict()
        json_str = json.dumps(result_dict, indent=2)

        parsed = json.loads(json_str)
        assert parsed["success"] is True
        assert parsed["pr_number"] == 127
        assert parsed["ticket_id"] == "TICKET-460"
        assert len(parsed["operations"]) == 6


class TestWorkflowEdgeCases:
    """Test edge cases and error scenarios."""

    def test_workflow_with_minimal_inputs(self, env_vars, mock_apis):
        """Test workflow with only required inputs."""
        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/128",
            pr_number=128,
            ticket_id="TICKET-461",
            summary="Minimal test",
        )

        assert result.success is True
        slack_op = next(op for op in result.operations if op.operation == "slack_notify")
        assert slack_op.details["channel"] == "#hcc-ai-assistant"

    def test_workflow_with_long_summary(self, env_vars, mock_apis):
        """Test workflow with very long PR summary."""
        _, mock_jira_call = mock_apis
        _reset_jira_mock(mock_jira_call)

        long_summary = "A" * 1000

        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/129",
            pr_number=129,
            ticket_id="TICKET-462",
            summary=long_summary,
        )

        assert result.success is True

        jira_comment_op = next(op for op in result.operations if op.operation == "jira_add_comment")
        assert long_summary in jira_comment_op.details["comment"]

    def test_workflow_with_special_characters(self, env_vars, mock_apis):
        """Test workflow with special characters in summary."""
        _, mock_jira_call = mock_apis
        _reset_jira_mock(mock_jira_call)

        special_summary = 'Test "quotes" & <tags> and \\backslashes\\'

        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/130",
            pr_number=130,
            ticket_id="TICKET-463",
            summary=special_summary,
        )

        assert result.success is True

        task_op = next(op for op in result.operations if op.operation == "task_update")
        assert task_op.status == OperationStatus.SUCCESS
        assert task_op.details["jira_ticket"] == "TICKET-463"

    def test_workflow_with_reviewers(self, env_vars, mock_apis):
        """Test workflow with reviewers specified."""
        _, mock_jira_call = mock_apis
        _reset_jira_mock(mock_jira_call)

        result = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/131",
            pr_number=131,
            ticket_id="TICKET-464",
            summary="Reviewer test",
            reviewers=["reviewer1", "reviewer2", "reviewer3"],
        )

        assert result.success is True

        task_op = next(op for op in result.operations if op.operation == "task_update")
        assert "reviewer1" in str(task_op.details.get("reviewers_requested", []))


class TestWorkflowPersistence:
    """Test that workflow operations persist data correctly."""

    def test_github_pr_updates(self, env_vars, mock_apis):
        """Test that GitHub PR updates include correct details."""
        _, mock_jira_call = mock_apis

        result1 = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/132",
            pr_number=132,
            ticket_id="TICKET-465",
            summary="First PR",
            reviewers=["user1"],
        )

        _reset_jira_mock(mock_jira_call)

        result2 = execute_post_pr_workflow(
            pr_url="https://github.com/test/other-repo/pull/133",
            pr_number=133,
            ticket_id="TICKET-466",
            summary="Second PR",
            reviewers=["user2", "user3"],
        )

        assert result1.success is True
        assert result2.success is True

        task_op1 = next(op for op in result1.operations if op.operation == "task_update")
        assert task_op1.details["owner"] == "RedHatInsights"
        assert task_op1.details["repo"] == "hcc-ai-assistant"
        assert task_op1.details["pr_number"] == 132
        assert task_op1.details["reviewers_requested"] == ["user1"]

        task_op2 = next(op for op in result2.operations if op.operation == "task_update")
        assert task_op2.details["owner"] == "test"
        assert task_op2.details["repo"] == "other-repo"
        assert task_op2.details["pr_number"] == 133
        assert task_op2.details["reviewers_requested"] == ["user2", "user3"]

    def test_memory_accumulation(self, env_vars, temp_dir, mock_apis):
        """Test that memories accumulate over multiple executions."""
        _, mock_jira_call = mock_apis

        for i in range(3):
            _reset_jira_mock(mock_jira_call)
            result = execute_post_pr_workflow(
                pr_url=f"https://github.com/RedHatInsights/hcc-ai-assistant/pull/{134 + i}",
                pr_number=134 + i,
                ticket_id=f"TICKET-{467 + i}",
                summary=f"PR {i + 1}",
            )
            assert result.success is True

        memory_store = Path(os.environ["POST_PR_MEMORY_STORE"])
        assert memory_store.exists()

        with open(memory_store, "r") as f:
            memories = json.load(f)
            assert len(memories) == 3

            for i, memory in enumerate(memories):
                assert memory["ticket_id"] == f"TICKET-{467 + i}"
                assert memory["pr_url"] == f"https://github.com/RedHatInsights/hcc-ai-assistant/pull/{134 + i}"

    def test_bot_status_overwrite(self, env_vars, mock_apis):
        """Test that bot status is overwritten on each execution."""
        _, mock_jira_call = mock_apis

        result1 = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/137",
            pr_number=137,
            ticket_id="TICKET-470",
            summary="First",
        )

        _reset_jira_mock(mock_jira_call)

        result2 = execute_post_pr_workflow(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/138",
            pr_number=138,
            ticket_id="TICKET-471",
            summary="Second",
        )

        assert result1.success is True
        assert result2.success is True

        status_file = Path("/tmp/bot_status.json")
        assert status_file.exists()

        with open(status_file, "r") as f:
            status = json.load(f)
            assert status["status"] == "idle"
            assert status["timestamp"]

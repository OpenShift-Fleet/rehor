"""Unit tests for post-PR operations."""

import json
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from scripts.post_pr_operations import (
    OperationResult,
    OperationStatus,
    PostPROperations,
    WorkflowResult,
)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def operations(temp_dir):
    """Create PostPROperations instance with temp file paths."""
    return PostPROperations(
        slack_webhook="https://hooks.slack.com/test",
        memory_store_path=str(temp_dir / "memory.json"),
        jira_url="https://test-jira.example.com",
        dry_run=False,
    )


def _mock_subprocess_run(responses):
    """Create a side_effect function for subprocess.run that returns responses in order.

    Each response is a dict with: stdout, stderr (optional), returncode (default 0).
    """
    call_index = [0]

    def side_effect(args, **kwargs):
        idx = call_index[0]
        call_index[0] += 1
        if idx >= len(responses):
            resp = responses[-1]
        else:
            resp = responses[idx]
        result = Mock(spec=subprocess.CompletedProcess)
        result.stdout = resp.get("stdout", "")
        result.stderr = resp.get("stderr", "")
        result.returncode = resp.get("returncode", 0)
        return result

    return side_effect


class TestTaskUpdate:
    """Test task_update operation (GitHub PR updates via gh CLI)."""

    @patch("scripts.post_pr_operations.subprocess.run")
    def test_task_update_github_success(self, mock_run, operations):
        """Test successful GitHub PR update via gh CLI."""
        mock_run.side_effect = _mock_subprocess_run(
            [
                {"stdout": json.dumps([{"name": "code-review"}, {"name": "awaiting-review"}])},
                {"stdout": json.dumps({"body": "Existing PR description"})},
                {"stdout": json.dumps({"body": "Updated description"})},
                {"stdout": json.dumps({"requested_reviewers": [{"login": "user1"}, {"login": "user2"}]})},
            ]
        )

        result = operations.task_update(
            pr_url="https://github.com/RedHatInsights/hcc-ai-assistant/pull/123",
            pr_number=123,
            ticket_id="TICKET-456",
            reviewers=["user1", "user2"],
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "task_update"
        assert "123" in result.message
        assert result.details["pr_number"] == 123
        assert result.details["owner"] == "RedHatInsights"
        assert result.details["repo"] == "hcc-ai-assistant"
        assert result.details["jira_ticket"] == "TICKET-456"
        assert result.details["reviewers_requested"] == ["user1", "user2"]
        assert "code-review" in result.details["labels_added"]

        labels_call = mock_run.call_args_list[0]
        assert "repos/RedHatInsights/hcc-ai-assistant/issues/123/labels" in labels_call[0][0]
        assert labels_call[1].get("input") is not None
        labels_payload = json.loads(labels_call[1]["input"])
        assert labels_payload["labels"] == ["code-review", "awaiting-review"]

        get_call = mock_run.call_args_list[1]
        assert "repos/RedHatInsights/hcc-ai-assistant/pulls/123" in get_call[0][0]

        patch_call = mock_run.call_args_list[2]
        assert "PATCH" in patch_call[0][0]
        patch_payload = json.loads(patch_call[1]["input"])
        assert "TICKET-456" in patch_payload["body"]
        assert "https://test-jira.example.com/browse/TICKET-456" in patch_payload["body"]

        reviewers_call = mock_run.call_args_list[3]
        assert "requested_reviewers" in " ".join(reviewers_call[0][0])
        reviewers_payload = json.loads(reviewers_call[1]["input"])
        assert reviewers_payload["reviewers"] == ["user1", "user2"]

    def test_task_update_dry_run(self, temp_dir):
        """Test GitHub PR update in dry-run mode."""
        operations = PostPROperations(
            slack_webhook="https://hooks.slack.com/test",
            memory_store_path=str(temp_dir / "memory.json"),
            dry_run=True,
        )

        result = operations.task_update(
            pr_url="https://github.com/test/repo/pull/2", pr_number=2, ticket_id="TICKET-789", reviewers=None
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.details["owner"] == "test"
        assert result.details["repo"] == "repo"

    @patch("scripts.post_pr_operations.subprocess.run")
    def test_task_update_no_reviewers(self, mock_run, operations):
        """Test GitHub PR update without reviewers."""
        mock_run.side_effect = _mock_subprocess_run(
            [
                {"stdout": json.dumps([{"name": "code-review"}])},
                {"stdout": json.dumps({"body": "Existing PR description"})},
                {"stdout": json.dumps({"body": "Updated"})},
            ]
        )

        result = operations.task_update(
            pr_url="https://github.com/test/repo/pull/3", pr_number=3, ticket_id="TICKET-111", reviewers=None
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.details["reviewers_requested"] == []
        assert mock_run.call_count == 3  # labels, get PR, patch PR

    def test_task_update_invalid_url(self, operations):
        """Test PR update with invalid URL."""
        result = operations.task_update(
            pr_url="https://invalid.com/not/a/pr", pr_number=5, ticket_id="TICKET-333", reviewers=None
        )

        assert result.status == OperationStatus.FAILED
        assert "Unsupported PR URL" in result.message

    @patch("scripts.post_pr_operations.subprocess.run")
    def test_task_update_gh_cli_failure(self, mock_run, operations):
        """Test GitHub PR update when gh CLI fails."""
        mock_run.side_effect = _mock_subprocess_run(
            [
                {"returncode": 1, "stderr": "gh: Not Found (HTTP 404)"},
            ]
        )

        result = operations.task_update(
            pr_url="https://github.com/test/repo/pull/99", pr_number=99, ticket_id="TICKET-999", reviewers=None
        )

        assert result.status == OperationStatus.FAILED
        assert "Failed to add labels" in result.message

    @patch("scripts.post_pr_operations.subprocess.run")
    def test_task_update_gitlab_success(self, mock_run, operations):
        """Test successful GitLab MR update via glab CLI."""
        mock_run.side_effect = _mock_subprocess_run(
            [
                {"stdout": json.dumps({"labels": ["code-review", "awaiting-review"]})},
                {"stdout": json.dumps({"description": "Existing MR description"})},
                {"stdout": json.dumps({"description": "Updated"})},
                {"stdout": json.dumps([{"id": 42, "username": "reviewer1"}])},
                {"stdout": json.dumps({"reviewers": [{"id": 42}]})},
            ]
        )

        result = operations.task_update(
            pr_url="https://gitlab.cee.redhat.com/insights-qe/test-repo/-/merge_requests/5",
            pr_number=5,
            ticket_id="TICKET-GL1",
            reviewers=["reviewer1"],
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.details["owner"] == "insights-qe"
        assert result.details["repo"] == "test-repo"
        assert result.details["jira_ticket"] == "TICKET-GL1"

        labels_call = mock_run.call_args_list[0]
        cli_args = labels_call[0][0]
        hostname_idx = cli_args.index("--hostname")
        assert cli_args[hostname_idx + 1] == "gitlab.cee.redhat.com"


class TestJiraTransitionIssue:
    """Test jira_transition_issue operation (via MCP)."""

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_transition_success(self, mock_jira_call, operations):
        """Test successful JIRA transition via MCP."""
        mock_jira_call.side_effect = [
            {
                "transitions": [
                    {"id": "11", "to": {"name": "In Progress"}},
                    {"id": "21", "to": {"name": "Code Review"}},
                    {"id": "31", "to": {"name": "Done"}},
                ]
            },
            {"success": True},
        ]

        result = operations.jira_transition_issue(ticket_id="TICKET-123", target_status="Code Review")

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "jira_transition_issue"
        assert "TICKET-123" in result.message
        assert result.details["status"] == "Code Review"

        assert mock_jira_call.call_count == 2
        mock_jira_call.assert_any_call("jira_get_transitions", {"issue_key": "TICKET-123"})
        mock_jira_call.assert_any_call("jira_transition_issue", {"issue_key": "TICKET-123", "transition_id": "21"})

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_transition_mcp_unavailable(self, mock_jira_call, operations):
        """Test JIRA transition fails when MCP returns None."""
        mock_jira_call.return_value = None

        result = operations.jira_transition_issue(ticket_id="TICKET-456")

        assert result.status == OperationStatus.FAILED
        assert "Failed to get transitions" in result.message

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_transition_invalid_status(self, mock_jira_call, operations):
        """Test JIRA transition fails when target status doesn't exist."""
        mock_jira_call.return_value = {
            "transitions": [
                {"id": "11", "to": {"name": "In Progress"}},
                {"id": "21", "to": {"name": "Code Review"}},
            ]
        }

        result = operations.jira_transition_issue(ticket_id="TICKET-999", target_status="Nonexistent Status")

        assert result.status == OperationStatus.FAILED
        assert "Cannot transition to 'Nonexistent Status'" in result.message
        assert "Available transitions:" in result.message
        assert mock_jira_call.call_count == 1

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_transition_custom_status(self, mock_jira_call, operations):
        """Test JIRA transition to custom status."""
        mock_jira_call.side_effect = [
            {
                "transitions": [
                    {"id": "11", "to": {"name": "In Progress"}},
                    {"id": "21", "to": {"name": "Code Review"}},
                ]
            },
            {"success": True},
        ]

        result = operations.jira_transition_issue(ticket_id="TICKET-789", target_status="In Progress")

        assert result.status == OperationStatus.SUCCESS
        assert result.details["status"] == "In Progress"
        mock_jira_call.assert_any_call("jira_transition_issue", {"issue_key": "TICKET-789", "transition_id": "11"})

    def test_jira_transition_dry_run(self, operations):
        """Test JIRA transition in dry-run mode skips MCP calls."""
        operations.dry_run = True
        result = operations.jira_transition_issue(ticket_id="TICKET-DRY")

        assert result.status == OperationStatus.SUCCESS
        assert result.details["status"] == "Code Review"


class TestJiraAddComment:
    """Test jira_add_comment operation (via MCP)."""

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_add_comment_success(self, mock_jira_call, operations):
        """Test successful JIRA comment via MCP."""
        mock_jira_call.return_value = {"id": "12345"}

        result = operations.jira_add_comment(
            ticket_id="TICKET-123", pr_url="https://github.com/test/repo/pull/1", summary="Test PR summary"
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "jira_add_comment"
        assert "TICKET-123" in result.message
        assert "Test PR summary" in result.details["comment"]
        assert "https://github.com/test/repo/pull/1" in result.details["comment"]

        mock_jira_call.assert_called_once_with(
            "jira_add_comment",
            {
                "issue_key": "TICKET-123",
                "body": "Pull Request created: https://github.com/test/repo/pull/1\n\nSummary: Test PR summary",
            },
        )

    @patch("scripts.post_pr_operations.jira_call")
    def test_jira_add_comment_mcp_fails(self, mock_jira_call, operations):
        """Test JIRA comment fails when MCP returns None."""
        mock_jira_call.return_value = None

        result = operations.jira_add_comment(
            ticket_id="TICKET-456", pr_url="https://github.com/test/repo/pull/2", summary="Test"
        )

        assert result.status == OperationStatus.FAILED
        assert "Failed to add comment" in result.message

    def test_jira_add_comment_dry_run(self, operations):
        """Test JIRA comment in dry-run mode skips MCP calls."""
        operations.dry_run = True
        result = operations.jira_add_comment(
            ticket_id="TICKET-DRY", pr_url="https://github.com/test/repo/pull/3", summary="Dry run"
        )

        assert result.status == OperationStatus.SUCCESS


class TestSlackNotify:
    """Test slack_notify operation."""

    @patch("scripts.post_pr_operations.httpx.Client")
    def test_slack_notify_success(self, mock_client_class, operations):
        """Test successful Slack notification."""
        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client

        mock_post_response = Mock()
        mock_post_response.raise_for_status = Mock()

        mock_client.post.return_value = mock_post_response

        result = operations.slack_notify(
            pr_url="https://github.com/test/repo/pull/1", pr_number=1, summary="Test PR", channel="#test-channel"
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "slack_notify"
        assert "#test-channel" in result.message
        assert result.details["channel"] == "#test-channel"

        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        assert call_args[0][0] == "https://hooks.slack.com/test"
        assert call_args[1]["timeout"] == 30.0

        message_json = call_args[1]["json"]
        assert message_json["channel"] == "#test-channel"
        assert message_json["text"] == "New PR created: #1"
        assert "attachments" in message_json
        assert len(message_json["attachments"]) == 1

        attachment = message_json["attachments"][0]
        assert attachment["color"] == "good"

        fields = attachment["fields"]
        assert len(fields) == 2
        assert fields[0]["title"] == "PR"
        assert "<https://github.com/test/repo/pull/1|#1>" in fields[0]["value"]
        assert fields[0]["short"] is True
        assert fields[1]["title"] == "Summary"
        assert fields[1]["value"] == "Test PR"
        assert fields[1]["short"] is False

    def test_slack_notify_no_webhook(self, temp_dir, monkeypatch):
        """Test Slack notification fails without webhook."""
        monkeypatch.delenv("POST_PR_SLACK_WEBHOOK", raising=False)
        operations = PostPROperations(
            slack_webhook="",
            memory_store_path=str(temp_dir / "memory.json"),
        )

        result = operations.slack_notify(
            pr_url="https://github.com/test/repo/pull/2", pr_number=2, summary="Test", channel="#test"
        )

        assert result.status == OperationStatus.FAILED
        assert "Slack webhook not configured" in result.message

    @patch("scripts.post_pr_operations.httpx.Client")
    def test_slack_notify_default_channel(self, mock_client_class, operations):
        """Test Slack notification with default channel."""
        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client

        mock_post_response = Mock()
        mock_post_response.raise_for_status = Mock()

        mock_client.post.return_value = mock_post_response

        result = operations.slack_notify(pr_url="https://github.com/test/repo/pull/3", pr_number=3, summary="Test PR")

        assert result.status == OperationStatus.SUCCESS
        assert result.details["channel"] == "#hcc-ai-assistant"

        call_args = mock_client.post.call_args
        message_json = call_args[1]["json"]
        assert message_json["channel"] == "#hcc-ai-assistant"


class TestMemoryStore:
    """Test memory_store operation."""

    def test_memory_store_success(self, operations):
        """Test successful memory storage."""
        learnings = {
            "patterns": ["Use async/await"],
            "gotchas": ["Watch for race conditions"],
            "decisions": ["Chose FastAPI"],
        }

        result = operations.memory_store(
            pr_url="https://github.com/test/repo/pull/1", ticket_id="TICKET-123", learnings=learnings
        )

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "memory_store"
        assert result.details["learnings"] == learnings

        memory_file = Path(operations.memory_store_path)
        assert memory_file.exists()
        with open(memory_file, "r") as f:
            memories = json.load(f)
            assert len(memories) == 1
            assert memories[0]["ticket_id"] == "TICKET-123"
            assert memories[0]["learnings"] == learnings

    def test_memory_store_append(self, operations):
        """Test memory storage appends to existing file."""
        operations.memory_store(
            pr_url="https://github.com/test/repo/pull/1",
            ticket_id="TICKET-123",
            learnings={"patterns": ["Pattern 1"]},
        )

        operations.memory_store(
            pr_url="https://github.com/test/repo/pull/2",
            ticket_id="TICKET-456",
            learnings={"patterns": ["Pattern 2"]},
        )

        with open(operations.memory_store_path, "r") as f:
            memories = json.load(f)
            assert len(memories) == 2
            assert memories[0]["ticket_id"] == "TICKET-123"
            assert memories[1]["ticket_id"] == "TICKET-456"

    def test_memory_store_dry_run(self, temp_dir):
        """Test memory storage in dry-run mode."""
        operations = PostPROperations(
            slack_webhook="https://hooks.slack.com/test",
            memory_store_path=str(temp_dir / "memory.json"),
            dry_run=True,
        )

        result = operations.memory_store(
            pr_url="https://github.com/test/repo/pull/3", ticket_id="TICKET-789", learnings={"patterns": []}
        )

        assert result.status == OperationStatus.SUCCESS
        assert not Path(operations.memory_store_path).exists()


class TestBotStatusUpdate:
    """Test bot_status_update operation."""

    def test_bot_status_update_success(self, operations):
        """Test successful bot status update."""
        result = operations.bot_status_update(status="idle")

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "bot_status_update"
        assert "idle" in result.message
        assert result.details["status"] == "idle"

        status_file = Path("/tmp/bot_status.json")
        assert status_file.exists()
        with open(status_file, "r") as f:
            data = json.load(f)
            assert data["status"] == "idle"

    def test_bot_status_update_custom_status(self, operations):
        """Test bot status update with custom status."""
        result = operations.bot_status_update(status="working")

        assert result.status == OperationStatus.SUCCESS
        assert result.details["status"] == "working"

    def test_bot_status_update_dry_run(self, temp_dir):
        """Test bot status update in dry-run mode."""
        operations = PostPROperations(
            slack_webhook="https://hooks.slack.com/test",
            memory_store_path=str(temp_dir / "memory.json"),
            dry_run=True,
        )

        result = operations.bot_status_update(status="idle")

        assert result.status == OperationStatus.SUCCESS


class TestOperationResult:
    """Test OperationResult dataclass."""

    def test_operation_result_creation(self):
        """Test creating an OperationResult."""
        result = OperationResult(
            operation="test_op", status=OperationStatus.SUCCESS, message="Test message", details={"key": "value"}
        )

        assert result.operation == "test_op"
        assert result.status == OperationStatus.SUCCESS
        assert result.message == "Test message"
        assert result.details == {"key": "value"}
        assert result.timestamp

    def test_operation_result_failed_status(self):
        """Test OperationResult with failed status."""
        result = OperationResult(operation="test_op", status=OperationStatus.FAILED, message="Error occurred")

        assert result.status == OperationStatus.FAILED
        assert "Error occurred" in result.message


class TestWorkflowResult:
    """Test WorkflowResult dataclass."""

    def test_workflow_result_to_dict(self):
        """Test converting WorkflowResult to dictionary."""
        operations = [
            OperationResult(operation="op1", status=OperationStatus.SUCCESS, message="OK"),
            OperationResult(operation="op2", status=OperationStatus.FAILED, message="Failed"),
        ]

        result = WorkflowResult(
            success=False,
            pr_url="https://github.com/test/repo/pull/1",
            pr_number=1,
            ticket_id="TICKET-123",
            operations=operations,
        )

        result_dict = result.to_dict()

        assert result_dict["success"] is False
        assert result_dict["pr_url"] == "https://github.com/test/repo/pull/1"
        assert result_dict["pr_number"] == 1
        assert result_dict["ticket_id"] == "TICKET-123"
        assert len(result_dict["operations"]) == 2
        assert result_dict["operations"][0]["status"] == "success"
        assert result_dict["operations"][1]["status"] == "failed"


class TestParseURL:
    """Test URL parsing for GitHub and GitLab."""

    def test_parse_github_url(self, operations):
        """Test parsing GitHub PR URL."""
        info = operations._parse_pr_url("https://github.com/RedHatInsights/hcc-ai-assistant/pull/123")
        assert info["host"] == "github"
        assert info["owner"] == "RedHatInsights"
        assert info["repo"] == "hcc-ai-assistant"

    def test_parse_gitlab_url(self, operations):
        """Test parsing GitLab MR URL."""
        info = operations._parse_pr_url("https://gitlab.cee.redhat.com/insights-qe/test-repo/-/merge_requests/5")
        assert info["host"] == "gitlab"
        assert info["hostname"] == "gitlab.cee.redhat.com"
        assert info["owner"] == "insights-qe"
        assert info["repo"] == "test-repo"
        assert info["project_path"] == "insights-qe/test-repo"

    def test_parse_gitlab_nested_url(self, operations):
        """Test parsing GitLab MR URL with nested groups."""
        info = operations._parse_pr_url("https://gitlab.cee.redhat.com/service/platform/backend/-/merge_requests/42")
        assert info["host"] == "gitlab"
        assert info["owner"] == "service/platform"
        assert info["repo"] == "backend"
        assert info["project_path"] == "service/platform/backend"

    def test_parse_github_issues_url_rejected(self, operations):
        """Test that GitHub issues URL is rejected (not a PR)."""
        with pytest.raises(ValueError, match="Invalid GitHub PR URL"):
            operations._parse_pr_url("https://github.com/org/repo/issues/123")

    def test_parse_selfhosted_gitlab_url(self, operations):
        """Test parsing self-hosted GitLab MR URL (detected by path pattern)."""
        info = operations._parse_pr_url("https://gitlab.internal.example.com/team/project/-/merge_requests/10")
        assert info["host"] == "gitlab"
        assert info["hostname"] == "gitlab.internal.example.com"
        assert info["owner"] == "team"
        assert info["repo"] == "project"

    def test_parse_unsupported_url(self, operations):
        """Test parsing unsupported URL raises error."""
        with pytest.raises(ValueError, match="Unsupported PR URL"):
            operations._parse_pr_url("https://bitbucket.org/team/repo/pull-requests/1")

"""Unit tests for claim-ticket operations with MCP."""

from unittest.mock import Mock, patch

import pytest
from scripts.claim_ticket_operations import (
    ClaimTicketOperations,
    OperationStatus,
)


@pytest.fixture
def operations():
    """Create ClaimTicketOperations instance for testing."""
    return ClaimTicketOperations(
        memory_url="https://test-memory.example.com",
        dry_run=False,
    )


@pytest.fixture(autouse=True)
def clear_bot_account_cache():
    """Clear bot account ID cache before each test."""
    ClaimTicketOperations._bot_account_id_cache = None
    yield
    ClaimTicketOperations._bot_account_id_cache = None


class TestGetBotEmail:
    """Test get_bot_email operation."""

    def test_get_bot_email_success(self, operations):
        """Test successful bot email retrieval from env var."""
        result = operations.get_bot_email()

        assert result.status == OperationStatus.SUCCESS
        assert result.operation == "get_bot_email"
        assert "bot@example.com" in result.message
        assert result.details["email"] == "bot@example.com"
        assert operations.bot_account_id == "bot@example.com"

    def test_get_bot_email_missing_env_var(self, monkeypatch):
        """Test failure when BOT_JIRA_EMAIL is not set."""
        monkeypatch.delenv("BOT_JIRA_EMAIL", raising=False)
        ops = ClaimTicketOperations(memory_url="https://test.example.com")
        result = ops.get_bot_email()

        assert result.status == OperationStatus.FAILED
        assert "BOT_JIRA_EMAIL" in result.message


class TestGetTransitions:
    """Test get_transitions operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_transitions_success(self, mock_jira_call, operations):
        """Test successful transition retrieval."""
        mock_jira_call.return_value = {
            "transitions": [
                {"id": "11", "name": "To Do"},
                {"id": "21", "name": "In Progress"},
                {"id": "31", "name": "Done"},
            ]
        }

        result = operations.get_transitions("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        assert result.details["transition_id"] == "21"
        assert operations.transition_id == "21"

        mock_jira_call.assert_called_once_with("jira_get_transitions", {"issue_key": "RHCLOUD-12345"})

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_transitions_flat_list(self, mock_jira_call, operations):
        """Test transition retrieval when MCP returns flat list."""
        mock_jira_call.return_value = [
            {"id": "11", "name": "To Do"},
            {"id": "21", "name": "In Progress"},
        ]

        result = operations.get_transitions("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        assert operations.transition_id == "21"

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_transitions_not_found(self, mock_jira_call, operations):
        """Test when In Progress transition not found."""
        mock_jira_call.return_value = {"transitions": [{"id": "11", "name": "To Do"}]}

        result = operations.get_transitions("RHCLOUD-12345")

        assert result.status == OperationStatus.FAILED
        assert "not found" in result.message


class TestAssignTicket:
    """Test assign_ticket operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_assign_ticket_success(self, mock_jira_call, operations):
        """Test successful ticket assignment using email string."""
        operations.bot_account_id = "bot@example.com"
        mock_jira_call.return_value = {}

        result = operations.assign_ticket("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        mock_jira_call.assert_called_once_with(
            "jira_update_issue",
            {"issue_key": "RHCLOUD-12345", "fields": '{"assignee": "bot@example.com"}'},
        )

    def test_assign_ticket_no_account_id(self, operations):
        """Test when bot account ID not set."""
        result = operations.assign_ticket("RHCLOUD-12345")

        assert result.status == OperationStatus.FAILED
        assert "Bot account ID not available" in result.message


class TestTransitionToInProgress:
    """Test transition_to_in_progress operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_transition_success(self, mock_jira_call, operations):
        """Test successful transition."""
        operations.transition_id = "21"
        mock_jira_call.return_value = {}

        result = operations.transition_to_in_progress("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        mock_jira_call.assert_called_once_with(
            "jira_transition_issue",
            {"issue_key": "RHCLOUD-12345", "transition_id": "21"},
        )

    def test_transition_no_transition_id(self, operations):
        """Test when transition ID not set."""
        result = operations.transition_to_in_progress("RHCLOUD-12345")

        assert result.status == OperationStatus.FAILED
        assert "Transition ID not available" in result.message


class TestResolveBoard:
    """Test resolve_board operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_resolve_board_from_env_id(self, mock_jira_call, operations, monkeypatch):
        """Test board resolution from BOT_BOARD_ID env var."""
        monkeypatch.setenv("BOT_BOARD_ID", "9297")

        result = operations.resolve_board("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        assert operations.board_id == "9297"
        mock_jira_call.assert_not_called()

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_resolve_board_from_env_name(self, mock_jira_call, operations, monkeypatch):
        """Test board resolution from BOT_BOARD_NAME env var via Jira lookup."""
        monkeypatch.delenv("BOT_BOARD_ID", raising=False)
        monkeypatch.setenv("BOT_BOARD_NAME", "Platform Experience UI")
        mock_jira_call.return_value = {"values": [{"id": 9297, "name": "Platform Experience UI"}]}

        result = operations.resolve_board("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        assert operations.board_id == "9297"
        mock_jira_call.assert_called_once_with(
            "jira_get_agile_boards", {"board_name": "Platform Experience UI", "limit": 1}
        )

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_resolve_board_name_not_found(self, mock_jira_call, operations, monkeypatch):
        """Test board resolution when name lookup returns empty."""
        monkeypatch.delenv("BOT_BOARD_ID", raising=False)
        monkeypatch.setenv("BOT_BOARD_NAME", "Nonexistent Board")
        mock_jira_call.return_value = {"values": []}

        result = operations.resolve_board("RHCLOUD-12345")

        assert result.status == OperationStatus.FAILED
        assert "No board found" in result.message

    def test_resolve_board_no_env_vars(self, operations, monkeypatch):
        """Test board resolution when no env vars set."""
        monkeypatch.delenv("BOT_BOARD_ID", raising=False)
        monkeypatch.delenv("BOT_BOARD_NAME", raising=False)

        result = operations.resolve_board("RHCLOUD-12345")

        assert result.status == OperationStatus.FAILED
        assert "Neither BOT_BOARD_ID nor BOT_BOARD_NAME" in result.message


class TestGetActiveSprint:
    """Test get_active_sprint operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_active_sprint_success(self, mock_jira_call, operations):
        """Test successful active sprint retrieval."""
        operations.board_id = "9297"
        mock_jira_call.return_value = {"sprints": [{"id": 12345, "name": "Sprint 42"}]}

        result = operations.get_active_sprint()

        assert result.status == OperationStatus.SUCCESS
        assert operations.sprint_id == 12345
        mock_jira_call.assert_called_once_with("jira_get_sprints_from_board", {"board_id": "9297", "state": "active"})

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_active_sprint_flat_list(self, mock_jira_call, operations):
        """Test sprint retrieval when MCP returns flat list."""
        operations.board_id = "9297"
        mock_jira_call.return_value = [{"id": 12345, "name": "Sprint 42"}]

        result = operations.get_active_sprint()

        assert result.status == OperationStatus.SUCCESS
        assert operations.sprint_id == 12345

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_get_active_sprint_no_active(self, mock_jira_call, operations):
        """Test when no active sprint found."""
        operations.board_id = "9297"
        mock_jira_call.return_value = {"sprints": []}

        result = operations.get_active_sprint()

        assert result.status == OperationStatus.FAILED
        assert "No active sprint" in result.message


class TestAddToSprint:
    """Test add_to_sprint operation."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_add_to_sprint_success(self, mock_jira_call, operations):
        """Test successful sprint addition when ticket has no sprint."""
        operations.sprint_id = 12345
        mock_jira_call.side_effect = [
            {"fields": {"customfield_10020": []}},
            {},
        ]

        result = operations.add_to_sprint("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        assert mock_jira_call.call_count == 2
        mock_jira_call.assert_any_call(
            "jira_get_issue",
            {"issue_key": "RHCLOUD-12345", "fields": "customfield_10020"},
        )
        mock_jira_call.assert_any_call(
            "jira_add_issues_to_sprint",
            {"sprint_id": 12345, "issue_keys": ["RHCLOUD-12345"]},
        )

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_add_to_sprint_skips_existing(self, mock_jira_call, operations):
        """Test sprint addition is skipped when ticket already has an active sprint."""
        operations.sprint_id = 12345
        mock_jira_call.return_value = {
            "fields": {"customfield_10020": [{"id": 99999, "name": "CCXDEV Sprint 169", "state": "active"}]}
        }

        result = operations.add_to_sprint("CCXDEV-16393")

        assert result.status == OperationStatus.SUCCESS
        assert "already in sprint" in result.message
        assert result.details["skipped"] is True
        assert result.details["existing_sprint"] == "CCXDEV Sprint 169"
        mock_jira_call.assert_called_once_with(
            "jira_get_issue",
            {"issue_key": "CCXDEV-16393", "fields": "customfield_10020"},
        )


class TestTaskAdd:
    """Test task_add operation."""

    @patch("scripts.claim_ticket_operations.httpx.Client")
    def test_task_add_success(self, mock_client_class, operations):
        """Test successful task addition to memory server."""
        operations.bot_account_id = "bot-123"
        operations.board_id = "9297"
        operations.sprint_id = 12345

        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = operations.task_add("RHCLOUD-12345")

        assert result.status == OperationStatus.SUCCESS
        mock_client.post.assert_called_once()

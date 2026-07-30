"""Integration tests for claim-ticket workflow with MCP."""

from unittest.mock import patch

import pytest
from conftest import TEST_BOARD_ID, TEST_JIRA_KEY, TEST_MEMORY_URL
from scripts.claim_ticket_operations import (
    ClaimTicketOperations,
    OperationStatus,
    execute_claim_ticket_workflow,
)


@pytest.fixture(autouse=True)
def set_board_env(monkeypatch):
    """Set BOT_BOARD_NAME for all integration tests."""
    monkeypatch.setenv("BOT_BOARD_NAME", "Test Board")
    monkeypatch.delenv("BOT_BOARD_ID", raising=False)


class TestWorkflow:
    """Test complete workflow execution."""

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_successful_workflow(self, mock_jira_call, mock_memory_server, successful_jira_responses):
        """Test successful end-to-end workflow."""
        mock_jira_call.side_effect = lambda tool_name, args: successful_jira_responses.get(tool_name)

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
        )

        assert result.success is True
        assert len(result.operations) == 8
        assert all(op.status == OperationStatus.SUCCESS for op in result.operations)

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_fails_on_first_error(self, mock_jira_call):
        """Test workflow stops on first failure."""
        ClaimTicketOperations._bot_account_id_cache = None

        mock_jira_call.return_value = None

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
        )

        assert result.success is False
        assert len(result.operations) == 2
        assert result.operations[0].status == OperationStatus.SUCCESS
        assert result.operations[0].operation == "get_bot_email"
        assert result.operations[1].status == OperationStatus.FAILED
        assert result.operations[1].operation == "get_transitions"

    def test_workflow_missing_memory_url(self):
        """Test workflow fails without memory URL."""
        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=None,
        )

        assert result.success is False
        assert result.operations[0].operation == "config_validation"

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_with_skip_operations(self, mock_jira_call, mock_memory_server):
        """Test workflow with skipped operations."""
        jira_responses = {
            "jira_get_user_profile": {"account_id": "bot-123"},
            "jira_get_agile_boards": {"values": [{"id": int(TEST_BOARD_ID), "name": "Test Board"}]},
            "jira_get_sprints_from_board": {"sprints": [{"id": 12345}]},
        }

        mock_jira_call.side_effect = lambda tool_name, args: jira_responses.get(tool_name, {})

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
            skip_operations=["get_transitions", "assign_ticket", "transition_to_in_progress", "add_to_sprint"],
        )

        assert result.success is True
        skipped = [op for op in result.operations if op.status == OperationStatus.SKIPPED]
        assert len(skipped) == 4

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_with_board_id_env(self, mock_jira_call, mock_memory_server, monkeypatch):
        """Test workflow uses BOT_BOARD_ID when set (skips name lookup)."""
        monkeypatch.setenv("BOT_BOARD_ID", "8070")
        monkeypatch.delenv("BOT_BOARD_NAME", raising=False)

        jira_responses = {
            "jira_get_user_profile": {"account_id": "bot-123"},
            "jira_get_transitions": {"transitions": [{"id": "21", "name": "In Progress"}]},
            "jira_update_issue": {},
            "jira_transition_issue": {},
            "jira_get_sprints_from_board": {"sprints": [{"id": 12345, "name": "Sprint 42"}]},
            "jira_add_issues_to_sprint": {},
        }
        mock_jira_call.side_effect = lambda tool_name, args: jira_responses.get(tool_name)

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
        )

        assert result.success is True
        board_op = next(op for op in result.operations if op.operation == "resolve_board")
        assert board_op.details["board_id"] == "8070"

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_no_board_config(self, mock_jira_call, monkeypatch):
        """Test workflow fails when no board env vars set."""
        monkeypatch.delenv("BOT_BOARD_ID", raising=False)
        monkeypatch.delenv("BOT_BOARD_NAME", raising=False)

        jira_responses = {
            "jira_get_user_profile": {"account_id": "bot-123"},
            "jira_get_transitions": {"transitions": [{"id": "21", "name": "In Progress"}]},
            "jira_update_issue": {},
            "jira_transition_issue": {},
        }
        mock_jira_call.side_effect = lambda tool_name, args: jira_responses.get(tool_name, {})

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
        )

        assert result.success is False
        board_op = next(op for op in result.operations if op.operation == "resolve_board")
        assert board_op.status == OperationStatus.FAILED
        assert "Neither BOT_BOARD_ID nor BOT_BOARD_NAME" in board_op.message

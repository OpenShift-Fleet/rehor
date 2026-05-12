"""Integration tests for claim-ticket workflow with MCP."""

from unittest.mock import patch

from scripts.claim_ticket_operations import (
    ClaimTicketOperations,
    OperationStatus,
    execute_claim_ticket_workflow,
)

from .conftest import TEST_JIRA_KEY, TEST_MEMORY_URL


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
        # Clear cache to ensure get_bot_account_id runs
        ClaimTicketOperations._bot_account_id_cache = None

        mock_jira_call.return_value = None  # Simulates MCP failure

        result = execute_claim_ticket_workflow(
            jira_key=TEST_JIRA_KEY,
            memory_url=TEST_MEMORY_URL,
        )

        assert result.success is False
        assert len(result.operations) == 1  # Only first operation attempted
        assert result.operations[0].status == OperationStatus.FAILED

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
            "jira_get_issue": {"fields": {"labels": []}},
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

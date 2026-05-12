"""Integration tests for claim-ticket workflow with MCP."""

from unittest.mock import Mock, patch

import pytest

from scripts.claim_ticket_operations import (
    OperationStatus,
    execute_claim_ticket_workflow,
)


class TestWorkflow:
    """Test complete workflow execution."""

    @patch("scripts.claim_ticket_operations.httpx.Client")
    @patch("scripts.claim_ticket_operations.jira_call")
    def test_successful_workflow(self, mock_jira_call, mock_client_class):
        """Test successful end-to-end workflow."""
        # Mock MCP calls
        jira_responses = {
            "jira_get_user_profile": {"account_id": "bot-123"},
            "jira_get_transitions": {"transitions": [{"id": "21", "name": "In Progress"}]},
            "jira_update_issue": {},
            "jira_transition_issue": {},
            "jira_get_issue": {"fields": {"labels": ["platform-experience-ui"]}},
            "jira_get_sprints_from_board": {"sprints": [{"id": 12345, "name": "Sprint 42"}]},
            "jira_add_issues_to_sprint": {},
        }

        mock_jira_call.side_effect = lambda tool_name, args: jira_responses.get(tool_name)

        # Mock memory server HTTP call
        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = execute_claim_ticket_workflow(
            jira_key="RHCLOUD-12345",
            memory_url="https://test-memory.example.com",
        )

        assert result.success is True
        assert len(result.operations) == 8
        assert all(op.status == OperationStatus.SUCCESS for op in result.operations)

    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_fails_on_first_error(self, mock_jira_call):
        """Test workflow stops on first failure."""
        # Clear cache to ensure get_bot_account_id runs
        from scripts.claim_ticket_operations import ClaimTicketOperations

        ClaimTicketOperations._bot_account_id_cache = None

        mock_jira_call.return_value = None  # Simulates MCP failure

        result = execute_claim_ticket_workflow(
            jira_key="RHCLOUD-12345",
            memory_url="https://test-memory.example.com",
        )

        assert result.success is False
        assert len(result.operations) == 1  # Only first operation attempted
        assert result.operations[0].status == OperationStatus.FAILED

    def test_workflow_missing_memory_url(self):
        """Test workflow fails without memory URL."""
        result = execute_claim_ticket_workflow(
            jira_key="RHCLOUD-12345",
            memory_url=None,
        )

        assert result.success is False
        assert result.operations[0].operation == "config_validation"

    @patch("scripts.claim_ticket_operations.httpx.Client")
    @patch("scripts.claim_ticket_operations.jira_call")
    def test_workflow_with_skip_operations(self, mock_jira_call, mock_client_class):
        """Test workflow with skipped operations."""
        jira_responses = {
            "jira_get_user_profile": {"account_id": "bot-123"},
            "jira_get_issue": {"fields": {"labels": []}},
            "jira_get_sprints_from_board": {"sprints": [{"id": 12345}]},
        }

        mock_jira_call.side_effect = lambda tool_name, args: jira_responses.get(tool_name, {})

        # Mock memory server HTTP call
        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response

        result = execute_claim_ticket_workflow(
            jira_key="RHCLOUD-12345",
            memory_url="https://test-memory.example.com",
            skip_operations=["get_transitions", "assign_ticket", "transition_to_in_progress", "add_to_sprint"],
        )

        assert result.success is True
        skipped = [op for op in result.operations if op.status == OperationStatus.SKIPPED]
        assert len(skipped) == 4

"""Shared test fixtures and utilities."""

from unittest.mock import Mock, patch

import pytest

# Test constants
TEST_JIRA_KEY = "RHCLOUD-12345"
TEST_BOT_ACCOUNT_ID = "bot-123"
TEST_BOT_EMAIL = "bot@example.com"
TEST_MEMORY_URL = "https://test-memory.example.com"
TEST_SPRINT_ID = 12345
TEST_SPRINT_NAME = "Sprint 42"
TEST_TRANSITION_ID = "21"
TEST_BOARD_ID = "9297"


@pytest.fixture(autouse=True)
def set_bot_jira_email(monkeypatch):
    """Set BOT_JIRA_EMAIL for all tests."""
    monkeypatch.setenv("BOT_JIRA_EMAIL", TEST_BOT_EMAIL)


@pytest.fixture
def mock_memory_server():
    """Mock httpx Client for memory server HTTP calls."""
    with patch("scripts.claim_ticket_operations.httpx.Client") as mock_client_class:
        mock_client = Mock()
        mock_client_class.return_value.__enter__.return_value = mock_client
        mock_response = Mock()
        mock_response.raise_for_status = Mock()
        mock_client.post.return_value = mock_response
        yield mock_client


@pytest.fixture
def successful_jira_responses():
    """Standard JIRA responses for successful workflow."""
    return {
        "jira_get_user_profile": {"account_id": TEST_BOT_ACCOUNT_ID},
        "jira_get_transitions": {"transitions": [{"id": TEST_TRANSITION_ID, "name": "In Progress"}]},
        "jira_update_issue": {},
        "jira_transition_issue": {},
        "jira_get_agile_boards": {"values": [{"id": int(TEST_BOARD_ID), "name": "Test Board"}]},
        "jira_get_sprints_from_board": {"sprints": [{"id": TEST_SPRINT_ID, "name": TEST_SPRINT_NAME}]},
        "jira_add_issues_to_sprint": {},
    }

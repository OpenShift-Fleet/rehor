"""Tests for claim_onboarding — focused on the transitions response format bug."""

import sys
from pathlib import Path
from unittest.mock import patch

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_DIR))
sys.path.insert(0, str(SKILL_DIR.parent))

from claim_onboarding import _transition_in_progress

TRANSITIONS_LIST = [
    {"id": "11", "name": "To Do"},
    {"id": "41", "name": "In Progress"},
    {"id": "51", "name": "Done"},
]


class TestTransitionInProgress:
    @patch("claim_onboarding.jira_call")
    def test_handles_list_response(self, mock_jira):
        """MCP returns transitions as a plain list — the format that caused the bug."""
        mock_jira.side_effect = [
            TRANSITIONS_LIST,
            {"key": "RHCLOUD-100"},
        ]
        assert _transition_in_progress("RHCLOUD-100") is True
        assert mock_jira.call_count == 2
        transition_call = mock_jira.call_args_list[1]
        assert transition_call[0][1]["transition_id"] == "41"

    @patch("claim_onboarding.jira_call")
    def test_handles_dict_response(self, mock_jira):
        """Also handles the wrapped dict format for forward compatibility."""
        mock_jira.side_effect = [
            {"transitions": TRANSITIONS_LIST},
            {"key": "RHCLOUD-100"},
        ]
        assert _transition_in_progress("RHCLOUD-100") is True
        transition_call = mock_jira.call_args_list[1]
        assert transition_call[0][1]["transition_id"] == "41"

    @patch("claim_onboarding.jira_call")
    def test_returns_false_when_no_matching_transition(self, mock_jira):
        mock_jira.return_value = [
            {"id": "11", "name": "To Do"},
            {"id": "51", "name": "Done"},
        ]
        assert _transition_in_progress("RHCLOUD-100") is False

    @patch("claim_onboarding.jira_call")
    def test_returns_false_on_none(self, mock_jira):
        mock_jira.return_value = None
        assert _transition_in_progress("RHCLOUD-100") is False

    @patch("claim_onboarding.jira_call")
    def test_matches_start_progress_variant(self, mock_jira):
        mock_jira.side_effect = [
            [{"id": "21", "name": "Start Progress"}],
            {"key": "RHCLOUD-100"},
        ]
        assert _transition_in_progress("RHCLOUD-100") is True
        transition_call = mock_jira.call_args_list[1]
        assert transition_call[0][1]["transition_id"] == "21"

"""Tests for create_phase_tickets — issue type detection and hierarchy."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_DIR))
sys.path.insert(0, str(SKILL_DIR.parent))

from create_phase_tickets import PHASES, create_tickets


def _mock_story_parent(tool_name, arguments):
    if tool_name == "jira_get_issue":
        return {"issue_type": {"name": "Story"}}
    if tool_name == "jira_create_issue":
        summary = arguments.get("summary", "")
        for i, phase in enumerate(PHASES):
            if phase["summary"] in summary:
                return {"message": "Issue created", "issue": {"key": f"RHCLOUD-10{i}"}}
        return {"message": "Issue created", "issue": {"key": "RHCLOUD-999"}}
    return None


def _mock_epic_parent(tool_name, arguments):
    if tool_name == "jira_get_issue":
        return {"issue_type": {"name": "Epic"}}
    if tool_name == "jira_create_issue":
        summary = arguments.get("summary", "")
        for i, phase in enumerate(PHASES):
            if phase["summary"] in summary:
                return {"message": "Issue created", "issue": {"key": f"RHCLOUD-10{i}"}}
        return {"message": "Issue created", "issue": {"key": "RHCLOUD-999"}}
    return None


def _mock_unknown_parent(tool_name, arguments):
    if tool_name == "jira_get_issue":
        return None
    if tool_name == "jira_create_issue":
        return {"message": "Issue created", "issue": {"key": "RHCLOUD-100"}}
    return None


class TestCreateTickets:
    @patch("create_phase_tickets.jira_call")
    def test_story_parent_creates_subtasks(self, mock_jira):
        """Story parent -> Sub-task children with parent linkage."""
        mock_jira.side_effect = _mock_story_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        for call in create_calls:
            args = call[0][1]
            assert args["issue_type"] == "Sub-task"
            additional = json.loads(args["additional_fields"])
            assert additional["parent"] == "RHCLOUD-100"
            assert "epicKey" not in additional

    @patch("create_phase_tickets.jira_call")
    def test_epic_parent_creates_stories(self, mock_jira):
        """Epic parent -> Story children with epicKey linkage."""
        mock_jira.side_effect = _mock_epic_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        for call in create_calls:
            args = call[0][1]
            assert args["issue_type"] == "Story"
            additional = json.loads(args["additional_fields"])
            assert additional["epicKey"] == "RHCLOUD-100"
            assert "parent" not in additional

    @patch("create_phase_tickets.jira_call")
    def test_unknown_parent_falls_back_to_subtask(self, mock_jira):
        """If parent type can't be determined, default to Sub-task."""
        mock_jira.side_effect = _mock_unknown_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        for call in create_calls:
            assert call[0][1]["issue_type"] == "Sub-task"

    @patch("create_phase_tickets.jira_call")
    def test_creates_three_phases(self, mock_jira):
        mock_jira.side_effect = _mock_story_parent
        result = create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        assert len(create_calls) == 3
        assert "phase1" in result
        assert "phase2" in result
        assert "phase3" in result

    @patch("create_phase_tickets.jira_call")
    def test_includes_team_name_in_summary(self, mock_jira):
        mock_jira.side_effect = _mock_story_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Acme Corp")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        for call in create_calls:
            assert "Acme Corp" in call[0][1]["summary"]

    @patch("create_phase_tickets.jira_call")
    def test_returns_none_on_failure(self, mock_jira):
        def fail_on_create(tool_name, arguments):
            if tool_name == "jira_get_issue":
                return {"fields": {"issuetype": {"name": "Story"}}}
            return None

        mock_jira.side_effect = fail_on_create
        result = create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")
        assert result is None

    @patch("create_phase_tickets.jira_call")
    def test_phase_summaries(self, mock_jira):
        mock_jira.side_effect = _mock_story_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        summaries = [call[0][1]["summary"] for call in create_calls]
        assert "[Phase 1] Instance Setup" in summaries[0]
        assert "[Phase 2] Konflux CI/CD" in summaries[1]
        assert "[Phase 3] Deployment" in summaries[2]

    @patch("create_phase_tickets.jira_call")
    def test_descriptions_are_set(self, mock_jira):
        """Each phase ticket gets a non-empty description."""
        mock_jira.side_effect = _mock_story_parent
        create_tickets("RHCLOUD-100", "RHCLOUD", "Test Team")

        create_calls = [c for c in mock_jira.call_args_list if c[0][0] == "jira_create_issue"]
        assert len(create_calls) == 3
        for call in create_calls:
            desc = call[0][1].get("description", "")
            assert desc, "Phase ticket should have a description"
            assert "Done when:" in desc

"""Tests for onboarding_helpers — label logic, workflow field validation."""

import json
from unittest.mock import patch

from onboarding_helpers import (
    BLOCKED_LABEL,
    WORKFLOW_REQUIRED_FIELDS,
    get_missing_workflow_fields,
    sanitize_for_markdown,
    update_task_metadata,
)


class TestGetMissingWorkflowFields:
    def test_sprint_missing_board_name(self):
        missing = get_missing_workflow_fields("jira-sprint", {})
        assert "board_name" in missing

    def test_sprint_has_board_name(self):
        missing = get_missing_workflow_fields("jira-sprint", {"board_name": "My Board"})
        assert missing == []

    def test_kanban_missing_board_name(self):
        missing = get_missing_workflow_fields("jira-kanban", {})
        assert "board_name" in missing

    def test_kanban_has_board_name(self):
        missing = get_missing_workflow_fields("jira-kanban", {"board_name": "123"})
        assert missing == []

    def test_unknown_workflow_no_requirements(self):
        missing = get_missing_workflow_fields("onboarding", {})
        assert missing == []

    def test_sprint_optional_not_required(self):
        missing = get_missing_workflow_fields("jira-sprint", {"board_name": "X"})
        assert "sprint_prefix" not in missing

    def test_both_workflows_require_board_name(self):
        for wf in WORKFLOW_REQUIRED_FIELDS:
            assert "board_name" in WORKFLOW_REQUIRED_FIELDS[wf]["required"]


class TestApplyLabelPreservesBlocked:
    """Test that apply_label preserves onboarding:blocked when applying step labels."""

    @patch("onboarding_helpers.jira_call")
    def test_preserves_blocked_label(self, mock_jira):
        mock_jira.side_effect = [
            {"labels": ["onboarding:intake", BLOCKED_LABEL, "other-label"]},
            {},
        ]
        from onboarding_helpers import apply_label

        apply_label("TEST-1", "onboarding:requirements-gathering")

        update_call = mock_jira.call_args_list[1]
        updated_labels = json.loads(update_call[0][1]["fields"])["labels"]
        assert BLOCKED_LABEL in updated_labels
        assert "onboarding:requirements-gathering" in updated_labels
        assert "onboarding:intake" not in updated_labels
        assert "other-label" in updated_labels

    @patch("onboarding_helpers.jira_call")
    def test_step_label_replaces_previous_step(self, mock_jira):
        mock_jira.side_effect = [
            {"labels": ["onboarding:intake"]},
            {},
        ]
        from onboarding_helpers import apply_label

        apply_label("TEST-1", "onboarding:requirements-gathering")

        update_call = mock_jira.call_args_list[1]
        updated_labels = json.loads(update_call[0][1]["fields"])["labels"]
        assert "onboarding:requirements-gathering" in updated_labels
        assert "onboarding:intake" not in updated_labels

    @patch("onboarding_helpers.jira_call")
    def test_no_blocked_label_not_added(self, mock_jira):
        mock_jira.side_effect = [
            {"labels": ["onboarding:intake", "unrelated"]},
            {},
        ]
        from onboarding_helpers import apply_label

        apply_label("TEST-1", "onboarding:plan-posted")

        update_call = mock_jira.call_args_list[1]
        updated_labels = json.loads(update_call[0][1]["fields"])["labels"]
        assert BLOCKED_LABEL not in updated_labels


class TestApplyBlockedLabel:
    @patch("onboarding_helpers.jira_call")
    def test_adds_blocked_without_removing_step(self, mock_jira):
        mock_jira.side_effect = [
            {"labels": ["onboarding:intake", "other"]},
            {},
        ]
        from onboarding_helpers import apply_blocked_label

        apply_blocked_label("TEST-1")

        update_call = mock_jira.call_args_list[1]
        updated_labels = json.loads(update_call[0][1]["fields"])["labels"]
        assert BLOCKED_LABEL in updated_labels
        assert "onboarding:intake" in updated_labels
        assert "other" in updated_labels

    @patch("onboarding_helpers.jira_call")
    def test_idempotent_if_already_blocked(self, mock_jira):
        mock_jira.return_value = {"labels": [BLOCKED_LABEL, "onboarding:intake"]}
        from onboarding_helpers import apply_blocked_label

        result = apply_blocked_label("TEST-1")

        assert result is True
        assert mock_jira.call_count == 1


class TestRemoveBlockedLabel:
    @patch("onboarding_helpers.jira_call")
    def test_removes_blocked_keeps_step(self, mock_jira):
        mock_jira.side_effect = [
            {"labels": ["onboarding:intake", BLOCKED_LABEL, "other"]},
            {},
        ]
        from onboarding_helpers import remove_blocked_label

        remove_blocked_label("TEST-1")

        update_call = mock_jira.call_args_list[1]
        updated_labels = json.loads(update_call[0][1]["fields"])["labels"]
        assert BLOCKED_LABEL not in updated_labels
        assert "onboarding:intake" in updated_labels
        assert "other" in updated_labels

    @patch("onboarding_helpers.jira_call")
    def test_idempotent_if_not_blocked(self, mock_jira):
        mock_jira.return_value = {"labels": ["onboarding:intake"]}
        from onboarding_helpers import remove_blocked_label

        result = remove_blocked_label("TEST-1")

        assert result is True
        assert mock_jira.call_count == 1


class TestSanitizeForMarkdown:
    def test_strips_newlines(self):
        assert sanitize_for_markdown("line1\nline2") == "line1 line2"

    def test_strips_carriage_returns(self):
        assert sanitize_for_markdown("line1\r\nline2") == "line1 line2"

    def test_passes_through_clean_string(self):
        assert sanitize_for_markdown("hello world") == "hello world"

    def test_converts_non_string_to_string(self):
        assert sanitize_for_markdown(123) == "123"

    def test_strips_multiple_newlines(self):
        assert sanitize_for_markdown("a\nb\nc") == "a b c"


class TestUpdateTaskMetadata:
    @patch("httpx.Client")
    def test_deep_merges_nested_dicts(self, mock_client_cls):
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.get.return_value.status_code = 200
        mock_client.get.return_value.json.return_value = {
            "metadata": {"requirements": {"team_name": "Acme", "repo_url": "https://example.com"}, "phase": 1}
        }
        mock_client.patch.return_value.status_code = 200

        update_task_metadata("http://memory", "task-1", {"requirements": {"team_name": "New Name"}})

        patched = mock_client.patch.call_args[1]["json"]["metadata"]
        assert patched["requirements"]["team_name"] == "New Name"
        assert patched["requirements"]["repo_url"] == "https://example.com"
        assert patched["phase"] == 1

    @patch("httpx.Client")
    def test_replaces_non_dict_values(self, mock_client_cls):
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.get.return_value.status_code = 200
        mock_client.get.return_value.json.return_value = {"metadata": {"phase": 1, "prs": []}}
        mock_client.patch.return_value.status_code = 200

        update_task_metadata("http://memory", "task-1", {"phase": 2, "prs": [{"repo": "r", "number": 1}]})

        patched = mock_client.patch.call_args[1]["json"]["metadata"]
        assert patched["phase"] == 2
        assert patched["prs"] == [{"repo": "r", "number": 1}]

    @patch("httpx.Client")
    def test_adds_new_keys(self, mock_client_cls):
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.get.return_value.status_code = 200
        mock_client.get.return_value.json.return_value = {"metadata": {"phase": 1}}
        mock_client.patch.return_value.status_code = 200

        update_task_metadata("http://memory", "task-1", {"deployment": {"gcp_project_id": "proj-1"}})

        patched = mock_client.patch.call_args[1]["json"]["metadata"]
        assert patched["deployment"] == {"gcp_project_id": "proj-1"}
        assert patched["phase"] == 1

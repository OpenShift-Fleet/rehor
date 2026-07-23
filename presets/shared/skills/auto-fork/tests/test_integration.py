"""Integration tests for auto-fork workflow."""

import json
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from auto_fork import AutoForkOperations, OperationStatus


@pytest.fixture
def integration_operations(temp_config_dir, monkeypatch):
    """Create AutoForkOperations for integration testing."""
    monkeypatch.chdir(temp_config_dir.parent)
    ops = AutoForkOperations(dry_run=False)
    ops.config_dir = temp_config_dir
    ops.agent_dir = temp_config_dir / "agent"
    ops.project_repos_path = ops.agent_dir / "project-repos.json"
    return ops


class TestEndToEndWorkflow:
    """Test complete end-to-end workflows."""

    @patch("auto_fork.subprocess.run")
    def test_full_workflow_success(self, mock_run, integration_operations):
        """Test successful complete workflow with mocked subprocess."""

        # Mock all subprocess calls
        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stderr = ""

            # Handle different commands
            if cmd[0] == "gh" and "fork" in cmd:
                result.stdout = ""
            elif cmd[0] == "git" and "symbolic-ref" in cmd:
                result.stdout = "refs/remotes/origin/master"
            else:
                result.stdout = ""

            return result

        mock_run.side_effect = mock_run_side_effect

        # Mock push-and-pr workflow
        with patch("auto_fork.execute_push_and_pr_workflow", return_value=0):
            results = integration_operations.execute_workflow()

        # Verify all operations succeeded
        assert len(results) == 4
        assert results[0].operation == "detect_unforkable_repos"
        assert results[0].status == OperationStatus.SUCCESS
        assert results[1].operation == "fork_repos"
        assert results[1].status == OperationStatus.SUCCESS
        assert results[2].operation == "update_and_commit"
        assert results[2].status == OperationStatus.SUCCESS
        assert results[3].operation == "push_and_create_pr"
        assert results[3].status == OperationStatus.SUCCESS

        # Verify repos were forked (includes GitLab repo now)
        assert len(integration_operations.forked_repos) == 2
        assert "test-repo-2" in integration_operations.forked_repos
        assert "gitlab-repo" in integration_operations.forked_repos

        # Verify config was updated
        with open(integration_operations.project_repos_path) as f:
            repos = json.load(f)
        assert integration_operations.bot_username in repos["test-repo-2"]["url"]

    @patch("auto_fork.subprocess.run")
    def test_workflow_with_multiple_repos(self, mock_run, integration_operations, temp_config_dir):
        """Test workflow with multiple repos needing forks."""
        # Add more repos to config
        with open(integration_operations.project_repos_path) as f:
            repos = json.load(f)

        repos["test-repo-3"] = {
            "url": "https://github.com/other-user/test-repo-3.git",
            "upstream": "https://github.com/TestOrg/test-repo-3.git",
        }
        repos["test-repo-4"] = {
            "url": "https://github.com/other-user/test-repo-4.git",
            "upstream": "https://github.com/TestOrg/test-repo-4.git",
        }

        with open(integration_operations.project_repos_path, "w") as f:
            json.dump(repos, f)

        # Mock subprocess
        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stderr = ""
            if "symbolic-ref" in cmd:
                result.stdout = "refs/remotes/origin/master"
            else:
                result.stdout = ""
            return result

        mock_run.side_effect = mock_run_side_effect

        integration_operations.execute_workflow()

        # Verify multiple repos were forked (includes GitLab repo)
        assert len(integration_operations.forked_repos) == 4
        assert "test-repo-2" in integration_operations.forked_repos
        assert "test-repo-3" in integration_operations.forked_repos
        assert "test-repo-4" in integration_operations.forked_repos
        assert "gitlab-repo" in integration_operations.forked_repos

    @patch("auto_fork.subprocess.run")
    def test_workflow_handles_existing_forks(self, mock_run, integration_operations):
        """Test workflow handles repos that already have forks."""

        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()

            # Both gh and glab repo fork fail for existing forks
            if (cmd[0] == "gh" or cmd[0] == "glab") and "fork" in cmd:
                result.returncode = 1
                result.stderr = "repository already exists"
            elif "symbolic-ref" in cmd:
                result.returncode = 0
                result.stdout = "refs/remotes/origin/master"
            else:
                result.returncode = 0
                result.stderr = ""
                result.stdout = ""

            return result

        mock_run.side_effect = mock_run_side_effect

        results = integration_operations.execute_workflow()

        # Should still succeed (both GitHub and GitLab repos)
        assert results[1].status == OperationStatus.SUCCESS
        assert len(integration_operations.forked_repos) == 2

    @patch("auto_fork.subprocess.run")
    def test_workflow_partial_failure(self, mock_run, integration_operations, temp_config_dir):
        """Test workflow when some forks fail."""
        # Add multiple repos
        with open(integration_operations.project_repos_path) as f:
            repos = json.load(f)
        repos["test-repo-3"] = {
            "url": "https://github.com/other-user/test-repo-3.git",
            "upstream": "https://github.com/TestOrg/test-repo-3.git",
        }
        with open(integration_operations.project_repos_path, "w") as f:
            json.dump(repos, f)

        call_count = 0

        def mock_run_side_effect(cmd, *args, **kwargs):
            nonlocal call_count
            result = Mock()

            if cmd[0] == "gh" and "fork" in cmd:
                call_count += 1
                if call_count == 1:
                    # First fork succeeds
                    result.returncode = 0
                    result.stderr = ""
                else:
                    # Second fork fails
                    result.returncode = 1
                    result.stderr = "permission denied"
            else:
                result.returncode = 0
                result.stderr = ""
                result.stdout = ""

            return result

        mock_run.side_effect = mock_run_side_effect

        results = integration_operations.execute_workflow()

        # Fork operation should fail
        assert results[1].status == OperationStatus.FAILED
        # Workflow stops after failure
        assert len(results) == 2


class TestConfigFileHandling:
    """Test proper handling of config files."""

    @patch("auto_fork.subprocess.run")
    def test_preserves_other_repos(self, mock_run, integration_operations):
        """Test that repos not being forked are preserved unchanged."""
        original_repos = None
        with open(integration_operations.project_repos_path) as f:
            original_repos = json.load(f)

        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stderr = ""
            result.stdout = "refs/remotes/origin/master" if "symbolic-ref" in cmd else ""
            return result

        mock_run.side_effect = mock_run_side_effect

        integration_operations.execute_workflow()

        # Check that unchanged repos remain unchanged
        with open(integration_operations.project_repos_path) as f:
            updated_repos = json.load(f)

        # test-repo-1 already has a fork, so should be unchanged
        assert updated_repos["test-repo-1"] == original_repos["test-repo-1"]
        # gitlab-repo is now forked, so it should be updated
        assert updated_repos["gitlab-repo"]["url"] != original_repos["gitlab-repo"]["url"]

    @patch("auto_fork.subprocess.run")
    def test_json_formatting(self, mock_run, integration_operations):
        """Test that JSON formatting is preserved."""

        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stderr = ""
            result.stdout = "refs/remotes/origin/master" if "symbolic-ref" in cmd else ""
            return result

        mock_run.side_effect = mock_run_side_effect

        integration_operations.execute_workflow()

        # Verify JSON is properly formatted
        content = integration_operations.project_repos_path.read_text()
        assert content.endswith("\n")  # Trailing newline
        parsed = json.loads(content)
        assert parsed  # Valid JSON


class TestDryRunMode:
    """Test dry run mode for integration."""

    def test_dry_run_no_side_effects(self, integration_operations):
        """Test dry run makes no actual changes."""
        integration_operations.dry_run = True

        original_config = integration_operations.project_repos_path.read_text()

        # Mock push-and-pr workflow
        with patch("auto_fork.execute_push_and_pr_workflow", return_value=0):
            results = integration_operations.execute_workflow()

        # Verify no changes to config
        updated_config = integration_operations.project_repos_path.read_text()
        assert original_config == updated_config

        # Verify operations report success
        assert all(r.status in (OperationStatus.SUCCESS, OperationStatus.SKIPPED) for r in results)

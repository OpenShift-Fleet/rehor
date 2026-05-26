"""Unit tests for auto-fork operations."""

import json
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from auto_fork import (
    AutoForkOperations,
    OperationStatus,
    RepoInfo,
)


@pytest.fixture
def operations(temp_config_dir, monkeypatch):
    """Create AutoForkOperations instance for testing."""
    monkeypatch.chdir(temp_config_dir.parent)
    ops = AutoForkOperations(dry_run=False)
    ops.config_dir = temp_config_dir
    ops.agent_dir = temp_config_dir / "agent"
    ops.project_repos_path = ops.agent_dir / "project-repos.json"
    return ops


class TestDetectUnforkableRepos:
    """Test detect_unforkable_repos operation."""

    def test_detect_success(self, operations):
        """Test successful repo detection."""
        result = operations.detect_unforkable_repos()

        assert result.status == OperationStatus.SUCCESS
        assert "test-repo-2" in result.details["repos"]
        assert "test-repo-1" not in result.details["repos"]  # Already has fork
        assert len(operations.repos_to_fork) == 1
        assert operations.repos_to_fork[0].name == "test-repo-2"

    def test_detect_skips_gitlab(self, operations):
        """Test GitLab repos are skipped."""
        result = operations.detect_unforkable_repos()

        assert result.status == OperationStatus.SUCCESS
        gitlab_repos = [r for r in operations.repos_to_fork if r.host == "gitlab"]
        assert len(gitlab_repos) == 0

    def test_detect_missing_username(self, monkeypatch):
        """Test failure when BOT_GITHUB_USERNAME not set."""
        monkeypatch.delenv("BOT_GITHUB_USERNAME", raising=False)

        with pytest.raises(ValueError, match="BOT_GITHUB_USERNAME"):
            AutoForkOperations()

    def test_detect_missing_config_file(self, operations, tmp_path):
        """Test failure when project-repos.json missing."""
        operations.project_repos_path = tmp_path / "nonexistent.json"

        result = operations.detect_unforkable_repos()

        assert result.status == OperationStatus.FAILED
        assert "not found" in result.message

    def test_detect_no_repos_need_forking(self, operations):
        """Test when all repos already forked."""
        # Update config so all repos already have forks
        with open(operations.project_repos_path) as f:
            repos = json.load(f)
        repos["test-repo-2"]["url"] = f"https://github.com/{operations.bot_username}/test-repo-2.git"
        with open(operations.project_repos_path, "w") as f:
            json.dump(repos, f)

        result = operations.detect_unforkable_repos()

        assert result.status == OperationStatus.SKIPPED
        assert "No repos need forking" in result.message


class TestForkRepos:
    """Test fork_repos operation."""

    @patch("auto_fork.subprocess.run")
    def test_fork_success(self, mock_run, operations, mock_subprocess_result):
        """Test successful repo forking."""
        operations.repos_to_fork = [
            RepoInfo(
                name="test-repo",
                upstream="https://github.com/TestOrg/test-repo.git",
                current_url=None,
                host="github",
            )
        ]

        mock_run.return_value = mock_subprocess_result()

        result = operations.fork_repos()

        assert result.status == OperationStatus.SUCCESS
        assert "test-repo" in operations.forked_repos
        assert operations.forked_repos["test-repo"] == f"https://github.com/{operations.bot_username}/test-repo.git"
        mock_run.assert_called_once()

    @patch("auto_fork.subprocess.run")
    def test_fork_already_exists(self, mock_run, operations, mock_subprocess_result):
        """Test forking when fork already exists."""
        operations.repos_to_fork = [
            RepoInfo(
                name="existing-repo",
                upstream="https://github.com/TestOrg/existing-repo.git",
                current_url=None,
                host="github",
            )
        ]

        mock_run.return_value = mock_subprocess_result(returncode=1, stderr="repository already exists")

        result = operations.fork_repos()

        assert result.status == OperationStatus.SUCCESS
        assert "existing-repo" in operations.forked_repos

    @patch("auto_fork.subprocess.run")
    def test_fork_failure(self, mock_run, operations, mock_subprocess_result):
        """Test fork failure."""
        operations.repos_to_fork = [
            RepoInfo(
                name="fail-repo",
                upstream="https://github.com/TestOrg/fail-repo.git",
                current_url=None,
                host="github",
            )
        ]

        mock_run.return_value = mock_subprocess_result(returncode=1, stderr="permission denied")

        result = operations.fork_repos()

        assert result.status == OperationStatus.FAILED
        assert "fail-repo" in result.details["failed"]

    def test_fork_no_repos(self, operations):
        """Test when no repos to fork."""
        operations.repos_to_fork = []

        result = operations.fork_repos()

        assert result.status == OperationStatus.SKIPPED
        assert "No repos to fork" in result.message

    def test_fork_dry_run(self, operations):
        """Test dry run mode."""
        operations.dry_run = True
        operations.repos_to_fork = [
            RepoInfo(
                name="test-repo",
                upstream="https://github.com/TestOrg/test-repo.git",
                current_url=None,
                host="github",
            )
        ]

        result = operations.fork_repos()

        assert result.status == OperationStatus.SUCCESS
        assert "test-repo" in operations.forked_repos


class TestUpdateAndCommit:
    """Test update_and_commit operation."""

    @patch("auto_fork.subprocess.run")
    def test_update_success(self, mock_run, operations):
        """Test successful config update and commit."""
        operations.forked_repos = {"test-repo-2": f"https://github.com/{operations.bot_username}/test-repo-2.git"}

        # Mock git commands
        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stdout = "refs/remotes/origin/master"
            result.stderr = ""
            return result

        mock_run.side_effect = mock_run_side_effect

        result = operations.update_and_commit()

        assert result.status == OperationStatus.SUCCESS
        assert "test-repo-2" in result.details["updates"]

        # Verify config was updated
        with open(operations.project_repos_path) as f:
            repos = json.load(f)
        assert repos["test-repo-2"]["url"] == f"https://github.com/{operations.bot_username}/test-repo-2.git"

    def test_update_no_forks(self, operations):
        """Test when no forks to update."""
        operations.forked_repos = {}

        result = operations.update_and_commit()

        assert result.status == OperationStatus.SKIPPED
        assert "No forks to update" in result.message

    def test_update_dry_run(self, operations):
        """Test dry run mode."""
        operations.dry_run = True
        operations.forked_repos = {"test-repo": f"https://github.com/{operations.bot_username}/test-repo.git"}

        result = operations.update_and_commit()

        assert result.status == OperationStatus.SUCCESS
        assert "dry run" in result.message.lower()


class TestExecuteWorkflow:
    """Test complete workflow execution."""

    @patch("auto_fork.subprocess.run")
    def test_workflow_success(self, mock_run, operations):
        """Test successful end-to-end workflow."""

        # Mock subprocess for git and gh commands
        def mock_run_side_effect(cmd, *args, **kwargs):
            result = Mock()
            result.returncode = 0
            result.stdout = "refs/remotes/origin/master"
            result.stderr = ""
            return result

        mock_run.side_effect = mock_run_side_effect

        results = operations.execute_workflow()

        assert len(results) >= 2  # At least detect and fork
        assert results[0].operation == "detect_unforkable_repos"
        assert results[0].status == OperationStatus.SUCCESS

    def test_workflow_stops_on_failure(self, operations):
        """Test workflow stops on first failure."""
        operations.project_repos_path = Path("/nonexistent/path.json")

        results = operations.execute_workflow()

        assert len(results) == 1
        assert results[0].status == OperationStatus.FAILED

    def test_workflow_dry_run(self, operations):
        """Test workflow in dry run mode."""
        operations.dry_run = True

        results = operations.execute_workflow()

        # Should complete all steps in dry run
        assert all(r.status in (OperationStatus.SUCCESS, OperationStatus.SKIPPED) for r in results)

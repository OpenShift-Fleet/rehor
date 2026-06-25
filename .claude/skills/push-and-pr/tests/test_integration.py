"""Integration tests for push-and-pr workflow."""

import json
import tempfile
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import pytest
from scripts.push_and_pr_operations import execute_push_and_pr_workflow


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def github_fork_setup(temp_dir):
    """Setup for GitHub fork workflow."""
    # Create project-repos.json
    config_file = temp_dir / "project-repos.json"
    config_data = {
        "test-repo": {
            "type": "github",
            "upstream": "RedHatInsights/test-repo",
            "fork": "catastrophe-brandon/test-repo",
        }
    }
    with open(config_file, "w") as f:
        json.dump(config_data, f)

    return temp_dir


class TestGitHubForkWorkflow:
    """Test complete GitHub fork workflow."""

    @patch("scripts.push_and_pr_operations.Path.cwd")
    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_github_fork_workflow_success(self, mock_run, mock_cwd, github_fork_setup):
        """Test successful GitHub fork workflow (all 4 operations)."""
        mock_cwd.return_value = github_fork_setup / "test-repo"

        # Mock command responses in order
        mock_run.side_effect = [
            # detect_repository: get current branch
            CompletedProcess([], 0, stdout="feature-branch\n", stderr=""),
            # sync_fork: gh repo sync
            CompletedProcess([], 0, stdout="Synced successfully\n", stderr=""),
            # push_branch: git push
            CompletedProcess([], 0, stdout="Pushed to origin\n", stderr=""),
            # create_pr: gh pr create
            CompletedProcess([], 0, stdout="https://github.com/RedHatInsights/test-repo/pull/123\n", stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test PR", body="Test description", dry_run=False)

        assert exit_code == 0
        assert mock_run.call_count == 4

        # Verify command sequence
        calls = mock_run.call_args_list
        assert calls[0][0][0] == ["git", "rev-parse", "--abbrev-ref", "HEAD"]
        assert calls[1][0][0] == ["gh", "repo", "sync", "catastrophe-brandon/test-repo"]
        assert calls[2][0][0][0:3] == ["git", "-c", "credential.helper=!gh auth git-credential"]
        assert calls[3][0][0][0:2] == ["gh", "pr"]

    @patch("scripts.push_and_pr_operations.Path.cwd")
    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_github_fork_workflow_already_synced(self, mock_run, mock_cwd, github_fork_setup):
        """Test GitHub fork workflow when fork is already up-to-date."""
        mock_cwd.return_value = github_fork_setup / "test-repo"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 1, stdout="", stderr="already up-to-date"),  # sync already done
            CompletedProcess([], 0, stdout="", stderr="Everything up-to-date"),  # push already done
            CompletedProcess([], 0, stdout="https://github.com/RedHatInsights/test-repo/pull/456\n", stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Update docs", body="Minor update", dry_run=False)

        assert exit_code == 0

    @patch("scripts.push_and_pr_operations.Path.cwd")
    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_github_fork_workflow_with_special_chars(self, mock_run, mock_cwd, github_fork_setup):
        """Test GitHub fork workflow with special characters in PR title/body."""
        mock_cwd.return_value = github_fork_setup / "test-repo"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="fix-bug\n", stderr=""),
            CompletedProcess([], 0, stdout="Synced\n", stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout="https://github.com/RedHatInsights/test-repo/pull/789\n", stderr=""),
        ]

        title = 'Fix "quoted" issue & <tags>'
        body = "Description with\\nspecial chars"

        exit_code = execute_push_and_pr_workflow(title=title, body=body, dry_run=False)

        assert exit_code == 0

        # Verify title and body were passed to gh pr create
        pr_create_call = mock_run.call_args_list[3]
        assert title in pr_create_call[0][0]
        assert body in pr_create_call[0][0]


class TestGitHubDirectWorkflow:
    """Test complete GitHub direct push workflow."""

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_github_direct_workflow_success(self, mock_run):
        """Test successful GitHub direct push workflow."""
        # Mock git remote output for direct push (no upstream)
        remote_output = (
            "origin\thttps://github.com/RedHatInsights/test-repo.git (fetch)\n"
            "origin\thttps://github.com/RedHatInsights/test-repo.git (push)\n"
        )

        mock_run.side_effect = [
            # detect_repository: get current branch
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            # detect_repository: get remotes
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            # sync_fork: skipped (not a fork)
            # push_branch: git push
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            # create_pr: gh pr create (direct)
            CompletedProcess([], 0, stdout="https://github.com/RedHatInsights/test-repo/pull/100\n", stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Direct PR", body="Direct push", dry_run=False)

        assert exit_code == 0
        assert mock_run.call_count == 4

        # Verify gh pr create for direct push (no --repo, no --head)
        pr_create_call = mock_run.call_args_list[3]
        cmd = pr_create_call[0][0]
        assert cmd[0:2] == ["gh", "pr"]
        assert "--repo" not in cmd
        assert "--head" not in cmd
        assert "--title" in cmd
        assert "--body" in cmd

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_github_direct_workflow_ssh_url(self, mock_run):
        """Test GitHub direct workflow with SSH remote URL."""
        remote_output = (
            "origin\tgit@github.com:org/project.git (fetch)\norigin\tgit@github.com:org/project.git (push)\n"
        )

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="develop\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout="https://github.com/org/project/pull/42\n", stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="SSH test", body="Testing SSH URL", dry_run=False)

        assert exit_code == 0


class TestGitLabWorkflow:
    """Test complete GitLab workflow."""

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_gitlab_workflow_success(self, mock_run):
        """Test successful GitLab workflow."""
        remote_output = (
            "origin\thttps://gitlab.cee.redhat.com/user/project.git (fetch)\n"
            "origin\thttps://gitlab.cee.redhat.com/user/project.git (push)\n"
            "upstream\thttps://gitlab.cee.redhat.com/team/project.git (fetch)\n"
            "upstream\thttps://gitlab.cee.redhat.com/team/project.git (push)\n"
        )

        mr_output = "Created merge request\n!123 https://gitlab.cee.redhat.com/team/project/-/merge_requests/123\n"

        mock_run.side_effect = [
            # detect_repository: get current branch
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            # detect_repository: get remotes
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            # sync_fork: glab repo sync
            CompletedProcess([], 0, stdout="Synced\n", stderr=""),
            # push_branch: git push with glab credential helper
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            # create_pr: glab mr create
            CompletedProcess([], 0, stdout=mr_output, stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="GitLab MR", body="Test MR", dry_run=False)

        assert exit_code == 0
        assert mock_run.call_count == 5

        # Verify glab commands were used
        sync_call = mock_run.call_args_list[2]
        assert sync_call[0][0] == ["glab", "repo", "sync"]

        push_call = mock_run.call_args_list[3]
        assert "glab auth git-credential" in push_call[0][0][2]

        mr_create_call = mock_run.call_args_list[4]
        cmd = mr_create_call[0][0]
        assert cmd[0:2] == ["glab", "mr"]
        assert "--hostname" in cmd
        assert "gitlab.cee.redhat.com" in cmd

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_gitlab_workflow_direct_push(self, mock_run):
        """Test GitLab workflow with direct push (no fork)."""
        remote_output = (
            "origin\thttps://gitlab.cee.redhat.com/team/project.git (fetch)\n"
            "origin\thttps://gitlab.cee.redhat.com/team/project.git (push)\n"
        )

        mr_output = "!99 https://gitlab.cee.redhat.com/team/project/-/merge_requests/99"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            # sync skipped for direct push
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout=mr_output, stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Direct MR", body="Direct", dry_run=False)

        assert exit_code == 0


class TestWorkflowErrorHandling:
    """Test error handling and fail-fast behavior."""

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_detect_error(self, mock_run):
        """Test workflow fails fast on detect_repository error."""
        mock_run.side_effect = [
            # detect_repository: failed to get current branch
            CompletedProcess([], 1, stdout="", stderr="not a git repository"),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1
        assert mock_run.call_count == 1  # Stopped after first operation

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_sync_error(self, mock_run):
        """Test workflow fails fast on sync_fork error."""
        remote_output = (
            "origin\tgit@github.com:user/repo.git (fetch)\n"
            "origin\tgit@github.com:user/repo.git (push)\n"
            "upstream\tgit@github.com:org/repo.git (fetch)\n"
            "upstream\tgit@github.com:org/repo.git (push)\n"
        )

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            # sync_fork: failed
            CompletedProcess([], 1, stdout="", stderr="authentication failed"),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1
        assert mock_run.call_count == 3  # Stopped after sync failed

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_push_error(self, mock_run):
        """Test workflow fails fast on push_branch error."""
        remote_output = "origin\thttps://github.com/org/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            # sync skipped (direct push)
            # push_branch: failed
            CompletedProcess([], 1, stdout="", stderr="rejected"),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1
        assert mock_run.call_count == 3  # Stopped after push failed

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_create_pr_error(self, mock_run):
        """Test workflow fails fast on create_pr error."""
        remote_output = "origin\thttps://github.com/org/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            # create_pr: failed
            CompletedProcess([], 1, stdout="", stderr="pull request already exists"),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1
        assert mock_run.call_count == 4  # All operations attempted, last one failed

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_unsupported_remote(self, mock_run):
        """Test workflow fails when remote is unsupported."""
        remote_output = "origin\thttps://bitbucket.org/user/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_fails_on_no_origin(self, mock_run):
        """Test workflow fails when no origin remote exists."""
        remote_output = "upstream\tgit@github.com:org/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 1


class TestDryRunWorkflow:
    """Test dry-run mode for complete workflow."""

    @patch("scripts.push_and_pr_operations.Path.cwd")
    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_dry_run_workflow(self, mock_run, mock_cwd, temp_dir):
        """Test workflow in dry-run mode."""
        mock_cwd.return_value = temp_dir / "test-repo"

        # Create config file
        config_file = temp_dir / "project-repos.json"
        config_data = {"test-repo": {"type": "github", "upstream": "org/repo", "fork": "user/repo"}}
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        # In dry-run mode, _run_command returns empty responses except for branch detection
        # First call is for branch detection, needs to return a branch name
        mock_run.return_value = CompletedProcess([], 0, stdout="main\n", stderr="")

        exit_code = execute_push_and_pr_workflow(title="Dry run test", body="Testing", dry_run=True)

        # Dry run should succeed but not execute actual commands
        assert exit_code == 0
        # Commands are still "called" in dry-run mode but subprocess.run is not executed
        assert mock_run.call_count >= 1

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_dry_run_prints_commands(self, mock_run, capsys):
        """Test dry-run mode prints commands without executing."""
        remote_output = "origin\thttps://github.com/org/repo.git (fetch)\n"

        # First call for branch detection needs to return something
        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="", stderr=""),
            CompletedProcess([], 0, stdout="", stderr=""),
        ]

        execute_push_and_pr_workflow(title="Test", body="Test", dry_run=True)

        # In dry-run mode, commands should be logged/printed
        # (implementation prints "[DRY RUN] Would execute: ..." in _run_command)
        captured = capsys.readouterr()
        # At minimum, we should have success messages
        assert "Detecting repository" in captured.out or "✓" in captured.out


class TestWorkflowOutputs:
    """Test workflow outputs and PR URL extraction."""

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_extracts_pr_url(self, mock_run, capsys):
        """Test workflow extracts and displays PR URL."""
        remote_output = "origin\thttps://github.com/org/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout="https://github.com/org/repo/pull/999\n", stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        assert exit_code == 0

        # Verify PR URL is printed
        captured = capsys.readouterr()
        assert "https://github.com/org/repo/pull/999" in captured.out

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_extracts_mr_number(self, mock_run, capsys):
        """Test workflow extracts GitLab MR number."""
        remote_output = "origin\thttps://gitlab.cee.redhat.com/team/project.git (fetch)\n"

        mr_output = "!555 https://gitlab.cee.redhat.com/team/project/-/merge_requests/555"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="feature\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout=mr_output, stderr=""),
        ]

        exit_code = execute_push_and_pr_workflow(title="MR test", body="Test", dry_run=False)

        assert exit_code == 0

        captured = capsys.readouterr()
        assert "555" in captured.out or "!555" in captured.out


class TestWorkflowProgressMessages:
    """Test workflow progress messages."""

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_prints_progress(self, mock_run, capsys):
        """Test workflow prints progress messages for each operation."""
        remote_output = "origin\thttps://github.com/org/repo.git (fetch)\n"

        mock_run.side_effect = [
            CompletedProcess([], 0, stdout="main\n", stderr=""),
            CompletedProcess([], 0, stdout=remote_output, stderr=""),
            CompletedProcess([], 0, stdout="Pushed\n", stderr=""),
            CompletedProcess([], 0, stdout="https://github.com/org/repo/pull/1\n", stderr=""),
        ]

        execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        captured = capsys.readouterr()

        # Verify progress messages are printed
        assert "[1/4]" in captured.out  # Detect repository
        assert "[2/4]" in captured.out  # Sync fork
        assert "[3/4]" in captured.out  # Push branch
        assert "[4/4]" in captured.out  # Create PR

    @patch("scripts.push_and_pr_operations.PushAndPROperations._run_command")
    def test_workflow_prints_error_on_failure(self, mock_run, capsys):
        """Test workflow prints error message on failure."""
        mock_run.side_effect = [CompletedProcess([], 1, stdout="", stderr="fatal error")]

        execute_push_and_pr_workflow(title="Test", body="Test", dry_run=False)

        captured = capsys.readouterr()
        assert "❌" in captured.out or "failed" in captured.out.lower()

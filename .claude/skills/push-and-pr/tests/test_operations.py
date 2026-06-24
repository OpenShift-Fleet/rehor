"""Unit tests for push-and-pr operations."""

import json
import tempfile
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

import pytest
from scripts.push_and_pr_operations import (
    PR_TEMPLATE_PATHS,
    PushAndPROperations,
    RepositoryConfig,
)


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def operations():
    """Create PushAndPROperations instance."""
    return PushAndPROperations(title="Test PR", body="Test description", dry_run=False)


@pytest.fixture
def dry_run_operations():
    """Create PushAndPROperations instance in dry-run mode."""
    return PushAndPROperations(title="Test PR", body="Test description", dry_run=True)


class TestDetectRepository:
    """Test detect_repository operation."""

    @patch("scripts.push_and_pr_operations.Path.cwd")
    def test_detect_from_config_github_fork(self, mock_cwd, operations, temp_dir):
        """Test detecting GitHub fork from project-repos.json."""
        # Setup test directory
        mock_cwd.return_value = temp_dir / "hcc-ai-assistant"
        config_file = temp_dir / "project-repos.json"

        config_data = {
            "hcc-ai-assistant": {
                "type": "github",
                "upstream": "RedHatInsights/hcc-ai-assistant",
                "fork": "catastrophe-brandon/hcc-ai-assistant",
            }
        }
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="feature-branch\n", stderr="")

            result = operations.detect_repository()

        assert result.success is True
        assert "github" in result.message.lower()
        assert "fork" in result.message.lower()
        assert operations.repo_config.repo_type == "github"
        assert operations.repo_config.is_fork is True
        assert operations.repo_config.upstream == "RedHatInsights/hcc-ai-assistant"
        assert operations.repo_config.fork == "catastrophe-brandon/hcc-ai-assistant"
        assert operations.current_branch == "feature-branch"

    @patch("scripts.push_and_pr_operations.Path.cwd")
    def test_detect_from_config_github_direct(self, mock_cwd, operations, temp_dir):
        """Test detecting GitHub direct push from project-repos.json."""
        mock_cwd.return_value = temp_dir / "test-repo"
        config_file = temp_dir / "project-repos.json"

        config_data = {"test-repo": {"type": "github", "upstream": "RedHatInsights/test-repo"}}
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="main\n", stderr="")

            result = operations.detect_repository()

        assert result.success is True
        assert operations.repo_config.repo_type == "github"
        assert operations.repo_config.is_fork is False
        assert operations.repo_config.upstream == "RedHatInsights/test-repo"
        assert operations.repo_config.fork is None

    @patch("scripts.push_and_pr_operations.Path.cwd")
    def test_detect_from_config_gitlab(self, mock_cwd, operations, temp_dir):
        """Test detecting GitLab from project-repos.json."""
        mock_cwd.return_value = temp_dir / "gitlab-repo"
        config_file = temp_dir / "project-repos.json"

        config_data = {"gitlab-repo": {"type": "gitlab", "upstream": "team/gitlab-repo", "fork": "user/gitlab-repo"}}
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="develop\n", stderr="")

            result = operations.detect_repository()

        assert result.success is True
        assert operations.repo_config.repo_type == "gitlab"
        assert operations.repo_config.is_fork is True

    def test_detect_from_remotes_github_fork(self, operations):
        """Test detecting GitHub fork from git remotes."""
        remote_output = (
            "origin\tgit@github.com:user/repo.git (fetch)\n"
            "origin\tgit@github.com:user/repo.git (push)\n"
            "upstream\tgit@github.com:org/repo.git (fetch)\n"
            "upstream\tgit@github.com:org/repo.git (push)\n"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.side_effect = [
                CompletedProcess([], 0, stdout="feature\n", stderr=""),
                CompletedProcess([], 0, stdout=remote_output, stderr=""),
            ]

            result = operations.detect_repository()

        assert result.success is True
        assert operations.repo_config.repo_type == "github"
        assert operations.repo_config.is_fork is True
        assert operations.repo_config.upstream == "org/repo"
        assert operations.repo_config.fork == "user/repo"

    def test_detect_from_remotes_github_direct(self, operations):
        """Test detecting GitHub direct push from git remotes."""
        remote_output = (
            "origin\thttps://github.com/org/repo.git (fetch)\norigin\thttps://github.com/org/repo.git (push)\n"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.side_effect = [
                CompletedProcess([], 0, stdout="main\n", stderr=""),
                CompletedProcess([], 0, stdout=remote_output, stderr=""),
            ]

            result = operations.detect_repository()

        assert result.success is True
        assert operations.repo_config.repo_type == "github"
        assert operations.repo_config.is_fork is False
        assert operations.repo_config.upstream is None
        assert operations.repo_config.fork is None

    def test_detect_from_remotes_gitlab(self, operations):
        """Test detecting GitLab from git remotes."""
        remote_output = (
            "origin\thttps://gitlab.cee.redhat.com/user/project.git (fetch)\n"
            "origin\thttps://gitlab.cee.redhat.com/user/project.git (push)\n"
            "upstream\thttps://gitlab.cee.redhat.com/team/project.git (fetch)\n"
            "upstream\thttps://gitlab.cee.redhat.com/team/project.git (push)\n"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.side_effect = [
                CompletedProcess([], 0, stdout="feature\n", stderr=""),
                CompletedProcess([], 0, stdout=remote_output, stderr=""),
            ]

            result = operations.detect_repository()

        assert result.success is True
        assert operations.repo_config.repo_type == "gitlab"
        assert operations.repo_config.is_fork is True

    def test_detect_no_origin(self, operations):
        """Test detecting repository fails when no origin remote exists."""
        remote_output = "upstream\tgit@github.com:org/repo.git (fetch)\n"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.side_effect = [
                CompletedProcess([], 0, stdout="main\n", stderr=""),
                CompletedProcess([], 0, stdout=remote_output, stderr=""),
            ]

            result = operations.detect_repository()

        assert result.success is False
        assert "No 'origin' remote found" in result.message

    def test_detect_unsupported_remote(self, operations):
        """Test detecting repository fails for unsupported remote URL."""
        remote_output = "origin\thttps://bitbucket.org/user/repo.git (fetch)\n"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.side_effect = [
                CompletedProcess([], 0, stdout="main\n", stderr=""),
                CompletedProcess([], 0, stdout=remote_output, stderr=""),
            ]

            result = operations.detect_repository()

        assert result.success is False
        assert "Unsupported remote URL" in result.message

    @patch("scripts.push_and_pr_operations.Path.cwd")
    def test_detect_invalid_config_missing_repo(self, mock_cwd, operations, temp_dir):
        """Test detecting repository fails when repo not in config."""
        mock_cwd.return_value = temp_dir / "missing-repo"
        config_file = temp_dir / "project-repos.json"

        config_data = {"other-repo": {"type": "github", "upstream": "org/other-repo"}}
        with open(config_file, "w") as f:
            json.dump(config_data, f)

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="main\n", stderr="")

            result = operations.detect_repository()

        assert result.success is False
        assert "not found" in result.message.lower()

    @patch("scripts.push_and_pr_operations.Path.cwd")
    def test_detect_invalid_config_malformed_json(self, mock_cwd, operations, temp_dir):
        """Test detecting repository fails with malformed JSON config."""
        mock_cwd.return_value = temp_dir / "test-repo"
        config_file = temp_dir / "project-repos.json"

        with open(config_file, "w") as f:
            f.write("{invalid json")

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="main\n", stderr="")

            result = operations.detect_repository()

        assert result.success is False
        assert "Failed to parse" in result.message

    def test_detect_no_current_branch(self, operations):
        """Test detecting repository fails when current branch cannot be determined."""
        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="")

            result = operations.detect_repository()

        assert result.success is False
        assert "Failed to detect current branch" in result.message


class TestSyncFork:
    """Test sync_fork operation."""

    def test_sync_github_fork_success(self, operations):
        """Test syncing GitHub fork successfully."""
        operations.repo_config = RepositoryConfig(
            repo_type="github", is_fork=True, upstream="org/repo", fork="user/repo"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="Synced fork\n", stderr="")

            result = operations.sync_fork()

        assert result.success is True
        assert "user/repo" in result.message
        mock_run.assert_called_once_with(["gh", "repo", "sync", "user/repo"], check=False)

    def test_sync_gitlab_fork_success(self, operations):
        """Test syncing GitLab fork successfully."""
        operations.repo_config = RepositoryConfig(
            repo_type="gitlab", is_fork=True, upstream="team/project", fork="user/project"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="Synced\n", stderr="")

            result = operations.sync_fork()

        assert result.success is True
        mock_run.assert_called_once_with(["glab", "repo", "sync"], check=False)

    def test_sync_non_fork_skip(self, operations):
        """Test syncing skipped for non-fork repository."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)

        result = operations.sync_fork()

        assert result.success is True
        assert "Not a fork" in result.message
        assert result.data.get("skipped") is True

    def test_sync_already_up_to_date(self, operations):
        """Test syncing when fork is already up-to-date."""
        operations.repo_config = RepositoryConfig(
            repo_type="github", is_fork=True, upstream="org/repo", fork="user/repo"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 1, stdout="", stderr="already up-to-date")

            result = operations.sync_fork()

        assert result.success is True
        assert "up-to-date" in result.message.lower()

    def test_sync_github_error(self, operations):
        """Test syncing GitHub fork with error."""
        operations.repo_config = RepositoryConfig(
            repo_type="github", is_fork=True, upstream="org/repo", fork="user/repo"
        )

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 1, stdout="", stderr="authentication failed")

            result = operations.sync_fork()

        assert result.success is False
        assert "gh repo sync failed" in result.message

    def test_sync_no_config(self, operations):
        """Test syncing fails without repository configuration."""
        result = operations.sync_fork()

        assert result.success is False
        assert "Repository configuration not detected" in result.message

    def test_sync_github_no_fork_specified(self, operations):
        """Test syncing GitHub fork fails when fork not specified."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=True, upstream="org/repo", fork=None)

        result = operations.sync_fork()

        assert result.success is False
        assert "Fork repository not specified" in result.message


class TestPushBranch:
    """Test push_branch operation."""

    def test_push_github_success(self, operations):
        """Test pushing branch to GitHub successfully."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=True)
        operations.current_branch = "feature-branch"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="Pushed\n", stderr="")

            result = operations.push_branch()

        assert result.success is True
        assert "feature-branch" in result.message
        expected_cmd = [
            "git",
            "-c",
            "credential.helper=!gh auth git-credential",
            "push",
            "origin",
            "feature-branch",
            "-u",
        ]
        mock_run.assert_called_once_with(expected_cmd, check=False)

    def test_push_gitlab_success(self, operations):
        """Test pushing branch to GitLab successfully."""
        operations.repo_config = RepositoryConfig(repo_type="gitlab", is_fork=False)
        operations.current_branch = "develop"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="Pushed\n", stderr="")

            result = operations.push_branch()

        assert result.success is True
        expected_cmd = ["git", "-c", "credential.helper=!glab auth git-credential", "push", "origin", "develop", "-u"]
        mock_run.assert_called_once_with(expected_cmd, check=False)

    def test_push_already_up_to_date(self, operations):
        """Test pushing when branch is already up-to-date."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = "main"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="Everything up-to-date")

            result = operations.push_branch()

        assert result.success is True
        assert "up-to-date" in result.message.lower()

    def test_push_error(self, operations):
        """Test pushing branch with error."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = "feature"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 1, stdout="", stderr="permission denied")

            result = operations.push_branch()

        assert result.success is False
        assert "git push failed" in result.message
        assert "permission denied" in result.message

    def test_push_no_config(self, operations):
        """Test pushing fails without repository configuration."""
        result = operations.push_branch()

        assert result.success is False
        assert "Repository configuration not detected" in result.message

    def test_push_no_current_branch(self, operations):
        """Test pushing fails without current branch."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = None

        result = operations.push_branch()

        assert result.success is False
        assert "Current branch not detected" in result.message

    def test_push_unsupported_repo_type(self, operations):
        """Test pushing fails with unsupported repository type."""
        operations.repo_config = RepositoryConfig(repo_type="bitbucket", is_fork=False)
        operations.current_branch = "main"

        result = operations.push_branch()

        assert result.success is False
        assert "Unsupported repo type" in result.message


class TestCreatePR:
    """Test create_pr operation."""

    def test_create_github_pr_fork(self, operations):
        """Test creating GitHub PR for fork."""
        operations.repo_config = RepositoryConfig(
            repo_type="github", is_fork=True, upstream="org/repo", fork="user/repo"
        )
        operations.current_branch = "feature"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="https://github.com/org/repo/pull/123\n", stderr="")

            result = operations.create_pr()

        assert result.success is True
        assert result.data["pr_url"] == "https://github.com/org/repo/pull/123"
        assert result.data["pr_number"] == "123"
        assert operations.pr_url == "https://github.com/org/repo/pull/123"
        assert operations.pr_number == "123"

        expected_cmd = [
            "gh",
            "pr",
            "create",
            "--repo",
            "org/repo",
            "--head",
            "user:feature",
            "--title",
            "Test PR",
            "--body",
            "Test description",
        ]
        mock_run.assert_called_once_with(expected_cmd, check=False)

    def test_create_github_pr_direct(self, operations):
        """Test creating GitHub PR for direct push."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = "main"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="https://github.com/org/repo/pull/456\n", stderr="")

            result = operations.create_pr()

        assert result.success is True
        assert result.data["pr_number"] == "456"

        expected_cmd = ["gh", "pr", "create", "--title", "Test PR", "--body", "Test description"]
        mock_run.assert_called_once_with(expected_cmd, check=False)

    def test_create_gitlab_mr(self, operations):
        """Test creating GitLab MR."""
        operations.repo_config = RepositoryConfig(repo_type="gitlab", is_fork=True)
        operations.current_branch = "feature"

        with patch.object(operations, "_run_command") as mock_run:
            mr_output = "Created merge request\n!42 https://gitlab.cee.redhat.com/team/project/-/merge_requests/42\n"
            mock_run.return_value = CompletedProcess([], 0, stdout=mr_output, stderr="")

            result = operations.create_pr()

        assert result.success is True
        assert "!42" in result.data["pr_url"]
        assert result.data["pr_number"] == "42"

        expected_cmd = [
            "glab",
            "mr",
            "create",
            "--hostname",
            "gitlab.cee.redhat.com",
            "--title",
            "Test PR",
            "--description",
            "Test description",
        ]
        mock_run.assert_called_once_with(expected_cmd, check=False)

    def test_create_pr_error(self, operations):
        """Test creating PR with error."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = "feature"

        with patch.object(operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 1, stdout="", stderr="PR already exists")

            result = operations.create_pr()

        assert result.success is False
        assert "gh pr create failed" in result.message
        assert "PR already exists" in result.message

    def test_create_pr_no_config(self, operations):
        """Test creating PR fails without repository configuration."""
        result = operations.create_pr()

        assert result.success is False
        assert "Repository configuration not detected" in result.message

    def test_create_pr_no_current_branch(self, operations):
        """Test creating PR fails without current branch."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        operations.current_branch = None

        result = operations.create_pr()

        assert result.success is False
        assert "Current branch not detected" in result.message

    def test_create_github_pr_fork_no_upstream(self, operations):
        """Test creating GitHub PR for fork fails without upstream."""
        operations.repo_config = RepositoryConfig(repo_type="github", is_fork=True, upstream=None, fork="user/repo")
        operations.current_branch = "feature"

        result = operations.create_pr()

        assert result.success is False
        assert "Upstream and fork repositories required" in result.message

    def test_create_pr_unsupported_repo_type(self, operations):
        """Test creating PR fails with unsupported repository type."""
        operations.repo_config = RepositoryConfig(repo_type="svn", is_fork=False)
        operations.current_branch = "main"

        result = operations.create_pr()

        assert result.success is False
        assert "Unsupported repo type" in result.message


class TestExtractOwnerRepo:
    """Test _extract_owner_repo helper."""

    def test_extract_ssh_url(self, operations):
        """Test extracting owner/repo from SSH URL."""
        url = "git@github.com:RedHatInsights/hcc-ai-assistant.git"
        result = operations._extract_owner_repo(url)
        assert result == "RedHatInsights/hcc-ai-assistant"

    def test_extract_https_url(self, operations):
        """Test extracting owner/repo from HTTPS URL."""
        url = "https://github.com/RedHatInsights/hcc-ai-assistant.git"
        result = operations._extract_owner_repo(url)
        assert result == "RedHatInsights/hcc-ai-assistant"

    def test_extract_https_url_no_git_extension(self, operations):
        """Test extracting owner/repo from HTTPS URL without .git."""
        url = "https://github.com/user/repo"
        result = operations._extract_owner_repo(url)
        assert result == "user/repo"

    def test_extract_gitlab_ssh_url(self, operations):
        """Test extracting owner/repo from GitLab SSH URL."""
        url = "git@gitlab.cee.redhat.com:team/project.git"
        result = operations._extract_owner_repo(url)
        assert result == "team/project"

    def test_extract_gitlab_https_url(self, operations):
        """Test extracting owner/repo from GitLab HTTPS URL."""
        url = "https://gitlab.cee.redhat.com/team/project.git"
        result = operations._extract_owner_repo(url)
        assert result == "team/project"

    def test_extract_invalid_url(self, operations):
        """Test extracting owner/repo from invalid URL returns original."""
        url = "invalid-url"
        result = operations._extract_owner_repo(url)
        assert result == "invalid-url"


class TestDryRun:
    """Test dry-run mode."""

    def test_dry_run_detect_repository(self, dry_run_operations):
        """Test detect_repository in dry-run mode."""
        with patch.object(dry_run_operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="")

            dry_run_operations.detect_repository()

        # In dry-run mode, commands are not actually executed
        # _run_command should still be called but won't execute the actual subprocess
        assert mock_run.called

    def test_dry_run_sync_fork(self, dry_run_operations):
        """Test sync_fork in dry-run mode."""
        dry_run_operations.repo_config = RepositoryConfig(
            repo_type="github", is_fork=True, upstream="org/repo", fork="user/repo"
        )

        with patch.object(dry_run_operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="")

            result = dry_run_operations.sync_fork()

        assert result.success is True
        mock_run.assert_called_once()

    def test_dry_run_push_branch(self, dry_run_operations):
        """Test push_branch in dry-run mode."""
        dry_run_operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        dry_run_operations.current_branch = "feature"

        with patch.object(dry_run_operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="")

            result = dry_run_operations.push_branch()

        assert result.success is True
        mock_run.assert_called_once()

    def test_dry_run_create_pr(self, dry_run_operations):
        """Test create_pr in dry-run mode."""
        dry_run_operations.repo_config = RepositoryConfig(repo_type="github", is_fork=False)
        dry_run_operations.current_branch = "feature"

        with patch.object(dry_run_operations, "_run_command") as mock_run:
            mock_run.return_value = CompletedProcess([], 0, stdout="", stderr="")

            result = dry_run_operations.create_pr()

        assert result.success is True
        mock_run.assert_called_once()


class TestFindPRTemplate:
    """Test find_pr_template static method."""

    def test_finds_github_template(self, temp_dir):
        """Test finding .github/pull_request_template.md (most common location)."""
        github_dir = temp_dir / ".github"
        github_dir.mkdir()
        template = github_dir / "pull_request_template.md"
        template.write_text("## Description\n<!-- what and why -->\n")

        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert result.data["path"] == ".github/pull_request_template.md"
        assert "## Description" in result.data["content"]

    def test_finds_root_uppercase_template(self, temp_dir):
        """Test finding PULL_REQUEST_TEMPLATE.md in repo root (no .github/ dir)."""
        template = temp_dir / "PULL_REQUEST_TEMPLATE.md"
        template.write_text("# PR Template\n")

        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert result.data["path"] in ("PULL_REQUEST_TEMPLATE.md", "pull_request_template.md")

    def test_finds_root_template(self, temp_dir):
        """Test finding pull_request_template.md in repo root."""
        template = temp_dir / "pull_request_template.md"
        template.write_text("Root template\n")

        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert result.data["path"] in ("pull_request_template.md", "PULL_REQUEST_TEMPLATE.md")

    def test_finds_default_template_in_subdirectory(self, temp_dir):
        """Test finding .github/PULL_REQUEST_TEMPLATE/default.md."""
        template_dir = temp_dir / ".github" / "PULL_REQUEST_TEMPLATE"
        template_dir.mkdir(parents=True)
        template = template_dir / "default.md"
        template.write_text("Default template\n")

        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert result.data["path"] == ".github/PULL_REQUEST_TEMPLATE/default.md"

    def test_no_template_found(self, temp_dir):
        """Test graceful handling when no template exists."""
        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert result.data["path"] is None
        assert "No PR template found" in result.message

    def test_priority_order_github_over_root(self, temp_dir):
        """Test that .github/ template is found before root template."""
        github_dir = temp_dir / ".github"
        github_dir.mkdir()
        (github_dir / "pull_request_template.md").write_text("github dir\n")
        (temp_dir / "PULL_REQUEST_TEMPLATE.md").write_text("root dir\n")

        result = PushAndPROperations.find_pr_template(repo_dir=temp_dir)

        assert result.success is True
        assert ".github/" in result.data["path"]
        assert result.data["content"] == "github dir\n"

    def test_uses_cwd_when_no_repo_dir(self):
        """Test that find_pr_template defaults to cwd."""
        with patch("scripts.push_and_pr_operations.Path.cwd") as mock_cwd:
            mock_cwd.return_value = Path("/nonexistent/path")
            result = PushAndPROperations.find_pr_template()

        assert result.success is True
        assert result.data["path"] is None

    def test_template_paths_constant(self):
        """Test that PR_TEMPLATE_PATHS contains expected entries."""
        assert ".github/pull_request_template.md" in PR_TEMPLATE_PATHS
        assert ".github/PULL_REQUEST_TEMPLATE.md" in PR_TEMPLATE_PATHS
        assert "pull_request_template.md" in PR_TEMPLATE_PATHS
        assert "PULL_REQUEST_TEMPLATE.md" in PR_TEMPLATE_PATHS
        assert ".github/PULL_REQUEST_TEMPLATE/default.md" in PR_TEMPLATE_PATHS

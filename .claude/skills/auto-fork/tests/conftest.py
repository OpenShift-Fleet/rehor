"""Shared test fixtures and utilities."""

import json
from unittest.mock import Mock

import pytest

# Test constants
TEST_BOT_USERNAME = "test-bot"
TEST_CONFIG_REPO = "https://github.com/test-org/test-config.git"
TEST_INSTANCE_ID = "test-instance"


@pytest.fixture(autouse=True)
def set_env_vars(monkeypatch):
    """Set required env vars for all tests."""
    monkeypatch.setenv("BOT_GITHUB_USERNAME", TEST_BOT_USERNAME)
    monkeypatch.setenv("BOT_CONFIG_REPO", TEST_CONFIG_REPO)
    monkeypatch.setenv("BOT_INSTANCE_ID", TEST_INSTANCE_ID)
    monkeypatch.setenv("BOT_CONFIG_PATH", "test-config")


@pytest.fixture
def temp_config_dir(tmp_path):
    """Create temporary config directory structure."""
    config_dir = tmp_path / "test-config"
    agent_dir = config_dir / "agent"
    agent_dir.mkdir(parents=True)

    # Create project-repos.json
    # test-repo-1 already has fork (uses TEST_BOT_USERNAME)
    # test-repo-2 needs fork (uses different user)
    repos = {
        "test-repo-1": {
            "url": f"https://github.com/{TEST_BOT_USERNAME}/test-repo-1.git",
            "upstream": "https://github.com/TestOrg/test-repo-1.git",
        },
        "test-repo-2": {
            "url": "https://github.com/other-user/test-repo-2.git",
            "upstream": "https://github.com/TestOrg/test-repo-2.git",
        },
        "gitlab-repo": {
            "url": "https://gitlab.cee.redhat.com/other-user/gitlab-repo.git",
            "upstream": "https://gitlab.cee.redhat.com/TestOrg/gitlab-repo.git",
            "host": "gitlab",
        },
    }

    project_repos_path = agent_dir / "project-repos.json"
    project_repos_path.write_text(json.dumps(repos, indent=2))

    # Initialize git repo
    import subprocess

    subprocess.run(["git", "init"], cwd=config_dir, capture_output=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=config_dir, capture_output=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=config_dir, capture_output=True)
    subprocess.run(["git", "add", "."], cwd=config_dir, capture_output=True)
    subprocess.run(["git", "commit", "-m", "Initial"], cwd=config_dir, capture_output=True)
    subprocess.run(["git", "remote", "add", "origin", TEST_CONFIG_REPO], cwd=config_dir, capture_output=True)

    return config_dir


@pytest.fixture
def mock_subprocess_run():
    """Mock subprocess.run for gh/git commands."""
    with pytest.MonkeyPatch.context() as m:
        original_run = __import__("subprocess").run

        def mock_run(cmd, *args, **kwargs):
            # Mock gh repo fork
            if cmd[0] == "gh" and cmd[1] == "repo" and cmd[2] == "fork":
                result = Mock()
                result.returncode = 0
                result.stdout = ""
                result.stderr = ""
                return result
            # Let real git commands through for test setup
            return original_run(cmd, *args, **kwargs)

        m.setattr("subprocess.run", mock_run)
        yield mock_run

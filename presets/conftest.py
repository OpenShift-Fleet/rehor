"""Root conftest for all skill tests.

Adds each skill directory to sys.path so relative imports
(e.g. `from scripts.post_pr_operations import ...`) keep working.
Also merges per-skill fixtures here to avoid conftest.py name collisions.
"""

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

repo_root = Path(__file__).resolve().parent.parent

skill_dirs = [
    repo_root / "presets" / "shared" / "skills" / "auto-fork",
    repo_root / "presets" / "shared" / "skills" / "post-pr",
    repo_root / "presets" / "shared" / "skills" / "push-and-pr",
    repo_root / "presets" / "workflows" / "jira-sprint" / "skills" / "claim-ticket",
    repo_root / "presets" / "workflows" / "jira-kanban" / "skills" / "claim-ticket",
    repo_root / "presets" / "workflows" / "onboarding" / "skills" / "generate-instance",
]

for skill_path in skill_dirs:
    p = str(skill_path)
    if p not in sys.path:
        sys.path.insert(0, p)

skills_root = str(repo_root / ".claude" / "skills")
if skills_root not in sys.path:
    sys.path.insert(0, skills_root)

collect_ignore_glob = ["*/.venv/*"]

# ---------------------------------------------------------------------------
# Shared test constants
# ---------------------------------------------------------------------------

TEST_BOT_USERNAME = "test-bot"
TEST_BOT_EMAIL = "bot@example.com"
TEST_INSTANCE_ID = "test-instance"
GITLAB_HOST = "gitlab.cee.redhat.com"
HOST_GITHUB = "github"
HOST_GITLAB = "gitlab"

TEST_JIRA_KEY = "RHCLOUD-12345"
TEST_BOT_ACCOUNT_ID = "bot-123"
TEST_MEMORY_URL = "https://test-memory.example.com"
TEST_SPRINT_ID = 12345
TEST_SPRINT_NAME = "Sprint 42"
TEST_TRANSITION_ID = "21"
TEST_BOARD_ID = "9297"


# ---------------------------------------------------------------------------
# auto-fork fixtures
# ---------------------------------------------------------------------------

TEST_REPOS_CONFIG = {
    "test-repo-1": {
        "url": f"https://github.com/{TEST_BOT_USERNAME}/test-repo-1.git",
        "upstream": "https://github.com/TestOrg/test-repo-1.git",
    },
    "test-repo-2": {
        "url": "https://github.com/other-user/test-repo-2.git",
        "upstream": "https://github.com/TestOrg/test-repo-2.git",
    },
    "gitlab-repo": {
        "url": f"https://{GITLAB_HOST}/other-user/gitlab-repo.git",
        "upstream": f"https://{GITLAB_HOST}/TestOrg/gitlab-repo.git",
        "host": HOST_GITLAB,
    },
}


@pytest.fixture(autouse=True)
def set_env_vars(monkeypatch):
    """Set required env vars for all tests."""
    monkeypatch.setenv("GH_USER_NAME", TEST_BOT_USERNAME)
    monkeypatch.setenv("GL_USER_NAME", TEST_BOT_USERNAME)
    monkeypatch.setenv("BOT_INSTANCE_ID", TEST_INSTANCE_ID)
    monkeypatch.setenv("BOT_CONFIG_PATH", "test-config")
    monkeypatch.setenv("BOT_JIRA_EMAIL", TEST_BOT_EMAIL)


@pytest.fixture
def temp_config_dir(tmp_path):
    """Create temporary config directory structure with git repo."""
    config_dir = tmp_path / "test-config"
    agent_dir = config_dir / "agent"
    agent_dir.mkdir(parents=True)

    project_repos_path = agent_dir / "project-repos.json"
    project_repos_path.write_text(json.dumps(TEST_REPOS_CONFIG, indent=2))

    subprocess.run(["git", "init"], cwd=config_dir, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=config_dir, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=config_dir, capture_output=True, check=True)
    subprocess.run(["git", "add", "."], cwd=config_dir, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "Initial"], cwd=config_dir, capture_output=True, check=True)
    subprocess.run(
        ["git", "remote", "add", "origin", "https://github.com/test-org/test-config.git"],
        cwd=config_dir,
        capture_output=True,
        check=True,
    )

    return config_dir


@pytest.fixture
def mock_subprocess_result():
    """Factory fixture for creating mock subprocess results."""

    def _make_result(returncode: int = 0, stdout: str = "", stderr: str = ""):
        result = Mock()
        result.returncode = returncode
        result.stdout = stdout
        result.stderr = stderr
        return result

    return _make_result


# ---------------------------------------------------------------------------
# claim-ticket fixtures
# ---------------------------------------------------------------------------


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
        "jira_get_transitions": {"transitions": [{"id": TEST_TRANSITION_ID, "name": "In Progress"}]},
        "jira_update_issue": {},
        "jira_transition_issue": {},
        "jira_get_agile_boards": {"values": [{"id": int(TEST_BOARD_ID), "name": "Test Board"}]},
        "jira_get_sprints_from_board": {"sprints": [{"id": TEST_SPRINT_ID, "name": TEST_SPRINT_NAME}]},
        "jira_add_issues_to_sprint": {},
    }

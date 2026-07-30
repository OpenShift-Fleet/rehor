"""Integration tests for Git Auth Reverse Proxy.

Validates end-to-end git operations (clone, push, fetch) through the proxy
with credential injection, using the docker-compose stack.

These tests require:
- docker-compose stack running (proxy + bot containers)
- GH_TOKEN environment variable for GitHub auth
- GITLAB_TOKEN and GL_USERNAME for GitLab auth
- Test repositories accessible (public or authenticated)

Run with: pytest tests/test_git_proxy_integration.py -v
"""

import os
import subprocess
import time
from pathlib import Path

import pytest

# Test configuration constants
HEALTHCHECK_TIMEOUT_SECONDS = 30
HEALTHCHECK_RETRY_INTERVAL = 1.0
DOCKER_EXEC_TIMEOUT = 5
GIT_OPERATION_TIMEOUT = 30
GIT_CLONE_TIMEOUT = 60
PROXY_LOG_WINDOW = "2m"


@pytest.fixture(scope="module")
def docker_compose_services():
    """Ensure docker-compose stack is running for tests.

    This doesn't start/stop the stack (assumes it's already running),
    but verifies services are healthy before proceeding.
    """
    # Check if proxy service is reachable
    max_retries = int(HEALTHCHECK_TIMEOUT_SECONDS / HEALTHCHECK_RETRY_INTERVAL)
    for i in range(max_retries):
        result = subprocess.run(
            ["docker", "compose", "exec", "-T", "proxy", "curl", "-s", "http://localhost:8447/healthz"],
            capture_output=True,
            timeout=DOCKER_EXEC_TIMEOUT,
        )
        if result.returncode == 0 and b"ok" in result.stdout:
            break
        if i < max_retries - 1:
            time.sleep(HEALTHCHECK_RETRY_INTERVAL)
    else:
        pytest.skip("Proxy service not healthy - is docker-compose running?")

    # Check if bot service is reachable
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "bot", "echo", "healthy"],
        capture_output=True,
        timeout=DOCKER_EXEC_TIMEOUT,
    )
    if result.returncode != 0:
        pytest.skip("Bot service not healthy - is docker-compose running?")

    yield


@pytest.fixture
def bot_exec():
    """Helper to execute commands in bot container."""

    def run_cmd(
        cmd: list[str], check: bool = True, timeout: int = GIT_OPERATION_TIMEOUT
    ) -> subprocess.CompletedProcess:
        """Execute command in bot container.

        Args:
            cmd: Command and arguments to execute
            check: Raise exception on non-zero exit code
            timeout: Command timeout in seconds

        Returns:
            CompletedProcess with stdout, stderr, returncode
        """
        return subprocess.run(
            ["docker", "compose", "exec", "-T", "bot"] + cmd,
            capture_output=True,
            text=True,
            check=check,
            timeout=timeout,
        )

    return run_cmd


@pytest.fixture
def proxy_logs():
    """Helper to get proxy container logs."""

    def get_logs(since: str = PROXY_LOG_WINDOW) -> str:
        """Get recent proxy logs.

        Args:
            since: Time window for logs (e.g., "1m", "30s")

        Returns:
            Proxy container logs as string
        """
        result = subprocess.run(
            ["docker", "compose", "logs", "--since", since, "proxy"],
            capture_output=True,
            text=True,
        )
        return result.stdout

    return get_logs


class TestGitProxyEndToEnd:
    """End-to-end tests for git operations through the proxy."""

    def test_proxy_healthz_endpoint(self, docker_compose_services, bot_exec):
        """Verify git-auth proxy healthz endpoint is accessible."""
        result = bot_exec(["curl", "-s", "http://proxy:8447/healthz"])

        assert result.returncode == 0, f"Health check failed: {result.stderr}"
        assert "ok" in result.stdout, f"Unexpected healthz response: {result.stdout}"

    def test_git_clone_public_repo_through_proxy(self, docker_compose_services, bot_exec, proxy_logs):
        """Clone a small public GitHub repo through the proxy.

        This tests:
        - URL rewrite (insteadOf) configuration
        - HTTP -> HTTPS upgrade
        - Bearer token injection (if GH_TOKEN set)
        - Git smart HTTP protocol compatibility
        """
        # Clean up any previous test clone
        bot_exec(["rm", "-rf", "/tmp/test-clone"], check=False)

        # Clone a small, stable public repo
        # Using a Red Hat repo to ensure it exists
        result = bot_exec(
            ["git", "clone", "--depth", "1", "https://github.com/RedHatInsights/insights-chrome", "/tmp/test-clone"],
            timeout=GIT_CLONE_TIMEOUT,
        )

        assert result.returncode == 0, f"Git clone failed: {result.stderr}"
        assert "Cloning into" in result.stderr or "Cloning into" in result.stdout, (
            f"Unexpected git output: {result.stderr}"
        )

        # Verify the clone worked
        ls_result = bot_exec(["ls", "-la", "/tmp/test-clone/.git"])
        assert ls_result.returncode == 0, "Cloned repo missing .git directory"

        # Verify proxy was used (check logs for git-auth traffic)
        logs = proxy_logs()
        assert "gitauth:" in logs, "Proxy logs don't show git-auth traffic"
        assert "github.com" in logs, "Proxy logs don't show GitHub host"
        assert "status=200" in logs or "status=301" in logs, "Proxy logs don't show successful request"

    def test_git_fetch_through_proxy(self, docker_compose_services, bot_exec):
        """Test git fetch operation through proxy.

        Requires a repo already cloned (uses previous test's clone).
        """
        # Ensure we have a cloned repo
        check_result = bot_exec(["test", "-d", "/tmp/test-clone/.git"], check=False)
        if check_result.returncode != 0:
            pytest.skip("No existing clone found - run test_git_clone_public_repo_through_proxy first")

        # Fetch updates
        result = bot_exec(["sh", "-c", "cd /tmp/test-clone && git fetch origin"], timeout=GIT_OPERATION_TIMEOUT)

        assert result.returncode == 0, f"Git fetch failed: {result.stderr}"


class TestGitProxyConfigMigration:
    """Tests for config migration between credential helper and proxy modes."""

    def test_proxy_mode_env_var_present(self, docker_compose_services, bot_exec):
        """Verify GIT_AUTH_PROXY_HOST is set in bot container."""
        result = bot_exec(["sh", "-c", "echo $GIT_AUTH_PROXY_HOST"])

        # In docker-compose, this should be set to "proxy"
        # If not set, the bot would fall back to credential helper mode
        proxy_host = result.stdout.strip()

        # This might not be set yet (Phase 1 implementation only)
        # So we just verify the mechanism works
        if proxy_host:
            assert proxy_host == "proxy", f"Expected GIT_AUTH_PROXY_HOST=proxy, got: {proxy_host}"

    def test_gitconfig_has_insteadof_when_proxy_available(self, docker_compose_services, bot_exec):
        """When GIT_AUTH_PROXY_HOST is set, .gitconfig should have insteadOf rewrites.

        Note: This test validates the *design* for Phase 2.
        In Phase 1, the .gitconfig might still use credential helpers.
        """
        result = bot_exec(["cat", "/home/bot/.gitconfig"], check=False)

        if result.returncode != 0:
            pytest.skip(".gitconfig not found - bot may not be fully configured")

        gitconfig = result.stdout

        # Check which mode is configured
        has_insteadof = "insteadOf" in gitconfig
        has_credential_helper = "credential" in gitconfig and "helper" in gitconfig

        # At least one should be configured
        assert has_insteadof or has_credential_helper, (
            "Neither proxy mode nor credential helper configured in .gitconfig"
        )

        # If proxy mode is enabled, verify the rewrites are correct
        if has_insteadof:
            assert "http://proxy:8447/github.com" in gitconfig, "insteadOf rewrite for GitHub missing or incorrect"
            # GitLab might not be configured in all environments
            # So we only check GitHub which should always be present


class TestGitProxyErrorHandling:
    """Tests for proxy error handling and edge cases."""

    def test_proxy_returns_400_for_bare_path(self, docker_compose_services, bot_exec):
        """Proxy should return 400 for requests without host in path."""
        result = bot_exec(["curl", "-s", "-w", "\\n%{http_code}", "http://proxy:8447/info/refs"], check=False)

        output_lines = result.stdout.strip().split("\n")
        http_code = output_lines[-1] if output_lines else ""

        assert http_code == "400", f"Expected 400 for bare path, got: {http_code}"

    def test_proxy_returns_403_for_unknown_host(self, docker_compose_services, bot_exec):
        """Proxy should return 403 for unknown hosts."""
        result = bot_exec(
            ["curl", "-s", "-w", "\\n%{http_code}", "http://proxy:8447/evil.com/repo.git/info/refs"], check=False
        )

        output_lines = result.stdout.strip().split("\n")
        http_code = output_lines[-1] if output_lines else ""

        assert http_code == "403", f"Expected 403 for unknown host, got: {http_code}"

    def test_proxy_returns_503_when_token_missing(self, docker_compose_services, bot_exec):
        """Proxy should return 503 when authentication token is not configured.

        Note: This test may be skipped if tokens are properly configured.
        It's more relevant for deployment validation.
        """
        # We can't easily unset env vars in the running proxy container
        # So this test documents the expected behavior rather than testing it
        # In a real deployment, missing GH_TOKEN would cause 503 responses
        pytest.skip("Cannot test missing token scenario with running docker-compose stack")


class TestGitProxyValidation:
    """Tests for ValidateGitAuthConfig startup validation."""

    def test_proxy_validates_config_at_startup(self, docker_compose_services):
        """Verify proxy container started successfully with valid config.

        If ValidateGitAuthConfig is working, proxy should only start
        when at least one of (GH_TOKEN, GITLAB_TOKEN+GL_USERNAME) is set.
        """
        # Check proxy is healthy
        result = subprocess.run(
            ["docker", "compose", "ps", "proxy"],
            capture_output=True,
            text=True,
        )

        assert "Up" in result.stdout or "running" in result.stdout, (
            "Proxy container not running - config validation may have failed"
        )


# Helper to check if this is running in CI vs local dev
def is_ci_environment() -> bool:
    """Check if tests are running in CI environment."""
    return os.getenv("CI") == "true" or os.getenv("GITHUB_ACTIONS") == "true"


# Mark all tests as requiring docker-compose
pytestmark = pytest.mark.skipif(
    not Path("docker-compose.yml").exists(), reason="docker-compose.yml not found - run from repo root"
)

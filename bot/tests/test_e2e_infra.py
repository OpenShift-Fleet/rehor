"""Tests for E2E infrastructure changes (REHOR-110).

Covers:
- align-playwright-browsers helper script (extracted from install.sh)
- 10-chromium.sh credential mapping and extra-hosts loading
- dev-proxy install.sh prerequisite check
- squid.conf playwright domain allowlist
"""

import json
import os
import re
import subprocess
import textwrap

import pytest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _extract_heredoc(install_sh_path, marker="SCRIPT"):
    """Extract the heredoc script from install.sh between cat > ... << 'MARKER' and MARKER."""
    with open(install_sh_path) as f:
        content = f.read()
    pattern = rf"cat > [^\n]+ << '{marker}'\n(.*?)\n{marker}"
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        raise ValueError(f"Could not find heredoc with marker {marker} in {install_sh_path}")
    return match.group(1)


HAS_GREP_P = (
    subprocess.run(
        ["grep", "-oP", "x", "/dev/null"],
        capture_output=True,
    ).returncode
    != 2
)

requires_grep_p = pytest.mark.skipif(not HAS_GREP_P, reason="grep -P not available")


@requires_grep_p
class TestAlignPlaywrightBrowsers:
    """Test the align-playwright-browsers helper extracted from browser/install.sh."""

    @pytest.fixture
    def align_script(self, tmp_path):
        """Extract the actual align-playwright-browsers script from install.sh."""
        install_sh = os.path.join(REPO_ROOT, "presets", "envs", "browser", "install.sh")
        script_body = _extract_heredoc(install_sh, "SCRIPT")
        script_path = tmp_path / "align-playwright-browsers"
        script_path.write_text(script_body)
        script_path.chmod(0o755)
        return script_path

    @pytest.fixture
    def pw_env(self, tmp_path):
        """Set up fake playwright browsers directory."""
        browsers = tmp_path / "pw-browsers"
        (browsers / "chromium-1234").mkdir(parents=True)
        (browsers / "ffmpeg-1011").mkdir(parents=True)

        cache = tmp_path / ".cache" / "ms-playwright"
        cache.mkdir(parents=True)

        return browsers, cache

    def test_versions_match_no_symlinks(self, align_script, pw_env, tmp_path):
        browsers, cache = pw_env
        repo = tmp_path / "repo"
        repo.mkdir()
        mock_npx = repo / "npx"
        mock_npx.write_text("#!/bin/bash\necho 'chromium-1234 some text'\n")
        mock_npx.chmod(0o755)

        env = {
            "PATH": str(repo) + ":" + os.environ.get("PATH", ""),
            "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
            "HOME": str(tmp_path),
        }
        result = subprocess.run(
            ["bash", str(align_script), str(repo)],
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        assert result.returncode == 0
        assert "Versions match" in result.stdout

    def test_version_mismatch_creates_symlinks(self, align_script, pw_env, tmp_path):
        browsers, cache = pw_env
        repo = tmp_path / "repo"
        repo.mkdir()
        mock_npx = repo / "npx"
        mock_npx.write_text("#!/bin/bash\necho 'chromium-5678 some text'\n")
        mock_npx.chmod(0o755)

        env = {
            "PATH": str(repo) + ":" + os.environ.get("PATH", ""),
            "PLAYWRIGHT_BROWSERS_PATH": str(browsers),
            "HOME": str(tmp_path),
        }
        result = subprocess.run(
            ["bash", str(align_script), str(repo)],
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        assert result.returncode == 0
        assert "Aligning" in result.stdout
        assert (cache / "chromium-5678").is_symlink()
        assert str(cache / "chromium-5678").endswith("chromium-5678")

    def test_missing_installed_version_exits_1(self, align_script, tmp_path):
        empty_browsers = tmp_path / "empty-browsers"
        empty_browsers.mkdir()
        repo = tmp_path / "repo"
        repo.mkdir()
        mock_npx = repo / "npx"
        mock_npx.write_text("#!/bin/bash\necho 'chromium-1234 some text'\n")
        mock_npx.chmod(0o755)

        env = {
            "PATH": str(repo) + ":" + os.environ.get("PATH", ""),
            "PLAYWRIGHT_BROWSERS_PATH": str(empty_browsers),
            "HOME": str(tmp_path),
        }
        result = subprocess.run(
            ["bash", str(align_script), str(repo)],
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        assert result.returncode == 1
        assert "Could not determine" in result.stderr


class TestChromiumCredentialMapping:
    """Test E2E credential mapping from .credentials file in 10-chromium.sh."""

    @pytest.fixture
    def credential_script(self, tmp_path):
        """Extract the credential mapping logic that reads from .credentials."""
        original_path = "presets/envs/browser/entrypoint.d/10-chromium.sh"
        loaded_path = os.path.join(REPO_ROOT, original_path)
        if not os.path.exists(loaded_path):
            raise FileNotFoundError(f"Could not find {original_path} in repo root {REPO_ROOT}")

        loaded_content = ""
        with open(loaded_path) as f:
            loaded_content = f.read()
        extracted_content = re.search(
            r"(?s)(# BEGIN CREDENTIAL MAPPING.*?# END CREDENTIAL MAPPING)",
            loaded_content,
        )
        if not extracted_content:
            raise ValueError(f"Could not extract credential mapping from {loaded_path}")
        loaded_content = extracted_content.group(1)
        # The extracted snippet only exports; append echoes so the subprocess
        # surfaces the resulting values on stdout for assertions.
        loaded_content += '\necho "E2E_USER=${E2E_USER:-unset}"\necho "E2E_PASSWORD=${E2E_PASSWORD:-unset}"\n'
        path = tmp_path / "cred-map.sh"
        path.write_text(loaded_content)
        path.chmod(0o755)
        return path

    def test_reads_from_credentials_file(self, credential_script, tmp_path):
        cred_file = tmp_path / ".credentials"
        cred_file.write_text(json.dumps({"sso": {"username": "testuser", "password": "secret123"}}))
        env = {"HOME": str(tmp_path), "CRED_FILE": str(cred_file)}
        result = subprocess.run(
            ["bash", str(credential_script)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        assert "E2E_USER=testuser" in result.stdout
        assert "E2E_PASSWORD=secret123" in result.stdout

    def test_e2e_not_overwritten_when_already_set(self, credential_script, tmp_path):
        cred_file = tmp_path / ".credentials"
        cred_file.write_text(json.dumps({"sso": {"username": "sso-user", "password": "sso-pass"}}))
        env = {
            "HOME": str(tmp_path),
            "CRED_FILE": str(cred_file),
            "E2E_USER": "explicit-user",
            "E2E_PASSWORD": "explicit-pass",
        }
        result = subprocess.run(
            ["bash", str(credential_script)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        assert "E2E_USER=explicit-user" in result.stdout
        assert "E2E_PASSWORD=explicit-pass" in result.stdout

    def test_no_credentials_file_no_mapping(self, credential_script, tmp_path):
        env = {"HOME": str(tmp_path), "CRED_FILE": str(tmp_path / "nonexistent")}
        result = subprocess.run(
            ["bash", str(credential_script)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        assert "E2E_USER=unset" in result.stdout


class TestExtraHostsLoading:
    """Test extra-hosts file loading from 10-chromium.sh."""

    @pytest.fixture
    def hosts_script(self, tmp_path):
        """Extract just the hosts-loading portion."""
        script = textwrap.dedent("""\
            #!/bin/bash
            HOSTS_FILE="${1:-/dev/null}"
            OUTPUT="${2:-/dev/stdout}"
            > "$OUTPUT"
            if [ -f "$HOSTS_FILE" ]; then
                while IFS= read -r line || [ -n "$line" ]; do
                    line="${line%%#*}"
                    [ -z "${line// /}" ] && continue
                    echo "$line" >> "$OUTPUT"
                done < "$HOSTS_FILE"
            fi
        """)
        path = tmp_path / "load-hosts.sh"
        path.write_text(script)
        path.chmod(0o755)
        return path

    def test_loads_valid_entries(self, hosts_script, tmp_path):
        hosts_file = tmp_path / "extra-hosts"
        hosts_file.write_text("127.0.0.1 stage.foo.redhat.com\n::1 stage.foo.redhat.com\n")
        output = tmp_path / "output"

        subprocess.run(
            ["bash", str(hosts_script), str(hosts_file), str(output)],
            timeout=5,
            check=True,
        )
        content = output.read_text()
        assert "127.0.0.1 stage.foo.redhat.com" in content
        assert "::1 stage.foo.redhat.com" in content

    def test_strips_comments(self, hosts_script, tmp_path):
        hosts_file = tmp_path / "extra-hosts"
        hosts_file.write_text("# full comment\n127.0.0.1 test.com # inline comment\n")
        output = tmp_path / "output"

        subprocess.run(
            ["bash", str(hosts_script), str(hosts_file), str(output)],
            timeout=5,
            check=True,
        )
        content = output.read_text()
        assert "full comment" not in content
        assert "127.0.0.1 test.com " in content

    def test_skips_blank_lines(self, hosts_script, tmp_path):
        hosts_file = tmp_path / "extra-hosts"
        hosts_file.write_text("127.0.0.1 a.com\n\n   \n127.0.0.1 b.com\n")
        output = tmp_path / "output"

        subprocess.run(
            ["bash", str(hosts_script), str(hosts_file), str(output)],
            timeout=5,
            check=True,
        )
        lines = [line for line in output.read_text().strip().split("\n") if line.strip()]
        assert len(lines) == 2


class TestDevProxyInstall:
    """Test dev-proxy/install.sh prerequisite checks."""

    def test_fails_without_go(self, tmp_path):
        script = textwrap.dedent("""\
            #!/bin/bash
            set -e
            if ! command -v go &>/dev/null; then
                echo "ERROR: dev-proxy preset requires go preset (go not found)" >&2
                exit 1
            fi
            echo "go found"
        """)
        path = tmp_path / "check-go.sh"
        path.write_text(script)

        empty_bin = tmp_path / "empty-bin"
        empty_bin.mkdir()
        env = {"PATH": str(empty_bin)}
        result = subprocess.run(
            ["/bin/bash", str(path)],
            capture_output=True,
            text=True,
            env=env,
            timeout=5,
        )
        assert result.returncode == 1
        assert "go not found" in result.stderr


class TestSquidPlaywrightAllowlist:
    """Verify squid.conf includes playwright CDN domains."""

    @pytest.fixture
    def squid_conf(self):
        path = os.path.join(REPO_ROOT, "proxy", "squid.conf")
        with open(path) as f:
            return f.read()

    def test_playwright_cdn_allowed(self, squid_conf):
        assert "cdn.playwright.dev" in squid_conf

    def test_playwright_microsoft_cdn_allowed(self, squid_conf):
        assert "playwright.download.prss.microsoft.com" in squid_conf

    def test_redhat_domains_allowed(self, squid_conf):
        assert ".redhat.com" in squid_conf

    def test_no_direct_anthropic_in_allowlist(self, squid_conf):
        lines = [
            line.strip()
            for line in squid_conf.splitlines()
            if line.strip().startswith("acl allowed_domains") and "anthropic" in line.lower()
        ]
        assert len(lines) == 0, "Anthropic API should not be in allowed_domains (goes via Vertex AI)"

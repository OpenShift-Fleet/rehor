"""Tests for git TLS trust configuration in setup_git()."""

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _mock_sdk():
    """Mock claude_agent_sdk so bot.run can be imported locally."""
    sdk = MagicMock()
    sentinel = object()
    prev = sys.modules.get("claude_agent_sdk", sentinel)
    sys.modules["claude_agent_sdk"] = sdk
    for mod_name in list(sys.modules):
        if mod_name.startswith("bot.agent") or mod_name == "bot.run":
            sys.modules.pop(mod_name, None)
    yield
    if prev is sentinel:
        sys.modules.pop("claude_agent_sdk", None)
    else:
        sys.modules["claude_agent_sdk"] = prev
    for mod_name in list(sys.modules):
        if mod_name.startswith("bot.agent") or mod_name == "bot.run":
            sys.modules.pop(mod_name, None)


def _import_run():
    import bot.run as run_mod

    return run_mod


def test_setup_git_adds_gitlab_ssl_ca_config_when_path_set(tmp_path, monkeypatch):
    run_mod = _import_run()

    # Ensure setup_git writes to a test-scoped env var that monkeypatch restores.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "")
    monkeypatch.setenv("GH_USER_NAME", "gh-bot")
    monkeypatch.setenv("GH_USER_EMAIL", "gh-bot@example.com")
    monkeypatch.setenv("GL_USER_NAME", "gl-bot")
    monkeypatch.setenv("GL_USER_EMAIL", "gl-bot@example.com")
    monkeypatch.setenv("GITLAB_CA_CERT_FILE", "/tmp/gitlab-ca.pem")

    run_mod.setup_git(tmp_path)

    config = (tmp_path / ".gitconfig").read_text()
    assert '[http "https://gitlab.cee.redhat.com/"]' in config
    assert "\tsslCAInfo = /tmp/gitlab-ca.pem" in config
    assert "\tsslVerify = true" in config
    assert '[credential "https://gitlab.cee.redhat.com"]' in config


def test_setup_git_keeps_proxy_rewrite_and_adds_tls_config(tmp_path, monkeypatch):
    run_mod = _import_run()

    # Ensure setup_git writes to a test-scoped env var that monkeypatch restores.
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", "")
    monkeypatch.setenv("GH_USER_NAME", "gh-bot")
    monkeypatch.setenv("GH_USER_EMAIL", "gh-bot@example.com")
    monkeypatch.setenv("GL_USER_NAME", "gl-bot")
    monkeypatch.setenv("GL_USER_EMAIL", "gl-bot@example.com")
    monkeypatch.setenv("GIT_AUTH_PROXY_HOST", "devbot-proxy")
    monkeypatch.setenv("GITLAB_CA_CERT_FILE", "/tmp/gitlab-ca.pem")

    run_mod.setup_git(tmp_path)

    config = (tmp_path / ".gitconfig").read_text()
    assert '[url "http://devbot-proxy:8447/gitlab.cee.redhat.com/"]' in config
    assert "\tinsteadOf = https://gitlab.cee.redhat.com/" in config
    assert '[http "https://gitlab.cee.redhat.com/"]' in config
    assert "\tsslCAInfo = /tmp/gitlab-ca.pem" in config

    assert os.environ.get("GIT_CONFIG_GLOBAL") == str(tmp_path / ".gitconfig")


@pytest.mark.parametrize("explicit_global", [False, True])
@pytest.mark.parametrize(
    "platform,host,key",
    [
        ("github", "github.com", "ABCDEF0123456789"),
        ("gitlab", "gitlab.cee.redhat.com", "0123456789ABCDEF"),
    ],
)
def test_private_setup_git_composes_gateway_and_signs(tmp_path, monkeypatch, explicit_global, platform, host, key):
    run_mod = _import_run()
    home = tmp_path / 'private "home"'
    home.mkdir()
    app = home / "app"
    app.mkdir()
    baseline = home / ("custom config" if explicit_global else ".gitconfig")
    gateway_config = (
        '[url "https://gateway.example/git/github.com/"]\n'
        "\tinsteadOf = https://github.com/\n"
        '[url "https://gateway.example/git/gitlab.cee.redhat.com/"]\n'
        "\tinsteadOf = https://gitlab.cee.redhat.com/\n"
        '[http "https://gateway.example/git/"]\n'
        "\textraHeader = Authorization: Bearer openshell:resolve:env:provider\n"
    )
    gateway_file = home / ".gitconfig-gateway"
    gateway_file.write_text(gateway_config)
    baseline_config = "[include]\n\tpath = ~/.gitconfig-gateway\n"
    baseline.write_text(baseline_config)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("REHOR_INPUT_SOURCE", "sandbox")
    monkeypatch.setenv("REHOR_PRIVATE_RUNTIME", "1")
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    if explicit_global:
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(baseline))
    else:
        monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    monkeypatch.setenv("GIT_AUTH_PROXY_HOST", "must-not-be-used")
    for name, value in {
        "GH_USER_NAME": 'GitHub "Bot"',
        "GH_USER_EMAIL": "gh@example.invalid",
        "GL_USER_NAME": "GitLab Bot",
        "GL_USER_EMAIL": "gl@example.invalid",
        "GH_GPG_SIGNING_KEY": "ABCDEF0123456789",
        "GL_GPG_SIGNING_KEY": "0123456789ABCDEF",
    }.items():
        monkeypatch.setenv(name, value)

    run_mod.setup_git(app)
    generated = Path(os.environ["GIT_CONFIG_GLOBAL"])
    assert generated != baseline
    assert baseline.read_text() == baseline_config
    assert gateway_file.read_text() == gateway_config
    assert "must-not-be-used" not in generated.read_text()
    assert "Authorization" not in generated.read_text()
    assert "openshell:resolve" not in generated.read_text()
    repo = tmp_path / "repo"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", f"https://{host}/org/repo.git"], check=True)

    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

    assert git("config", "user.signingkey") == key
    assert git("config", "user.name") == ('GitHub "Bot"' if platform == "github" else "GitLab Bot")
    assert git("config", "user.email") == ("gh@example.invalid" if platform == "github" else "gl@example.invalid")
    assert git("config", "commit.gpgsign") == "true"
    assert (
        git("config", "--get-urlmatch", "http.extraheader", "https://gateway.example/git/github.com/repo")
        == "Authorization: Bearer openshell:resolve:env:provider"
    )
    assert git("remote", "get-url", "origin") == f"https://gateway.example/git/{host}/org/repo.git"

    gpg = tmp_path / "fake-gpg"
    log = tmp_path / "gpg-args"
    gpg.write_text(
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$GPG_TEST_LOG"\ncat >/dev/null\nprintf "%s\\n" "[GNUPG:] SIG_CREATED D 1 8 00 0 ABCDEF" >&2\nprintf "%s\\n" "-----BEGIN PGP SIGNATURE-----" "ZmFrZQ==" "-----END PGP SIGNATURE-----"\n'
    )
    gpg.chmod(0o755)
    monkeypatch.setenv("GPG_TEST_LOG", str(log))
    subprocess.run(["git", "-C", str(repo), "config", "gpg.program", str(gpg)], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "--allow-empty", "-qm", "signed"], check=True)
    assert key in log.read_text().splitlines()
    assert "gpgsig" in git("cat-file", "-p", "HEAD")


def test_private_setup_git_rejects_missing_key_without_overwriting_global(tmp_path, monkeypatch):
    run_mod = _import_run()
    baseline = tmp_path / ".gitconfig"
    baseline.write_text("# preserve gateway\n")
    for name, value in {
        "HOME": str(tmp_path),
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_PRIVATE_RUNTIME": "1",
        "GH_USER_NAME": "gh",
        "GH_USER_EMAIL": "gh@example.invalid",
        "GL_USER_NAME": "gl",
        "GL_USER_EMAIL": "gl@example.invalid",
        "GH_GPG_SIGNING_KEY": "ABCDEF0123456789",
        "GL_GPG_SIGNING_KEY": "not-a-key-id",
        "GIT_CONFIG_GLOBAL": str(baseline),
    }.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match="signing key IDs"):
        run_mod.setup_git(tmp_path)
    assert baseline.read_text() == "# preserve gateway\n"
    assert os.environ["GIT_CONFIG_GLOBAL"] == str(baseline)


@pytest.mark.parametrize("global_setting", ["missing", "empty"])
def test_private_setup_git_rejects_missing_gateway_config(tmp_path, monkeypatch, global_setting):
    run_mod = _import_run()
    for name, value in {
        "HOME": str(tmp_path),
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_PRIVATE_RUNTIME": "1",
        "GH_USER_NAME": "gh",
        "GH_USER_EMAIL": "gh@example.invalid",
        "GL_USER_NAME": "gl",
        "GL_USER_EMAIL": "gl@example.invalid",
        "GH_GPG_SIGNING_KEY": "ABCDEF0123456789",
        "GL_GPG_SIGNING_KEY": "0123456789ABCDEF",
    }.items():
        monkeypatch.setenv(name, value)
    if global_setting == "empty":
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", "")
    else:
        monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    with pytest.raises(ValueError, match="bootstrap Git config"):
        run_mod.setup_git(tmp_path)

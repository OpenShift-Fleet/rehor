"""Tests for git TLS trust configuration in setup_git()."""

import os
import sys
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

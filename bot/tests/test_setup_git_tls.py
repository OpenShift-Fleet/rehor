"""Tests for git TLS trust configuration in setup_git()."""

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
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
    "platform,host",
    [
        ("github", "github.com"),
        ("gitlab", "gitlab.cee.redhat.com"),
    ],
)
def test_private_setup_git_composes_gateway_and_signs(tmp_path, monkeypatch, explicit_global, platform, host):
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
    monkeypatch.setenv("EXECUTOR_HTTP_URL", "https://gateway.example/executor/execute")
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
        "GH_GPG_SIGNING_KEY": "ignored-legacy-key",
        "GL_GPG_SIGNING_KEY": "ignored-legacy-key",
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

    assert subprocess.run(["git", "-C", str(repo), "config", "--get", "user.signingkey"]).returncode == 1
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
    identity = git("var", "GIT_COMMITTER_IDENT").rsplit(" ", 2)[0]
    assert log.read_text().splitlines()[-2:] == ["-bsau", identity]
    assert "gpgsig" in git("cat-file", "-p", "HEAD")
    head = git("rev-parse", "HEAD")
    failed = subprocess.run(
        ["git", "-C", str(repo), "-c", "gpg.program=/bin/false", "commit", "--allow-empty", "-qm", "must fail"],
        capture_output=True,
    )
    assert failed.returncode != 0
    assert git("rev-parse", "HEAD") == head


@pytest.mark.parametrize("global_setting", ["missing", "empty"])
def test_private_setup_git_rejects_missing_gateway_config(tmp_path, monkeypatch, global_setting):
    run_mod = _import_run()
    for name, value in {
        "HOME": str(tmp_path),
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_PRIVATE_RUNTIME": "1",
        "EXECUTOR_HTTP_URL": "https://gateway.example/executor/execute",
        "GH_USER_NAME": "gh",
        "GH_USER_EMAIL": "gh@example.invalid",
        "GL_USER_NAME": "gl",
        "GL_USER_EMAIL": "gl@example.invalid",
    }.items():
        monkeypatch.setenv(name, value)
    if global_setting == "empty":
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", "")
    else:
        monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    with pytest.raises(ValueError, match="bootstrap Git config"):
        run_mod.setup_git(tmp_path)


@pytest.mark.parametrize("missing", ["GH_USER_NAME", "GH_USER_EMAIL", "GL_USER_NAME", "GL_USER_EMAIL"])
def test_private_setup_git_rejects_incomplete_configuration(tmp_path, monkeypatch, missing):
    run_mod = _import_run()
    (tmp_path / ".gitconfig").write_text("# bootstrap\n")
    values = {
        "HOME": str(tmp_path),
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_PRIVATE_RUNTIME": "1",
        "EXECUTOR_HTTP_URL": "https://gateway.example/executor/execute",
        "GH_USER_NAME": "gh",
        "GH_USER_EMAIL": "gh@example.invalid",
        "GL_USER_NAME": "gl",
        "GL_USER_EMAIL": "gl@example.invalid",
    }
    values[missing] = ""
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / ".gitconfig"))
    with pytest.raises(ValueError, match="both Git identities"):
        run_mod.setup_git(tmp_path)


@pytest.mark.skipif(not shutil.which("gpg") or not shutil.which("git"), reason="git and gpg required")
def test_private_setup_git_selects_two_real_keys(tmp_path, monkeypatch):
    run_mod = _import_run()
    # GPG agent socket paths have a short platform limit.
    with tempfile.TemporaryDirectory(prefix="rehor-gpg-", dir="/tmp") as keyring:
        monkeypatch.setenv("GNUPGHOME", keyring)
        try:
            for identity in ("GitHub Bot <gh@example.invalid>", "GitLab Bot <gl@example.invalid>"):
                subprocess.run(
                    [
                        "gpg",
                        "--batch",
                        "--pinentry-mode",
                        "loopback",
                        "--passphrase",
                        "",
                        "--quick-generate-key",
                        identity,
                        "ed25519",
                        "sign",
                        "0",
                    ],
                    check=True,
                    capture_output=True,
                )
            home = tmp_path / "home"
            home.mkdir()
            baseline = home / ".gitconfig"
            baseline.write_text("# bootstrap\n")
            for name, value in {
                "HOME": str(home),
                "GIT_CONFIG_GLOBAL": str(baseline),
                "GIT_CONFIG_NOSYSTEM": "1",
                "REHOR_INPUT_SOURCE": "sandbox",
                "REHOR_PRIVATE_RUNTIME": "1",
                "EXECUTOR_HTTP_URL": "https://gateway.example/executor/execute",
                "GH_USER_NAME": "GitHub Bot",
                "GH_USER_EMAIL": "gh@example.invalid",
                "GL_USER_NAME": "GitLab Bot",
                "GL_USER_EMAIL": "gl@example.invalid",
            }.items():
                monkeypatch.setenv(name, value)
            monkeypatch.delenv("GH_GPG_SIGNING_KEY", raising=False)
            monkeypatch.delenv("GL_GPG_SIGNING_KEY", raising=False)
            run_mod.setup_git(home)
            wrapper = tmp_path / "gpg-wrapper"
            wrapper.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$@" > "$GPG_ARG_LOG"\nexec ' + shlex.quote(shutil.which("gpg")) + ' "$@"\n'
            )
            wrapper.chmod(0o755)
            selected = []
            for i, (host, identity) in enumerate(
                (
                    ("github.com", "GitHub Bot <gh@example.invalid>"),
                    ("gitlab.cee.redhat.com", "GitLab Bot <gl@example.invalid>"),
                )
            ):
                repo = tmp_path / host
                log = tmp_path / f"gpg-args-{i}"
                monkeypatch.setenv("GPG_ARG_LOG", str(log))
                listing = subprocess.check_output(["gpg", "--with-colons", "--list-keys", identity], text=True)
                key = next(line.split(":")[9] for line in listing.splitlines() if line.startswith("fpr:"))
                selected.append(key)
                subprocess.run(["git", "init", "-q", str(repo)], check=True)
                subprocess.run(
                    ["git", "-C", str(repo), "remote", "add", "origin", f"https://{host}/org/repo"], check=True
                )
                assert subprocess.run(["git", "-C", str(repo), "config", "--get", "user.signingkey"]).returncode == 1
                subprocess.run(
                    [
                        "git",
                        "-C",
                        str(repo),
                        "-c",
                        f"gpg.program={wrapper}",
                        "commit",
                        "--allow-empty",
                        "-qm",
                        "signed",
                    ],
                    check=True,
                )
                args = log.read_text().splitlines()
                assert args[-2:] == ["-bsau", identity]
                verification = subprocess.run(
                    ["git", "-C", str(repo), "verify-commit", "--raw", "HEAD"],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                assert f"[GNUPG:] VALIDSIG {key} " in verification.stderr
            assert len(set(selected)) == 2
        finally:
            if shutil.which("gpgconf"):
                subprocess.run(
                    ["gpgconf", "--homedir", keyring, "--kill", "gpg-agent"], check=False, capture_output=True
                )

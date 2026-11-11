"""Private runtime bootstrap tests; no services, credentials or preflights."""

import importlib.util
import os
import shutil
import ssl
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

BOOTSTRAP = Path(__file__).resolve().parents[1] / "scripts" / "sandbox-bootstrap.py"
PLACEHOLDER = "openshell:resolve:env:BOT_MEMORY_TOKEN"


@pytest.fixture
def runtime(tmp_path: Path) -> tuple[Path, Path]:
    source = tmp_path / "image" / "app"
    parent = tmp_path / "writable"
    (source / ".venv" / "bin").mkdir(parents=True)
    (source / "coordinator" / "node_modules").mkdir(parents=True)
    parent.mkdir()
    (source / "config.json").write_text("{}")
    (source / "config.json").chmod(0o444)
    (source / "entrypoint.sh").write_text(
        '#!/bin/bash\nprintf "%s\\n" "$HOME" "$PWD" "$REHOR_WORKSPACE_OWNER_UID" '
        '"$REHOR_WORKSPACE_ROOT" "$REHOR_SCRIPT_DIR" "$PYTHONPATH"\n'
    )
    return source, parent


def run(source: Path, parent: Path, **extra: str) -> subprocess.CompletedProcess[str]:
    env = {
        "PATH": os.defpath,
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_RUNTIME_SOURCE": str(source),
        "REHOR_RUNTIME_PARENT": str(parent),
        "REHOR_WORKSPACE_OWNER_UID": "1000",
        **extra,
    }
    return subprocess.run([sys.executable, str(BOOTSTRAP)], env=env, text=True, capture_output=True, check=False)


def test_private_workspace_owned_by_actual_uid_and_dependencies_shared(runtime: tuple[Path, Path]) -> None:
    source, parent = runtime
    first = run(source, parent)
    second = run(source, parent)
    assert first.returncode == second.returncode == 0
    home, app, owner, root, script, pythonpath = first.stdout.splitlines()
    home_path, app_path = Path(home), Path(app)
    private = home_path.parent
    assert private != Path(second.stdout.splitlines()[0]).parent
    for directory in (private, home_path, app_path):
        assert directory.stat().st_uid == os.geteuid()
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert owner == str(os.geteuid())
    assert root == script == pythonpath == app
    assert (app_path / ".venv").resolve() == source / ".venv"
    assert (app_path / "coordinator" / "node_modules").resolve() == source / "coordinator" / "node_modules"
    assert (app_path / "config.json").stat().st_mode & stat.S_IWUSR
    assert stat.S_IMODE((source / "config.json").stat().st_mode) == 0o444


def test_rejects_non_sandbox_and_external_configuration_symlink(runtime: tuple[Path, Path], tmp_path: Path) -> None:
    source, parent = runtime
    assert run(source, parent, REHOR_INPUT_SOURCE="legacy").returncode == 1
    (source / "external").symlink_to(tmp_path)
    result = run(source, parent)
    assert result.returncode == 1
    assert result.stderr == "FATAL: private runner bootstrap failed\n"
    assert not list(parent.iterdir())


def test_rejects_absolute_symlink_even_when_it_points_inside_source(runtime: tuple[Path, Path]) -> None:
    source, parent = runtime
    (source / "alias").symlink_to(source / "config.json")
    assert run(source, parent).returncode == 1
    assert not list(parent.iterdir())


def test_deployment_config_mapping_and_missing_path(runtime: tuple[Path, Path]) -> None:
    source, parent = runtime
    (source / "entrypoint.sh").write_text(
        '#!/bin/bash\nprintf "%s\\n" "$PWD" "$REHOR_OPENCODE_DEPLOYMENT_CONFIG" "$PATH"\n'
    )
    for config in (
        "/home/botuser/app/instance/rehor-onboarding-config/opencode-deployment.json",
        "/opt/external/deployment.json",
        "/home/botuser/app/../other/deployment.json",
    ):
        env = {
            "REHOR_INPUT_SOURCE": "sandbox",
            "REHOR_RUNTIME_SOURCE": str(source),
            "REHOR_RUNTIME_PARENT": str(parent),
            "REHOR_OPENCODE_DEPLOYMENT_CONFIG": config,
        }
        result = subprocess.run([sys.executable, str(BOOTSTRAP)], env=env, text=True, capture_output=True, check=False)
        assert result.returncode == 0
        app, mapped, path = result.stdout.splitlines()
        expected = str(Path(app) / config.removeprefix("/home/botuser/app/")) if "/instance/" in config else config
        assert mapped == expected
        assert {"/usr/local/bin", "/usr/bin", "/bin"}.issubset(path.split(":"))


def git_env(home: Path, **extra: str) -> dict[str, str]:
    return {
        "PATH": os.defpath,
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        **extra,
    }


def git(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], env=env, text=True, capture_output=True, check=False)


def test_git_gateway_global_config_and_runner_precedence(runtime: tuple[Path, Path]) -> None:
    source, parent = runtime
    (source / "entrypoint.sh").write_text('#!/bin/bash\nprintf "%s\\n" "$HOME" "$GIT_CONFIG_GLOBAL"\n')
    route = "https://services.example:8443/executor/execute"
    result = run(
        source,
        parent,
        EXECUTOR_HTTP_URL=route,
        BOT_MEMORY_TOKEN=PLACEHOLDER,
        GIT_CONFIG_GLOBAL="/invalid/inherited/config",
    )
    assert result.returncode == 0
    home_line, selected = result.stdout.splitlines()
    home = Path(home_line)
    global_config, gateway = home / ".gitconfig", home / ".gitconfig-gateway"
    assert selected == str(global_config)
    for path in (global_config, gateway):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert PLACEHOLDER in gateway.read_text()
    assert PLACEHOLDER not in result.stdout + result.stderr
    env = git_env(home)
    assert git(env, "config", "--global", "credential.https://github.com.helper", "helper-example").returncode == 0
    assert git(env, "config", "--get", "http.sslVerify").returncode == 1
    assert git(env, "config", "--get", "http.followRedirects").returncode == 1
    for host in ("github.com", "gitlab.cee.redhat.com"):
        source_url = f"https://{host}/group/repo.git"
        target_url = f"https://services.example:8443/git/{host}/group/repo.git"
        assert git(env, "ls-remote", "--get-url", source_url).stdout.strip() == target_url
        header = git(env, "config", "--get-urlmatch", "http.extraHeader", target_url)
        assert header.stdout.strip() == f"Authorization: Bearer {PLACEHOLDER}"
    for url in (
        "https://other.example/git/github.com/group/repo.git",
        "https://services.example:8443/unrelated/repo.git",
        "https://services.example:8443/git/github.com.evil/repo.git",
    ):
        assert git(env, "config", "--get-urlmatch", "http.extraHeader", url).returncode == 1
    assert (
        git(env, "ls-remote", "--get-url", "https://github.com.evil/group/repo").stdout.strip()
        == "https://github.com.evil/group/repo"
    )

    # Model runner.setup_git's generated config: include must precede any
    # competing equal-length legacy insteadOf mappings.
    generated = home / "runner.gitconfig"
    generated.write_text(
        f"[include]\n\tpath = {global_config}\n"
        '[url "http://legacy:8447/github.com/"]\n\tinsteadOf = https://github.com/\n'
        "[user]\n\tname = Example Bot\n"
    )
    env["GIT_CONFIG_GLOBAL"] = str(generated)
    assert (
        git(env, "ls-remote", "--get-url", "https://github.com/group/repo").stdout.strip()
        == "https://services.example:8443/git/github.com/group/repo"
    )
    assert git(env, "config", "user.name").stdout.strip() == "Example Bot"
    assert (
        git(
            env,
            "config",
            "--get-urlmatch",
            "http.extraHeader",
            "https://services.example:8443/git/github.com/group/repo",
        ).stdout.strip()
        == f"Authorization: Bearer {PLACEHOLDER}"
    )


def test_git_config_idempotent_and_preserves_global_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = importlib.util.spec_from_file_location("sandbox_bootstrap", BOOTSTRAP)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    monkeypatch.setenv("EXECUTOR_HTTP_URL", "https://services.example/executor/execute")
    monkeypatch.setenv("BOT_MEMORY_TOKEN", PLACEHOLDER)
    config = tmp_path / ".gitconfig"
    config.write_text("[user]\n\tname = Existing Bot\n")
    module.configure_git(tmp_path)
    before = config.read_text(), (tmp_path / ".gitconfig-gateway").read_text()
    module.configure_git(tmp_path)
    assert before == (config.read_text(), (tmp_path / ".gitconfig-gateway").read_text())
    assert git(git_env(tmp_path), "config", "user.name").stdout.strip() == "Existing Bot"
    monkeypatch.setenv("EXECUTOR_HTTP_URL", "https://new.example/executor/execute")
    module.configure_git(tmp_path)
    assert config.read_text() == before[0]
    assert "https://new.example/git/github.com/" in (tmp_path / ".gitconfig-gateway").read_text()
    assert "services.example" not in (tmp_path / ".gitconfig-gateway").read_text()


@pytest.mark.parametrize(
    "url,token",
    [
        ("https://services.example/executor/execute", "actual.secret.token"),
        ("https://services.example/executor/execute", PLACEHOLDER + "\n"),
        ("https://services.example/executor/execute?", PLACEHOLDER),
        ("https://user@services.example/executor/execute", PLACEHOLDER),
        ("https://services.example:0/executor/execute", PLACEHOLDER),
        ('https://services.example"evil/executor/execute', PLACEHOLDER),
        ("https://services.example/other", PLACEHOLDER),
    ],
)
def test_git_gateway_rejects_invalid_route_or_placeholder(runtime: tuple[Path, Path], url: str, token: str) -> None:
    source, parent = runtime
    result = run(source, parent, EXECUTOR_HTTP_URL=url, BOT_MEMORY_TOKEN=token)
    assert result.returncode == 1
    assert result.stderr == "FATAL: private runner bootstrap failed\n"
    assert token not in result.stdout + result.stderr
    for path in parent.rglob(".gitconfig*"):
        assert "actual.secret.token" not in path.read_text()


def test_legacy_http_executor_has_no_git_gateway(runtime: tuple[Path, Path]) -> None:
    source, parent = runtime
    result = run(source, parent, EXECUTOR_HTTP_URL="http://executor:8080/executor/execute")
    assert result.returncode == 0
    home = Path(result.stdout.splitlines()[0])
    assert not (home / ".gitconfig").exists()
    assert not (home / ".gitconfig-gateway").exists()


@pytest.fixture
def git_servers(tmp_path: Path):
    if not shutil.which("openssl") or not shutil.which("git"):
        pytest.skip("local Git and OpenSSL required")
    cert, key = tmp_path / "cert.pem", tmp_path / "key.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=DNS:localhost,IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(cert),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    requests = []
    redirect = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append((self.server.server_port, self.path, self.headers.get_all("Authorization")))
            if self.server.server_port == redirect.get("port") and "/redirect.git/" in self.path:
                self.send_response(302)
                self.send_header("Location", redirect["url"] + self.path)
            else:
                self.send_response(404)
            self.end_headers()

        def log_message(self, *_args):
            pass

    servers = [ThreadingHTTPServer(("127.0.0.1", 0), Handler) for _ in range(2)]
    for server in servers:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    origins = [f"https://localhost:{servers[0].server_port}", f"https://127.0.0.1:{servers[1].server_port}"]
    redirect["url"] = origins[1]
    redirect["port"] = servers[0].server_port
    try:
        yield cert, origins, requests
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


def test_git_https_requests_scope_and_cross_origin_redirect(runtime: tuple[Path, Path], git_servers) -> None:
    source, parent = runtime
    cert, origins, requests = git_servers
    result = run(source, parent, EXECUTOR_HTTP_URL=origins[0] + "/executor/execute", BOT_MEMORY_TOKEN=PLACEHOLDER)
    assert result.returncode == 0
    home = Path(result.stdout.splitlines()[0])
    untrusted = git(git_env(home, NO_PROXY="localhost,127.0.0.1"), "ls-remote", "https://github.com/group/repo.git")
    assert untrusted.returncode != 0
    assert not requests  # Default TLS verification rejected the self-signed server.
    env = git_env(home, GIT_SSL_CAINFO=str(cert), NO_PROXY="localhost,127.0.0.1")
    for host in ("github.com", "gitlab.cee.redhat.com"):
        git(env, "ls-remote", f"https://{host}/group/repo.git")
        assert requests[-1][1].startswith(f"/git/{host}/group/repo.git/")
        assert requests[-1][2] == [f"Bearer {PLACEHOLDER}"]
    git(env, "ls-remote", origins[0] + "/unrelated/repo.git")
    assert requests[-1][1].startswith("/unrelated/")
    assert requests[-1][2] is None
    redirect_result = git(env, "ls-remote", "https://github.com/group/redirect.git")
    assert len(requests) == 5, (requests, redirect_result.stderr)
    assert requests[-2][2] == [f"Bearer {PLACEHOLDER}"]
    assert requests[-1][0] != requests[-2][0]
    assert requests[-1][2] is None

"""Exercise engine selection without starting an agent or running preflights."""

import socket
import subprocess
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "entrypoint.sh"


@pytest.mark.parametrize("engine", [None, "", "python", "unsupported"])
def test_sandbox_rejects_non_coordinator_before_setup(tmp_path, engine):
    env = {"PATH": str(tmp_path), "REHOR_INPUT_SOURCE": "sandbox"}
    if engine is not None:
        env["BOT_EXECUTION_ENGINE"] = engine
    result = subprocess.run(["/bin/bash", str(ENTRYPOINT)], env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == 64
    assert "sandbox dispatch requires BOT_EXECUTION_ENGINE=coordinator" in result.stderr
    assert "Missing required tools" not in result.stderr
    assert not result.stdout


@pytest.mark.parametrize("source", [None, "", "legacy"])
@pytest.mark.parametrize("engine", [None, "", "python"])
def test_legacy_default_python_executes_uv_without_agent(tmp_path, source, engine):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name in ("gh", "glab", "git", "gpg", "sed"):
        stub = bindir / name
        stub.write_text("#!/bin/bash\nexit 0\n")
        stub.chmod(0o755)
    uv = bindir / "uv"
    uv.write_text('#!/bin/bash\nprintf "FAKE_UV:%s\\n" "$*"\n')
    uv.chmod(0o755)

    home = tmp_path / "home"
    home.mkdir()
    # Keep deployment git configuration and system profiles outside the test.
    script = tmp_path / "entrypoint.sh"
    script.write_text(
        ENTRYPOINT.read_text()
        .replace("/home/botuser", str(home))
        .replace("/etc/profile.d/*.sh", str(tmp_path / "no-profiles" / "*.sh"))
    )
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin",
        "HOME": str(home),
        "BOT_LABEL": "test",
        "BOT_MEMORY_URL": "http://example.invalid/mcp",
        "GH_USER_EMAIL": "test@example.invalid",
        "GL_USER_EMAIL": "test@example.invalid",
        "GH_USER_NAME": "test",
        "GL_USER_NAME": "test",
    }
    if source is not None:
        env["REHOR_INPUT_SOURCE"] = source
    if engine is not None:
        env["BOT_EXECUTION_ENGINE"] = engine
    with socket.socket(socket.AF_INET) as executor:
        executor.bind(("127.0.0.1", 0))
        executor.listen()
        env["EXECUTOR_ADDR"] = f"127.0.0.1:{executor.getsockname()[1]}"
        result = subprocess.run(
            ["/bin/bash", str(script)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=5
        )
    assert result.returncode == 0, result.stderr
    assert "FAKE_UV:run dev-bot --label test" in result.stdout
    assert "sandbox dispatch requires" not in result.stderr


@pytest.mark.parametrize("profile_changes_engine", [False, True])
def test_sandbox_coordinator_selection_is_preserved(tmp_path, profile_changes_engine):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name in ("gh", "glab", "git", "gpg"):
        stub = bindir / name
        stub.write_text("#!/bin/bash\nexit 0\n")
        stub.chmod(0o755)
    node = bindir / "node"
    node.write_text('#!/bin/bash\nprintf "FAKE_NODE:%s\\n" "$*"\n')
    node.chmod(0o755)
    profile = tmp_path / "profile.sh"
    profile.write_text("BOT_EXECUTION_ENGINE=python\n" if profile_changes_engine else ":\n")
    script = tmp_path / "entrypoint.sh"
    script.write_text(ENTRYPOINT.read_text().replace("/etc/profile.d/*.sh", str(profile)))
    bundle = tmp_path / "coordinator" / "dist" / "cli.js"
    bundle.parent.mkdir(parents=True)
    bundle.touch()
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "BOT_LABEL": "test",
        "BOT_EXECUTION_ENGINE": "coordinator",
        "REHOR_INPUT_SOURCE": "sandbox",
        "REHOR_PRIVATE_RUNTIME": "1",
    }
    result = subprocess.run(
        ["/bin/bash", str(script)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=5
    )
    if profile_changes_engine:
        assert result.returncode == 64
        assert "sandbox dispatch requires BOT_EXECUTION_ENGINE=coordinator" in result.stderr
        assert "FAKE_NODE" not in result.stdout
    else:
        assert result.returncode == 0, result.stderr
        assert f"FAKE_NODE:{bundle} --label test --once" in result.stdout

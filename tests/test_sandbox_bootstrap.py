"""Private runtime bootstrap tests; no services, credentials or preflights."""

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

BOOTSTRAP = Path(__file__).resolve().parents[1] / "scripts" / "sandbox-bootstrap.py"


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

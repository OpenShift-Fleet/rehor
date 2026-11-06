#!/usr/bin/python3.12
"""Start a dispatched runner in a per-process, private writable workspace."""

import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def configure_routes(app: Path) -> None:
    urls = {name: os.environ.get(name, "") for name in ("REHOR_MODEL_PROXY_URL", "BOT_MEMORY_URL", "JIRA_MCP_URL")}
    https = {}
    for name, value in urls.items():
        parsed = urlsplit(value)
        https[name] = parsed.scheme == "https"
        if https[name] and (
            not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
        ):
            raise RuntimeError("invalid authenticated route")

    placeholder = os.environ.get("BOT_MEMORY_TOKEN", "")
    if any(https.values()) and not re.fullmatch(r"openshell:resolve:env:[A-Za-z0-9_]+", placeholder):
        raise RuntimeError("authenticated route requires a provider placeholder")
    if https["REHOR_MODEL_PROXY_URL"]:
        os.environ["REHOR_MODEL_PROXY_TOKEN"] = placeholder

    for env_name, relative_path, server_name in (
        ("BOT_MEMORY_URL", ".mcp.json", "bot-memory"),
        ("JIRA_MCP_URL", "bot/mcp.json", "mcp-atlassian"),
    ):
        if not urls[env_name]:
            continue
        path = app / relative_path
        if not path.resolve().is_relative_to(app.resolve()):
            raise RuntimeError("MCP config is outside the private workspace")
        data = json.loads(path.read_text(encoding="utf-8"))
        server = data["mcpServers"][server_name]
        server["url"] = urls[env_name]
        if https[env_name]:
            headers = server.setdefault("headers", {})
            for name in list(headers):
                if name.lower() == "authorization":
                    del headers[name]
            headers["Authorization"] = f"Bearer {placeholder}"
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        path.chmod(0o600)


def main() -> None:
    if os.environ.get("REHOR_INPUT_SOURCE") != "sandbox":
        raise RuntimeError("private bootstrap requires sandbox input")
    source = Path(os.environ.get("REHOR_RUNTIME_SOURCE", "/opt/rehor/app"))
    parent = Path(os.environ.get("REHOR_RUNTIME_PARENT", "/tmp"))
    if not source.is_absolute() or not parent.is_absolute():
        raise RuntimeError("runtime paths must be absolute")
    # The source is image-owned; never follow a link outside it when copying
    # configuration. Dependencies are deliberately linked separately below.
    for directory, dirs, files in os.walk(source, followlinks=False):
        if Path(directory) == source:
            dirs[:] = [name for name in dirs if name != ".venv"]
        if Path(directory) == source / "coordinator":
            dirs[:] = [name for name in dirs if name != "node_modules"]
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink() and (
                path.readlink().is_absolute() or not path.resolve().is_relative_to(source.resolve())
            ):
                raise RuntimeError("runtime source contains an external symlink")
    os.umask(0o077)
    private = Path(tempfile.mkdtemp(prefix="rehor-runtime-", dir=parent))
    info = private.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("private runtime directory has unexpected owner or mode")
    home = private / "home"
    app = home / "app"
    home.mkdir(mode=0o700)
    shutil.copytree(
        source,
        app,
        symlinks=True,
        ignore=lambda directory, names: {
            name
            for name in names
            if (
                (Path(directory) == source and name == ".venv")
                or (Path(directory) == source / "coordinator" and name == "node_modules")
            )
        },
    )
    for directory, dirs, files in os.walk(app, followlinks=False):
        for name in [".", *dirs, *files]:
            path = Path(directory) / name
            if not path.is_symlink():
                path.chmod(path.stat().st_mode | stat.S_IRUSR | stat.S_IWUSR)
    app.chmod(0o700)
    (app / ".venv").symlink_to(source / ".venv", target_is_directory=True)
    (app / "coordinator" / "node_modules").symlink_to(source / "coordinator" / "node_modules", target_is_directory=True)
    configure_routes(app)
    path = ":".join(
        part
        for part in (os.environ.get("PATH") or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").split(
            ":"
        )
        if part not in {"/home/botuser/app/.venv/bin", "/home/botuser/go/bin"}
    )
    deployment_config = os.environ.get("REHOR_OPENCODE_DEPLOYMENT_CONFIG")
    if deployment_config:
        try:
            relative_config = Path(deployment_config).relative_to("/home/botuser/app")
            if ".." not in relative_config.parts:
                os.environ["REHOR_OPENCODE_DEPLOYMENT_CONFIG"] = str(app / relative_config)
        except ValueError:
            pass
    os.environ.update(
        {
            "HOME": str(home),
            "GOPATH": str(home / "go"),
            "REHOR_SCRIPT_DIR": str(app),
            "REHOR_WORKSPACE_ROOT": str(app),
            "REHOR_WORKSPACE_OWNER_UID": str(os.geteuid()),
            "PYTHONPATH": str(app),
            "PATH": f"{source}/.venv/bin:{home}/go/bin:{path}",
            "REHOR_PRIVATE_RUNTIME": "1",
        }
    )
    os.chdir(app)
    os.execv("/bin/bash", ["/bin/bash", str(app / "entrypoint.sh")])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not expose image configuration or runtime environment in logs.
        print("FATAL: private runner bootstrap failed", file=sys.stderr)
        sys.exit(1)

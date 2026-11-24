#!/usr/bin/python3.12
"""Start a dispatched runner in a per-process, private writable workspace."""

import ipaddress
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


def configure_git(home: Path) -> None:
    """Route sandbox Git HTTPS traffic through the authenticated services gateway."""
    value = os.environ.get("EXECUTOR_HTTP_URL", "")
    if not value or urlsplit(value).scheme != "https":
        return

    parsed = urlsplit(value)
    placeholder = os.environ.get("BOT_MEMORY_TOKEN", "")
    if (
        any(ord(c) <= 32 or ord(c) == 127 for c in value)
        or "\\" in value
        or parsed.path != "/executor/execute"
        or parsed.username is not None
        or parsed.password is not None
        or "?" in value
        or "#" in value
        or not re.fullmatch(r"openshell:resolve:env:[A-Za-z0-9_]+", placeholder)
    ):
        raise RuntimeError("invalid authenticated Git route")
    # Restrict the authority before embedding it in Git's config subsections.
    authority = parsed.netloc
    if authority.startswith("["):
        if not re.fullmatch(r"\[[0-9A-Fa-f:.]+\](?::[0-9]+)?", authority):
            raise RuntimeError("invalid services gateway authority")
        try:
            ipaddress.IPv6Address(parsed.hostname or "")
        except ValueError:
            raise RuntimeError("invalid services gateway authority") from None
    else:
        if not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", authority):
            raise RuntimeError("invalid services gateway authority")
        hostname = (parsed.hostname or "").rstrip(".")
        if len(hostname) > 253 or not all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in hostname.split(".")
        ):
            raise RuntimeError("invalid services gateway authority")
    if parsed.port == 0:
        raise RuntimeError("invalid services gateway authority")

    origin = f"https://{authority}"
    gateway = home / ".gitconfig-gateway"
    global_config = home / ".gitconfig"
    lines = ["# Private sandbox services gateway; contains only a provider placeholder."]
    for host in ("github.com", "gitlab.cee.redhat.com"):
        target = f"{origin}/git/{host}/"
        lines.extend(
            (
                f'[url "{target}"]',
                f"\tinsteadOf = https://{host}/",
                f'[http "{target}"]',
                f"\textraHeader = Authorization: Bearer {placeholder}",
            )
        )

    # The home is newly created and private. O_NOFOLLOW also prevents accidental
    # writes through a link if this function is called again.
    def write_private(path: Path, content: str) -> None:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(content)

    write_private(gateway, "\n".join(lines) + "\n")
    include = "[include]\n\tpath = ~/.gitconfig-gateway\n"
    if global_config.is_symlink():
        raise RuntimeError("invalid private Git config")
    current = global_config.read_text(encoding="utf-8") if global_config.exists() else ""
    if include not in current:
        if current and not current.endswith("\n"):
            current += "\n"
        current += include
    write_private(global_config, current)
    # Ignore an inherited global-config override; later runner configuration
    # must include this file when it sets its own GIT_CONFIG_GLOBAL.
    os.environ["GIT_CONFIG_GLOBAL"] = str(global_config)


def configure_routes(app: Path) -> None:
    if os.environ.get("REHOR_INPUT_SOURCE") != "sandbox":
        raise RuntimeError("private bootstrap requires sandbox input")
    urls = {
        name: os.environ.get(name, "")
        for name in ("REHOR_MODEL_PROXY_URL", "BOT_MEMORY_URL", "JIRA_MCP_URL", "EXECUTOR_HTTP_URL")
    }
    https = {}
    for name, value in urls.items():
        https[name] = False
        if value:
            try:
                parsed = urlsplit(value)
                if (
                    any(ord(c) <= 32 or ord(c) == 127 for c in value)
                    or "\\" in value
                    or parsed.scheme not in ("http", "https")
                    or not parsed.hostname
                    or parsed.username is not None
                    or parsed.password is not None
                    or "?" in value
                    or "#" in value
                    or (name == "EXECUTOR_HTTP_URL" and parsed.path != "/executor/execute")
                ):
                    raise ValueError
                _ = parsed.port
                https[name] = parsed.scheme == "https"
            except ValueError:
                raise RuntimeError("invalid authenticated route") from None

    placeholder = os.environ.get("BOT_MEMORY_TOKEN", "")
    if any(https.values()) and not re.fullmatch(r"openshell:resolve:env:[A-Za-z0-9_]+", placeholder):
        raise RuntimeError("authenticated route requires a provider placeholder")
    if https["REHOR_MODEL_PROXY_URL"]:
        os.environ["REHOR_MODEL_PROXY_TOKEN"] = placeholder
    os.environ.pop("EXECUTOR_TOKEN", None)
    if https["EXECUTOR_HTTP_URL"]:
        os.environ["EXECUTOR_TOKEN"] = placeholder

    for env_name, relative_path, server_name in (
        ("BOT_MEMORY_URL", ".mcp.json", "bot-memory"),
        ("JIRA_MCP_URL", "bot/mcp.json", "mcp-atlassian"),
    ):
        if not urls[env_name] and not (env_name == "BOT_MEMORY_URL" and os.environ.get("BOT_INSTANCE_ID")):
            continue
        path = app / relative_path
        if not path.resolve().is_relative_to(app.resolve()):
            raise RuntimeError("MCP config is outside the private workspace")
        data = json.loads(path.read_text(encoding="utf-8"))
        server = data["mcpServers"][server_name]
        if urls[env_name]:
            server["url"] = urls[env_name]
        headers = server.setdefault("headers", {})
        for name in list(headers):
            if name.lower() == "authorization" or (
                env_name == "BOT_MEMORY_URL" and name.lower() == "x-bot-instance-id"
            ):
                del headers[name]
        if https[env_name]:
            headers["Authorization"] = f"Bearer {placeholder}"
        if env_name == "BOT_MEMORY_URL" and os.environ.get("BOT_INSTANCE_ID"):
            # Node HTTP headers are Latin-1 strings; memory-server decodes the
            # resulting wire bytes as UTF-8 after ASGI's Latin-1 decoding.
            headers["X-Bot-Instance-Id"] = os.environ["BOT_INSTANCE_ID"].encode("utf-8").decode("latin-1")
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
    configure_git(home)
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

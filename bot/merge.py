"""Merge engine for remote config with protected-key registry.

Combines remote config repo contents with built-in bot configuration.
Bot-critical config always wins; remote config adds/extends everything else.
"""

import json
import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

PROTECTED = {
    "settings": ["permissions", "sandbox", "hooks.PreToolUse", "hooks.PostToolUse"],
    "skills": [
        "triage",
        "post-pr",
        "wrap-up",
        "new-work",
        "claim-ticket",
        "push-and-pr",
    ],
    "mcps": ["bot-memory", "mcp-atlassian", "chrome-devtools"],
    "project_repos_fields": ["url", "upstream"],
}

PROTECTED_HOOKS = ["validate-bash.sh", "block-secrets-read.sh", "scan-secrets.sh"]


@dataclass
class MergeReport:
    added: list[str] = field(default_factory=list)
    overridden: list[str] = field(default_factory=list)
    protected: list[str] = field(default_factory=list)

    def log(self) -> None:
        if self.added:
            logger.info("Remote config added: %s", ", ".join(self.added))
        if self.overridden:
            logger.info("Remote config overridden: %s", ", ".join(self.overridden))
        if self.protected:
            logger.info("Protected from remote override: %s", ", ".join(self.protected))
        if not (self.added or self.overridden or self.protected):
            logger.info("Remote config: nothing to merge")


def _is_protected_path(path: str, protected_paths: list[str]) -> bool:
    """Check if a dot-notation path matches or is nested under a protected path."""
    for pp in protected_paths:
        if path == pp or path.startswith(pp + "."):
            return True
    return False


def _deep_merge(
    base: dict,
    overlay: dict,
    protected_paths: list[str],
    report: MergeReport,
    prefix: str = "",
) -> dict:
    """Recursively merge overlay into base, skipping protected paths."""
    result = dict(base)
    for key, value in overlay.items():
        dot_path = f"{prefix}.{key}" if prefix else key
        if _is_protected_path(dot_path, protected_paths):
            report.protected.append(f"settings:{dot_path}")
            continue
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(
                result[key], value, protected_paths, report, dot_path
            )
        elif key in result:
            result[key] = value
            report.overridden.append(f"settings:{dot_path}")
        else:
            result[key] = value
            report.added.append(f"settings:{dot_path}")
    return result


def deep_merge_settings(builtin: dict, remote: dict, report: MergeReport) -> dict:
    """Deep merge settings.json — protected keys never overridden."""
    return _deep_merge(builtin, remote, PROTECTED["settings"], report)


def merge_mcp_servers(builtin: dict, remote: dict, report: MergeReport) -> dict:
    """Additive merge of MCP server definitions. Protected servers unchanged."""
    result = dict(builtin)
    builtin_servers = result.get("mcpServers", {})
    remote_servers = remote.get("mcpServers", {})

    for name, cfg in remote_servers.items():
        if name in PROTECTED["mcps"]:
            report.protected.append(f"mcp:{name}")
            continue
        if name in builtin_servers:
            report.overridden.append(f"mcp:{name}")
        else:
            report.added.append(f"mcp:{name}")
        builtin_servers[name] = cfg

    result["mcpServers"] = builtin_servers
    return result


def merge_skills(builtin_dir: Path, remote_dir: Path, report: MergeReport) -> list[str]:
    """Copy remote skills alongside built-in. Protected skills skipped."""
    added = []
    if not remote_dir.is_dir():
        return added

    for item in remote_dir.iterdir():
        if not item.is_dir():
            continue
        name = item.name
        if name in PROTECTED["skills"]:
            report.protected.append(f"skill:{name}")
            continue

        dest = builtin_dir / name
        if dest.exists():
            shutil.rmtree(dest)
            report.overridden.append(f"skill:{name}")
        else:
            report.added.append(f"skill:{name}")

        _copytree_safe(item, dest)
        added.append(name)

    return added


def merge_personas(
    builtin_dir: Path, remote_dir: Path, report: MergeReport
) -> list[str]:
    """Merge personas — remote wins on name conflicts."""
    merged = []
    if not remote_dir.is_dir():
        return merged

    for item in remote_dir.iterdir():
        if not item.is_dir():
            continue
        name = item.name
        dest = builtin_dir / name
        if dest.exists():
            report.overridden.append(f"persona:{name}")
        else:
            report.added.append(f"persona:{name}")

        _copytree_safe(item, dest, dirs_exist_ok=True)
        merged.append(name)

    return merged


def merge_project_repos(builtin: dict, remote: dict, report: MergeReport) -> dict:
    """Deep merge by repo key. url/upstream fields protected per repo."""
    result = dict(builtin)
    for repo_name, remote_cfg in remote.items():
        if repo_name not in result:
            result[repo_name] = remote_cfg
            report.added.append(f"repo:{repo_name}")
            continue

        existing = result[repo_name]
        for field_key, value in remote_cfg.items():
            if field_key in PROTECTED["project_repos_fields"]:
                if field_key in existing and existing[field_key] != value:
                    report.protected.append(f"repo:{repo_name}.{field_key}")
                    continue
            if field_key in existing and existing[field_key] != value:
                report.overridden.append(f"repo:{repo_name}.{field_key}")
            elif field_key not in existing:
                report.added.append(f"repo:{repo_name}.{field_key}")
            existing[field_key] = value

    return result


def merge_hooks(builtin_dir: Path, remote_dir: Path, report: MergeReport) -> list[str]:
    """Additive merge of hook scripts. Bot safety hooks cannot be overridden."""
    added = []
    if not remote_dir.is_dir():
        return added

    builtin_dir.mkdir(parents=True, exist_ok=True)

    for item in remote_dir.iterdir():
        if not item.is_file():
            continue
        name = item.name
        if name in PROTECTED_HOOKS:
            report.protected.append(f"hook:{name}")
            continue

        dest = builtin_dir / name
        if dest.exists():
            report.overridden.append(f"hook:{name}")
        else:
            report.added.append(f"hook:{name}")

        shutil.copyfile(item, dest)
        _make_executable(dest)
        added.append(name)

    return added


def _copytree_safe(src: Path, dst: Path, **kwargs) -> None:
    """copytree using copyfile to avoid EPERM under OpenShift overlay FS."""
    try:
        shutil.copytree(src, dst, copy_function=shutil.copyfile, **kwargs)
    except shutil.Error as exc:
        real_errors = [e for e in exc.args[0] if not Path(e[0]).is_dir()]
        if real_errors:
            raise shutil.Error(real_errors) from None


def _make_executable(path: Path) -> None:
    """Add execute permission to a file."""
    import stat

    try:
        st = path.stat()
        path.chmod(st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass


def apply_merged_config(script_dir: Path, remote_agent_dir: Path) -> MergeReport:
    """Orchestrate all merge operations. Returns structured report."""
    report = MergeReport()

    # 1. Personas
    remote_personas = remote_agent_dir / "personas"
    if remote_personas.is_dir():
        merge_personas(script_dir / "personas", remote_personas, report)

    # 2. project-repos.json
    remote_repos = remote_agent_dir / "project-repos.json"
    if remote_repos.is_file():
        builtin_path = script_dir / "project-repos.json"
        try:
            builtin = (
                json.loads(builtin_path.read_text()) if builtin_path.exists() else {}
            )
            remote = json.loads(remote_repos.read_text())
            merged = merge_project_repos(builtin, remote, report)
            builtin_path.write_text(json.dumps(merged, indent=2) + "\n")
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to merge project-repos.json: %s", exc)

    # 3. Skills
    remote_skills = remote_agent_dir / "skills"
    if remote_skills.is_dir():
        merge_skills(script_dir / ".claude" / "skills", remote_skills, report)

    # 4. MCP servers
    remote_mcp = remote_agent_dir / "mcp.json"
    if remote_mcp.is_file():
        data_dir = script_dir / "data"
        merged_path = data_dir / "merged-mcp.json"
        try:
            builtin_mcp_path = script_dir / "bot" / "mcp.json"
            builtin = (
                json.loads(builtin_mcp_path.read_text())
                if builtin_mcp_path.exists()
                else {}
            )
            remote = json.loads(remote_mcp.read_text())
            merged = merge_mcp_servers(builtin, remote, report)
            new_content = json.dumps(merged, indent=2) + "\n"
            existing = merged_path.read_text() if merged_path.exists() else ""
            if new_content != existing:
                data_dir.mkdir(parents=True, exist_ok=True)
                merged_path.write_text(new_content)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to merge MCP config: %s", exc)

    # 5. Settings
    remote_settings = remote_agent_dir / "settings.json"
    if remote_settings.is_file():
        settings_path = script_dir / ".claude" / "settings.json"
        try:
            builtin = (
                json.loads(settings_path.read_text()) if settings_path.exists() else {}
            )
            remote = json.loads(remote_settings.read_text())
            merged = deep_merge_settings(builtin, remote, report)
            settings_path.write_text(json.dumps(merged, indent=2) + "\n")
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to merge settings.json: %s", exc)

    # 6. Hooks
    remote_hooks = remote_agent_dir / "hooks"
    if remote_hooks.is_dir():
        merge_hooks(script_dir / ".claude" / "hooks", remote_hooks, report)

    report.log()
    return report

"""Configuration loading for the dev bot."""

from __future__ import annotations

import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class Config:
    model: str
    max_turns: int
    interval: int
    idle_interval: int
    cycle_timeout: int
    board_key: str


@dataclass
class InstanceConfig:
    """Per-instance preset selection from instance.yaml or env var fallback."""

    workflow: str = "jira-sprint"
    source: str = "jira"
    envs: list[str] | None = None  # None = all available, [] = none
    claude_md_strategy: str = "ignore"  # replace / append / ignore

    @classmethod
    def from_yaml(cls, path: Path) -> InstanceConfig:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        claude_md = data.get("claude_md")
        strategy = claude_md.get("strategy", "ignore") if isinstance(claude_md, dict) else "ignore"
        return cls(
            workflow=data.get("workflow", "jira-sprint"),
            source=data.get("source", "jira"),
            envs=data.get("envs"),
            claude_md_strategy=strategy,
        )

    @classmethod
    def from_env(cls) -> InstanceConfig:
        workflow = os.environ.get("BOT_WORKFLOW_PRESET", "jira-sprint")
        envs_str = os.environ.get("BOT_ENV_PRESETS")
        envs: list[str] | None = None
        if envs_str is not None:
            envs = [e.strip() for e in envs_str.split(",") if e.strip()]
        return cls(workflow=workflow, envs=envs)


def load_instance_config(remote_agent_dir: Path | None) -> InstanceConfig:
    """Load instance.yaml from remote config, or fall back to env vars/defaults."""
    logger = logging.getLogger(__name__)
    if remote_agent_dir:
        yaml_path = remote_agent_dir / "instance.yaml"
        if yaml_path.is_file():
            ic = InstanceConfig.from_yaml(yaml_path)
            logger.info(
                "Loaded instance.yaml: workflow=%s, source=%s, envs=%s",
                ic.workflow,
                ic.source,
                ic.envs,
            )
            return ic

    ic = InstanceConfig.from_env()
    logger.info("No instance.yaml — env/defaults: workflow=%s, envs=%s", ic.workflow, ic.envs)
    return ic


def resolve_active_envs(script_dir: Path, instance_config: InstanceConfig) -> list[str]:
    """Resolve which env presets are active. None = all available."""
    if instance_config.envs is not None:
        return list(instance_config.envs)
    envs_dir = script_dir / "presets" / "envs"
    if not envs_dir.is_dir():
        return []
    return sorted(d.name for d in envs_dir.iterdir() if d.is_dir() and d.name != ".gitkeep")


def validate_instance_config(script_dir: Path, instance_config: InstanceConfig) -> None:
    """Validate instance config references exist. FATAL on missing workflow, WARNING on missing env."""
    logger = logging.getLogger(__name__)
    presets = script_dir / "presets"

    wf_dir = presets / "workflows" / instance_config.workflow
    if not wf_dir.is_dir():
        logger.error("FATAL: Workflow preset '%s' not found at %s", instance_config.workflow, wf_dir)
        sys.exit(1)

    if instance_config.envs is not None:
        for env in instance_config.envs:
            env_dir = presets / "envs" / env
            if not env_dir.is_dir():
                logger.warning("Env preset '%s' not found — skipping", env)

    active = resolve_active_envs(script_dir, instance_config)
    for env_name in active:
        manifest_path = presets / "envs" / env_name / "manifest.yaml"
        if not manifest_path.is_file():
            continue
        with open(manifest_path) as f:
            manifest = yaml.safe_load(f) or {}
        requires = manifest.get("requires", {})
        for var in requires.get("env_vars", []):
            if not os.environ.get(var):
                logger.warning("Env preset '%s' requires '%s' (not set)", env_name, var)

    logger.info("Instance config validated: workflow=%s, envs=%s", instance_config.workflow, active)


def load_config(script_dir: Path) -> Config:
    """Load bot configuration from config.json."""
    with open(script_dir / "config.json") as f:
        raw = json.load(f)
    return Config(
        model=raw["claude"]["model"],
        max_turns=raw["claude"]["maxTurns"],
        interval=raw["polling"]["intervalSeconds"],
        idle_interval=raw["polling"].get("idleIntervalSeconds", 3600),
        cycle_timeout=raw["claude"].get("cycleTimeoutSeconds", 1800),
        board_key=raw["jira"]["boardKey"],
    )


def load_mcp_servers(script_dir: Path) -> dict:
    """Load and merge MCP servers from bot and persona configs.

    The root .mcp.json (bot-memory, chrome-devtools) is loaded automatically
    by the SDK via setting_sources=["project"]. This function loads additional
    servers: bot-specific (bot/mcp.json for mcp-atlassian) and per-persona.
    """
    servers: dict = {}

    # Bot-specific MCP servers (e.g. mcp-atlassian — kept separate from
    # .mcp.json so it doesn't interfere with local dev sessions)
    bot_mcp = script_dir / "bot" / "mcp.json"
    if bot_mcp.exists():
        with open(bot_mcp) as f:
            data = json.load(f)
        for name, cfg in data.get("mcpServers", {}).items():
            servers[name] = _resolve_env_vars(cfg)

    merged_mcp = script_dir / "data" / "merged-mcp.json"
    if merged_mcp.exists():
        with open(merged_mcp) as f:
            data = json.load(f)
        for name, cfg in data.get("mcpServers", {}).items():
            if name not in servers:
                servers[name] = _resolve_env_vars(cfg)

    for mcp_file in sorted(script_dir.glob("personas/*/mcp.json")):
        with open(mcp_file) as f:
            data = json.load(f)
        for name, cfg in data.get("mcpServers", {}).items():
            servers[name] = _resolve_env_vars(cfg)
    return servers


def _resolve_env_vars(obj):
    """Recursively resolve ${VAR} references in MCP server configs.

    This lets us remove secrets from os.environ before starting the agent
    while still passing them to MCP servers via resolved literal values.
    """
    if isinstance(obj, str):
        return re.sub(
            r"\$\{(\w+)\}",
            lambda m: os.environ.get(m.group(1), ""),
            obj,
        )
    if isinstance(obj, dict):
        return {k: _resolve_env_vars(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_resolve_env_vars(v) for v in obj]
    return obj


def load_manifest(script_dir: Path, workflow: str) -> dict | None:
    """Load manifest.yaml for a workflow preset. Returns None if not found."""
    path = script_dir / "presets" / "workflows" / workflow / "manifest.yaml"
    if not path.is_file():
        return None
    with open(path) as f:
        return yaml.safe_load(f)


def validate_manifest(
    script_dir: Path,
    workflow: str,
    mcp_servers: dict,
) -> None:
    """Validate workflow manifest requirements at startup.

    FATAL (sys.exit) on missing required MCP servers or env vars.
    WARNING on missing optional env vars or absent manifest.
    """
    logger = logging.getLogger(__name__)
    manifest = load_manifest(script_dir, workflow)
    if manifest is None:
        logger.warning("No manifest.yaml for workflow '%s' — skipping validation", workflow)
        return

    requires = manifest.get("requires", {})
    errors: list[str] = []

    # Collect all available MCP server names: bot/mcp.json + merged + persona
    # servers are in `mcp_servers`; root .mcp.json (SDK-loaded) checked separately.
    available_servers = set(mcp_servers.keys())
    root_mcp = script_dir / ".mcp.json"
    if root_mcp.is_file():
        with open(root_mcp) as f:
            root_data = json.load(f)
        available_servers.update(root_data.get("mcpServers", {}).keys())

    for server in requires.get("mcp_servers", []):
        if server not in available_servers:
            errors.append(f"Required MCP server '{server}' not configured")

    for var in requires.get("env_vars", []):
        if not os.environ.get(var):
            errors.append(f"Required env var '{var}' not set")

    if errors:
        for err in errors:
            logger.error("FATAL: %s", err)
        logger.error(
            "Workflow '%s' manifest validation failed — %d error(s). Check deployment config.",
            workflow,
            len(errors),
        )
        sys.exit(1)

    for var in requires.get("optional_env_vars", []):
        if not os.environ.get(var):
            logger.warning("Optional env var '%s' not set", var)

    logger.info("Manifest validation passed for workflow '%s'", workflow)


# Env vars that contain secrets and must be removed before starting
# the agent. MCP servers get resolved values; gh/glab use config files.
SECRET_ENV_VARS = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "GPG_PRIVATE_KEY_B64",
    "GPG_SIGNING_KEY",
    "SSO_USERNAME",
    "SSO_PASSWORD",
]


# Git env vars that override gitconfig — must be removed so
# includeIf per-platform identity works correctly.
GIT_OVERRIDE_VARS = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
]


def sanitize_env() -> None:
    """Remove secret and git-override env vars before starting the agent.

    Call this AFTER load_mcp_servers() (which resolves ${VAR} references)
    and after gh/glab auth setup (which writes tokens to config files).
    """
    for var in SECRET_ENV_VARS + GIT_OVERRIDE_VARS:
        os.environ.pop(var, None)


ALLOWED_TOOLS = [
    # Built-in tools
    "Edit",
    "Write",
    "Read",
    "Glob",
    "Grep",
    "Bash",
    "LSP",
    "Skill",
    # Jira MCP tools
    "mcp__mcp-atlassian__jira_search",
    "mcp__mcp-atlassian__jira_get_issue",
    "mcp__mcp-atlassian__jira_add_comment",
    "mcp__mcp-atlassian__jira_update_issue",
    "mcp__mcp-atlassian__jira_get_transitions",
    "mcp__mcp-atlassian__jira_transition_issue",
    "mcp__mcp-atlassian__jira_get_user_profile",
    "mcp__mcp-atlassian__jira_download_attachments",
    "mcp__mcp-atlassian__jira_get_agile_boards",
    "mcp__mcp-atlassian__jira_get_sprints_from_board",
    "mcp__mcp-atlassian__jira_add_issues_to_sprint",
    "mcp__mcp-atlassian__jira_create_issue",
    "mcp__mcp-atlassian__jira_create_issue_link",
    "mcp__mcp-atlassian__jira_get_field_options",
    # Wildcard MCP tools
    "mcp__hcc-patternfly-data-view__*",
    "mcp__chrome-devtools__*",
    "mcp__bot-memory__*",
]

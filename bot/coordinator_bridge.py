"""JSON bridge between the TypeScript coordinator and Python cycle preparation.

The bridge keeps existing Python preflight and config behavior as the source of
truth while giving a future TypeScript runner a small, process-safe protocol.
Requests and responses are single JSON objects on stdin/stdout. Logs stay on
stderr so stdout remains machine-readable.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1


class BridgeError(ValueError):
    """Invalid bridge request or unsupported bridge operation."""


def _required_string(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise BridgeError(f"{key} must be a non-empty string")
    return value


def _optional_string(request: dict[str, Any], key: str) -> str | None:
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise BridgeError(f"{key} must be a non-empty string when provided")
    return value


def _serialize_preflight(result: Any) -> dict[str, Any] | None:
    if result is None:
        return None
    return {
        "action": result.action,
        "prompt": result.prompt,
        "transcript": result.transcript,
        "scripts": [
            {
                "name": script.name,
                "status": script.status,
                "content": script.content,
            }
            for script in result.scripts
        ],
    }


def _run_preflight(request: dict[str, Any]) -> dict[str, Any] | None:
    from .preflight import run_preflight

    script_dir = Path(_required_string(request, "scriptDir")).resolve()
    _load_dotenv(script_dir)
    workflow = _required_string(request, "workflow")
    remote_agent_dir = _optional_string(request, "remoteAgentDir")
    instance_id = _optional_string(request, "instanceId")

    result = run_preflight(
        script_dir,
        workflow,
        Path(remote_agent_dir).resolve() if remote_agent_dir else None,
        instance_id,
    )
    return _serialize_preflight(result)


def _prepare_config(request: dict[str, Any]) -> dict[str, Any]:
    """Sync and merge config using the same functions as bot/run.py.

    Import is intentionally lazy: preflight-only callers should not need to
    import the Claude SDK or initialize the full runner module.
    """

    from . import run as runner
    from .config import (
        ALLOWED_TOOLS,
        discover_optional_mcp_servers,
        load_config,
        load_instance_config,
        load_mcp_servers,
        resolve_active_envs,
        resolve_cycle_model,
        resolve_workflow_dir,
        validate_instance_config,
        validate_manifest,
        validate_runtime_provider_selection,
    )
    from .merge import apply_merged_config, install_skills

    script_dir = Path(_required_string(request, "scriptDir")).resolve()
    _load_dotenv(script_dir)
    if script_dir != runner.SCRIPT_DIR.resolve():
        raise BridgeError(
            f"scriptDir must be the bot repository root ({runner.SCRIPT_DIR}), got {script_dir}",
        )

    label = _required_string(request, "label")
    runtime_config = load_config(script_dir)
    profile_dir, shared_dir = runner.sync_config_repo(label)

    if shared_dir:
        apply_merged_config(script_dir, shared_dir)
    if profile_dir:
        apply_merged_config(script_dir, profile_dir)

    instance_config = load_instance_config(profile_dir)
    selection_errors = validate_runtime_provider_selection(
        instance_config.runtime,
        instance_config.provider,
    )
    if selection_errors:
        raise BridgeError("; ".join(selection_errors))
    workflow_dir = resolve_workflow_dir(script_dir, instance_config.workflow, profile_dir)
    active_envs = resolve_active_envs(script_dir, instance_config)
    install_skills(script_dir, workflow_dir, active_envs)
    runner.assemble_claude_md(script_dir, instance_config, profile_dir, shared_dir)
    cycle_model = resolve_cycle_model(script_dir, instance_config, runtime_config, profile_dir)
    # Preserve the legacy Claude view: resolved MCP values and no project
    # servers, because Claude discovers .mcp.json through setting_sources.
    mcp_servers = load_mcp_servers(script_dir)
    # Keep a separate reference-only view for OpenCode. It owns project-server
    # discovery; the TypeScript renderer validates its untrusted references.
    opencode_mcp_servers = load_mcp_servers(
        script_dir,
        resolve_env=False,
        include_project=True,
    )
    validate_manifest(
        script_dir,
        instance_config.workflow,
        mcp_servers,
        profile_dir,
        model_tiers=runtime_config.model_tiers,
    )
    validate_instance_config(script_dir, instance_config, profile_dir)

    return {
        "model": cycle_model,
        "runtimeId": instance_config.runtime,
        "providerId": instance_config.provider,
        "maxTurns": runtime_config.max_turns,
        "intervalSeconds": runtime_config.interval,
        "idleIntervalSeconds": runtime_config.idle_interval,
        "cycleTimeoutSeconds": runtime_config.cycle_timeout,
        "idleReminderCooldownSeconds": runtime_config.idle_reminder_cooldown_seconds,
        "workflow": instance_config.workflow,
        "source": instance_config.source,
        "envs": instance_config.envs,
        "activeEnvs": active_envs,
        "claudeMdStrategy": instance_config.claude_md_strategy,
        "idleCycleLimit": instance_config.idle_cycle_limit,
        "remoteAgentDir": str(profile_dir) if profile_dir else None,
        "sharedAgentDir": str(shared_dir) if shared_dir else None,
        "claudeMdPath": str(script_dir / "CLAUDE.md"),
        "mcpServers": mcp_servers,
        "openCodeMcpServers": opencode_mcp_servers,
        "allowedTools": ALLOWED_TOOLS,
        "optionalMcpServers": discover_optional_mcp_servers(script_dir, active_envs),
    }


def _load_dotenv(script_dir: Path) -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(script_dir / ".env", override=False)


def _maintenance_script_dir(request: dict[str, Any]):
    from . import run as runner

    script_dir = Path(_required_string(request, "scriptDir")).resolve()
    _load_dotenv(script_dir)
    if script_dir != runner.SCRIPT_DIR.resolve():
        raise BridgeError(
            f"scriptDir must be the bot repository root ({runner.SCRIPT_DIR}), got {script_dir}",
        )
    return script_dir, runner


def _idle_skip(request: dict[str, Any]) -> None:
    script_dir, _runner = _maintenance_script_dir(request)
    from . import idle_reminder

    instance_id = _required_string(request, "instanceId")
    idle_cycle_limit = request.get("idleCycleLimit")
    cooldown_seconds = request.get("cooldownSeconds")
    if not isinstance(idle_cycle_limit, int) or idle_cycle_limit < 0:
        raise BridgeError("idleCycleLimit must be a non-negative integer")
    if not isinstance(cooldown_seconds, (int, float)) or cooldown_seconds < 0:
        raise BridgeError("cooldownSeconds must be non-negative")
    idle_reminder.on_preflight_skip(
        instance_id,
        idle_cycle_limit=idle_cycle_limit,
        cooldown_seconds=int(cooldown_seconds),
    )


def _idle_start(request: dict[str, Any]) -> None:
    _script_dir, _runner = _maintenance_script_dir(request)
    from . import idle_reminder

    idle_reminder.on_preflight_start(_required_string(request, "instanceId"))


def _cleanup(request: dict[str, Any]) -> None:
    script_dir, runner = _maintenance_script_dir(request)
    runner.cleanup_between_cycles(script_dir)


def handle(request: dict[str, Any]) -> Any:
    if request.get("protocolVersion", PROTOCOL_VERSION) != PROTOCOL_VERSION:
        raise BridgeError("unsupported protocolVersion")

    operation = request.get("operation")
    if operation == "preflight":
        return _run_preflight(request)
    if operation == "prepare":
        return _prepare_config(request)
    if operation == "idle_skip":
        _idle_skip(request)
        return None
    if operation == "idle_start":
        _idle_start(request)
        return None
    if operation == "cleanup":
        _cleanup(request)
        return None
    raise BridgeError("operation must be preflight, prepare, idle_skip, idle_start, or cleanup")


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise BridgeError("request must be a JSON object")
        result = handle(request)
        json.dump({"protocolVersion": PROTOCOL_VERSION, "ok": True, "result": result}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    except (BridgeError, json.JSONDecodeError, OSError) as exc:
        print(f"coordinator bridge failed: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # pragma: no cover - defensive process boundary
        print(f"coordinator bridge crashed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

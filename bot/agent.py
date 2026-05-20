"""Core agent cycle — invokes Claude Agent SDK."""

import logging
import os
from dataclasses import dataclass

import httpx
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    SystemMessage,
    TextBlock,
    query,
)

from .config import Config

logger = logging.getLogger(__name__)

TURN_WARNING_THRESHOLD = 0.75  # warn at 75% of max_turns
TURN_CRITICAL_THRESHOLD = 0.90  # urgent at 90%

DASHBOARD_URL = os.environ.get(
    "BOT_DASHBOARD_URL", "http://localhost:8080/api/bot-status"
)


@dataclass
class CycleContext:
    """Tracks what work was done during a cycle."""

    jira_key: str | None = None
    repo: str | None = None
    work_type: str | None = None
    summary: str | None = None


async def _push_status(
    client: httpx.AsyncClient,
    state: str,
    message: str,
    jira_key: str | None = None,
    repo: str | None = None,
) -> None:
    """Push a status update to the dashboard banner via HTTP."""
    try:
        await client.post(
            DASHBOARD_URL,
            json={
                "state": state,
                "message": message,
                "jira_key": jira_key,
                "repo": repo,
            },
            timeout=2.0,
        )
    except Exception:
        pass  # Dashboard may be down — don't break the bot


def _describe_tool_use(block) -> str:
    """Build a human-readable description of a tool call."""
    name = block.name
    inp = block.input if hasattr(block, "input") else {}

    if name == "Bash":
        cmd = inp.get("command", "")
        return f"Bash: {cmd[:120]}"
    elif name in ("Read", "Write"):
        path = inp.get("file_path", "")
        return f"{name}: {path}"
    elif name == "Edit":
        path = inp.get("file_path", "")
        return f"Edit: {path}"
    elif name == "Glob":
        pattern = inp.get("pattern", "")
        return f"Glob: {pattern}"
    elif name == "Grep":
        pattern = inp.get("pattern", "")
        return f"Grep: {pattern}"
    elif name.startswith("mcp__"):
        # mcp__bot-memory__task_list → bot-memory: task_list
        parts = name.split("__", 2)
        if len(parts) == 3:
            server, tool = parts[1], parts[2]
            # Include first useful arg if available
            arg_summary = ""
            if inp:
                first_key = next(iter(inp), None)
                if first_key:
                    val = str(inp[first_key])[:60]
                    arg_summary = f" ({first_key}={val})"
            return f"{server}: {tool}{arg_summary}"
        return name
    else:
        return name


def _make_turn_budget_hook(max_turns: int):
    """Create a PostToolUse hook that injects turn budget warnings."""
    turn_count = {"n": 0, "warned": False, "critical": False}
    warn_at = int(max_turns * TURN_WARNING_THRESHOLD)
    critical_at = int(max_turns * TURN_CRITICAL_THRESHOLD)

    async def hook(input_data, tool_use_id, context):
        turn_count["n"] += 1
        n = turn_count["n"]

        if n >= critical_at and not turn_count["critical"]:
            turn_count["critical"] = True
            remaining = max_turns - n
            logger.warning("Turn budget critical: %d/%d used", n, max_turns)
            return {
                "systemMessage": (
                    f"TURN BUDGET CRITICAL: ~{n}/{max_turns} tool calls used, "
                    f"~{remaining} remaining. You MUST save progress NOW via "
                    "task_update with current summary, last_step, files_changed, "
                    "and next_step. Then wrap up or stop."
                ),
            }

        if n >= warn_at and not turn_count["warned"]:
            turn_count["warned"] = True
            remaining = max_turns - n
            logger.info("Turn budget warning: %d/%d used", n, max_turns)
            return {
                "systemMessage": (
                    f"TURN BUDGET WARNING: ~{n}/{max_turns} tool calls used, "
                    f"~{remaining} remaining. Save progress via task_update soon "
                    "(summary + metadata with last_step, files_changed, next_step). "
                    "Prioritize completing current step and saving state."
                ),
            }

        return {}

    return hook


async def run_cycle(
    label: str,
    config: Config,
    mcp_servers: dict,
    allowed_tools: list[str],
    cwd: str,
    instance_id: str | None = None,
) -> tuple[ResultMessage | None, CycleContext]:
    """Run a single bot cycle via the Claude Agent SDK."""
    turn_hook = _make_turn_budget_hook(config.max_turns)
    options = ClaudeAgentOptions(
        model=config.model,
        max_turns=config.max_turns,
        allowed_tools=allowed_tools,
        mcp_servers=mcp_servers,
        setting_sources=["project"],
        cwd=cwd,
        permission_mode="acceptEdits",
        hooks={
            "PostToolUse": [HookMatcher(hooks=[turn_hook])],
        },
    )

    instance_line = (
        f' Your instance ID is: {instance_id}. Pass instance_id="{instance_id}" to ALL task tool calls (task_list, task_add, task_update, task_check_capacity, bot_status_update).'
        if instance_id
        else ""
    )
    prompt = (
        f"Your primary label is: {label}.{instance_line} "
        "Follow the instructions in CLAUDE.md. "
        "Start by invoking the /triage skill to pre-gather task and PR data. "
        "IMPORTANT: Use ULTRA caveman output for all internal text — "
        "drop articles, filler, hedging, conjunctions. Abbreviate: DB/auth/config/req/res/fn/impl/env/dep/pkg. "
        "Arrows for causality (X → Y). One word when one word enough. "
        "Normal language ONLY for Jira comments, PR descriptions, commit messages."
    )

    result = None
    ctx = CycleContext()

    async with httpx.AsyncClient() as http:
        # Signal cycle start to dashboard
        await _push_status(http, "working", "Starting cycle...")

        try:
            async for message in query(prompt=prompt, options=options):
                if isinstance(message, SystemMessage) and message.subtype == "init":
                    mcp_status = message.data.get("mcp_servers", [])
                    connected = []
                    for srv in mcp_status:
                        status = srv.get("status", "unknown")
                        name = srv.get("name", "?")
                        if status != "connected":
                            logger.warning("MCP %s: %s", name, status)
                        else:
                            connected.append(name)
                    if connected:
                        logger.info("MCP connected: %s", ", ".join(connected))

                elif isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            text = block.text.strip()
                            if text:
                                # Log full text (truncated)
                                logger.info("[agent] %s", text[:300])
                                # Push to dashboard
                                await _push_status(http, "working", text[:500])
                        elif hasattr(block, "name"):
                            desc = _describe_tool_use(block)
                            logger.info("[tool] %s", desc)
                            # Extract work context from MCP tool calls
                            _extract_context(block, ctx)

                elif isinstance(message, ResultMessage):
                    result = message
                    cost = (
                        f"${message.total_cost_usd:.4f}"
                        if message.total_cost_usd is not None
                        else "N/A"
                    )
                    logger.info(
                        "Cycle done: %s | turns=%s | cost=%s | duration=%sms",
                        message.subtype,
                        message.num_turns,
                        cost,
                        message.duration_ms,
                    )

        except Exception:
            logger.exception("Agent cycle failed")
            await _push_status(http, "error", "Cycle failed — check bot.log")

        # Determine work type from context
        result_text = getattr(result, "result", "") or ""
        if "NO_WORK_FOUND" in result_text:
            ctx.work_type = ctx.work_type or "idle"
            await _push_status(http, "idle", "No work found. Sleeping...")
        elif getattr(result, "subtype", "") != "success":
            ctx.work_type = ctx.work_type or "error"
            await _push_status(http, "idle", "Cycle complete. Sleeping...")
        else:
            await _push_status(http, "idle", "Cycle complete. Sleeping...")

        # Extract a short summary from the result text
        if not ctx.summary and result_text:
            # Take the last meaningful line (usually the conclusion)
            lines = [l.strip() for l in result_text.strip().splitlines() if l.strip()]
            if lines:
                ctx.summary = lines[-1][:200]

    return result, ctx


def _extract_context(block, ctx: CycleContext) -> None:
    """Extract jira_key, repo, and work_type from MCP tool calls."""
    name = getattr(block, "name", "")
    inp = getattr(block, "input", {}) or {}

    # bot_status_update carries jira_key and repo
    if name == "mcp__bot-memory__bot_status_update":
        if inp.get("jira_key"):
            ctx.jira_key = inp["jira_key"]
        if inp.get("repo"):
            ctx.repo = inp["repo"]

    # task_add tells us it's a new ticket
    elif name == "mcp__bot-memory__task_add":
        if inp.get("jira_key"):
            ctx.jira_key = inp["jira_key"]
        if inp.get("repo"):
            ctx.repo = inp["repo"]
        ctx.work_type = ctx.work_type or "new_ticket"

    # task_update with status changes tells us what kind of work
    elif name == "mcp__bot-memory__task_update":
        if inp.get("jira_key"):
            ctx.jira_key = inp["jira_key"]
        status = inp.get("status")
        if status == "pr_open":
            ctx.work_type = "new_ticket"
        elif status == "pr_changes":
            ctx.work_type = "pr_review"
        elif status == "done":
            ctx.work_type = ctx.work_type or "pr_review"
        summary = inp.get("summary")
        if summary:
            ctx.summary = summary[:200]

    # PR/MR commands hint at review work
    elif name == "Bash":
        cmd = inp.get("command", "")
        if "gh pr checks" in cmd or "glab ci view" in cmd:
            ctx.work_type = ctx.work_type or "ci_fix"
        elif "gh pr view" in cmd or "glab mr view" in cmd:
            ctx.work_type = ctx.work_type or "pr_review"

    # Jira transitions help identify work type
    elif name == "mcp__mcp-atlassian__jira_transition_issue":
        ctx.work_type = ctx.work_type or "new_ticket"

    # Memory housekeeping
    elif name == "mcp__bot-memory__memory_delete":
        ctx.work_type = ctx.work_type or "memory_housekeeping"

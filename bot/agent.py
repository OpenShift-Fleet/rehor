"""Core agent cycle — invokes Claude Agent SDK."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolResultBlock,
    query,
)

from .config import Config
from .constants import MEMORY_API_BASE
from .costs import summarize_result
from .log import bind
from .metrics import MCP_SERVER_STATUS_TOTAL, TURN_BUDGET_EVENT_TOTAL, WORK_TYPE_TOTAL

logger = logging.getLogger(__name__)

TURN_WARNING_THRESHOLD = 0.75  # warn at 75% of max_turns
TURN_CRITICAL_THRESHOLD = 0.90  # urgent at 90%

DASHBOARD_URL = os.environ.get("BOT_DASHBOARD_URL", f"{MEMORY_API_BASE}/bot-status")

# Track consecutive status push failures for warning after N misses
_status_fail_count = 0
_STATUS_FAIL_WARNING_THRESHOLD = 5

_USAGE_TOKEN_KEYS = (
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
)


@dataclass
class CycleContext:
    """Tracks what work was done during a cycle.

    Mutable fields like session_id / started_at / partial_usage are updated
    during the SDK stream so they survive asyncio.wait_for cancellation.
    """

    jira_key: str | None = None
    repo: str | None = None
    work_type: str | None = None
    summary: str | None = None
    task_id: int | None = None
    session_id: str | None = None
    started_at: datetime | None = None
    partial_usage: dict[str, int] = field(default_factory=dict)
    model_usage: dict[str, Any] = field(default_factory=dict)
    num_turns: int = 0
    notes: str | None = None
    timed_out: bool = False
    _usage_by_response: dict[str, tuple[str, dict[str, int]]] = field(default_factory=dict, repr=False)


async def _push_status(
    client: httpx.AsyncClient,
    state: str,
    message: str,
    jira_key: str | None = None,
    repo: str | None = None,
    instance_id: str | None = None,
) -> None:
    """Push a status update to the dashboard banner via HTTP."""
    global _status_fail_count
    try:
        payload: dict = {
            "state": state,
            "message": message,
            "external_key": jira_key,
            "repo": repo,
        }
        if instance_id:
            payload["instance_id"] = instance_id
        await client.post(
            DASHBOARD_URL,
            json=payload,
            timeout=2.0,
        )
        _status_fail_count = 0
    except Exception as e:
        _status_fail_count += 1
        logger.debug("Dashboard push failed: %s", e)
        if _status_fail_count == _STATUS_FAIL_WARNING_THRESHOLD:
            logger.warning(
                "Dashboard unreachable (%d consecutive failures, silencing)",
                _STATUS_FAIL_WARNING_THRESHOLD,
            )


def push_status(
    state: str,
    message: str,
    *,
    instance_id: str | None = None,
    jira_key: str | None = None,
    repo: str | None = None,
) -> None:
    """Synchronous status push for the runner loop (preflight skip/error)."""

    async def _run() -> None:
        async with httpx.AsyncClient() as http:
            await _push_status(http, state, message, jira_key=jira_key, repo=repo, instance_id=instance_id)

    asyncio.run(_run())


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


def _complete_tool(pending: dict[str, tuple[float, str]], tool_use_id: str | None) -> None:
    """Log duration for a tool if we still have a matching start time."""
    if not tool_use_id:
        return
    start = pending.pop(tool_use_id, None)
    if start is None:
        return
    t0, desc = start
    elapsed_ms = int((time.monotonic() - t0) * 1000)
    logger.info("[tool] %s completed in %dms", desc, elapsed_ms)


def _make_turn_budget_hook(max_turns: int, label: str):
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
            TURN_BUDGET_EVENT_TOTAL.labels(label, "critical").inc()
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
            TURN_BUDGET_EVENT_TOTAL.labels(label, "warning").inc()
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


def _capture_stream_meta(message: object, ctx: CycleContext) -> None:
    """Capture session_id and first-message started_at from any SDK message."""
    if ctx.started_at is None:
        ctx.started_at = datetime.now(UTC)

    sid = getattr(message, "session_id", None)
    if not sid and isinstance(message, SystemMessage):
        data = getattr(message, "data", None) or {}
        if isinstance(data, dict):
            sid = data.get("session_id")
    if sid and not ctx.session_id:
        ctx.session_id = str(sid)


def _usage_counts(raw: object) -> dict[str, int] | None:
    if not isinstance(raw, dict):
        return None
    counts: dict[str, int] = {}
    for key in _USAGE_TOKEN_KEYS:
        value = raw.get(key)
        if value is not None:
            counts[key] = int(value or 0)
    return counts or None


def _record_assistant_usage(message: AssistantMessage, ctx: CycleContext) -> None:
    """Accumulate per-response usage from assistant messages (best-effort)."""
    usage = _usage_counts(getattr(message, "usage", None))
    if not usage:
        return

    model = str(getattr(message, "model", None) or "unknown")
    # Prefer message_id so repeated content-block streams replace, not sum.
    message_id = getattr(message, "message_id", None)
    if message_id:
        key = str(message_id)
    else:
        # Without an id, keep one slot per model so streaming duplicates replace.
        key = f"anonymous:{model}"
    ctx._usage_by_response[key] = (model, usage)

    totals: dict[str, int] = {}
    by_model: dict[str, dict[str, int]] = {}
    for response_model, response_usage in ctx._usage_by_response.values():
        model_totals = by_model.setdefault(response_model, {})
        for token_key, value in response_usage.items():
            totals[token_key] = totals.get(token_key, 0) + value
            model_totals[token_key] = model_totals.get(token_key, 0) + value
    ctx.partial_usage = totals
    ctx.model_usage = by_model

    ctx.num_turns = max(ctx.num_turns, len(ctx._usage_by_response))


async def run_cycle(
    label: str,
    config: Config,
    mcp_servers: dict,
    allowed_tools: list[str],
    cwd: str,
    instance_id: str | None = None,
    preflight_prompt: str | None = None,
    model: str | None = None,
    ctx: CycleContext | None = None,
) -> tuple[ResultMessage | None, CycleContext]:
    """Run a single bot cycle via the Claude Agent SDK."""
    if model:
        bind(model=model)
    turn_hook = _make_turn_budget_hook(config.max_turns, label)
    pending_tools: dict[str, tuple[float, str]] = {}

    async def tool_timing_post(input_data, tool_use_id, context):
        # Live SDK stream usually does not yield ToolResultBlock; PostToolUse does.
        _complete_tool(pending_tools, tool_use_id or input_data.get("tool_use_id"))
        return {}

    options = ClaudeAgentOptions(
        model=model or config.model,
        max_turns=config.max_turns,
        allowed_tools=allowed_tools,
        mcp_servers=mcp_servers,
        setting_sources=["project"],
        cwd=cwd,
        permission_mode="acceptEdits",
        hooks={
            "PostToolUse": [HookMatcher(hooks=[turn_hook, tool_timing_post])],
            "PostToolUseFailure": [HookMatcher(hooks=[tool_timing_post])],
        },
    )

    instance_line = (
        f' Your instance ID is: {instance_id}. Pass instance_id="{instance_id}"'
        f" to ALL task tool calls (task_list, task_add, task_update, task_check_capacity, bot_status_update)."
        if instance_id
        else ""
    )

    caveman_line = (
        "IMPORTANT: Use ULTRA caveman output for all internal text — "
        "drop articles, filler, hedging, conjunctions. Abbreviate: DB/auth/config/req/res/fn/impl/env/dep/pkg. "
        "Arrows for causality (X → Y). One word when one word enough. "
        "Normal language ONLY for Jira comments, PR descriptions, commit messages."
    )

    if preflight_prompt:
        prompt = (
            f"Your primary label is: {label}.{instance_line} "
            "Follow the instructions in CLAUDE.md. "
            f"{caveman_line}\n\n"
            "## Pre-flight Data\n\n"
            "The following data was gathered by pre-flight scripts. "
            "Do NOT re-fetch task statuses, PR statuses, or Jira comments already shown below. "
            "Do NOT invoke /triage — triage data is already provided.\n\n"
            f"{preflight_prompt}"
        )
    else:
        prompt = (
            f"Your primary label is: {label}.{instance_line} "
            "Follow the instructions in CLAUDE.md. "
            "Start by invoking the /triage skill to pre-gather task and PR data. "
            f"{caveman_line}"
        )

    result = None
    if ctx is None:
        ctx = CycleContext()

    cycle_timeout = max(1, int(config.cycle_timeout))
    deadline = time.monotonic() + cycle_timeout

    async with httpx.AsyncClient() as http:
        # Signal cycle start to dashboard
        await _push_status(http, "working", "Starting cycle...", instance_id=instance_id)

        stream = query(prompt=prompt, options=options)
        try:
            while True:
                if result is None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        ctx.timed_out = True
                        logger.error("Cycle timed out after %ds — closing SDK session", cycle_timeout)
                        break
                else:
                    remaining = None

                try:
                    if remaining is not None:
                        message = await asyncio.wait_for(stream.__anext__(), timeout=remaining)
                    else:
                        message = await stream.__anext__()
                except StopAsyncIteration:
                    break
                except TimeoutError:
                    ctx.timed_out = True
                    logger.error("Cycle timed out after %ds — closing SDK session", cycle_timeout)
                    break

                _capture_stream_meta(message, ctx)

                if isinstance(message, SystemMessage) and message.subtype == "init":
                    mcp_status = message.data.get("mcp_servers", [])
                    connected = []
                    for srv in mcp_status:
                        status = srv.get("status", "unknown")
                        name = srv.get("name", "?")
                        MCP_SERVER_STATUS_TOTAL.labels(name, status).inc()
                        if status != "connected":
                            logger.warning("MCP %s: %s", name, status)
                        else:
                            connected.append(name)
                    if connected:
                        logger.info("MCP connected: %s", ", ".join(connected))
                    if ctx.session_id:
                        logger.info("Session started: %s", ctx.session_id)

                elif isinstance(message, AssistantMessage):
                    _record_assistant_usage(message, ctx)
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            text = block.text.strip()
                            if text:
                                # Log full text (truncated)
                                logger.info("[agent] %s", text[:300])
                                # Push to dashboard
                                await _push_status(http, "working", text[:500], instance_id=instance_id)
                        elif isinstance(block, ToolResultBlock):
                            _extract_task_id_from_result(block, ctx)
                            _complete_tool(pending_tools, block.tool_use_id)
                        elif hasattr(block, "name"):
                            desc = _describe_tool_use(block)
                            logger.info("[tool] %s", desc)
                            tool_id = getattr(block, "id", None)
                            if tool_id:
                                pending_tools[tool_id] = (time.monotonic(), desc)
                            _extract_context(block, ctx)

                elif isinstance(message, ResultMessage):
                    result = message
                    if getattr(message, "session_id", None) and not ctx.session_id:
                        ctx.session_id = str(message.session_id)
                    if getattr(message, "num_turns", None) is not None:
                        ctx.num_turns = int(message.num_turns)
                    cost = f"${message.total_cost_usd:.4f}" if message.total_cost_usd is not None else "N/A"
                    summary = summarize_result(message)
                    model_name = summary.get("model") or getattr(result, "model", None)
                    if model_name and model_name != "unknown":
                        bind(cost=message.total_cost_usd, model=model_name)
                    else:
                        bind(cost=message.total_cost_usd)
                    logger.info(
                        "Cycle done: %s | model=%s | turns=%s | cost=%s | duration=%sms | "
                        "tokens in=%s out=%s | cache_read=%s cache_write=%s ratio=%s",
                        message.subtype,
                        summary["model"] or "unknown",
                        message.num_turns,
                        cost,
                        message.duration_ms,
                        summary["input_tokens"],
                        summary["output_tokens"],
                        summary["cache_read_tokens"],
                        summary["cache_write_tokens"],
                        summary["cache_ratio"],
                    )

            if pending_tools:
                logger.debug(
                    "Unmatched tool starts at cycle end: %s",
                    [desc for _, desc in pending_tools.values()],
                )

        except Exception:
            logger.exception("Agent cycle failed")
            await _push_status(http, "error", "Cycle failed — check bot.log", instance_id=instance_id)
        finally:
            try:
                await stream.aclose()  # type: ignore[attr-defined]  # query() is AsyncGenerator at runtime
            except Exception:
                logger.debug("SDK stream aclose failed", exc_info=True)
            _terminate_orphaned_claude_children()

        if ctx.timed_out:
            return None, ctx

        # Determine work type from context
        result_text = getattr(result, "result", "") or ""
        if "NO_WORK_FOUND" in result_text:
            ctx.work_type = ctx.work_type or "idle"
            await _push_status(http, "idle", "No work found. Sleeping...", instance_id=instance_id)
        elif getattr(result, "subtype", "") != "success":
            ctx.work_type = ctx.work_type or "error"
            await _push_status(http, "idle", "Cycle complete. Sleeping...", instance_id=instance_id)
        else:
            await _push_status(http, "idle", "Cycle complete. Sleeping...", instance_id=instance_id)

        # Extract a short summary from the result text
        if not ctx.summary and result_text:
            # Take the last meaningful line (usually the conclusion)
            lines = [line.strip() for line in result_text.strip().splitlines() if line.strip()]
            if lines:
                ctx.summary = lines[-1][:200]

    WORK_TYPE_TOTAL.labels(label, ctx.work_type or "triage_only").inc()
    return result, ctx


def _terminate_orphaned_claude_children() -> None:
    """Best-effort SIGTERM for CLI children the SDK still tracks after aclose."""
    try:
        from claude_agent_sdk._internal.transport.subprocess_cli import _ACTIVE_CHILDREN  # type: ignore[attr-defined]
    except Exception:
        return
    for proc in list(_ACTIVE_CHILDREN):
        try:
            if getattr(proc, "returncode", None) is None:
                proc.terminate()
        except Exception:
            logger.debug("Failed to terminate Claude CLI child", exc_info=True)


def _extract_context(block, ctx: CycleContext) -> None:
    """Extract external task identity, repo, and work_type from tool calls."""
    name = getattr(block, "name", "")
    inp = getattr(block, "input", {}) or {}

    if name in {
        "mcp__bot-memory__bot_status_update",
        "mcp__bot-memory__task_add",
        "mcp__bot-memory__task_update",
        "mcp__bot-memory__task_outcome_report",
        "mcp__bot-memory__task_remove",
    }:
        external_key = inp.get("external_key") or inp.get("jira_key")
        if external_key:
            if external_key != ctx.jira_key:
                ctx.task_id = None
            ctx.jira_key = external_key
        if inp.get("repo"):
            ctx.repo = inp["repo"]
        if inp.get("summary"):
            ctx.summary = inp["summary"][:200]

    # task_add tells us it's a new ticket
    if name == "mcp__bot-memory__task_add":
        ctx.work_type = ctx.work_type or "new_ticket"

    # task_update with status changes tells us what kind of work
    elif name == "mcp__bot-memory__task_update":
        status = inp.get("status")
        if status == "pr_open":
            ctx.work_type = "new_ticket"
        elif status == "pr_changes":
            ctx.work_type = "pr_review"
        elif status == "done":
            ctx.work_type = ctx.work_type or "pr_review"

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

    # Saved progress fills missing context without replacing selected work.
    elif name == "mcp__bot-memory__progress_store":
        progress = inp.get("progress") or {}
        if isinstance(progress, dict):
            external_key = progress.get("external_key") or progress.get("jira_key")
            if external_key and not ctx.jira_key:
                ctx.task_id = None
                ctx.jira_key = ctx.jira_key or external_key
            if progress.get("repo") and (not external_key or external_key == ctx.jira_key):
                ctx.repo = ctx.repo or progress["repo"]

    if ctx.jira_key:
        bind(task_key=ctx.jira_key)


def _extract_task_id_from_result(block: ToolResultBlock, ctx: CycleContext) -> None:
    """Extract task_id from MCP tool result content.

    Matches task objects (task_add/get/update → {id, jira_key, ...})
    and cycle run objects (progress_store → {task_id, cycle_type, ...}).
    """
    content = block.content
    if not content:
        return
    try:
        text = content if isinstance(content, str) else content[0].get("text", "") if isinstance(content, list) else ""
        if not text:
            return
        data = json.loads(text)
        if not isinstance(data, dict):
            return
        external_key = data.get("external_key") or data.get("jira_key")
        if ctx.jira_key and external_key and external_key != ctx.jira_key:
            return
        # Task objects: {id: int, external_key: ...}
        if isinstance(data.get("id"), int) and ("external_key" in data or "jira_key" in data):
            ctx.task_id = data["id"]
        # Cycle run objects from progress_store: {task_id: int, cycle_type: ...}
        elif isinstance(data.get("task_id"), int) and data["task_id"] > 0:
            ctx.task_id = data["task_id"]
    except (json.JSONDecodeError, TypeError, IndexError, AttributeError):
        pass

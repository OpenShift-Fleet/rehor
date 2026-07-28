"""Idle cycle tracking and programmatic reminder sending.

Tracks consecutive preflight-skip cycles and sends Slack reminders when a
configurable threshold is breached — without starting an AI session.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_STATE_FILENAME = "idle-state.json"


@dataclass
class IdleState:
    consecutive_cycles: int = 0
    last_reminder_sent_at_cycle: int = 0


def _state_path(data_dir: Path) -> Path:
    return data_dir / _STATE_FILENAME


def load_state(data_dir: Path) -> IdleState:
    """Load idle state from disk, returning a zeroed state if not found."""
    try:
        data = json.loads(_state_path(data_dir).read_text())
        return IdleState(
            consecutive_cycles=int(data.get("consecutive_cycles", 0)),
            last_reminder_sent_at_cycle=int(data.get("last_reminder_sent_at_cycle", 0)),
        )
    except FileNotFoundError:
        return IdleState()
    except Exception:
        logger.warning("Failed to load idle state — resetting", exc_info=True)
        return IdleState()


def save_state(state: IdleState, data_dir: Path) -> None:
    """Persist idle state to disk."""
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        _state_path(data_dir).write_text(json.dumps(asdict(state)))
    except Exception:
        logger.warning("Failed to save idle state", exc_info=True)


def increment(state: IdleState) -> IdleState:
    """Return a new state with consecutive_cycles incremented by 1."""
    return IdleState(
        consecutive_cycles=state.consecutive_cycles + 1,
        last_reminder_sent_at_cycle=state.last_reminder_sent_at_cycle,
    )


def reset(_state: IdleState) -> IdleState:
    """Return a fully zeroed state for a fresh idle tracking period."""
    return IdleState()


def should_send_reminder(state: IdleState, limit: int, cooldown_cycles: int) -> bool:
    """Return True when the idle threshold is breached and cooldown has expired."""
    if limit <= 0:
        return False
    if state.consecutive_cycles < limit:
        return False
    if state.last_reminder_sent_at_cycle == 0:
        return True
    return (state.consecutive_cycles - state.last_reminder_sent_at_cycle) >= cooldown_cycles


def _get_memory_api_base() -> str:
    costs_url = os.environ.get("COSTS_API_URL", "http://localhost:8080/api/costs")
    return costs_url.rsplit("/", 1)[0]


def fetch_open_tasks(
    memory_api_base: str | None = None,
    instance_id: str | None = None,
) -> list[dict]:
    """Fetch tasks with pr_open status from the memory server REST API."""
    base = memory_api_base or _get_memory_api_base()
    params: dict[str, str] = {"status": "pr_open"}
    if instance_id:
        params["instance_id"] = instance_id
    try:
        resp = httpx.get(f"{base}/tasks", params=params, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
        # api_tasks returns {"items": [...], "total": N, ...}
        if not isinstance(data, dict):
            return []
        items = data.get("items", [])
        return items if isinstance(items, list) else []
    except Exception:
        logger.warning("Could not fetch open tasks for reminder", exc_info=True)
        return []


def _format_task_line(task: dict) -> str:
    name = task.get("name") or task.get("title") or "Untitled"
    jira_key = task.get("jira_key") or ""
    artifacts = task.get("artifacts") or []
    pr_url = ""
    for artifact in artifacts:
        if artifact.get("type") in ("pull_request", "merge_request"):
            pr_url = artifact.get("url", "")
            break
    parts = [f"*{name}*"]
    if jira_key:
        parts.append(f"({jira_key})")
    if pr_url:
        parts.append(f"— {pr_url}")
    return "• " + " ".join(parts)


def send_reminder(
    state: IdleState,
    instance_id: str | None = None,
    memory_api_base: str | None = None,
    slack_webhook_url: str | None = None,
) -> IdleState:
    """Send a Slack reminder listing outstanding open PRs.

    Returns a new state with last_reminder_sent_at_cycle updated on success,
    or the original state unchanged on failure.
    """
    webhook = slack_webhook_url or os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook:
        logger.warning("SLACK_WEBHOOK_URL not set — skipping idle reminder")
        return state

    try:
        tasks = fetch_open_tasks(memory_api_base, instance_id=instance_id)

        lines = [
            f":bell: *Bot idle for {state.consecutive_cycles} cycles — outstanding work may need attention*",
        ]
        if instance_id:
            lines.append(f"Instance: `{instance_id}`")
        if tasks:
            lines.append(f"\n*{len(tasks)} PR(s) awaiting review:*")
            for task in tasks:
                if isinstance(task, dict):
                    lines.append(_format_task_line(task))
        else:
            lines.append("\nNo open tasks found in memory server.")

        message = "\n".join(lines)

        resp = httpx.post(webhook, json={"text": message}, timeout=5.0)
        resp.raise_for_status()
        logger.info("Idle reminder sent after %d consecutive idle cycles", state.consecutive_cycles)
        return IdleState(
            consecutive_cycles=state.consecutive_cycles,
            last_reminder_sent_at_cycle=state.consecutive_cycles,
        )
    except Exception:
        logger.warning("Failed to send idle reminder to Slack", exc_info=True)
        return state


def on_preflight_skip(
    data_dir: Path,
    *,
    idle_cycle_limit: int,
    cooldown_cycles: int,
    instance_id: str | None = None,
) -> IdleState:
    """Increment idle counter on preflight skip, send reminder if due, persist."""
    idle_state = increment(load_state(data_dir))
    if should_send_reminder(idle_state, idle_cycle_limit, cooldown_cycles):
        idle_state = send_reminder(idle_state, instance_id=instance_id)
    save_state(idle_state, data_dir)
    return idle_state


def on_preflight_start(data_dir: Path) -> IdleState:
    """Reset idle tracking when preflight starts a real session."""
    idle_state = reset(load_state(data_dir))
    save_state(idle_state, data_dir)
    return idle_state

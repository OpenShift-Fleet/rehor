"""Idle cycle tracking and programmatic reminder sending.

Tracks consecutive preflight-skip cycles and sends Slack reminders when a
configurable threshold is breached — without starting an AI session.
State is stored in bot_instances via the memory server API (not on disk).
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime

import httpx

from .constants import _DEFAULT_COOLDOWN_SECONDS, MEMORY_API_BASE

logger = logging.getLogger(__name__)


def fetch_idle_state(
    instance_id: str,
    memory_api_base: str | None = None,
) -> tuple[int, datetime | None] | None:
    """Return (consecutive_cycles, last_reminder_sent_at) from memory server.

    Returns None when the fetch fails for a reason other than 404, so callers
    can avoid overwriting existing DB state after a transient error.
    A 404 (unknown instance) is treated as fresh state (0, None).
    """
    base = memory_api_base or MEMORY_API_BASE
    try:
        resp = httpx.get(f"{base}/instances/{instance_id}", timeout=5.0)
        if resp.status_code == 404:
            return 0, None
        resp.raise_for_status()
        data = resp.json()
        cycles = int(data.get("idle_consecutive_cycles") or 0)
        ts_str = data.get("last_idle_reminder_sent_at")
        last_sent: datetime | None = None
        if ts_str:
            last_sent = datetime.fromisoformat(ts_str)
            if last_sent.tzinfo is None:
                last_sent = last_sent.replace(tzinfo=UTC)
        return cycles, last_sent
    except Exception:
        logger.warning("Could not fetch idle state for %s — skipping update", instance_id, exc_info=True)
        return None


def update_idle_state(
    instance_id: str,
    consecutive_cycles: int,
    last_reminder_sent_at: datetime | None,
    memory_api_base: str | None = None,
) -> None:
    """Persist idle state to bot_instances via memory server API."""
    base = memory_api_base or MEMORY_API_BASE
    payload: dict = {"idle_consecutive_cycles": consecutive_cycles}
    if last_reminder_sent_at is not None:
        payload["last_idle_reminder_sent_at"] = last_reminder_sent_at.isoformat()
    try:
        resp = httpx.patch(f"{base}/instances/{instance_id}/idle", json=payload, timeout=5.0)
        resp.raise_for_status()
    except Exception:
        logger.warning("Could not update idle state for %s", instance_id, exc_info=True)


def should_send_reminder(
    consecutive_cycles: int,
    last_sent_at: datetime | None,
    limit: int,
    cooldown_seconds: int,
    now: datetime | None = None,
) -> bool:
    """Return True when threshold is breached and cooldown has expired."""
    if limit <= 0:
        return False
    if consecutive_cycles < limit:
        return False
    if last_sent_at is None:
        return True
    _now = now or datetime.now(UTC)
    return (_now - last_sent_at).total_seconds() >= cooldown_seconds


def fetch_open_tasks(
    memory_api_base: str | None = None,
    instance_id: str | None = None,
) -> list[dict]:
    """Fetch tasks with pr_open status from the memory server REST API."""
    base = memory_api_base or MEMORY_API_BASE
    params: dict[str, str] = {"status": "pr_open"}
    if instance_id:
        params["instance_id"] = instance_id
    try:
        resp = httpx.get(f"{base}/tasks", params=params, timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
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
    consecutive_cycles: int,
    instance_id: str | None = None,
    memory_api_base: str | None = None,
    slack_webhook_url: str | None = None,
) -> datetime | None:
    """Send a Slack reminder listing outstanding open PRs.

    Returns the timestamp of the sent reminder on success, None on failure.
    """
    webhook = slack_webhook_url or os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook:
        logger.warning("SLACK_WEBHOOK_URL not set — skipping idle reminder")
        return None

    try:
        tasks = fetch_open_tasks(memory_api_base, instance_id=instance_id)

        lines = [
            f":bell: *Bot idle for {consecutive_cycles} cycles — outstanding work may need attention*",
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
        sent_at = datetime.now(UTC)
        logger.info("Idle reminder sent after %d consecutive idle cycles", consecutive_cycles)
        return sent_at
    except Exception:
        logger.warning("Failed to send idle reminder to Slack", exc_info=True)
        return None


def on_preflight_skip(
    instance_id: str,
    *,
    idle_cycle_limit: int,
    cooldown_seconds: int = _DEFAULT_COOLDOWN_SECONDS,
    memory_api_base: str | None = None,
    _now: datetime | None = None,
) -> None:
    """Increment idle counter on preflight skip, send reminder if due, persist to DB."""
    if not instance_id:
        return

    state = fetch_idle_state(instance_id, memory_api_base)
    if state is None:
        return

    consecutive_cycles, last_sent_at = state
    consecutive_cycles += 1

    if should_send_reminder(consecutive_cycles, last_sent_at, idle_cycle_limit, cooldown_seconds, now=_now):
        sent_at = send_reminder(consecutive_cycles, instance_id=instance_id, memory_api_base=memory_api_base)
        if sent_at is not None:
            last_sent_at = sent_at

    update_idle_state(instance_id, consecutive_cycles, last_sent_at, memory_api_base)


def on_preflight_start(
    instance_id: str,
    memory_api_base: str | None = None,
) -> None:
    """Reset idle tracking when preflight starts a real session."""
    if not instance_id:
        return
    update_idle_state(instance_id, 0, None, memory_api_base)

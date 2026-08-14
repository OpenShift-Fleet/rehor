import json
import logging
import os
from datetime import UTC, datetime, timedelta

import httpx
from fastmcp import FastMCP

from ..db import get_pool
from ..events import Event, bus

logger = logging.getLogger(__name__)

COOLDOWN_HOURS = 48


def register_slack_tools(mcp: FastMCP):
    @mcp.tool()
    async def slack_notify(
        external_key: str,
        event_type: str = "",
        message: str = "",
        webhook_url: str | None = os.environ.get("SLACK_WEBHOOK_URL"),
        source_type: str = "jira",
        instance_id: str | None = None,
        notify_mode: str = "immediate",
    ) -> dict:
        """Send a Slack notification. Deduplicates by external_key (48h cooldown per ticket, any event type).

        In daily_digest mode, suppresses the notification (digest reads from tasks table directly).

        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        source_type: Source system — 'jira', 'github', etc.
        event_type: 'pr_created', 'release_pending', 'needs_help', 'infra_error', 'review_reminder'.
        message: Human-readable message to post. Keep it concise (1-2 sentences + links).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var on the memory server.
        instance_id: Bot instance identifier (optional, used for digest grouping).
        notify_mode: 'immediate' (default) or 'daily_digest'. Passed by the caller from its env.

        Returns {"sent": true/false, "reason": "..."} or {"suppressed": true} in digest mode."""
        pool = get_pool()

        if not webhook_url:
            return {"sent": False, "reason": "SLACK_WEBHOOK_URL not configured"}

        if notify_mode == "daily_digest":
            return {
                "sent": False,
                "suppressed": True,
                "reason": "Suppressed — daily digest mode active",
            }

        cutoff = datetime.now(UTC) - timedelta(hours=COOLDOWN_HOURS)
        recent = await pool.fetchrow(
            """
            SELECT id, event_type, sent_at FROM slack_notifications
            WHERE external_key = $1 AND sent_at > $2
            ORDER BY sent_at DESC LIMIT 1
            """,
            external_key,
            cutoff,
        )

        if recent:
            return {
                "sent": False,
                "reason": (
                    f"Cooldown active — last {recent['event_type']} for "
                    f"{external_key} sent {recent['sent_at'].isoformat()}"
                ),
            }

        try:
            if "/services/" in webhook_url:
                payload = {"text": message}
            else:
                payload = {"msg": message}
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(webhook_url, json=payload)
                resp.raise_for_status()
        except Exception as e:
            logger.error("Slack webhook failed: %s", e)
            return {"sent": False, "reason": f"Webhook error: {e}"}

        await pool.execute(
            """
            INSERT INTO slack_notifications (external_key, source_type, event_type, message)
            VALUES ($1, $2, $3, $4)
            """,
            external_key,
            source_type,
            event_type,
            message,
        )

        await bus.publish(
            Event(
                "slack_notification",
                {
                    "external_key": external_key,
                    "event_type": event_type,
                    "message": message,
                },
            )
        )

        return {"sent": True, "reason": "ok"}

    @mcp.tool()
    async def slack_send_digest(
        instance_id: str | None = None,
        webhook_url: str | None = os.environ.get("SLACK_WEBHOOK_URL"),
        digest_key: str | None = None,
    ) -> dict:
        """Send a daily digest of open PRs from the tasks table.

        Queries tasks with status pr_open or pr_changes and formats a
        snapshot summary. This is NOT event-based — it always reflects the
        current state of open PRs.

        Timing and weekend checks are handled by the caller (bot runner).
        This tool handles sent-today deduplication via digest_key in
        slack_notifications table.

        instance_id: Filter tasks by bot instance (optional).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var.
        digest_key: Deterministic key (e.g. digest-instance-2026-07-28) for
            sent-today deduplication. If already in slack_notifications, skips.

        Returns {"sent": true/false, "count": N, "reason": "..."}."""
        if not webhook_url:
            return {"sent": False, "count": 0, "reason": "SLACK_WEBHOOK_URL not configured"}

        pool = get_pool()

        if digest_key:
            already_sent = await pool.fetchrow(
                "SELECT id FROM slack_notifications WHERE external_key = $1",
                digest_key,
            )
            if already_sent:
                return {"sent": False, "count": 0, "reason": f"Digest already sent: {digest_key}"}

        if instance_id:
            rows = await pool.fetch(
                """
                SELECT external_key, status, title, repo, artifacts, metadata, created_at
                FROM tasks
                WHERE status = ANY($1::task_status[])
                AND instance_id = $2
                ORDER BY created_at ASC
                """,
                ["pr_open", "pr_changes"],
                instance_id,
            )
        else:
            rows = await pool.fetch(
                """
                SELECT external_key, status, title, repo, artifacts, metadata, created_at
                FROM tasks
                WHERE status = ANY($1::task_status[])
                ORDER BY created_at ASC
                """,
                ["pr_open", "pr_changes"],
            )

        if not rows:
            return {"sent": False, "count": 0, "reason": "No open PRs to report"}

        now = datetime.now(UTC)
        digest_message = _format_digest(instance_id, rows, now)

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(webhook_url, json={"msg": digest_message})
                resp.raise_for_status()
        except Exception as e:
            logger.error("Slack digest webhook failed: %s", e)
            return {"sent": False, "count": len(rows), "reason": f"Webhook error: {e}"}

        if digest_key:
            await pool.execute(
                """
                INSERT INTO slack_notifications (external_key, source_type, event_type, message)
                VALUES ($1, $2, $3, $4)
                """,
                digest_key,
                "digest",
                "daily_digest",
                digest_message,
            )

        await bus.publish(
            Event(
                "slack_digest_sent",
                {"instance_id": instance_id, "count": len(rows)},
            )
        )

        return {"sent": True, "count": len(rows), "reason": "ok"}


def _format_digest(instance_id: str | None, rows: list, now: datetime) -> str:
    date_str = now.strftime("%Y-%m-%d")
    instance_label = f"Instance: {instance_id}" if instance_id else "All instances"
    lines = [f"Daily Bot Digest — {instance_label} | {date_str}", ""]

    lines.append(f"Open PRs ({len(rows)}):")
    for r in rows:
        pr_label = _format_pr_label(r)
        title_part = f" — {r['title']}" if r.get("title") else ""
        age_days = (now - r["created_at"]).days
        status_label = _status_label(r["status"])
        lines.append(f"• {pr_label}{title_part} - {r['external_key']} · {status_label} {age_days}d")
    lines.append("")

    return "\n".join(lines)


_STATUS_LABELS = {
    "pr_open": "open for",
    "pr_changes": "changes requested ·",
}


def _status_label(status: str) -> str:
    return _STATUS_LABELS.get(status, status)


def _parse_artifacts(raw) -> list:
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if isinstance(raw, list):
        return raw
    return []


def _format_pr_label(row) -> str:
    artifacts = _parse_artifacts(row.get("artifacts"))
    for art in artifacts:
        art_type = art.get("type", "")
        if art_type in ("pull_request", "merge_request") and art.get("url"):
            name = art.get("name", "PR")
            return f"{name} ({art['url']})"

    metadata = row.get("metadata")
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (json.JSONDecodeError, TypeError):
            metadata = {}
    if isinstance(metadata, dict):
        prs = metadata.get("prs", [])
        if prs and isinstance(prs, list) and prs[0].get("url"):
            pr = prs[0]
            repo = row.get("repo", "")
            number = pr.get("number", "?")
            return f"{repo}#{number} ({pr['url']})"

    return "PR (no link)"

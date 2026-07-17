import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastmcp import FastMCP

from ..db import get_pool
from ..events import Event, bus

logger = logging.getLogger(__name__)

COOLDOWN_HOURS = 48
PR_EVENT_TYPES = {"pr_created", "review_reminder"}


def register_slack_tools(mcp: FastMCP):
    @mcp.tool()
    async def slack_notify(
        external_key: str,
        event_type: str = "",
        message: str = "",
        webhook_url: Optional[str] = os.environ.get("SLACK_WEBHOOK_URL"),
        source_type: str = "jira",
        instance_id: Optional[str] = None,
        pr_url: Optional[str] = None,
        pr_number: Optional[int] = None,
        repo: Optional[str] = None,
        title: Optional[str] = None,
    ) -> dict:
        """Send a Slack notification. Deduplicates by external_key (48h cooldown per ticket, any event type).

        In daily_digest mode (SLACK_NOTIFY_MODE=daily_digest), queues the notification
        instead of sending immediately. Use slack_send_digest to send the digest.

        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        source_type: Source system — 'jira', 'github', etc.
        event_type: 'pr_created', 'release_pending', 'needs_help', 'infra_error', 'review_reminder'.
        message: Human-readable message to post. Keep it concise (1-2 sentences + links).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var on the memory server.
        instance_id: Bot instance identifier (optional, used for digest grouping).
        pr_url: PR URL (optional, used for richer digest formatting).
        pr_number: PR number (optional, used for richer digest formatting).
        repo: Repository name (optional, used for richer digest formatting).
        title: PR/issue title (optional, used for richer digest formatting).

        Returns {"sent": true/false, "reason": "..."} or {"queued": true} in digest mode."""
        pool = get_pool()

        if not webhook_url:
            return {"sent": False, "reason": "SLACK_WEBHOOK_URL not configured"}

        notify_mode = os.environ.get("SLACK_NOTIFY_MODE", "immediate")

        if notify_mode == "daily_digest":
            await pool.execute(
                """
                INSERT INTO slack_digest_queue
                    (instance_id, jira_key, event_type, pr_url, pr_number, repo, title, message)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                instance_id,
                external_key,
                event_type,
                pr_url,
                pr_number,
                repo,
                title,
                message,
            )
            return {"sent": False, "queued": True, "reason": "Queued for daily digest"}

        cutoff = datetime.now(timezone.utc) - timedelta(hours=COOLDOWN_HOURS)
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
        instance_id: Optional[str] = None,
        webhook_url: Optional[str] = os.environ.get("SLACK_WEBHOOK_URL"),
    ) -> dict:
        """Send a daily digest of queued Slack notifications.

        Groups events by jira_key, formats a single summary message, and sends
        to the webhook. Skips weekends (Sat/Sun — events accumulate to Monday).
        Skips silently when the queue is empty.

        instance_id: Filter queued items by bot instance (optional).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var.

        Returns {"sent": true/false, "count": N, "reason": "..."}."""
        if not webhook_url:
            return {"sent": False, "count": 0, "reason": "SLACK_WEBHOOK_URL not configured"}

        now = datetime.now(timezone.utc)
        if now.weekday() >= 5:
            return {"sent": False, "count": 0, "reason": "Weekend — digest skipped"}

        pool = get_pool()

        if instance_id:
            rows = await pool.fetch(
                """
                SELECT * FROM slack_digest_queue
                WHERE sent = FALSE AND instance_id = $1
                ORDER BY queued_at ASC
                """,
                instance_id,
            )
        else:
            rows = await pool.fetch(
                """
                SELECT * FROM slack_digest_queue
                WHERE sent = FALSE
                ORDER BY queued_at ASC
                """,
            )

        if not rows:
            return {"sent": False, "count": 0, "reason": "No items to digest"}

        digest_message = _format_digest(instance_id, rows, now)

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(webhook_url, json={"msg": digest_message})
                resp.raise_for_status()
        except Exception as e:
            logger.error("Slack digest webhook failed: %s", e)
            return {"sent": False, "count": len(rows), "reason": f"Webhook error: {e}"}

        row_ids = [r["id"] for r in rows]
        await pool.execute(
            "UPDATE slack_digest_queue SET sent = TRUE WHERE id = ANY($1::int[])",
            row_ids,
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
    instance_label = f"Instance: `{instance_id}`" if instance_id else "All instances"
    lines = [f"*Daily Bot Digest* — {instance_label} | {date_str}", ""]

    pr_items = [r for r in rows if r["event_type"] in PR_EVENT_TYPES]
    other_items = [r for r in rows if r["event_type"] not in PR_EVENT_TYPES]

    if pr_items:
        lines.append(f"*PR events ({len(pr_items)}):*")
        for r in pr_items:
            pr_label = _format_pr_label(r)
            title_part = f" — {r['title']}" if r["title"] else ""
            lines.append(f"• {pr_label}{title_part}")
            lines.append(f"  {r['jira_key']} | {r['event_type']}")
        lines.append("")

    if other_items:
        lines.append(f"*Other events ({len(other_items)}):*")
        for r in other_items:
            lines.append(f"• {r['jira_key']}: {r['event_type']} — {r['message']}")
        lines.append("")

    return "\n".join(lines)


def _format_pr_label(row) -> str:
    if row["pr_url"] and row["pr_number"] and row["repo"]:
        return f"<{row['pr_url']}|{row['repo']}#{row['pr_number']}>"
    if row["pr_url"] and row["pr_number"]:
        return f"<{row['pr_url']}|#{row['pr_number']}>"
    if row["pr_url"]:
        return f"<{row['pr_url']}|PR>"
    return "PR"

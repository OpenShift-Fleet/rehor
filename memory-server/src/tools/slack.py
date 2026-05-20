import logging
import os
from datetime import datetime, timezone, timedelta

import httpx
from fastmcp import FastMCP

from ..db import get_pool
from ..events import Event, bus

logger = logging.getLogger(__name__)

COOLDOWN_HOURS = 48  # Don't re-notify same task within this window


def register_slack_tools(mcp: FastMCP):
    @mcp.tool()
    async def slack_notify(
        jira_key: str,
        event_type: str,
        message: str,
        webhook_url: Optional[str] = os.environ.get("SLACK_WEBHOOK_URL"),
    ) -> dict:
        """Send a Slack notification. Deduplicates by jira_key (48h cooldown per ticket, any event type).

        event_type: 'pr_created', 'release_pending', 'needs_help', 'infra_error', 'review_reminder'.
        message: Human-readable message to post. Keep it concise (1-2 sentences + links).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var on the memory server.

        Returns {"sent": true/false, "reason": "..."}.
        Skipped silently if cooldown active or webhook not configured."""
        pool = get_pool()

        if not webhook_url:
            return {"sent": False, "reason": "SLACK_WEBHOOK_URL not configured"}

        # Check cooldown — any notification for this jira_key within 48h
        cutoff = datetime.now(timezone.utc) - timedelta(hours=COOLDOWN_HOURS)
        recent = await pool.fetchrow(
            """
            SELECT id, event_type, sent_at FROM slack_notifications
            WHERE jira_key = $1 AND sent_at > $2
            ORDER BY sent_at DESC LIMIT 1
            """,
            jira_key,
            cutoff,
        )

        if recent:
            return {
                "sent": False,
                "reason": f"Cooldown active — last {recent['event_type']} for {jira_key} sent {recent['sent_at'].isoformat()}",
            }

        # Send to Slack
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(webhook_url, json={"msg": message})
                resp.raise_for_status()
        except Exception as e:
            logger.error("Slack webhook failed: %s", e)
            return {"sent": False, "reason": f"Webhook error: {e}"}

        # Record notification
        await pool.execute(
            """
            INSERT INTO slack_notifications (jira_key, event_type, message)
            VALUES ($1, $2, $3)
            """,
            jira_key,
            event_type,
            message,
        )

        await bus.publish(
            Event(
                "slack_notification",
                {
                    "jira_key": jira_key,
                    "event_type": event_type,
                    "message": message,
                },
            )
        )

        return {"sent": True, "reason": "ok"}

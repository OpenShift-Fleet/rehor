import logging
import os
from datetime import datetime, timezone, timedelta
from typing import Optional

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
        webhook_url: Optional[str] = os.environ.get("SLACK_WEBHOOK_URL"),
        source_type: str = "jira",
    ) -> dict:
        """Send a Slack notification. Deduplicates by external_key (48h cooldown per ticket, any event type).
        external_key: The external identifier (e.g. Jira key 'RHCLOUD-12345').
        source_type: Source system — 'jira', 'github', etc.
        event_type: 'pr_created', 'release_pending', 'needs_help', 'infra_error', 'review_reminder'.
        message: Human-readable message to post. Keep it concise (1-2 sentences + links).
        webhook_url: Slack webhook URL. Defaults to SLACK_WEBHOOK_URL env var on the memory server.

        Returns {"sent": true/false, "reason": "..."}."""
        pool = get_pool()

        if not webhook_url:
            return {"sent": False, "reason": "SLACK_WEBHOOK_URL not configured"}

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
                "reason": f"Cooldown active — last {recent['event_type']} for {external_key} sent {recent['sent_at'].isoformat()}",
            }

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(webhook_url, json={"msg": message})
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

#!/usr/bin/env python3
"""Slack daily digest — runner-triggered, zero LLM tokens.

Called by bot/run.py after each cycle. Checks conditions locally
(hour, weekend, webhook) before calling the memory server MCP tool.

Usage:
    python3 bot/slack_digest.py digest
    python3 bot/slack_digest.py status <JIRA_KEY>
"""

import json
import logging
import os
import sys
from datetime import UTC, datetime

from .memory_mcp import memory_call, memory_cleanup

logger = logging.getLogger(__name__)


def try_slack_digest() -> None:
    """Entry point called by bot/run.py after each cycle. Zero LLM tokens."""
    if not os.environ.get("SLACK_WEBHOOK_URL"):
        return
    try:
        cmd_digest()
    except Exception as e:
        logger.warning("Slack digest failed: %s", e)


def cmd_digest():
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        print(json.dumps({"sent": False, "reason": "SLACK_WEBHOOK_URL not set"}))
        return

    now = datetime.now(UTC)

    if now.weekday() >= 5:
        print(json.dumps({"sent": False, "reason": "Weekend — digest skipped"}))
        return

    digest_hour_raw = os.environ.get("SLACK_DIGEST_HOUR")
    if not digest_hour_raw:
        return

    digest_hour = int(digest_hour_raw)
    if now.hour < digest_hour:
        print(json.dumps({"sent": False, "reason": f"Before digest hour (current: {now.hour}, target: {digest_hour})"}))
        return

    instance_id = os.environ.get("BOT_INSTANCE_ID") or None
    digest_key = f"digest-{instance_id or 'all'}-{now.strftime('%Y-%m-%d')}"

    result = memory_call(
        "slack_send_digest",
        {
            "instance_id": instance_id,
            "webhook_url": webhook_url,
            "digest_key": digest_key,
        },
    )
    memory_cleanup()

    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({"sent": False, "reason": "MCP call failed"}))


def cmd_status(jira_key):
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        print(json.dumps({"sent": False, "reason": "SLACK_WEBHOOK_URL not set"}))
        return

    result = memory_call(
        "slack_notify",
        {
            "external_key": jira_key,
            "event_type": "status_update",
            "message": f"Status update requested for {jira_key}",
            "webhook_url": webhook_url,
        },
    )
    memory_cleanup()

    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({"sent": False, "reason": "MCP call failed"}))


def main():
    if len(sys.argv) < 2:
        print("Usage: slack_cmd.py <digest|status> [JIRA_KEY]", file=sys.stderr)
        sys.exit(1)

    subcmd = sys.argv[1]

    if subcmd == "digest":
        cmd_digest()
    elif subcmd == "status":
        if len(sys.argv) < 3:
            print("Usage: slack_cmd.py status <JIRA_KEY>", file=sys.stderr)
            sys.exit(1)
        cmd_status(sys.argv[2])
    else:
        cmd_status(subcmd)


if __name__ == "__main__":
    main()

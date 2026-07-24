#!/usr/bin/env python3
"""Slack daily digest — runner-triggered, zero LLM tokens.

Called by bot/run.py after each cycle. Checks conditions locally
(hour, weekend, webhook) before calling the memory server MCP tool.

Usage:
    python3 bot/slack_digest.py digest
    python3 bot/slack_digest.py status <JIRA_KEY>
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".claude" / "skills"))
from memory_mcp import memory_call, memory_cleanup


def cmd_digest():
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        print(json.dumps({"sent": False, "reason": "SLACK_WEBHOOK_URL not set"}))
        return

    now = datetime.now(timezone.utc)

    if now.weekday() >= 5:
        print(json.dumps({"sent": False, "reason": "Weekend — digest skipped"}))
        return

    digest_hour = int(os.environ.get("SLACK_DIGEST_HOUR", "9"))
    if now.hour != digest_hour:
        print(json.dumps({"sent": False, "reason": f"Not digest hour (current: {now.hour}, target: {digest_hour})"}))
        return

    instance_id = os.environ.get("BOT_INSTANCE_ID") or None
    result = memory_call(
        "slack_send_digest",
        {
            "instance_id": instance_id,
            "webhook_url": webhook_url,
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

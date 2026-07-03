#!/usr/bin/env python3
"""Send Slack notification via memory-server MCP. Reads SLACK_WEBHOOK_URL from env.

Usage:
    python3 .claude/skills/slack-notify/slack_notify.py <jira_key> <event_type> <message>

Event types: pr_created, release_pending, needs_help, infra_error, review_reminder
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from memory_mcp import memory_call, memory_cleanup


def main():
    if len(sys.argv) < 4:
        print(
            "Usage: slack_notify.py <jira_key> <event_type> <message>",
            file=sys.stderr,
        )
        sys.exit(1)

    jira_key = sys.argv[1]
    event_type = sys.argv[2]
    message = sys.argv[3]

    webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        print(json.dumps({"sent": False, "reason": "SLACK_WEBHOOK_URL not set"}))
        return

    result = memory_call(
        "slack_notify",
        {
            "external_key": jira_key,
            "event_type": event_type,
            "message": message,
            "webhook_url": webhook_url,
        },
    )
    memory_cleanup()

    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({"sent": False, "reason": "MCP call failed"}))


if __name__ == "__main__":
    main()

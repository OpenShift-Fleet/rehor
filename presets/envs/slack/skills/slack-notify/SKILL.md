---
name: slack-notify
description: >
  Send Slack notification. Reads SLACK_WEBHOOK_URL from env, calls memory-server
  MCP slack_notify w/ webhook_url. No-ops if webhook not configured.
when_to_use: >
  Any Slack notification. Replaces direct slack_notify MCP calls.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/slack-notify/slack_notify.py *)"
---

```bash
python3 .claude/skills/slack-notify/slack_notify.py <JIRA_KEY> <EVENT_TYPE> "<MESSAGE>" 2>&1
```

Events: `pr_created`, `release_pending`, `needs_help`, `infra_error`, `review_reminder`.

Msg = normal human language (NOT caveman). 1-2 sentences + links.

Output: `{"sent": true/false, "reason": "..."}`. No webhook → silent no-op. 48h cooldown/ticket automatic.

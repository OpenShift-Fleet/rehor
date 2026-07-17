---
name: slack-digest
description: >
  Slack daily digest management. Send daily digest of queued notifications
  or trigger a status update for a specific ticket.
  Routes through memory-server MCP for deduplication and digest support.
when_to_use: >
  Invoke for Slack digest or status updates. Triggers on: "slack digest",
  "slack status", "send digest". Subcommands: `/slack-digest digest`, `/slack-digest RHCLOUD-XXX`.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/slack-digest/slack_cmd.py *)"
---

## Subcommands

### `/slack-digest digest`
Trigger the daily digest. Sends all queued notifications as a single message.
Skips weekends (Sat/Sun) and empty queues silently.

```bash
python3 .claude/skills/slack-digest/slack_cmd.py digest 2>&1
```

### `/slack-digest RHCLOUD-XXX`
Send a status update for a specific ticket.

```bash
python3 .claude/skills/slack-digest/slack_cmd.py status RHCLOUD-12345 2>&1
```

Output: `{"sent": true/false, "reason": "..."}` or `{"sent": true, "count": N}` for digest.

## Scheduling

Set up weekday daily digest via durable cron:
```
CronCreate(cron="0 {SLACK_DIGEST_HOUR} * * 1-5", prompt="/slack-digest digest", recurring=true, durable=true)
```

## Configuration

- `SLACK_WEBHOOK_URL` -- Slack webhook URL (required)
- `SLACK_NOTIFY_MODE` -- "immediate" (default) or "daily_digest"
- `SLACK_DIGEST_HOUR` -- Hour in UTC for digest scheduling (default: 9)
- `BOT_INSTANCE_ID` -- Instance identifier for multi-instance environments

---
name: post-pr
description: >
  Consolidates post-PR-creation bookkeeping (task updates, JIRA transitions,
  Slack notifications, learning storage) into a single efficient operation
when_to_use: >
  Invoke after creating a PR to handle all bookkeeping operations. Triggers on:
  "pr created", "post pr", "pr bookkeeping". Replaces manual task_update +
  jira_transition + jira_comment + slack_notify + memory_store calls.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/post-pr/post_pr.py *)"
  - Read
  - mcp__bot-memory__task_update
  - mcp__bot-memory__bot_status_update
  - mcp__bot-memory__memory_store
  - mcp__mcp-atlassian__jira_transition_issue
  - mcp__mcp-atlassian__jira_add_comment
---

Run the post-pr script for a newly created PR:

```bash
python3 .claude/skills/post-pr/post_pr.py <JIRA_KEY> 2>&1
```

Use `--dry-run` to preview without making changes:

```bash
python3 .claude/skills/post-pr/post_pr.py <JIRA_KEY> --dry-run 2>&1
```

The script:
1. Fetches task data from memory server (pr_url, pr_number, summary)
2. Updates GitHub PR (labels, JIRA link)
3. Transitions JIRA → "Code Review"
4. Posts JIRA comment with PR link
5. Sends Slack notification (`pr_created`)
6. Stores implementation learnings
7. Updates bot status → `idle`

## Operations Performed

1. **GitHub PR Update** - Adds labels (`code-review`, `awaiting-review`) and JIRA link
2. **JIRA Transition** - Moves ticket to "Code Review" status
3. **JIRA Comment** - Posts PR link and summary
4. **Slack Notification** - Sends `pr_created` event notification
5. **Memory Storage** - Saves implementation learnings
6. **Bot Status Update** - Sets status to `idle`

## Error Handling

Fail-fast approach: if any operation fails, execution stops immediately and reports the error.

## Testing

Run tests with:

```bash
cd .claude/skills/post-pr

# Unit tests (21 tests - individual operations)
uv run pytest tests/test_operations.py -v

# Integration tests (12 tests - full workflow scenarios)
uv run pytest tests/test_integration.py -v

# All tests (35 total)
uv run pytest tests/ -v

# With coverage report
uv run pytest tests/ --cov=scripts --cov-report=html -v
```

## Configuration

Environment variables for API integration:

**Required:**
- `GITHUB_TOKEN` or `GH_TOKEN`: GitHub API token for PR operations
- `POST_PR_JIRA_TOKEN`: JIRA API token for issue transitions and comments
- `POST_PR_JIRA_EMAIL`: Email address for JIRA Basic authentication
- `SLACK_WEBHOOK_URL`: Slack incoming webhook URL for notifications

**Optional:**
- `POST_PR_JIRA_URL`: JIRA instance URL (default: https://redhat.atlassian.net)
- `POST_PR_MEMORY_STORE`: Memory storage path (default: /tmp/memory.json)

## Notes

- All inputs are known at PR creation time; no LLM reasoning needed
- Operations execute sequentially with fail-fast error handling
- Designed for speed: ~5-6 tool calls → 1 script execution
- Full API integration: GitHub REST API, JIRA Cloud API v3, Slack via memory-server MCP
- Uses Basic authentication for JIRA Cloud (email + API token)
- Supports both dry-run mode and skip operations for flexibility
- Logging to stdout for visibility in Claude Code output

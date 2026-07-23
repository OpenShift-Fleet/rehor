---
name: claim-ticket
description: >
  Consolidates ticket claiming operations (assign, transition, add to sprint, track)
  into a single efficient operation, reducing ~10 tool calls per new-work cycle
when_to_use: >
  Invoke when claiming a new JIRA ticket. Triggers on: "claim ticket", "assign ticket",
  "pick up work", "start new ticket". Replaces manual jira_update_issue + jira_transition +
  jira_add_issues_to_sprint + task_add calls.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/claim-ticket/scripts/claim_ticket_operations.py *)"
  - Read
---

Execute the claim-ticket workflow after selecting a ticket:

```bash
python3 .claude/skills/claim-ticket/scripts/claim_ticket_operations.py RHCLOUD-12345 2>&1
```

Use `--dry-run` to preview without executing:

```bash
python3 .claude/skills/claim-ticket/scripts/claim_ticket_operations.py RHCLOUD-12345 --dry-run 2>&1
```

The script executes 8 operations in sequence:

1. **get_bot_account_id** - Retrieve bot's JIRA account ID via jira_get_user_profile
2. **get_transitions** - Get available transitions via jira_get_transitions
3. **assign_ticket** - Assign ticket via jira_update_issue
4. **transition_to_in_progress** - Move to "In Progress" via jira_transition_issue
5. **resolve_board** - Determine board from BOT_BOARD_ID or BOT_BOARD_NAME env var
6. **get_active_sprint** - Get active sprint via jira_get_sprints_from_board
7. **add_to_sprint** - Add to sprint via jira_add_issues_to_sprint
8. **task_add** - Track in memory server

All operations use **fail-fast error handling**: if any operation fails, execution stops immediately.

## Configuration

Set these environment variables:

```bash
# JIRA MCP Server (required)
export JIRA_MCP_URL=http://proxy:8090

# Bot JIRA identity (required) — email of the bot's Jira service account (from Vault)
export BOT_JIRA_EMAIL=<your-bot-jira-email>

# Memory Server (required)
export BOT_MEMORY_URL=https://memory-server.example.com

# Board Configuration (one of these required for sprint assignment)
# WARNING: These are EXAMPLES — use your instance's actual board ID/name.
# Using wrong board IDs overwrites the ticket's existing sprint.
export BOT_BOARD_ID=<your-board-id>               # Direct board ID (skips lookup)
export BOT_BOARD_NAME="<Your Board Name>"         # Lookup board by name via Jira
```

## Authentication

JIRA operations use MCP via jira_call(). No API tokens needed - the mcp-atlassian server handles authentication. Bot identity for ticket assignment comes from `BOT_JIRA_EMAIL`.

Memory server operations use direct HTTP (POST /tasks).

## Board Resolution

Resolves board from environment variables (same as new-work skill):
- `BOT_BOARD_ID` set → use directly (fast path, no API call)
- `BOT_BOARD_NAME` set → lookup via `jira_get_agile_boards`
- Neither set → fail with error

## Error Handling

Fail-fast approach: if any operation fails, execution stops immediately and reports the error.

# Claim Ticket Skill

Consolidates the entire JIRA ticket claiming sequence into a single efficient operation, reducing ~10 tool calls per new-work cycle into one script execution.

## Quick Start

```bash
# Install dependencies with uv
uv sync

# Run tests
uv run pytest -v

# Run with coverage
uv run pytest --cov=scripts --cov-report=html -v

# Execute workflow
uv run python scripts/claim_ticket_operations.py RHCLOUD-12345
```

## What It Does

When the bot picks up new work, this skill executes 8 operations in sequence:

1. **get_bot_account_id** - Retrieve bot's JIRA account ID (cached after first call)
2. **get_transitions** - Get available transitions and find "In Progress" ID
3. **assign_ticket** - Assign ticket to bot user
4. **transition_to_in_progress** - Move ticket to "In Progress" status
5. **resolve_board** - Determine board from BOT_BOARD_ID or BOT_BOARD_NAME env var
6. **get_active_sprint** - Get active sprint from the board
7. **add_to_sprint** - Add ticket to active sprint
8. **task_add** - Track ticket in memory server

All operations use **fail-fast error handling**: if any operation fails, execution stops immediately.

## Usage

### From Claude Code

```bash
/claim-ticket RHCLOUD-12345
```

### From Command Line

```bash
# Basic usage
python scripts/claim_ticket_operations.py RHCLOUD-12345

# With options
uv run python scripts/claim_ticket_operations.py RHCLOUD-12345 \
  --jira-url=https://custom-jira.example.com \
  --skip=task_add \
  --dry-run

# JSON output
uv run python scripts/claim_ticket_operations.py RHCLOUD-12345 --json
```

### From Python

```python
from scripts.claim_ticket_operations import execute_claim_ticket_workflow

result = execute_claim_ticket_workflow(
    jira_key="RHCLOUD-12345",
    jira_url=None,  # Falls back to JIRA_URL env var
    jira_token=None,  # Falls back to JIRA_API_TOKEN or JIRA_API_TOKEN
    jira_email=None,  # Falls back to JIRA_EMAIL env var
    memory_url=None,  # Falls back to BOT_MEMORY_URL env var
    skip_operations=[],
    dry_run=False,
)

if result.success:
    print("✓ All operations completed successfully")
    for op in result.operations:
        print(f"  {op.operation}: {op.message}")
else:
    print("✗ Workflow failed")
    for op in result.operations:
        if op.status.value == "failed":
            print(f"  {op.operation}: {op.message}")
```

## Configuration

Set these environment variables for API integrations:

```bash
# JIRA Cloud (required)
export JIRA_API_TOKEN=your_api_token_here
export JIRA_EMAIL=your.email@redhat.com
export JIRA_URL=https://redhat.atlassian.net  # Optional, default

# Alternative JIRA token (fallback)
export JIRA_API_TOKEN=your_api_token_here

# Memory Server (required)
export BOT_MEMORY_URL=https://memory-server.example.com

# Board Configuration (one of these required for sprint assignment)
# WARNING: These are EXAMPLES — use your instance's actual board ID/name.
# Using wrong board IDs overwrites the ticket's existing sprint.
export BOT_BOARD_ID=<your-board-id>               # Direct board ID (skips lookup)
export BOT_BOARD_NAME="<Your Board Name>"         # Lookup board by name via Jira
```

**Note:** Uses JIRA Cloud API v3 with Basic authentication (email + API token).

## Testing

```bash
# Run all tests (54 total)
uv run pytest -v

# Run specific test file
uv run pytest tests/test_operations.py -v  # 36 unit tests
uv run pytest tests/test_integration.py -v  # 18 integration tests

# Run with coverage
uv run pytest --cov=scripts --cov-report=html -v

# View coverage report
open htmlcov/index.html
```

### Test Coverage

- **Unit tests** (`test_operations.py`): 36 tests for individual operations
  - Verifies exact API URLs, headers, JSON payloads
  - Tests error handling and edge cases
  - Validates JIRA API v3 and Agile API v1.0 integrations
  - Tests bot account ID caching

- **Integration tests** (`test_integration.py`): 18 tests for full workflow
  - End-to-end scenarios with mocked APIs
  - Tests fail-fast behavior
  - Validates skip operations and dry-run mode
  - Tests environment variable precedence

## Architecture

### Design Principles

1. **Fail fast**: Stop on first error to maintain consistency
2. **No LLM reasoning**: All logic is deterministic
3. **Sequential execution**: Operations have dependencies
4. **Idempotent**: Safe to retry on failure
5. **Observable**: Logs all actions to stdout
6. **Testable**: Comprehensive unit and integration tests
7. **Performance**: Caches bot account ID after first retrieval

### File Structure

```
.claude/skills/claim-ticket/
├── SKILL.md                        # Skill documentation (Claude Code entrypoint)
├── README.md                       # This file
├── pyproject.toml                  # Dependencies and tool config
├── uv.lock                         # Locked dependencies
├── scripts/
│   ├── __init__.py
│   └── claim_ticket_operations.py # Main implementation (~800 lines)
└── tests/
    ├── __init__.py
    ├── test_operations.py          # Unit tests (36 tests)
    └── test_integration.py         # Integration tests (18 tests)
```

### Dependencies

- **Python 3.12+**: Modern type hints and language features
- **httpx >= 0.27.0**: HTTP client for JIRA and Memory Server APIs
- **pytest >= 8.0.0**: Testing framework (dev dependency)
- **pytest-cov >= 4.1.0**: Coverage reporting (dev dependency)

Managed with **uv** for fast, reliable dependency resolution.

## API Integrations

### JIRA Cloud API v3

- **Authentication**: Basic (email:token)
- **User Search**: `GET /rest/api/3/user/search?query={email}`
- **Transitions**: `GET/POST /rest/api/3/issue/{key}/transitions`
- **Assignee**: `PUT /rest/api/3/issue/{key}/assignee`
- **Issue Fields**: `GET /rest/api/3/issue/{key}?fields=labels`
- **Endpoint**: `https://redhat.atlassian.net` (default)

### JIRA Agile API v1.0

- **Sprint Search**: `GET /rest/agile/1.0/board/{boardId}/sprint?state=active`
- **Add to Sprint**: `POST /rest/agile/1.0/sprint/{sprintId}/issue`

### Memory Server API

- **Add Task**: `POST {BOT_MEMORY_URL}/tasks`

## Board Resolution Logic

The skill resolves the board from environment variables (same pattern as new-work skill):

1. If `BOT_BOARD_ID` is set → use directly (no API call needed)
2. If `BOT_BOARD_NAME` is set → lookup via `jira_get_agile_boards`
3. Neither set → fail with error
4. Get active sprint from the resolved board
5. Add ticket to that sprint

## Performance Optimizations

### Bot Account ID Caching

The bot's JIRA account ID is cached at the class level after the first retrieval:

```python
class ClaimTicketOperations:
    _bot_account_id_cache: Optional[str] = None  # Shared across all instances
```

**Benefits:**
- First call: 1 API request to get account ID
- Subsequent calls: Use cached value (0 API requests)
- Cache persists across workflow executions in the same process
- Reduces total API calls from 10 to 9 per ticket

## Troubleshooting

### Common Issues

**Error: "JIRA token not configured"**
- Set `JIRA_API_TOKEN` or `JIRA_API_TOKEN` environment variable
- Or pass `--jira-token` parameter

**Error: "JIRA email not configured"**
- Set `JIRA_EMAIL` environment variable
- Or pass `--jira-email` parameter

**Error: "Memory server URL not configured"**
- Set `BOT_MEMORY_URL` environment variable
- Or pass `--memory-url` parameter

**Error: "'In Progress' transition not found"**
- Verify the ticket supports "In Progress" status
- Check available transitions with: `gh api /rest/api/3/issue/{key}/transitions`

**Error: "No active sprint found"**
- Verify the board has an active sprint
- Check sprint state in JIRA

### Dry Run Mode

Use `--dry-run` to preview what would happen without executing:

```bash
uv run python scripts/claim_ticket_operations.py RHCLOUD-12345 --dry-run
```

This logs all actions but doesn't make API calls or modify tickets.

## Contributing

### Code Style

- **Line length**: 120 characters (black + ruff)
- **Type hints**: Required for all functions
- **Docstrings**: Google style for all public functions
- **Tests**: Required for all new operations

### Adding New Operations

1. Add method to `ClaimTicketOperations` class
2. Update `execute_claim_ticket_workflow` to call the new operation
3. Add unit tests in `tests/test_operations.py`
4. Add integration tests in `tests/test_integration.py`
5. Update SKILL.md documentation

### Running Tests Before Commit

```bash
# Lint and auto-fix
uv run ruff check --fix scripts/

# Run tests
uv run pytest -v

# Check coverage
uv run pytest --cov=scripts --cov-report=term-missing -v
```

**Note**: Line length is configured to 120 characters in pyproject.toml.

## Comparison with Manual Claiming

| Aspect | Manual (LLM) | /claim-ticket |
|--------|--------------|---------------|
| **Tool Calls** | ~10-15 (with retries) | 1 |
| **API Calls** | 10-15 | 9 (8 with caching) |
| **Board Detection** | Trial and error | Env var config, deterministic |
| **Account ID Lookup** | Every time | Cached after first call |
| **Error Handling** | Retry with LLM | Fail-fast with clear errors |
| **Execution Time** | ~30-60 seconds | ~2-5 seconds |
| **Reliability** | Depends on LLM reasoning | Deterministic, testable |

## License

Same as parent project (hcc-ai-assistant).

## Related

- **JIRA**: RHCLOUD-47263
- **Related Skills**:
  - `/post-pr` - Post-PR-creation bookkeeping
  - `/wrap-up` - Post-merge bookkeeping

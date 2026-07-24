# Mock API Server

Minimal HTTP server providing mock API endpoints for dashboard development and testing.

## Quick Start

```bash
python3 mock_api.py
```

Server runs at http://localhost:8080

## Features

- **WebSocket support** for real-time updates
- **CORS enabled** for cross-origin requests
- **Shared fixtures** with test suite (see `dashboard/tests/fixtures/api_payloads.py`)
- **Stateful operations** (pause/unpause tasks, archive, etc.)

## Endpoints

See server startup output for full endpoint list.

### Key Endpoints

**Tasks:**
- `GET /api/tasks` - List tasks (supports filters: status, instance_id, limit, offset)
- `POST /api/tasks/:key/pause` - Pause a task
- `POST /api/tasks/:key/unpause` - Unpause a task
- `POST /api/tasks/:key/unarchive` - Unarchive a task
- `DELETE /api/tasks/:key` - Archive a task

**Memories:**
- `GET /api/memories` - List memories (supports filters: category, repo, tag)
- `GET /api/memories/:id` - Get memory by ID
- `GET /api/memories/search` - Search memories
- `GET /api/memories/embeddings` - Get embedding visualization data
- `DELETE /api/memories/:id` - Delete a memory

**Analytics:**
- `GET /api/stats` - Task and memory counts
- `GET /api/analytics` - Full analytics summary
- `GET /api/costs` - Cost tracking data
- `GET /api/cycle-runs` - Cycle run history
- `GET /api/cycle-runs/by-task` - Cycle runs grouped by task
- `GET /api/cycle-runs/:id/transcript` - View cycle transcript

**Bot Status:**
- `GET /api/bot-status` - Current bot state
- `POST /api/bot-status` - Update bot state
- `GET /api/instances` - List bot instances
- `POST /api/instances/:id/wake` - Wake a bot instance

## Data Fixtures

All mock data is defined in `dashboard/tests/fixtures/api_payloads.py`.

This ensures:
- Tests and dev server use identical data structures
- Single source of truth for payload formats
- No drift between development and testing

### Modifying Data

Edit `dashboard/tests/fixtures/api_payloads.py` to:
- Add new tasks, memories, or other entities
- Change default datasets
- Adjust factory function behavior

Changes automatically apply to both mock server and tests.

## Architecture

```
mock_api.py                      # HTTP server (this file)
  ↓ imports
dashboard/tests/fixtures/
  api_payloads.py                # Shared fixtures
  __init__.py
  
dashboard/tests/
  test_*.py                      # Tests (also import fixtures)
  conftest.py
```

## Testing with the Mock API

The mock server is stateful within a session but resets on restart.

**Example workflow:**

1. Start mock server: `python3 mock_api.py`
2. Start dashboard dev server: `cd dashboard && npm run dev`
3. Interact with UI - changes persist in mock server
4. Run tests: `npm run test` (uses same fixtures)

## Default Data

- **6 tasks** (RHCLOUD-001 through RHCLOUD-006)
- **4 memories** (bug, architecture, decision, workaround)
- **4 cycle runs** (implementation, review, idle_check)
- **5 cost entries**
- **3 embeddings** for visualization
- **8 tags**
- Full analytics summary

See server output on startup for details.

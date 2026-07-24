# Dashboard Development Guide

## Development Setup

### 1. Start Mock API Server

```bash
# From repo root
python3 mock_api.py
```

Server runs at http://localhost:8080 with mock data for all endpoints.

See [mock_api.README.md](../mock_api.README.md) for full API documentation.

### 2. Start Dashboard Dev Server

```bash
cd dashboard
npm run dev
```

Dashboard runs at http://localhost:5173 (or configured port).

### 3. Run Tests

```bash
npm run test
```

## Architecture

### Shared Test Fixtures

Both the mock API server and test suite import from a **single source of truth**:

```
dashboard/tests/fixtures/api_payloads.py
```

This ensures:
- Mock server and tests always use identical data structures
- Changes to payload format propagate automatically
- No drift between dev server and test stubs

### Structure

```
rehor/
  mock_api.py              # Mock API server (imports fixtures)
  dashboard/
    tests/
      fixtures/
        api_payloads.py    # ← Single source of truth
        __init__.py
      conftest.py          # Pytest configuration
      test_*.py            # Test files (import fixtures)
    src/                   # React components
    ...
```

### Using Fixtures

**In tests:**

```python
from fixtures import TASKS, task, memory

def test_something():
    # Use default dataset
    assert len(TASKS) == 6
    
    # Or create custom payload
    custom = task(99, "TEST-1", "Summary", "in_progress")
    assert custom["id"] == 99
```

**In mock server:**

Already configured - just edit `fixtures/api_payloads.py` to add/modify data.

### Adding New Fixtures

1. Add factory function to `tests/fixtures/api_payloads.py`
2. Export from `tests/fixtures/__init__.py`
3. Use in both mock server and tests

## Mock API Endpoints

See server startup output for full endpoint list. Key endpoints:

- `GET /api/tasks` - List tasks with filters
- `GET /api/memories` - List memories
- `GET /api/cycle-runs` - Cycle run history
- `GET /api/costs` - Cost tracking
- `GET /api/analytics` - Analytics summary
- `POST /api/tasks/:key/pause` - Pause task
- `POST /api/tasks/:key/unpause` - Unpause task

## Benefits

✅ **Single source of truth** - one place to update payloads  
✅ **Type safety** - Python type hints catch errors early  
✅ **DRY** - factory functions eliminate duplication  
✅ **Sync guarantee** - impossible for mock server and tests to drift  
✅ **Easy testing** - just import fixtures and use them

# Dashboard Tests

## Structure

```
tests/
  fixtures/
    api_payloads.py  # Single source of truth for mock data
    __init__.py
  conftest.py        # Pytest configuration
  test_*.py          # Test files
```

## Shared Fixtures

The `fixtures/api_payloads.py` module provides:

- **Factory functions**: `task()`, `memory()`, `cycle_run()`, `cycle_entry()`
- **Default datasets**: `TASKS`, `MEMORIES`, `CYCLE_RUNS`, `COSTS`, etc.

Both the mock API server (`~/dev/mock_api.py`) and test files import from this module, ensuring data stays in sync.

## Running Tests

```bash
# Install pytest if needed
npm run test  # or configure package.json

# Or directly
pytest tests/
pytest tests/test_api_payloads.py -v
```

## Adding New Fixtures

1. Add factory function to `fixtures/api_payloads.py`
2. Export from `fixtures/__init__.py`
3. Use in tests and mock server

Example:

```python
from fixtures import task, TASKS

def test_my_feature():
    custom_task = task(99, "CUSTOM-1", "Custom task", "in_progress")
    assert custom_task["id"] == 99
```

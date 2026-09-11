"""Shared fixtures for integration tests.

Integration tests in this directory require external services (docker-compose
stack with proxy + bot containers). They are excluded from default pytest
collection via --ignore in pyproject.toml addopts.

Run explicitly:
    pytest tests/integration/ -v
    make test-integration
"""

from pathlib import Path

import pytest

_INTEGRATION_DIR = Path(__file__).resolve().parent


def pytest_collection_modifyitems(items):
    """Mark only tests under tests/integration/, not the rest of the session.

    pytest_collection_modifyitems is session-scoped: even when this hook lives
    in a subdirectory conftest, `items` is the full collected list.
    """
    for item in items:
        item_path = Path(str(item.path)).resolve()
        if _INTEGRATION_DIR in item_path.parents:
            item.add_marker(pytest.mark.integration)

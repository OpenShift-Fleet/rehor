"""Shared fixtures for integration tests.

Integration tests in this directory require external services (docker-compose
stack with proxy + bot containers). They are excluded from default pytest
collection via --ignore in pyproject.toml addopts.

Run explicitly:
    pytest tests/integration/ -v
    make test-integration
"""

import pytest


def pytest_collection_modifyitems(items):
    """Automatically mark all tests in this directory as integration."""
    for item in items:
        item.add_marker(pytest.mark.integration)

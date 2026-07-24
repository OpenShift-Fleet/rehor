"""Pytest configuration and shared test fixtures."""

import copy

import pytest


@pytest.fixture
def api_base_url():
    """Base URL for mock API server."""
    return "http://localhost:8080"


@pytest.fixture
def clean_tasks():
    """Reset TASKS to default state for each test."""
    from fixtures.api_payloads import TASKS

    original = copy.deepcopy(TASKS)

    yield TASKS

    TASKS.clear()
    TASKS.update(original)

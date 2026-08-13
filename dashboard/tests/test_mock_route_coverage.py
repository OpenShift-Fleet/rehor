"""Ensure mock API routes match shared/openapi.yaml."""

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MOCK_API_PATH = REPO_ROOT / "mock_api.py"
OPENAPI_PATH = REPO_ROOT / "shared" / "openapi.yaml"

METHOD_BODY_RE = re.compile(
    r"def (do_GET|do_POST|do_DELETE)\(self\):(.*?)(?=\n    def |\nif __name__)",
    re.DOTALL,
)
EXACT_PATH_RE = re.compile(r"path == \"([^\"]+)\"")
# Bot polling endpoints — not needed by the dashboard dev mock.
OPENAPI_SKIP_GET_PATHS = {
    "/health",
    "/api/instances/{instance_id}",
    "/api/instances/{instance_id}/wake",
}


def _extract_method_bodies() -> dict[str, str]:
    source = MOCK_API_PATH.read_text()
    return dict(METHOD_BODY_RE.findall(source))


def _extract_mock_routes() -> set[tuple[str, str]]:
    bodies = _extract_method_bodies()
    routes: set[tuple[str, str]] = set()

    for path in EXACT_PATH_RE.findall(bodies.get("do_GET", "")):
        routes.add((path, "GET"))

    get_body = bodies.get("do_GET", "")
    if 'path.startswith("/api/memories/")' in get_body:
        routes.add(("/api/memories/{id}", "GET"))
    if 'path.startswith("/api/cycle-runs/")' in get_body and "/transcript" in get_body:
        routes.add(("/api/cycle-runs/{id}/transcript", "GET"))

    for path in EXACT_PATH_RE.findall(bodies.get("do_POST", "")):
        routes.add((path, "POST"))

    post_body = bodies.get("do_POST", "")
    if 'parts[3] == "pause"' in post_body:
        routes.add(("/api/tasks/{key}/pause", "POST"))
    if 'parts[3] == "unpause"' in post_body:
        routes.add(("/api/tasks/{key}/unpause", "POST"))
    if 'parts[3] == "unarchive"' in post_body:
        routes.add(("/api/tasks/{key}/unarchive", "POST"))
    if 'parts[3] == "wake"' in post_body:
        routes.add(("/api/instances/{instance_id}/wake", "POST"))

    delete_body = bodies.get("do_DELETE", "")
    if 'parts[1] == "tasks"' in delete_body:
        routes.add(("/api/tasks/{key}", "DELETE"))
    if 'parts[1] == "memories"' in delete_body:
        routes.add(("/api/memories/{id}", "DELETE"))

    return routes


def _extract_openapi_routes() -> set[tuple[str, str]]:
    spec = yaml.safe_load(OPENAPI_PATH.read_text())
    routes: set[tuple[str, str]] = set()
    for path, path_item in spec["paths"].items():
        for method, _operation in path_item.items():
            if method in ("get", "post", "delete", "patch", "put"):
                routes.add((path, method.upper()))
    return routes


def _extract_openapi_get_routes() -> set[tuple[str, str]]:
    return {
        (path, method)
        for path, method in _extract_openapi_routes()
        if method == "GET" and path not in OPENAPI_SKIP_GET_PATHS
    }


MOCK_ROUTES = _extract_mock_routes()
OPENAPI_ROUTES = _extract_openapi_routes()
OPENAPI_GET_ROUTES = _extract_openapi_get_routes()


@pytest.mark.parametrize(
    ("path", "method"),
    sorted(MOCK_ROUTES),
    ids=[f"{method} {path}" for path, method in sorted(MOCK_ROUTES)],
)
def test_every_mock_route_has_openapi_entry(path, method):
    assert (path, method) in OPENAPI_ROUTES


@pytest.mark.parametrize(
    ("path", "method"),
    sorted(OPENAPI_GET_ROUTES),
    ids=[f"{method} {path}" for path, method in sorted(OPENAPI_GET_ROUTES)],
)
def test_every_openapi_get_route_has_mock(path, method):
    assert (path, method) in MOCK_ROUTES

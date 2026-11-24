"""Ensure registered API routes match shared/openapi.yaml."""

import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVER_PATH = REPO_ROOT / "memory-server" / "bot_memory_server" / "server.py"
OPENAPI_PATH = REPO_ROOT / "shared" / "openapi.yaml"

CUSTOM_ROUTE_RE = re.compile(r"mcp\.custom_route\(\"([^\"]+)\",\s*methods=\[([^\]]+)\]\)")
METHOD_RE = re.compile(r"\"([A-Z]+)\"")
PATH_PARAM_RE = re.compile(r"\{(\w+):path\}")


def _normalize_path(path: str) -> str:
    return PATH_PARAM_RE.sub(r"{\1}", path)


def _is_static_route(path: str) -> bool:
    return path == "/" or path.startswith("/static/") or path.startswith("/assets/")


def _extract_server_routes() -> set[tuple[str, str]]:
    source = SERVER_PATH.read_text()
    routes: set[tuple[str, str]] = set()
    for path, methods_blob in CUSTOM_ROUTE_RE.findall(source):
        if _is_static_route(path):
            continue
        normalized = _normalize_path(path)
        for method in METHOD_RE.findall(methods_blob):
            routes.add((normalized, method))
    return routes


def _extract_openapi_routes(skip_health: bool = False) -> set[tuple[str, str]]:
    spec = yaml.safe_load(OPENAPI_PATH.read_text())
    routes: set[tuple[str, str]] = set()
    for path, path_item in spec["paths"].items():
        if skip_health and path == "/health":
            continue
        for method, _operation in path_item.items():
            if method in ("get", "post", "delete", "patch", "put"):
                routes.add((path, method.upper()))
    return routes


SERVER_ROUTES = _extract_server_routes()
OPENAPI_ROUTES = _extract_openapi_routes()
OPENAPI_ROUTES_NO_HEALTH = _extract_openapi_routes(skip_health=True)


@pytest.mark.parametrize(
    ("path", "method"),
    sorted(SERVER_ROUTES),
    ids=[f"{method} {path}" for path, method in sorted(SERVER_ROUTES)],
)
def test_every_registered_route_has_openapi_entry(path, method):
    assert (path, method) in OPENAPI_ROUTES


@pytest.mark.parametrize(
    ("path", "method"),
    sorted(OPENAPI_ROUTES_NO_HEALTH),
    ids=[f"{method} {path}" for path, method in sorted(OPENAPI_ROUTES_NO_HEALTH)],
)
def test_every_openapi_path_has_registered_route(path, method):
    assert (path, method) in SERVER_ROUTES

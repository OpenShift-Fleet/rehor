"""Exercise the development mock using the same public search request shape."""

import importlib.util
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest


@pytest.fixture(scope="module")
def mock_search():
    path = Path(__file__).resolve().parents[2] / "mock_api.py"
    spec = importlib.util.spec_from_file_location("global_search_mock_api", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    server = ThreadingHTTPServer(("127.0.0.1", 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False) as client:
            yield client
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_mock_task_list_search_filters_before_count_and_page_and_intersects_status(mock_search):
    matches = mock_search.get("/api/tasks", params={"q": " AWAITING-REVIEW "}).json()
    assert matches["total"] == 2
    second = mock_search.get("/api/tasks", params={"q": "awaiting-review", "limit": 1, "offset": 1}).json()
    assert second["total"] == 2 and len(second["items"]) == 1
    assert second["items"][0]["id"] == matches["items"][1]["id"]
    for task in matches["items"]:
        filtered = mock_search.get("/api/tasks", params={"q": "awaiting-review", "status": task["status"]}).json()
        assert all(item["status"] == task["status"] for item in filtered["items"])
        assert any(item["id"] == task["id"] for item in filtered["items"])
    bots = mock_search.get("/api/tasks", params={"q": "DEV-BOT"}).json()
    assert bots["total"] > 0
    assert all(task["instance_id"] == "dev-bot" for task in bots["items"])
    assert mock_search.get("/api/tasks", params={"q": "%_"}).json()["total"] == 0


@pytest.mark.parametrize(
    "params",
    [
        {"q": ""},
        {"q": "r"},
        {"q": "r" * 201},
        {"q": "aa\x00b"},
        {"q": "review", "limit": "bad"},
        {"q": "review", "offset": -1},
        {"q": "review", "status": "invalid"},
    ],
)
def test_mock_task_list_search_rejects_invalid_query_pagination_and_status(mock_search, params):
    assert mock_search.get("/api/tasks", params=params).status_code == 400


def test_mock_cycle_navigation_filters_and_group_envelope(mock_search):
    exact = mock_search.get("/api/cycle-runs", params={"run_id": 1, "task_id": 1, "limit": 1}).json()
    assert exact["total"] == 1
    assert [run["id"] for run in exact["items"]] == [1]
    assert mock_search.get("/api/cycle-runs", params={"run_id": 1, "instance_id": "not-a-bot"}).json()["items"] == []
    assert [
        run["id"]
        for run in mock_search.get("/api/cycle-runs", params={"task_id": "none", "external_key": ""}).json()["items"]
    ] == [4]
    for invalid in ("0", "-1", "invalid"):
        assert mock_search.get("/api/cycle-runs", params={"run_id": invalid}).status_code == 400
    groups = mock_search.get("/api/cycle-runs/by-task").json()
    assert isinstance(groups["items"], list)
    assert groups["total"] == len(groups["items"])
    assert mock_search.get("/api/cycle-runs/by-task", params={"instance_id": "not-a-bot"}).json() == {
        "items": [],
        "total": 0,
    }

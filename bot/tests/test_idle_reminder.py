"""Tests for bot/idle_reminder.py.

State is now stored in bot_instances via the memory server API, not on disk.
Memory-server /api/tasks returns {"items": [...], "total": N, ...}.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from bot.idle_reminder import (
    _format_task_line,
    fetch_idle_state,
    fetch_open_tasks,
    on_preflight_skip,
    on_preflight_start,
    send_reminder,
    should_send_reminder,
    update_idle_state,
)

_SAMPLE_TASK = {
    "jira_key": "PROJ-42",
    "title": "Fix auth bug",
    "status": "pr_open",
    "artifacts": [{"type": "pull_request", "url": "https://github.com/org/repo/pull/99"}],
}

_NOW = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
_48H_AGO = _NOW - timedelta(hours=48)
_47H_AGO = _NOW - timedelta(hours=47)


# --- fetch_idle_state ---


def test_fetch_idle_state_success():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "idle_consecutive_cycles": 7,
        "last_idle_reminder_sent_at": "2024-05-30T12:00:00+00:00",
    }
    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp):
        cycles, last_sent = fetch_idle_state("bot-1", "http://mem:8080/api")
    assert cycles == 7
    assert last_sent is not None
    assert last_sent.tzinfo is not None


def test_fetch_idle_state_not_found_returns_zeros():
    mock_resp = MagicMock()
    mock_resp.status_code = 404
    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp):
        result = fetch_idle_state("bot-1", "http://mem:8080/api")
    assert result == (0, None)


def test_fetch_idle_state_network_error_returns_none():
    with patch("bot.idle_reminder.httpx.get", side_effect=Exception("timeout")):
        assert fetch_idle_state("bot-1", "http://mem:8080/api") is None


def test_fetch_idle_state_no_reminder_timestamp():
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"idle_consecutive_cycles": 3, "last_idle_reminder_sent_at": None}
    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp):
        cycles, last_sent = fetch_idle_state("bot-1", "http://mem:8080/api")
    assert cycles == 3
    assert last_sent is None


# --- update_idle_state ---


def test_update_idle_state_calls_patch():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    with patch("bot.idle_reminder.httpx.patch", return_value=mock_resp) as mock_patch:
        update_idle_state("bot-1", 5, _NOW, "http://mem:8080/api")
    mock_patch.assert_called_once()
    call_kwargs = mock_patch.call_args
    assert "bot-1" in call_kwargs.args[0]
    payload = call_kwargs.kwargs["json"]
    assert payload["idle_consecutive_cycles"] == 5
    assert "last_idle_reminder_sent_at" in payload


def test_update_idle_state_no_timestamp_omits_field():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    with patch("bot.idle_reminder.httpx.patch", return_value=mock_resp) as mock_patch:
        update_idle_state("bot-1", 0, None, "http://mem:8080/api")
    payload = mock_patch.call_args.kwargs["json"]
    assert "last_idle_reminder_sent_at" not in payload


def test_update_idle_state_network_error_does_not_raise():
    with patch("bot.idle_reminder.httpx.patch", side_effect=Exception("timeout")):
        update_idle_state("bot-1", 5, None, "http://mem:8080/api")  # must not raise


# --- should_send_reminder ---


def test_disabled_when_limit_zero():
    assert not should_send_reminder(100, None, limit=0, cooldown_seconds=3600)


def test_disabled_when_limit_negative():
    assert not should_send_reminder(100, None, limit=-1, cooldown_seconds=3600)


def test_below_threshold():
    assert not should_send_reminder(9, None, limit=10, cooldown_seconds=3600)


def test_at_threshold_first_time():
    assert should_send_reminder(10, None, limit=10, cooldown_seconds=172800)


def test_within_cooldown():
    assert not should_send_reminder(15, _47H_AGO, limit=10, cooldown_seconds=172800, now=_NOW)


def test_cooldown_expired():
    assert should_send_reminder(15, _48H_AGO, limit=10, cooldown_seconds=172800, now=_NOW)


def test_cooldown_exact_boundary():
    exactly_48h_ago = _NOW - timedelta(hours=48)
    assert should_send_reminder(15, exactly_48h_ago, limit=10, cooldown_seconds=172800, now=_NOW)


# --- _format_task_line ---


def test_format_task_with_all_fields():
    line = _format_task_line(_SAMPLE_TASK)
    assert "*Fix auth bug*" in line
    assert "(PROJ-42)" in line
    assert "https://github.com/org/repo/pull/99" in line


def test_format_task_uses_title_from_api():
    line = _format_task_line({"title": "From API", "jira_key": "X-1", "artifacts": []})
    assert "*From API*" in line


def test_format_task_merge_request_artifact():
    task = {
        "title": "GitLab MR",
        "jira_key": "G-1",
        "artifacts": [{"type": "merge_request", "url": "https://gitlab.com/o/r/-/merge_requests/3"}],
    }
    line = _format_task_line(task)
    assert "https://gitlab.com/o/r/-/merge_requests/3" in line


def test_format_task_no_pr():
    task = {"title": "Work in progress", "jira_key": "PROJ-1", "artifacts": []}
    line = _format_task_line(task)
    assert "*Work in progress*" in line
    assert "(PROJ-1)" in line
    assert "http" not in line


def test_format_task_minimal():
    line = _format_task_line({})
    assert "Untitled" in line


# --- MEMORY_API_BASE ---


def test_memory_api_base_from_env(monkeypatch):
    import importlib

    import bot.constants as constants_mod

    monkeypatch.setenv("MEMORY_API_URL", "http://memory:9090/api")
    importlib.reload(constants_mod)
    assert constants_mod.MEMORY_API_BASE == "http://memory:9090/api"
    monkeypatch.delenv("MEMORY_API_URL")
    importlib.reload(constants_mod)


def test_memory_api_base_default(monkeypatch):
    import importlib

    import bot.constants as constants_mod

    monkeypatch.delenv("MEMORY_API_URL", raising=False)
    importlib.reload(constants_mod)
    assert constants_mod.MEMORY_API_BASE == "http://localhost:8080/api"
    importlib.reload(constants_mod)


# --- fetch_open_tasks ---


def test_fetch_open_tasks_uses_items_key():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"items": [_SAMPLE_TASK], "total": 1, "limit": 20, "offset": 0}

    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp) as mock_get:
        result = fetch_open_tasks("http://localhost:8080/api")

    mock_get.assert_called_once_with(
        "http://localhost:8080/api/tasks",
        params={"status": "pr_open"},
        timeout=5.0,
    )
    assert result == [_SAMPLE_TASK]


def test_fetch_open_tasks_empty_items():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"items": [], "total": 0, "limit": 20, "offset": 0}

    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp):
        result = fetch_open_tasks("http://localhost:8080/api")

    assert result == []


def test_fetch_open_tasks_passes_instance_id():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"items": [], "total": 0}

    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp) as mock_get:
        fetch_open_tasks("http://localhost:8080/api", instance_id="bot-alpha")

    assert mock_get.call_args.kwargs["params"] == {"status": "pr_open", "instance_id": "bot-alpha"}


def test_fetch_open_tasks_omits_instance_id_when_unset():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"items": [], "total": 0}

    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp) as mock_get:
        fetch_open_tasks("http://localhost:8080/api", instance_id=None)

    assert mock_get.call_args.kwargs["params"] == {"status": "pr_open"}


def test_fetch_open_tasks_network_error():
    with patch("bot.idle_reminder.httpx.get", side_effect=Exception("connection refused")):
        result = fetch_open_tasks("http://localhost:8080/api")
    assert result == []


def test_fetch_open_tasks_non_dict_json_returns_empty():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = [{"unexpected": "list"}]

    with patch("bot.idle_reminder.httpx.get", return_value=mock_resp):
        result = fetch_open_tasks("http://localhost:8080/api")

    assert result == []


# --- send_reminder ---


def test_send_reminder_no_webhook(caplog):
    with patch.dict("os.environ", {}, clear=True):
        result = send_reminder(10, instance_id="test")
    assert "SLACK_WEBHOOK_URL not set" in caplog.text
    assert result is None


def test_send_reminder_success():
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=[]) as mock_fetch,
        patch("bot.idle_reminder.httpx.post", return_value=mock_resp) as mock_post,
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(10, instance_id="bot-1")

    mock_fetch.assert_called_once_with(None, instance_id="bot-1")
    mock_post.assert_called_once()
    payload = mock_post.call_args.kwargs["json"]
    assert "10 cycles" in payload["text"]
    assert "bot-1" in payload["text"]
    assert result is not None
    assert result.tzinfo is not None


def test_send_reminder_webhook_failure_returns_none():
    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=[]),
        patch("bot.idle_reminder.httpx.post", side_effect=Exception("network error")),
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(10)

    assert result is None


def test_send_reminder_with_tasks():
    tasks = [{"title": "Fix thing", "jira_key": "P-5", "artifacts": []}]
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=tasks),
        patch("bot.idle_reminder.httpx.post", return_value=mock_resp) as mock_post,
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(12, instance_id="bot-2")

    payload = mock_post.call_args.kwargs["json"]
    assert "Fix thing" in payload["text"]
    assert "P-5" in payload["text"]
    assert result is not None


# --- on_preflight_skip / on_preflight_start ---


def test_on_preflight_skip_increments_and_persists():
    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=(4, None)) as mock_fetch,
        patch("bot.idle_reminder.update_idle_state") as mock_update,
    ):
        on_preflight_skip("bot-1", idle_cycle_limit=0)

    mock_fetch.assert_called_once_with("bot-1", None)
    mock_update.assert_called_once_with("bot-1", 5, None, None)


def test_on_preflight_skip_sends_reminder_at_threshold():
    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=(9, None)),
        patch("bot.idle_reminder.send_reminder", return_value=_NOW) as mock_send,
        patch("bot.idle_reminder.update_idle_state") as mock_update,
    ):
        on_preflight_skip("bot-x", idle_cycle_limit=10, cooldown_seconds=172800)

    mock_send.assert_called_once_with(10, instance_id="bot-x", memory_api_base=None)
    mock_update.assert_called_once_with("bot-x", 10, _NOW, None)


def test_on_preflight_skip_respects_disabled_limit():
    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=(100, None)),
        patch("bot.idle_reminder.send_reminder") as mock_send,
        patch("bot.idle_reminder.update_idle_state"),
    ):
        on_preflight_skip("bot-1", idle_cycle_limit=0)
    mock_send.assert_not_called()


def test_on_preflight_skip_respects_cooldown():
    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=(12, _47H_AGO)),
        patch("bot.idle_reminder.send_reminder") as mock_send,
        patch("bot.idle_reminder.update_idle_state"),
    ):
        on_preflight_skip("bot-1", idle_cycle_limit=10, cooldown_seconds=172800, _now=_NOW)
    mock_send.assert_not_called()


def test_on_preflight_skip_noop_when_no_instance_id():
    with (
        patch("bot.idle_reminder.fetch_idle_state") as mock_fetch,
        patch("bot.idle_reminder.update_idle_state") as mock_update,
    ):
        on_preflight_skip("", idle_cycle_limit=10)
    mock_fetch.assert_not_called()
    mock_update.assert_not_called()


def test_on_preflight_skip_skips_when_fetch_fails():
    with (
        patch("bot.idle_reminder.fetch_idle_state", return_value=None),
        patch("bot.idle_reminder.send_reminder") as mock_send,
        patch("bot.idle_reminder.update_idle_state") as mock_update,
    ):
        on_preflight_skip("bot-1", idle_cycle_limit=10)
    mock_send.assert_not_called()
    mock_update.assert_not_called()


def test_on_preflight_start_resets_state():
    with patch("bot.idle_reminder.update_idle_state") as mock_update:
        on_preflight_start("bot-1")
    mock_update.assert_called_once_with("bot-1", 0, None, None)


def test_on_preflight_start_noop_when_no_instance_id():
    with patch("bot.idle_reminder.update_idle_state") as mock_update:
        on_preflight_start("")
    mock_update.assert_not_called()

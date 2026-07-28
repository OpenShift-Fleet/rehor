"""Tests for bot/idle_reminder.py.

Memory-server /api/tasks returns {"items": [...], "total": N, ...} — same shape
used by preflight (presets/shared/preflight/common.py). Tests must use that
contract, not a fictional {"tasks": ...} payload.
"""

from unittest.mock import MagicMock, patch

from bot.idle_reminder import (
    IdleState,
    _format_task_line,
    _get_memory_api_base,
    fetch_open_tasks,
    increment,
    load_state,
    on_preflight_skip,
    on_preflight_start,
    reset,
    save_state,
    send_reminder,
    should_send_reminder,
)

# Realistic memory-server task row (see api._task)
_SAMPLE_TASK = {
    "jira_key": "PROJ-42",
    "title": "Fix auth bug",
    "status": "pr_open",
    "artifacts": [{"type": "pull_request", "url": "https://github.com/org/repo/pull/99"}],
}


# --- load_state / save_state ---


def test_load_state_missing_file(tmp_path):
    state = load_state(tmp_path)
    assert state.consecutive_cycles == 0
    assert state.last_reminder_sent_at_cycle == 0


def test_save_and_load_roundtrip(tmp_path):
    state = IdleState(consecutive_cycles=7, last_reminder_sent_at_cycle=5)
    save_state(state, tmp_path)
    loaded = load_state(tmp_path)
    assert loaded.consecutive_cycles == 7
    assert loaded.last_reminder_sent_at_cycle == 5


def test_load_state_corrupt_file(tmp_path):
    f = tmp_path / "idle-state.json"
    f.write_text("not json")
    state = load_state(tmp_path)
    assert state.consecutive_cycles == 0


# --- increment / reset ---


def test_increment():
    s = IdleState(consecutive_cycles=3, last_reminder_sent_at_cycle=2)
    s2 = increment(s)
    assert s2.consecutive_cycles == 4
    assert s2.last_reminder_sent_at_cycle == 2
    assert s.consecutive_cycles == 3  # original unchanged


def test_increment_from_zero():
    s = increment(IdleState())
    assert s.consecutive_cycles == 1


def test_reset():
    s = IdleState(consecutive_cycles=15, last_reminder_sent_at_cycle=10)
    s2 = reset(s)
    assert s2.consecutive_cycles == 0
    assert s2.last_reminder_sent_at_cycle == 0
    assert s.consecutive_cycles == 15  # original unchanged


# --- should_send_reminder ---


def test_disabled_when_limit_zero():
    s = IdleState(consecutive_cycles=100)
    assert not should_send_reminder(s, limit=0, cooldown_cycles=5)


def test_disabled_when_limit_negative():
    s = IdleState(consecutive_cycles=100)
    assert not should_send_reminder(s, limit=-1, cooldown_cycles=5)


def test_below_threshold():
    s = IdleState(consecutive_cycles=9)
    assert not should_send_reminder(s, limit=10, cooldown_cycles=5)


def test_at_threshold_first_time():
    s = IdleState(consecutive_cycles=10, last_reminder_sent_at_cycle=0)
    assert should_send_reminder(s, limit=10, cooldown_cycles=5)


def test_within_cooldown():
    s = IdleState(consecutive_cycles=12, last_reminder_sent_at_cycle=10)
    # 12 - 10 = 2, cooldown = 5 → should NOT send
    assert not should_send_reminder(s, limit=10, cooldown_cycles=5)


def test_cooldown_expired():
    s = IdleState(consecutive_cycles=15, last_reminder_sent_at_cycle=10)
    # 15 - 10 = 5 >= 5 → should send
    assert should_send_reminder(s, limit=10, cooldown_cycles=5)


def test_cooldown_one_past_expiry():
    s = IdleState(consecutive_cycles=16, last_reminder_sent_at_cycle=10)
    assert should_send_reminder(s, limit=10, cooldown_cycles=5)


def test_exact_threshold_with_prior_reminder_in_cooldown():
    s = IdleState(consecutive_cycles=10, last_reminder_sent_at_cycle=8)
    # 10 - 8 = 2 < 5 → still in cooldown
    assert not should_send_reminder(s, limit=10, cooldown_cycles=5)


# --- _format_task_line ---


def test_format_task_with_all_fields():
    line = _format_task_line(_SAMPLE_TASK)
    assert "*Fix auth bug*" in line
    assert "(PROJ-42)" in line
    assert "https://github.com/org/repo/pull/99" in line


def test_format_task_uses_title_from_api():
    """Memory-server _task() exposes title, not name."""
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
    task = {}
    line = _format_task_line(task)
    assert "Untitled" in line


# --- _get_memory_api_base ---


def test_get_memory_api_base_from_costs_url():
    with patch.dict("os.environ", {"COSTS_API_URL": "http://memory:8080/api/costs"}, clear=True):
        assert _get_memory_api_base() == "http://memory:8080/api"


def test_get_memory_api_base_default():
    with patch.dict("os.environ", {}, clear=True):
        assert _get_memory_api_base() == "http://localhost:8080/api"


# --- fetch_open_tasks ---


def test_fetch_open_tasks_uses_items_key():
    """Regression: real api_tasks returns items, not tasks."""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {
        "items": [_SAMPLE_TASK],
        "total": 1,
        "limit": 20,
        "offset": 0,
    }

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

    mock_get.assert_called_once_with(
        "http://localhost:8080/api/tasks",
        params={"status": "pr_open", "instance_id": "bot-alpha"},
        timeout=5.0,
    )


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
    state = IdleState(consecutive_cycles=10)
    with patch.dict("os.environ", {}, clear=True):
        result = send_reminder(state, instance_id="test")
    assert "SLACK_WEBHOOK_URL not set" in caplog.text
    assert result.last_reminder_sent_at_cycle == 0  # unchanged


def test_send_reminder_success():
    state = IdleState(consecutive_cycles=10)
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=[]) as mock_fetch,
        patch("bot.idle_reminder.httpx.post", return_value=mock_resp) as mock_post,
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(state, instance_id="bot-1")

    mock_fetch.assert_called_once_with(None, instance_id="bot-1")
    mock_post.assert_called_once()
    payload = mock_post.call_args.kwargs["json"]
    assert "10 cycles" in payload["text"]
    assert "bot-1" in payload["text"]
    assert result.last_reminder_sent_at_cycle == 10
    assert state.last_reminder_sent_at_cycle == 0  # original unchanged


def test_send_reminder_with_real_api_items_payload():
    """End-to-end through httpx.get — must not crash on {"items": ...}."""
    state = IdleState(consecutive_cycles=12)
    get_resp = MagicMock()
    get_resp.raise_for_status = MagicMock()
    get_resp.json.return_value = {"items": [_SAMPLE_TASK], "total": 1}
    post_resp = MagicMock()
    post_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.httpx.get", return_value=get_resp),
        patch("bot.idle_reminder.httpx.post", return_value=post_resp) as mock_post,
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(
            state,
            instance_id="bot-2",
            memory_api_base="http://localhost:8080/api",
        )

    payload = mock_post.call_args.kwargs["json"]
    assert "Fix auth bug" in payload["text"]
    assert "PROJ-42" in payload["text"]
    assert "https://github.com/org/repo/pull/99" in payload["text"]
    assert "1 PR(s) awaiting review" in payload["text"]
    assert result.last_reminder_sent_at_cycle == 12


def test_send_reminder_with_tasks():
    state = IdleState(consecutive_cycles=12)
    tasks = [{"title": "Fix thing", "jira_key": "P-5", "artifacts": []}]
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=tasks),
        patch("bot.idle_reminder.httpx.post", return_value=mock_resp) as mock_post,
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(state, instance_id="bot-2")

    payload = mock_post.call_args.kwargs["json"]
    assert "Fix thing" in payload["text"]
    assert "P-5" in payload["text"]
    assert result.last_reminder_sent_at_cycle == 12


def test_send_reminder_webhook_failure_does_not_update_state():
    state = IdleState(consecutive_cycles=10)

    with (
        patch("bot.idle_reminder.fetch_open_tasks", return_value=[]),
        patch("bot.idle_reminder.httpx.post", side_effect=Exception("network error")),
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(state)

    assert result.last_reminder_sent_at_cycle == 0  # not updated on failure
    assert result is state  # same object returned


def test_send_reminder_malformed_items_does_not_crash_bot():
    """If parsing still goes wrong, reminder path must not raise into the main loop."""
    state = IdleState(consecutive_cycles=10)
    get_resp = MagicMock()
    get_resp.raise_for_status = MagicMock()
    # Old buggy fallback would return this whole dict and then AttributeError on .get
    get_resp.json.return_value = {"items": [_SAMPLE_TASK], "total": 1}
    post_resp = MagicMock()
    post_resp.raise_for_status = MagicMock()

    with (
        patch("bot.idle_reminder.httpx.get", return_value=get_resp),
        patch("bot.idle_reminder.httpx.post", return_value=post_resp),
        patch.dict("os.environ", {"SLACK_WEBHOOK_URL": "https://hooks.slack.com/test"}),
    ):
        result = send_reminder(state, memory_api_base="http://localhost:8080/api")

    assert result.last_reminder_sent_at_cycle == 10


# --- on_preflight_skip / on_preflight_start (run.py orchestration) ---


def test_on_preflight_skip_increments_and_persists(tmp_path):
    on_preflight_skip(tmp_path, idle_cycle_limit=0, cooldown_cycles=5)
    state = load_state(tmp_path)
    assert state.consecutive_cycles == 1


def test_on_preflight_skip_sends_reminder_at_threshold(tmp_path):
    save_state(IdleState(consecutive_cycles=9), tmp_path)
    with patch("bot.idle_reminder.send_reminder") as mock_send:
        mock_send.side_effect = lambda s, **kw: IdleState(
            consecutive_cycles=s.consecutive_cycles,
            last_reminder_sent_at_cycle=s.consecutive_cycles,
        )
        on_preflight_skip(
            tmp_path,
            idle_cycle_limit=10,
            cooldown_cycles=5,
            instance_id="bot-x",
        )

    mock_send.assert_called_once()
    assert mock_send.call_args.kwargs["instance_id"] == "bot-x"
    state = load_state(tmp_path)
    assert state.consecutive_cycles == 10
    assert state.last_reminder_sent_at_cycle == 10


def test_on_preflight_skip_respects_disabled_limit(tmp_path):
    save_state(IdleState(consecutive_cycles=100), tmp_path)
    with patch("bot.idle_reminder.send_reminder") as mock_send:
        on_preflight_skip(tmp_path, idle_cycle_limit=0, cooldown_cycles=5)
    mock_send.assert_not_called()


def test_on_preflight_skip_respects_cooldown(tmp_path):
    save_state(IdleState(consecutive_cycles=12, last_reminder_sent_at_cycle=10), tmp_path)
    with patch("bot.idle_reminder.send_reminder") as mock_send:
        on_preflight_skip(tmp_path, idle_cycle_limit=10, cooldown_cycles=5)
    mock_send.assert_not_called()
    assert load_state(tmp_path).consecutive_cycles == 13


def test_on_preflight_start_resets_state(tmp_path):
    save_state(IdleState(consecutive_cycles=15, last_reminder_sent_at_cycle=10), tmp_path)
    on_preflight_start(tmp_path)
    state = load_state(tmp_path)
    assert state.consecutive_cycles == 0
    assert state.last_reminder_sent_at_cycle == 0

"""Unit tests for Slack notification tools — digest mode, send_digest, and immediate mode.

Tests use mocked DB pool and httpx client, no PostgreSQL required.
The MCP tool functions are nested inside register_slack_tools(), so we
capture them by registering into a real FastMCP instance and pulling
them out of its internal registry.
"""

import os
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bot_memory_server.tools.slack import _format_digest, _format_pr_label, register_slack_tools

# ---------------------------------------------------------------------------
# Fixture: extract tool functions from FastMCP registration
# ---------------------------------------------------------------------------


@pytest.fixture
def slack_tools():
    """Register slack tools into a FastMCP mock and capture the decorated functions."""
    captured = {}

    class FakeMCP:
        def tool(self):
            def decorator(fn):
                captured[fn.__name__] = fn
                return fn

            return decorator

    register_slack_tools(FakeMCP())
    return captured


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_pool(fetchrow_return=None, fetch_return=None):
    pool = AsyncMock()
    pool.fetchrow.return_value = fetchrow_return
    pool.fetch.return_value = fetch_return or []
    pool.execute = AsyncMock()
    return pool


def _make_row(**kwargs):
    defaults = {
        "id": 1,
        "instance_id": "test-instance",
        "jira_key": "RHCLOUD-100",
        "event_type": "pr_created",
        "pr_url": "https://github.com/org/repo/pull/42",
        "pr_number": 42,
        "repo": "org/repo",
        "title": "Fix navigation dropdown",
        "message": "New PR created: #42",
        "queued_at": datetime.now(timezone.utc),
        "sent": False,
    }
    defaults.update(kwargs)
    return defaults


# ---------------------------------------------------------------------------
# slack_notify — immediate mode (default)
# ---------------------------------------------------------------------------


class TestSlackNotifyImmediate:
    @pytest.mark.asyncio
    async def test_immediate_sends_to_webhook(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return=None)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch.dict(os.environ, {"SLACK_NOTIFY_MODE": "immediate"}),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
            patch("bot_memory_server.tools.slack.bus", new_callable=AsyncMock),
        ):
            mock_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_client.post.return_value = mock_resp
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_notify(
                external_key="RHCLOUD-100",
                event_type="pr_created",
                message="New PR: #42",
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is True
        assert result["reason"] == "ok"
        mock_client.post.assert_called_once()
        assert pool.execute.call_count == 1  # INSERT into slack_notifications

    @pytest.mark.asyncio
    async def test_immediate_respects_cooldown(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        recent_row = {
            "id": 1,
            "event_type": "pr_created",
            "sent_at": datetime.now(timezone.utc) - timedelta(hours=1),
        }
        pool = _make_pool(fetchrow_return=recent_row)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch.dict(os.environ, {"SLACK_NOTIFY_MODE": "immediate"}),
        ):
            result = await slack_notify(
                external_key="RHCLOUD-100",
                event_type="pr_created",
                message="New PR: #42",
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is False
        assert "Cooldown active" in result["reason"]

    @pytest.mark.asyncio
    async def test_no_webhook_returns_not_configured(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool()

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_notify(
                external_key="RHCLOUD-100",
                event_type="pr_created",
                message="Test",
                webhook_url=None,
            )

        assert result["sent"] is False
        assert "not configured" in result["reason"]

    @pytest.mark.asyncio
    async def test_webhook_error_returns_failure(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return=None)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch.dict(os.environ, {"SLACK_NOTIFY_MODE": "immediate"}),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
        ):
            mock_client = AsyncMock()
            mock_client.post.side_effect = Exception("Connection refused")
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_notify(
                external_key="RHCLOUD-100",
                event_type="pr_created",
                message="Test",
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is False
        assert "Webhook error" in result["reason"]


# ---------------------------------------------------------------------------
# slack_notify — digest mode
# ---------------------------------------------------------------------------


class TestSlackNotifyDigest:
    @pytest.mark.asyncio
    async def test_digest_mode_queues_instead_of_sending(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool()

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch.dict(os.environ, {"SLACK_NOTIFY_MODE": "daily_digest"}),
        ):
            result = await slack_notify(
                external_key="RHCLOUD-200",
                event_type="pr_created",
                message="New PR: #99",
                webhook_url="https://hooks.slack.com/test",
                instance_id="framework-1",
                pr_url="https://github.com/org/repo/pull/99",
                pr_number=99,
                repo="org/repo",
                title="Fix bug",
            )

        assert result["sent"] is False
        assert result["queued"] is True
        assert "daily digest" in result["reason"]

        pool.execute.assert_called_once()
        call_args = pool.execute.call_args
        assert "slack_digest_queue" in call_args[0][0]
        assert call_args[0][1] == "framework-1"
        assert call_args[0][2] == "RHCLOUD-200"
        assert call_args[0][3] == "pr_created"

    @pytest.mark.asyncio
    async def test_digest_mode_skips_cooldown(self, slack_tools):
        """In digest mode, cooldown is not checked — every event is queued."""
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool()

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch.dict(os.environ, {"SLACK_NOTIFY_MODE": "daily_digest"}),
        ):
            r1 = await slack_notify(
                external_key="RHCLOUD-300",
                event_type="pr_created",
                message="First",
                webhook_url="https://hooks.slack.com/test",
            )
            r2 = await slack_notify(
                external_key="RHCLOUD-300",
                event_type="review_reminder",
                message="Second",
                webhook_url="https://hooks.slack.com/test",
            )

        assert r1["queued"] is True
        assert r2["queued"] is True
        assert pool.execute.call_count == 2


# ---------------------------------------------------------------------------
# slack_send_digest
# ---------------------------------------------------------------------------


class TestSlackSendDigest:
    @pytest.mark.asyncio
    async def test_send_digest_success(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [
            _make_row(id=1, jira_key="RHCLOUD-100", event_type="pr_created"),
            _make_row(
                id=2,
                jira_key="RHCLOUD-101",
                event_type="needs_help",
                pr_url=None,
                pr_number=None,
                repo=None,
                title=None,
                message="Blocked on missing API endpoint",
            ),
        ]
        pool = _make_pool(fetch_return=rows)

        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)  # Wednesday

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
            patch("bot_memory_server.tools.slack.bus", new_callable=AsyncMock),
        ):
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_client.post.return_value = mock_resp
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_send_digest(
                instance_id="framework-1",
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is True
        assert result["count"] == 2

        webhook_call = mock_client.post.call_args
        payload = webhook_call[1]["json"]
        assert "Daily Bot Digest" in payload["msg"]
        assert "RHCLOUD-100" in payload["msg"]
        assert "RHCLOUD-101" in payload["msg"]

        update_call = pool.execute.call_args
        assert "UPDATE" in update_call[0][0]
        assert update_call[0][1] == [1, 2]

    @pytest.mark.asyncio
    async def test_send_digest_empty_queue_skips(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])
        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = mock_now
            result = await slack_send_digest(webhook_url="https://hooks.slack.com/test")

        assert result["sent"] is False
        assert result["count"] == 0
        assert "No items" in result["reason"]

    @pytest.mark.asyncio
    async def test_send_digest_weekend_skips(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        mock_now = datetime(2026, 7, 18, 9, 0, tzinfo=timezone.utc)  # Saturday

        with patch("bot_memory_server.tools.slack.datetime") as mock_dt:
            mock_dt.now.return_value = mock_now
            result = await slack_send_digest(webhook_url="https://hooks.slack.com/test")

        assert result["sent"] is False
        assert "Weekend" in result["reason"]

    @pytest.mark.asyncio
    async def test_send_digest_no_webhook(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        result = await slack_send_digest(webhook_url=None)

        assert result["sent"] is False
        assert "not configured" in result["reason"]

    @pytest.mark.asyncio
    async def test_send_digest_filters_by_instance(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])
        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = mock_now
            await slack_send_digest(
                instance_id="framework-1",
                webhook_url="https://hooks.slack.com/test",
            )

        fetch_call = pool.fetch.call_args
        assert "instance_id = $1" in fetch_call[0][0]
        assert fetch_call[0][1] == "framework-1"

    @pytest.mark.asyncio
    async def test_send_digest_no_instance_fetches_all(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])
        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = mock_now
            await slack_send_digest(
                instance_id=None,
                webhook_url="https://hooks.slack.com/test",
            )

        fetch_call = pool.fetch.call_args
        assert "instance_id" not in fetch_call[0][0]

    @pytest.mark.asyncio
    async def test_send_digest_webhook_error_does_not_mark_sent(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [_make_row(id=1)]
        pool = _make_pool(fetch_return=rows)
        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
        ):
            mock_dt.now.return_value = mock_now
            mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)
            mock_client = AsyncMock()
            mock_client.post.side_effect = Exception("Connection refused")
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_send_digest(webhook_url="https://hooks.slack.com/test")

        assert result["sent"] is False
        assert "Webhook error" in result["reason"]
        for call in pool.execute.call_args_list:
            assert "UPDATE" not in call[0][0]

    @pytest.mark.asyncio
    async def test_send_digest_idempotent(self, slack_tools):
        """Second call after all items sent returns empty."""
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])
        mock_now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.datetime") as mock_dt,
        ):
            mock_dt.now.return_value = mock_now
            result = await slack_send_digest(webhook_url="https://hooks.slack.com/test")

        assert result["sent"] is False
        assert result["count"] == 0


# ---------------------------------------------------------------------------
# Digest formatting helpers
# ---------------------------------------------------------------------------


class TestFormatDigest:
    def test_format_digest_with_pr_and_other_events(self):
        rows = [
            _make_row(
                id=1,
                jira_key="RHCLOUD-100",
                event_type="pr_created",
                pr_url="https://github.com/org/repo/pull/42",
                pr_number=42,
                repo="org/repo",
                title="Fix nav dropdown",
            ),
            _make_row(
                id=2,
                jira_key="RHCLOUD-101",
                event_type="needs_help",
                pr_url=None,
                pr_number=None,
                repo=None,
                title=None,
                message="Blocked on missing API",
            ),
        ]
        now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        result = _format_digest("framework-1", rows, now)

        assert "*Daily Bot Digest*" in result
        assert "framework-1" in result
        assert "2026-07-15" in result
        assert "*PR events (1):*" in result
        assert "*Other events (1):*" in result
        assert "RHCLOUD-100" in result
        assert "RHCLOUD-101" in result
        assert "Blocked on missing API" in result

    def test_format_digest_only_pr_events(self):
        rows = [
            _make_row(id=1, event_type="pr_created"),
            _make_row(id=2, event_type="review_reminder", jira_key="RHCLOUD-101", title="Add tests"),
        ]
        now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        result = _format_digest(None, rows, now)

        assert "*PR events (2):*" in result
        assert "*Other events" not in result
        assert "All instances" in result

    def test_format_digest_only_other_events(self):
        rows = [
            _make_row(id=1, event_type="needs_help", message="Help needed"),
            _make_row(id=2, event_type="release_pending", jira_key="RHCLOUD-102", message="PR merged"),
        ]
        now = datetime(2026, 7, 15, 9, 0, tzinfo=timezone.utc)

        result = _format_digest("bot-1", rows, now)

        assert "*Other events (2):*" in result
        assert "*PR events" not in result

    def test_format_pr_label_full_info(self):
        row = _make_row(pr_url="https://github.com/org/repo/pull/42", pr_number=42, repo="org/repo")
        assert _format_pr_label(row) == "<https://github.com/org/repo/pull/42|org/repo#42>"

    def test_format_pr_label_no_repo(self):
        row = _make_row(pr_url="https://github.com/org/repo/pull/42", pr_number=42, repo=None)
        assert _format_pr_label(row) == "<https://github.com/org/repo/pull/42|#42>"

    def test_format_pr_label_only_url(self):
        row = _make_row(pr_url="https://github.com/org/repo/pull/42", pr_number=None, repo=None)
        assert _format_pr_label(row) == "<https://github.com/org/repo/pull/42|PR>"

    def test_format_pr_label_no_info(self):
        row = _make_row(pr_url=None, pr_number=None, repo=None)
        assert _format_pr_label(row) == "PR"

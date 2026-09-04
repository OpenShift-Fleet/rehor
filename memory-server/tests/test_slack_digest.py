"""Unit tests for Slack notification tools — digest mode, send_digest, and immediate mode.

Tests use mocked DB pool and httpx client, no PostgreSQL required.
The MCP tool functions are nested inside register_slack_tools(), so we
capture them by registering into a real FastMCP instance and pulling
them out of its internal registry.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from bot_memory_server.tools.slack import (
    _format_digest,
    _format_pr_label,
    register_slack_tools,
)

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


def _make_task_row(**kwargs):
    defaults = {
        "external_key": "RHCLOUD-100",
        "status": "pr_open",
        "title": "Fix navigation dropdown",
        "repo": "org/repo",
        "artifacts": [
            {
                "name": "PR #42",
                "url": "https://github.com/org/repo/pull/42",
                "type": "pull_request",
            }
        ],
        "metadata": {},
        "created_at": datetime.now(UTC) - timedelta(days=3),
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
            "sent_at": datetime.now(UTC) - timedelta(hours=1),
        }
        pool = _make_pool(fetchrow_return=recent_row)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
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
# slack_notify — digest mode (suppressed)
# ---------------------------------------------------------------------------


class TestSlackNotifyDigest:
    @pytest.mark.asyncio
    async def test_digest_mode_suppresses_notification(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool()

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_notify(
                external_key="RHCLOUD-200",
                event_type="pr_created",
                message="New PR: #99",
                webhook_url="https://hooks.slack.com/test",
                notify_mode="daily_digest",
            )

        assert result["sent"] is False
        assert result["suppressed"] is True
        pool.execute.assert_not_called()
        pool.fetchrow.assert_not_called()
        pool.fetch.assert_not_called()


# ---------------------------------------------------------------------------
# slack_send_digest — task-based
# ---------------------------------------------------------------------------


class TestSlackSendDigest:
    @pytest.mark.asyncio
    async def test_send_digest_with_open_prs(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [
            _make_task_row(
                external_key="RHCLOUD-100",
                status="pr_open",
                title="Fix navigation dropdown",
            ),
            _make_task_row(
                external_key="RHCLOUD-101",
                status="pr_changes",
                title="Add drag handle",
                artifacts=[
                    {
                        "name": "PR #15",
                        "url": "https://github.com/org/repo/pull/15",
                        "type": "pull_request",
                    }
                ],
                created_at=datetime.now(UTC) - timedelta(days=7),
            ),
        ]
        pool = _make_pool(fetch_return=rows)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
            patch("bot_memory_server.tools.slack.bus", new_callable=AsyncMock),
        ):
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
        assert "Open PRs (2)" in payload["msg"]

    @pytest.mark.asyncio
    async def test_send_digest_no_open_prs(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_send_digest(
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is False
        assert result["count"] == 0
        assert "No open PRs" in result["reason"]

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

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            await slack_send_digest(
                instance_id="framework-1",
                webhook_url="https://hooks.slack.com/test",
            )

        fetch_call = pool.fetch.call_args
        assert "instance_id = $2" in fetch_call[0][0]
        assert fetch_call[0][2] == "framework-1"

    @pytest.mark.asyncio
    async def test_send_digest_no_instance_fetches_all(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            await slack_send_digest(
                instance_id=None,
                webhook_url="https://hooks.slack.com/test",
            )

        fetch_call = pool.fetch.call_args
        assert "instance_id" not in fetch_call[0][0]

    @pytest.mark.asyncio
    async def test_send_digest_already_sent_today(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetchrow_return={"id": 1})

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_send_digest(
                webhook_url="https://hooks.slack.com/test",
                digest_key="digest-framework-1-2026-07-28",
            )

        assert result["sent"] is False
        assert "already sent" in result["reason"]

    @pytest.mark.asyncio
    async def test_send_digest_webhook_error(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [_make_task_row()]
        pool = _make_pool(fetch_return=rows)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
        ):
            mock_client = AsyncMock()
            mock_client.post.side_effect = Exception("Connection refused")
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_send_digest(
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is False
        assert "Webhook error" in result["reason"]
        pool.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_digest_records_digest_key(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [_make_task_row()]
        pool = _make_pool(fetchrow_return=None, fetch_return=rows)

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
            patch("bot_memory_server.tools.slack.bus", new_callable=AsyncMock),
        ):
            mock_client = AsyncMock()
            mock_resp = MagicMock()
            mock_resp.raise_for_status = MagicMock()
            mock_client.post.return_value = mock_resp
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_send_digest(
                webhook_url="https://hooks.slack.com/test",
                digest_key="digest-framework-1-2026-08-13",
            )

        assert result["sent"] is True
        pool.execute.assert_called_once()
        insert_call = pool.execute.call_args
        assert "slack_notifications" in insert_call[0][0]
        assert insert_call[0][1] == "digest-framework-1-2026-08-13"


# ---------------------------------------------------------------------------
# Digest formatting helpers
# ---------------------------------------------------------------------------


class TestFormatDigest:
    def test_format_with_artifacts(self):
        rows = [
            _make_task_row(
                external_key="RHCLOUD-100",
                status="pr_open",
                title="Fix nav dropdown",
                artifacts=[
                    {
                        "name": "PR #42",
                        "url": "https://github.com/org/repo/pull/42",
                        "type": "pull_request",
                    }
                ],
                created_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC),
            ),
        ]
        now = datetime(2026, 8, 13, 9, 0, tzinfo=UTC)

        result = _format_digest("framework-1", rows, now)

        assert "Daily Bot Digest" in result
        assert "framework-1" in result
        assert "2026-08-13" in result
        assert "Open PRs (1):" in result
        assert "PR #42 (https://github.com/org/repo/pull/42) — Fix nav dropdown - RHCLOUD-100 · open for 3d" in result

    def test_format_with_metadata_prs_fallback(self):
        rows = [
            _make_task_row(
                external_key="RHCLOUD-200",
                status="pr_changes",
                title="Add drag handle",
                repo="org/frontend",
                artifacts=[],
                metadata={"prs": [{"url": "https://github.com/org/frontend/pull/15", "number": 15}]},
                created_at=datetime(2026, 8, 6, 9, 0, tzinfo=UTC),
            ),
        ]
        now = datetime(2026, 8, 13, 9, 0, tzinfo=UTC)

        result = _format_digest("framework-1", rows, now)

        assert "org/frontend#15 (https://github.com/org/frontend/pull/15)" in result
        assert "7d" in result

    def test_format_no_pr_info(self):
        rows = [
            _make_task_row(
                external_key="RHCLOUD-300",
                status="pr_open",
                title="Something",
                artifacts=[],
                metadata={},
                created_at=datetime(2026, 8, 13, 9, 0, tzinfo=UTC),
            ),
        ]
        now = datetime(2026, 8, 13, 9, 0, tzinfo=UTC)

        result = _format_digest(None, rows, now)

        assert "PR (no link)" in result
        assert "All instances" in result

    def test_format_pr_age(self):
        rows = [
            _make_task_row(
                created_at=datetime(2026, 8, 3, 9, 0, tzinfo=UTC),
            ),
        ]
        now = datetime(2026, 8, 13, 9, 0, tzinfo=UTC)

        result = _format_digest("bot-1", rows, now)

        assert "10d" in result


# ---------------------------------------------------------------------------
# _format_pr_label
# ---------------------------------------------------------------------------


class TestFormatPrLabel:
    def test_from_artifacts(self):
        row = _make_task_row(
            artifacts=[
                {
                    "name": "PR #42",
                    "url": "https://github.com/org/repo/pull/42",
                    "type": "pull_request",
                }
            ],
        )
        assert _format_pr_label(row) == "PR #42 (https://github.com/org/repo/pull/42)"

    def test_from_artifacts_merge_request(self):
        row = _make_task_row(
            artifacts=[
                {
                    "name": "MR #10",
                    "url": "https://gitlab.com/org/repo/-/merge_requests/10",
                    "type": "merge_request",
                }
            ],
        )
        assert _format_pr_label(row) == "MR #10 (https://gitlab.com/org/repo/-/merge_requests/10)"

    def test_from_metadata_prs(self):
        row = _make_task_row(
            artifacts=[],
            repo="org/repo",
            metadata={"prs": [{"url": "https://github.com/org/repo/pull/42", "number": 42}]},
        )
        assert _format_pr_label(row) == "org/repo#42 (https://github.com/org/repo/pull/42)"

    def test_no_info(self):
        row = _make_task_row(artifacts=[], metadata={})
        assert _format_pr_label(row) == "PR (no link)"

    def test_artifacts_as_json_string(self):
        import json

        row = _make_task_row(
            artifacts=json.dumps(
                [
                    {
                        "name": "PR #42",
                        "url": "https://github.com/org/repo/pull/42",
                        "type": "pull_request",
                    }
                ]
            ),
        )
        assert _format_pr_label(row) == "PR #42 (https://github.com/org/repo/pull/42)"

"""Unit tests for Slack notification tools — digest mode, send_digest, and immediate mode.

Tests use mocked DB pool and httpx client, no PostgreSQL required.
The MCP tool functions are nested inside register_slack_tools(), so we
capture them by registering into a real FastMCP instance and pulling
them out of its internal registry.
"""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from bot_memory_server.tools.slack import (
    _format_digest,
    _format_pr_label,
    _sanitize_webhook_error,
    register_slack_tools,
)
from fastmcp import FastMCP

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
        "queued_at": datetime.now(UTC),
        "sent": False,
    }
    defaults.update(kwargs)
    return defaults


# ---------------------------------------------------------------------------
# _sanitize_webhook_error — never leak the webhook URL (REHOR-123)
# ---------------------------------------------------------------------------


class TestSanitizeWebhookError:
    def test_http_status_error_reports_status_code_only(self):
        request = httpx.Request("POST", "https://hooks.slack.com/test/secret-path")
        response = httpx.Response(404, request=request)
        err = httpx.HTTPStatusError("boom", request=request, response=response)

        result = _sanitize_webhook_error(err)

        assert result == "HTTP 404"
        assert "hooks.slack.com" not in result
        assert "secret-path" not in result

    def test_timeout_reports_generic_label(self):
        request = httpx.Request("POST", "https://hooks.slack.com/test/secret-path")
        err = httpx.ConnectTimeout("timed out", request=request)

        result = _sanitize_webhook_error(err)

        assert result == "timeout"
        assert "hooks.slack.com" not in result

    def test_generic_exception_reports_type_name_only(self):
        err = ValueError("https://hooks.slack.com/test/secret-path is invalid")

        result = _sanitize_webhook_error(err)

        assert result == "ValueError"
        assert "hooks.slack.com" not in result
        assert "secret-path" not in result


# ---------------------------------------------------------------------------
# MCP tool schema must never expose the webhook secret (REHOR-123)
#
# FastMCP builds each tool's JSON schema (sent to every MCP client, including
# the agent, via tools/list) from the function signature — parameter defaults
# are serialized into it. A `webhook_url: str | None = os.environ.get(...)`
# default is evaluated once at module-import time and gets baked into that
# schema as a literal value, regardless of who calls the tool. This uses a
# real FastMCP instance (not the FakeMCP capture fixture) to verify the actual
# generated schema, not just the function's runtime behavior.
# ---------------------------------------------------------------------------


class TestMcpSchemaNeverLeaksWebhook:
    SECRET = "https://hooks.slack.com/test/should-never-appear-in-schema"

    @pytest.mark.asyncio
    async def test_slack_notify_schema_has_no_secret_default(self, monkeypatch):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", self.SECRET)
        mcp = FastMCP("test")
        register_slack_tools(mcp)

        tool = await mcp.get_tool("slack_notify")
        schema = tool.parameters

        assert self.SECRET not in json.dumps(schema)
        assert schema["properties"]["webhook_url"].get("default") is None

    @pytest.mark.asyncio
    async def test_slack_send_digest_schema_has_no_secret_default(self, monkeypatch):
        monkeypatch.setenv("SLACK_WEBHOOK_URL", self.SECRET)
        mcp = FastMCP("test")
        register_slack_tools(mcp)

        tool = await mcp.get_tool("slack_send_digest")
        schema = tool.parameters

        assert self.SECRET not in json.dumps(schema)
        assert schema["properties"]["webhook_url"].get("default") is None

    @pytest.mark.asyncio
    async def test_env_fallback_still_resolves_at_runtime_when_omitted(self, monkeypatch):
        """The env fallback moved from the signature into the function body
        (so it's absent from the schema) — confirm it still works at call
        time when the caller omits webhook_url."""
        monkeypatch.setenv("SLACK_WEBHOOK_URL", "https://hooks.slack.com/test")
        mcp = FastMCP("test")
        register_slack_tools(mcp)
        tool = await mcp.get_tool("slack_notify")

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

            result = await tool.run({"external_key": "RHCLOUD-999"})

        assert result.structured_content["sent"] is True


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

    @pytest.mark.asyncio
    async def test_webhook_error_does_not_leak_url(self, slack_tools):
        """Even if the underlying exception's str() embeds the webhook URL
        (e.g. httpx.HTTPStatusError), the returned reason must not (REHOR-123)."""
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return=None)
        secret_webhook = "https://hooks.slack.com/test/secret-path-should-not-leak"

        with (
            patch("bot_memory_server.tools.slack.get_pool", return_value=pool),
            patch("bot_memory_server.tools.slack.httpx.AsyncClient") as mock_client_class,
        ):
            request = httpx.Request("POST", secret_webhook)
            response = httpx.Response(403, request=request)
            mock_client = AsyncMock()
            mock_client.post.side_effect = httpx.HTTPStatusError("forbidden", request=request, response=response)
            mock_client_class.return_value.__aenter__.return_value = mock_client

            result = await slack_notify(
                external_key="RHCLOUD-100",
                event_type="pr_created",
                message="Test",
                webhook_url=secret_webhook,
            )

        assert result["sent"] is False
        assert "secret-path-should-not-leak" not in result["reason"]
        assert result["reason"] == "Webhook error: HTTP 403"


# ---------------------------------------------------------------------------
# slack_notify — digest mode
# ---------------------------------------------------------------------------


class TestSlackNotifyDigest:
    @pytest.mark.asyncio
    async def test_digest_mode_queues_instead_of_sending(self, slack_tools):
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return=None)

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_notify(
                external_key="RHCLOUD-200",
                event_type="pr_created",
                message="New PR: #99",
                webhook_url="https://hooks.slack.com/test",
                notify_mode="daily_digest",
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
    async def test_digest_different_event_types_both_queued(self, slack_tools):
        """Different event types for the same key are both queued."""
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return=None)

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            r1 = await slack_notify(
                external_key="RHCLOUD-300",
                event_type="pr_created",
                message="First",
                webhook_url="https://hooks.slack.com/test",
                notify_mode="daily_digest",
            )
            r2 = await slack_notify(
                external_key="RHCLOUD-300",
                event_type="review_reminder",
                message="Second",
                webhook_url="https://hooks.slack.com/test",
                notify_mode="daily_digest",
            )

        assert r1["queued"] is True
        assert r2["queued"] is True
        assert pool.execute.call_count == 2

    @pytest.mark.asyncio
    async def test_digest_duplicate_event_rejected(self, slack_tools):
        """Same (jira_key, event_type) already in queue is rejected."""
        slack_notify = slack_tools["slack_notify"]
        pool = _make_pool(fetchrow_return={"id": 99})

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_notify(
                external_key="RHCLOUD-300",
                event_type="pr_created",
                message="Duplicate",
                webhook_url="https://hooks.slack.com/test",
                notify_mode="daily_digest",
            )

        assert result["queued"] is False
        assert "Already queued" in result["reason"]
        pool.execute.assert_not_called()


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

    @pytest.mark.asyncio
    async def test_send_digest_empty_queue_skips(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_send_digest(
                webhook_url="https://hooks.slack.com/test",
            )

        assert result["sent"] is False
        assert result["count"] == 0
        assert "No items" in result["reason"]

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
        assert "instance_id = $1" in fetch_call[0][0]
        assert fetch_call[0][1] == "framework-1"

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
    async def test_send_digest_idempotent(self, slack_tools):
        """Second call after all items sent returns empty."""
        slack_send_digest = slack_tools["slack_send_digest"]
        pool = _make_pool(fetch_return=[])

        with patch("bot_memory_server.tools.slack.get_pool", return_value=pool):
            result = await slack_send_digest(webhook_url="https://hooks.slack.com/test")

        assert result["sent"] is False
        assert result["count"] == 0

    @pytest.mark.asyncio
    async def test_send_digest_already_sent_today_skips(self, slack_tools):
        """Digest with same digest_key already sent is skipped."""
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
    async def test_send_digest_webhook_error_does_not_mark_sent(self, slack_tools):
        slack_send_digest = slack_tools["slack_send_digest"]
        rows = [_make_row(id=1)]
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
        for call in pool.execute.call_args_list:
            assert "UPDATE" not in call[0][0]


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
        now = datetime(2026, 7, 15, 9, 0, tzinfo=UTC)

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
        now = datetime(2026, 7, 15, 9, 0, tzinfo=UTC)

        result = _format_digest(None, rows, now)

        assert "*PR events (2):*" in result
        assert "*Other events" not in result
        assert "All instances" in result

    def test_format_digest_only_other_events(self):
        rows = [
            _make_row(id=1, event_type="needs_help", message="Help needed"),
            _make_row(id=2, event_type="release_pending", jira_key="RHCLOUD-102", message="PR merged"),
        ]
        now = datetime(2026, 7, 15, 9, 0, tzinfo=UTC)

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

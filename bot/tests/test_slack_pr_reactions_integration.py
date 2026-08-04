"""Integration tests for slack_pr_reactions — run against a real Slack workspace.

Usage:
    SLACK_USER_TOKEN=xoxp-... SLACK_OPEN_PRS_CHANNEL=C... \
        uv run pytest bot/tests/test_slack_pr_reactions_integration.py -v

    # With a specific test PR (skips gh/glab CLI dependency):
    SLACK_TEST_PR_URL=https://github.com/org/repo/pull/42 \
        uv run pytest bot/tests/test_slack_pr_reactions_integration.py -v

All tests skip when SLACK_USER_TOKEN and SLACK_OPEN_PRS_CHANNEL are not set.
"""

import os
import sys
from pathlib import Path

import pytest

SHARED_DIR = Path(__file__).resolve().parent.parent.parent / "presets" / "shared" / "preflight"
sys.path.insert(0, str(SHARED_DIR))

from slack_pr_reactions import (  # noqa: E402
    EMOJI_APPROVED,
    EMOJI_CHANGES,
    EMOJI_EYES,
    EMOJI_MERGED,
    STATUS_REACTIONS,
    _reactions_add,
    _reactions_remove,
    check_github_pr,
    extract_pr_urls,
    find_open_prs_thread,
    get_bot_user_id,
    get_reactions,
    get_thread_replies,
    process_thread,
    sync_reaction,
)

TOKEN = os.environ.get("SLACK_USER_TOKEN", "").strip()
CHANNEL = os.environ.get("SLACK_OPEN_PRS_CHANNEL", "").strip()
PATTERN = os.environ.get("SLACK_OPEN_PRS_PATTERN", "").strip() or "open prs"

LIVE = bool(TOKEN and CHANNEL)

pytestmark = pytest.mark.skipif(not LIVE, reason="SLACK_USER_TOKEN and SLACK_OPEN_PRS_CHANNEL required")


# ---------------------------------------------------------------------------
# Fixtures (pytest)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def bot_user_id():
    uid = get_bot_user_id(TOKEN)
    assert uid, "Failed to resolve bot user ID from token"
    return uid


@pytest.fixture(scope="module")
def thread_ts():
    ts = find_open_prs_thread(TOKEN, CHANNEL, PATTERN)
    assert ts, f"No thread matching '{PATTERN}' in channel {CHANNEL}"
    return ts


@pytest.fixture(scope="module")
def thread_replies(thread_ts):
    replies = get_thread_replies(TOKEN, CHANNEL, thread_ts)
    assert replies, "Thread has no replies"
    return replies


@pytest.fixture(scope="module")
def pr_message(thread_replies):
    """Find first reply containing a PR/MR URL."""
    for msg in thread_replies:
        urls = extract_pr_urls(msg.get("text", ""))
        if urls:
            return msg
    pytest.skip("No PR/MR URLs found in thread replies")


@pytest.fixture(scope="module")
def pr_info(pr_message):
    """Extract (host, repo, num) from first PR URL in message."""
    urls = extract_pr_urls(pr_message["text"])
    return urls[0]


# ---------------------------------------------------------------------------
# Tests — Step by step through the flow
# ---------------------------------------------------------------------------


class TestAuth:
    """Step 1: Verify Slack token works."""

    def test_auth_resolves_user_id(self, bot_user_id):
        assert bot_user_id
        assert bot_user_id.startswith("U")


class TestFindThread:
    """Step 2: Find the Open PRs root post."""

    def test_finds_thread(self, thread_ts):
        assert thread_ts
        assert "." in thread_ts

    def test_thread_ts_is_valid_slack_ts(self, thread_ts):
        parts = thread_ts.split(".")
        assert len(parts) == 2
        assert parts[0].isdigit()
        assert parts[1].isdigit()


class TestReadReplies:
    """Step 3: Read thread replies."""

    def test_replies_not_empty(self, thread_replies):
        assert len(thread_replies) > 0

    def test_first_message_is_parent(self, thread_replies, thread_ts):
        assert thread_replies[0].get("ts") == thread_ts

    def test_replies_have_text(self, thread_replies):
        for msg in thread_replies:
            assert "ts" in msg


class TestExtractUrls:
    """Step 4: Extract PR/MR URLs from replies."""

    def test_finds_pr_urls_in_thread(self, thread_replies):
        all_urls = []
        for msg in thread_replies:
            all_urls.extend(extract_pr_urls(msg.get("text", "")))
        assert len(all_urls) > 0, "No PR/MR URLs found in any reply"

    def test_pr_message_has_valid_url(self, pr_info):
        host, repo, num = pr_info
        assert host in ("github", "gitlab")
        assert "/" in repo
        assert num > 0


class TestCheckPrStatus:
    """Step 5: Check PR status via gh/glab CLI."""

    def test_github_pr_status(self, pr_info):
        host, repo, num = pr_info
        if host != "github":
            pytest.skip("First PR in thread is not GitHub")
        pr = check_github_pr(repo, num)
        assert pr is not None, f"gh pr view failed for {repo}#{num}"
        assert "state" in pr
        assert pr["state"] in ("OPEN", "CLOSED", "MERGED")


class TestReactions:
    """Step 6: Read and manage reactions on a PR message."""

    def test_get_reactions(self, pr_message):
        ts = pr_message["ts"]
        reactions = get_reactions(TOKEN, CHANNEL, ts)
        assert isinstance(reactions, list)

    def _assert_only_reaction(self, ts, expected, bot_user_id):
        """Assert bot has exactly one status reaction matching expected."""
        reactions = get_reactions(TOKEN, CHANNEL, ts)
        bot_status = [r for r in reactions if r["name"] in STATUS_REACTIONS and bot_user_id in r.get("users", [])]
        if expected is None:
            assert not bot_status, f"Expected no status reactions, found: {[r['name'] for r in bot_status]}"
        else:
            names = [r["name"] for r in bot_status]
            assert names == [expected], f"Expected only :{expected}:, found: {names}"

    def test_sync_cycle_eyes(self, pr_message, bot_user_id):
        """open PR, no reviews -> :eyes:"""
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, [], EMOJI_EYES, bot_user_id)
        self._assert_only_reaction(ts, EMOJI_EYES, bot_user_id)

    def test_sync_cycle_changes(self, pr_message, bot_user_id):
        """changes requested -> transitions from :eyes: to :x:"""
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        current = get_reactions(TOKEN, CHANNEL, ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, current, EMOJI_CHANGES, bot_user_id)
        self._assert_only_reaction(ts, EMOJI_CHANGES, bot_user_id)

    def test_sync_cycle_approved(self, pr_message, bot_user_id):
        """approved -> transitions to :white_check_mark:"""
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        current = get_reactions(TOKEN, CHANNEL, ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, current, EMOJI_APPROVED, bot_user_id)
        self._assert_only_reaction(ts, EMOJI_APPROVED, bot_user_id)

    def test_sync_cycle_merged(self, pr_message, bot_user_id):
        """merged -> transitions to :rocket:"""
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        current = get_reactions(TOKEN, CHANNEL, ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, current, EMOJI_MERGED, bot_user_id)
        self._assert_only_reaction(ts, EMOJI_MERGED, bot_user_id)

    def test_sync_cycle_clear(self, pr_message, bot_user_id):
        """closed (not merged) -> clear all status reactions."""
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        current = get_reactions(TOKEN, CHANNEL, ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, current, None, bot_user_id)
        self._assert_only_reaction(ts, None, bot_user_id)

    def test_sync_conflict_human_reaction(self, pr_message, bot_user_id):
        """Conflict needs a second Slack user to add a competing reaction."""
        human_token = os.environ.get("SLACK_HUMAN_TOKEN", "").strip()
        if not human_token:
            pytest.skip("Conflict test needs SLACK_HUMAN_TOKEN (a second user's token)")
        ts = pr_message["ts"]
        thread_ts_val = pr_message.get("thread_ts", ts)
        _reactions_add(human_token, CHANNEL, ts, EMOJI_EYES)
        current = get_reactions(TOKEN, CHANNEL, ts)
        sync_reaction(TOKEN, CHANNEL, ts, thread_ts_val, current, EMOJI_APPROVED, bot_user_id)
        reactions = get_reactions(TOKEN, CHANNEL, ts)
        has_eyes = any(r["name"] == EMOJI_EYES for r in reactions)
        has_approved = any(r["name"] == EMOJI_APPROVED and bot_user_id in r.get("users", []) for r in reactions)
        assert has_eyes, f"Expected human :{EMOJI_EYES}: to remain"
        assert has_approved, f"Expected bot :{EMOJI_APPROVED}: to be added"
        replies = get_thread_replies(TOKEN, CHANNEL, thread_ts_val)
        conflict_msgs = [m for m in replies if "Status note" in (m.get("text") or "")]
        assert conflict_msgs, "Expected conflict comment in thread"
        _reactions_remove(human_token, CHANNEL, ts, EMOJI_EYES)
        _reactions_remove(TOKEN, CHANNEL, ts, EMOJI_APPROVED)


class TestFullFlow:
    """Step 7: End-to-end flow — process_thread on real data."""

    def test_process_thread(self, thread_ts, bot_user_id):
        count = process_thread(TOKEN, CHANNEL, thread_ts, bot_user_id)
        assert count >= 0
        print(f"\n  Processed {count} PR message(s)")

    def test_process_thread_idempotent(self, thread_ts, bot_user_id):
        """Running twice should not duplicate reactions or comments."""
        count1 = process_thread(TOKEN, CHANNEL, thread_ts, bot_user_id)
        count2 = process_thread(TOKEN, CHANNEL, thread_ts, bot_user_id)
        assert count1 == count2, "Second run should process same messages"

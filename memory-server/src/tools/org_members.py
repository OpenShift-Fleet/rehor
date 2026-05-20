import os
from datetime import datetime, timezone, timedelta

from fastmcp import FastMCP

from ..db import get_pool

CACHE_TTL = timedelta(hours=24)

# Automated bot accounts — always treated as trusted, skip org membership check.
# Set via TRUSTED_BOT_ACCOUNTS env var (comma-separated). Empty = no trusted bots.
BOT_ACCOUNTS = frozenset(
    b.strip().lower()
    for b in os.environ.get("TRUSTED_BOT_ACCOUNTS", "").split(",")
    if b.strip()
)


def register_org_member_tools(mcp: FastMCP):
    @mcp.tool()
    async def check_org_member(username: str, org: str) -> dict:
        """Check if a GitHub user is a member of an org. Returns cached result if fresh (24h TTL).
        If cache miss or stale, returns {cached: false} — caller should check via
        `gh api orgs/{org}/members/{username}` and then call store_org_member with the result.
        Known bot accounts (sourcery-ai[bot], coderabbitai[bot], red-hat-konflux[bot]) are
        always returned as trusted without checking."""
        # Bot accounts are always trusted
        if username.lower() in BOT_ACCOUNTS:
            return {
                "cached": True,
                "username": username,
                "org": org,
                "is_member": True,
                "is_bot": True,
            }

        pool = get_pool()
        row = await pool.fetchrow(
            "SELECT is_member, checked_at FROM org_members WHERE username = $1 AND org = $2",
            username.lower(),
            org.lower(),
        )
        if row:
            age = datetime.now(timezone.utc) - row["checked_at"]
            if age < CACHE_TTL:
                return {
                    "cached": True,
                    "username": username,
                    "org": org,
                    "is_member": row["is_member"],
                    "checked_at": row["checked_at"].isoformat(),
                }
        return {"cached": False, "username": username, "org": org}

    @mcp.tool()
    async def store_org_member(username: str, org: str, is_member: bool) -> dict:
        """Store the result of a GitHub org membership check.
        Call this after checking `gh api orgs/{org}/members/{username}` (204 = member, 404 = not)."""
        pool = get_pool()
        row = await pool.fetchrow(
            """
            INSERT INTO org_members (username, org, is_member, checked_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (username, org)
            DO UPDATE SET is_member = $3, checked_at = NOW()
            RETURNING *
            """,
            username.lower(),
            org.lower(),
            is_member,
        )
        return {
            "username": row["username"],
            "org": row["org"],
            "is_member": row["is_member"],
            "checked_at": row["checked_at"].isoformat(),
        }

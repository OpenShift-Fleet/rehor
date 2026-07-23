#!/usr/bin/env python3
"""
Post-PR workflow operations.

Consolidates post-PR-creation bookkeeping into a single script:
1. task_update - update GitHub PR (labels, JIRA link, reviewers)
2. jira_transition_issue - transition JIRA issue to "Code Review"
3. jira_add_comment - add PR link and summary as JIRA comment
4. slack_notify - send notification to Slack webhook
5. memory_store - save implementation learnings to JSON file
6. bot_status_update - update bot status to idle

Fully integrated with GitHub REST API, JIRA Cloud API v3, and Slack webhooks.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
import urllib.parse
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from jira_mcp import jira_call
from memory_mcp import memory_call

logging.basicConfig(level=logging.INFO, format="[post-pr] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


class OperationStatus(str, Enum):
    """Operation execution status."""

    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class OperationResult:
    """Result of a single operation."""

    operation: str
    status: OperationStatus
    message: str
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class WorkflowResult:
    """Result of the entire post-PR workflow."""

    success: bool
    pr_url: str
    pr_number: int
    ticket_id: str
    operations: List[OperationResult]
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            "success": self.success,
            "pr_url": self.pr_url,
            "pr_number": self.pr_number,
            "ticket_id": self.ticket_id,
            "timestamp": self.timestamp,
            "operations": [
                {
                    "operation": op.operation,
                    "status": op.status.value,
                    "message": op.message,
                    "timestamp": op.timestamp,
                    "details": op.details,
                }
                for op in self.operations
            ],
        }


class PostPROperations:
    """Post-PR workflow operations."""

    CLI_TIMEOUT = 30

    def __init__(
        self,
        slack_webhook: str,
        memory_store_path: str,
        jira_url: str = "https://redhat.atlassian.net",
        dry_run: bool = False,
    ):
        self.jira_url = jira_url
        self.slack_webhook = slack_webhook
        self.memory_store_path = Path(memory_store_path)
        self.dry_run = dry_run
        self.memory_store_path.parent.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _run_cli(args: List[str], input_data: Optional[str] = None, timeout: int = CLI_TIMEOUT) -> tuple:
        """Run a CLI command and return (success, output)."""
        try:
            r = subprocess.run(args, input=input_data, capture_output=True, text=True, timeout=timeout)
            if r.returncode != 0:
                return False, r.stderr.strip() or r.stdout.strip()
            return True, r.stdout.strip()
        except Exception as e:
            return False, str(e)

    def _parse_pr_url(self, pr_url: str) -> Dict[str, str]:
        """Parse a PR/MR URL into components."""
        parsed = urllib.parse.urlparse(pr_url)
        hostname = parsed.hostname or ""
        path = parsed.path or ""

        if "/-/merge_requests/" in path:
            path_parts = path.split("/-/merge_requests/")
            if len(path_parts) != 2:
                raise ValueError(f"Invalid GitLab MR URL: {pr_url}")
            project_path = path_parts[0].strip("/")
            segments = project_path.rsplit("/", 1)
            owner = segments[0] if len(segments) > 1 else ""
            repo = segments[-1]
            return {
                "host": "gitlab",
                "hostname": hostname,
                "owner": owner,
                "repo": repo,
                "project_path": project_path,
            }

        if hostname == "github.com":
            parts = path.strip("/").split("/")
            if len(parts) < 4 or parts[-2] != "pull":
                raise ValueError(f"Invalid GitHub PR URL: {pr_url}")
            return {"host": "github", "owner": parts[0], "repo": parts[1]}

        raise ValueError(f"Unsupported PR URL (not GitHub or GitLab): {pr_url}")

    def task_update(
        self, pr_url: str, pr_number: int, ticket_id: str, reviewers: Optional[List[str]] = None
    ) -> OperationResult:
        """Update PR/MR with labels, JIRA link in description, and request reviewers.

        Supports both GitHub (via gh CLI) and GitLab (via glab CLI).
        """
        try:
            info = self._parse_pr_url(pr_url)
            if reviewers is None:
                reviewers = []

            if info["host"] == "github":
                return self._update_github_pr(info, pr_url, pr_number, ticket_id, reviewers)
            else:
                return self._update_gitlab_mr(info, pr_url, pr_number, ticket_id, reviewers)

        except Exception as e:
            logger.error(f"Failed to update PR/MR: {e}")
            return OperationResult(
                operation="task_update", status=OperationStatus.FAILED, message=f"PR/MR update failed: {e}"
            )

    def _update_github_pr(
        self, info: Dict[str, str], pr_url: str, pr_number: int, ticket_id: str, reviewers: List[str]
    ) -> OperationResult:
        """Update GitHub PR via gh CLI."""
        owner = info["owner"]
        repo = info["repo"]
        updates = []
        labels_to_add = ["code-review", "awaiting-review"]

        if self.dry_run:
            logger.info(f"[DRY RUN] Would update GitHub PR #{pr_number} on {owner}/{repo}")
        else:
            ok, out = self._run_cli(
                ["gh", "api", f"repos/{owner}/{repo}/issues/{pr_number}/labels", "-X", "POST", "--input", "-"],
                input_data=json.dumps({"labels": labels_to_add}),
            )
            if not ok:
                raise ValueError(f"Failed to add labels: {out}")
            logger.info(f"Added labels to PR #{pr_number}: {labels_to_add}")
        updates.append(f"Added labels: {', '.join(labels_to_add)}")

        jira_link = f"{self.jira_url}/browse/{ticket_id}"
        jira_section = f"\n\n---\n**JIRA Ticket**: [{ticket_id}]({jira_link})"

        if self.dry_run:
            logger.info(f"[DRY RUN] Would update PR description with JIRA link: {jira_link}")
        else:
            ok, out = self._run_cli(["gh", "api", f"repos/{owner}/{repo}/pulls/{pr_number}"])
            if not ok:
                raise ValueError(f"Failed to get PR: {out}")
            pr_data = json.loads(out)
            current_body = pr_data.get("body") or ""

            if ticket_id not in current_body:
                updated_body = current_body + jira_section
                ok, out = self._run_cli(
                    ["gh", "api", f"repos/{owner}/{repo}/pulls/{pr_number}", "-X", "PATCH", "--input", "-"],
                    input_data=json.dumps({"body": updated_body}),
                )
                if not ok:
                    raise ValueError(f"Failed to update PR description: {out}")
                logger.info(f"Updated PR description with JIRA link: {jira_link}")
            else:
                logger.info("JIRA link already exists in PR description")
        updates.append("Added JIRA link to description")

        if reviewers:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would request reviewers for PR #{pr_number}: {reviewers}")
            else:
                ok, out = self._run_cli(
                    [
                        "gh",
                        "api",
                        f"repos/{owner}/{repo}/pulls/{pr_number}/requested_reviewers",
                        "-X",
                        "POST",
                        "--input",
                        "-",
                    ],
                    input_data=json.dumps({"reviewers": reviewers}),
                )
                if not ok:
                    raise ValueError(f"Failed to request reviewers: {out}")
                logger.info(f"Requested reviewers for PR #{pr_number}: {reviewers}")
            updates.append(f"Requested reviewers: {', '.join(reviewers)}")

        return OperationResult(
            operation="task_update",
            status=OperationStatus.SUCCESS,
            message=f"Updated PR #{pr_number}: {'; '.join(updates)}",
            details={
                "pr_url": pr_url,
                "pr_number": pr_number,
                "owner": owner,
                "repo": repo,
                "labels_added": labels_to_add,
                "jira_ticket": ticket_id,
                "jira_link": jira_link,
                "reviewers_requested": reviewers,
            },
        )

    def _update_gitlab_mr(
        self, info: Dict[str, str], pr_url: str, pr_number: int, ticket_id: str, reviewers: List[str]
    ) -> OperationResult:
        """Update GitLab MR via glab CLI."""
        hostname = info["hostname"]
        project_path = info["project_path"]
        encoded_project = urllib.parse.quote(project_path, safe="")
        owner = info["owner"]
        repo = info["repo"]
        updates = []
        labels_to_add = ["code-review", "awaiting-review"]

        if self.dry_run:
            logger.info(f"[DRY RUN] Would update GitLab MR !{pr_number} on {project_path}")
        else:
            ok, out = self._run_cli(
                [
                    "glab",
                    "api",
                    f"projects/{encoded_project}/merge_requests/{pr_number}",
                    "-X",
                    "PUT",
                    "-f",
                    f"add_labels={','.join(labels_to_add)}",
                    "--hostname",
                    hostname,
                ]
            )
            if not ok:
                raise ValueError(f"Failed to add labels: {out}")
            logger.info(f"Added labels to MR !{pr_number}: {labels_to_add}")
        updates.append(f"Added labels: {', '.join(labels_to_add)}")

        jira_link = f"{self.jira_url}/browse/{ticket_id}"
        jira_section = f"\n\n---\n**JIRA Ticket**: [{ticket_id}]({jira_link})"

        if self.dry_run:
            logger.info(f"[DRY RUN] Would update MR description with JIRA link: {jira_link}")
        else:
            ok, out = self._run_cli(
                [
                    "glab",
                    "api",
                    f"projects/{encoded_project}/merge_requests/{pr_number}",
                    "--hostname",
                    hostname,
                ]
            )
            if not ok:
                raise ValueError(f"Failed to get MR: {out}")
            mr_data = json.loads(out)
            current_body = mr_data.get("description") or ""

            if ticket_id not in current_body:
                updated_body = current_body + jira_section
                ok, out = self._run_cli(
                    [
                        "glab",
                        "api",
                        f"projects/{encoded_project}/merge_requests/{pr_number}",
                        "-X",
                        "PUT",
                        "--input",
                        "-",
                        "--hostname",
                        hostname,
                    ],
                    input_data=json.dumps({"description": updated_body}),
                )
                if not ok:
                    raise ValueError(f"Failed to update MR description: {out}")
                logger.info(f"Updated MR description with JIRA link: {jira_link}")
            else:
                logger.info("JIRA link already exists in MR description")
        updates.append("Added JIRA link to description")

        if reviewers:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would request reviewers for MR !{pr_number}: {reviewers}")
            else:
                reviewer_ids = []
                for reviewer in reviewers:
                    ok, out = self._run_cli(
                        [
                            "glab",
                            "api",
                            f"users?username={reviewer}",
                            "--hostname",
                            hostname,
                        ]
                    )
                    if ok:
                        users = json.loads(out)
                        if users:
                            reviewer_ids.append(users[0]["id"])

                if reviewer_ids:
                    ok, out = self._run_cli(
                        [
                            "glab",
                            "api",
                            f"projects/{encoded_project}/merge_requests/{pr_number}",
                            "-X",
                            "PUT",
                            "--input",
                            "-",
                            "--hostname",
                            hostname,
                        ],
                        input_data=json.dumps({"reviewer_ids": reviewer_ids}),
                    )
                    if not ok:
                        raise ValueError(f"Failed to request reviewers: {out}")
                    logger.info(f"Requested reviewers for MR !{pr_number}: {reviewers}")
            updates.append(f"Requested reviewers: {', '.join(reviewers)}")

        return OperationResult(
            operation="task_update",
            status=OperationStatus.SUCCESS,
            message=f"Updated MR !{pr_number}: {'; '.join(updates)}",
            details={
                "pr_url": pr_url,
                "pr_number": pr_number,
                "owner": owner,
                "repo": repo,
                "labels_added": labels_to_add,
                "jira_ticket": ticket_id,
                "jira_link": jira_link,
                "reviewers_requested": reviewers,
            },
        )

    def jira_transition_issue(self, ticket_id: str, target_status: str = "Code Review") -> OperationResult:
        """Transition JIRA issue to target status via MCP.

        Args:
            ticket_id: JIRA ticket ID (e.g., TICKET-456)
            target_status: Target status (default: "Code Review")

        Returns:
            OperationResult with success/failure status
        """
        try:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would transition {ticket_id} to {target_status}")
            else:
                data = jira_call("jira_get_transitions", {"issue_key": ticket_id})
                if not data:
                    raise ValueError("Failed to get transitions from Jira MCP")

                transitions = data if isinstance(data, list) else data.get("transitions", [])

                transition_id = None
                for transition in transitions:
                    name = transition.get("to", transition).get("name", "")
                    if name == target_status:
                        transition_id = transition.get("id")
                        break

                if not transition_id:
                    for transition in transitions:
                        name = transition.get("to", transition).get("name", "")
                        if name.lower() == target_status.lower():
                            transition_id = transition.get("id")
                            break

                if not transition_id:
                    available = [t.get("to", t).get("name", "") for t in transitions]
                    raise ValueError(
                        f"Cannot transition to '{target_status}'. Available transitions: {', '.join(available)}"
                    )

                result = jira_call(
                    "jira_transition_issue",
                    {
                        "issue_key": ticket_id,
                        "transition_id": str(transition_id),
                    },
                )
                if result is None:
                    raise ValueError("Transition call returned None")
                logger.info(f"Transitioned {ticket_id} to {target_status}")

            return OperationResult(
                operation="jira_transition_issue",
                status=OperationStatus.SUCCESS,
                message=f"Transitioned {ticket_id} to {target_status}",
                details={
                    "ticket_id": ticket_id,
                    "status": target_status,
                    "jira_url": f"{self.jira_url}/browse/{ticket_id}",
                },
            )

        except Exception as e:
            logger.error(f"Failed to transition JIRA issue: {e}")
            return OperationResult(
                operation="jira_transition_issue", status=OperationStatus.FAILED, message=f"JIRA transition failed: {e}"
            )

    def jira_add_comment(self, ticket_id: str, pr_url: str, summary: str) -> OperationResult:
        """Add comment to JIRA issue with PR link and summary via MCP.

        Args:
            ticket_id: JIRA ticket ID
            pr_url: GitHub PR URL
            summary: PR summary

        Returns:
            OperationResult with success/failure status
        """
        try:
            comment_text = f"Pull Request created: {pr_url}\n\nSummary: {summary}"

            if self.dry_run:
                logger.info(f"[DRY RUN] Would add comment to {ticket_id}: {comment_text}")
            else:
                result = jira_call(
                    "jira_add_comment",
                    {
                        "issue_key": ticket_id,
                        "body": comment_text,
                    },
                )
                if result is None:
                    raise ValueError("Failed to add comment via Jira MCP")
                logger.info(f"Added comment to {ticket_id}")

            return OperationResult(
                operation="jira_add_comment",
                status=OperationStatus.SUCCESS,
                message=f"Added comment to {ticket_id}",
                details={"ticket_id": ticket_id, "comment": comment_text},
            )

        except Exception as e:
            logger.error(f"Failed to add JIRA comment: {e}")
            return OperationResult(
                operation="jira_add_comment", status=OperationStatus.FAILED, message=f"JIRA comment failed: {e}"
            )

    def slack_notify(
        self, pr_url: str, pr_number: int, summary: str, ticket_id: str, channel: str = "#hcc-ai-assistant"
    ) -> OperationResult:
        """Send Slack notification for pr_created event via memory-server MCP.

        Routes through the unified slack_notify MCP tool, gaining 48h deduplication
        and daily digest support.

        Args:
            pr_url: GitHub/GitLab PR URL
            pr_number: PR number
            summary: PR summary
            ticket_id: JIRA ticket ID (used as external_key for deduplication)
            channel: Slack channel (unused — channel is determined by webhook URL)

        Returns:
            OperationResult with success/failure status
        """
        try:
            if not self.slack_webhook:
                raise ValueError("Slack webhook not configured (set SLACK_WEBHOOK_URL)")

            message = f"New PR created: <{pr_url}|#{pr_number}>\nSummary: {summary}"

            if self.dry_run:
                logger.info(f"[DRY RUN] Would send Slack notification: {message}")
            else:
                repo = None
                try:
                    info = self._parse_pr_url(pr_url)
                    repo = f"{info['owner']}/{info['repo']}" if info.get("owner") else info.get("repo")
                except Exception:
                    pass

                result = memory_call(
                    "slack_notify",
                    {
                        "external_key": ticket_id,
                        "event_type": "pr_created",
                        "message": message,
                        "webhook_url": self.slack_webhook,
                        "pr_url": pr_url,
                        "pr_number": pr_number,
                        "repo": repo,
                        "title": summary,
                    },
                )
                if result and result.get("sent"):
                    logger.info("Sent Slack notification via MCP")
                elif result and result.get("queued"):
                    logger.info("Slack notification queued for digest")
                else:
                    reason = result.get("reason", "unknown") if result else "MCP call failed"
                    logger.warning(f"Slack notification not sent: {reason}")

            return OperationResult(
                operation="slack_notify",
                status=OperationStatus.SUCCESS,
                message="Slack notification processed",
                details={"pr_url": pr_url},
            )

        except Exception as e:
            logger.error(f"Failed to send Slack notification: {e}")
            return OperationResult(
                operation="slack_notify", status=OperationStatus.FAILED, message=f"Slack notification failed: {e}"
            )

    def memory_store(self, pr_url: str, ticket_id: str, learnings: Dict[str, Any]) -> OperationResult:
        """Store implementation learnings in memory.

        Args:
            pr_url: GitHub PR URL
            ticket_id: JIRA ticket ID
            learnings: Implementation learnings (patterns, gotchas, decisions)

        Returns:
            OperationResult with success/failure status
        """
        try:
            memory_entry = {
                "pr_url": pr_url,
                "ticket_id": ticket_id,
                "timestamp": datetime.now(UTC).isoformat(),
                "learnings": learnings,
            }

            if self.dry_run:
                logger.info(f"[DRY RUN] Would store memory: {memory_entry}")
            else:
                # Append to JSON file (accumulative)
                memories = []
                if self.memory_store_path.exists():
                    with open(self.memory_store_path, "r") as f:
                        memories = json.load(f)
                memories.append(memory_entry)
                with open(self.memory_store_path, "w") as f:
                    json.dump(memories, f, indent=2)
                logger.info(f"Stored memory for {ticket_id}")

            return OperationResult(
                operation="memory_store",
                status=OperationStatus.SUCCESS,
                message="Stored implementation learnings",
                details=memory_entry,
            )

        except Exception as e:
            logger.error(f"Failed to store memory: {e}")
            return OperationResult(
                operation="memory_store", status=OperationStatus.FAILED, message=f"Memory storage failed: {e}"
            )

    def bot_status_update(self, status: str = "idle") -> OperationResult:
        """Update bot status.

        Args:
            status: Bot status (default: "idle")

        Returns:
            OperationResult with success/failure status
        """
        try:
            status_data = {"status": status, "timestamp": datetime.now(UTC).isoformat()}

            if self.dry_run:
                logger.info(f"[DRY RUN] Would update bot status to {status}")
            else:
                # Write to status file (overwrites previous status)
                status_file = Path("/tmp/bot_status.json")
                with open(status_file, "w") as f:
                    json.dump(status_data, f, indent=2)
                logger.info(f"Updated bot status to {status}")

            return OperationResult(
                operation="bot_status_update",
                status=OperationStatus.SUCCESS,
                message=f"Bot status set to {status}",
                details=status_data,
            )

        except Exception as e:
            logger.error(f"Failed to update bot status: {e}")
            return OperationResult(
                operation="bot_status_update", status=OperationStatus.FAILED, message=f"Bot status update failed: {e}"
            )


def execute_post_pr_workflow(
    pr_url: str,
    pr_number: int,
    ticket_id: str,
    summary: str,
    jira_url: Optional[str] = None,
    slack_webhook: Optional[str] = None,
    slack_channel: str = "#hcc-ai-assistant",
    memory_store_path: Optional[str] = None,
    reviewers: Optional[List[str]] = None,
    skip_operations: Optional[List[str]] = None,
    dry_run: bool = False,
) -> WorkflowResult:
    """Execute the complete post-PR workflow.

    GitHub/GitLab operations use gh/glab CLI (no tokens needed).
    JIRA operations use MCP via jira_call.
    """
    jira_url = jira_url or os.getenv("POST_PR_JIRA_URL", "https://redhat.atlassian.net")
    slack_webhook = slack_webhook or os.getenv("SLACK_WEBHOOK_URL")
    memory_store_path = memory_store_path or os.getenv("POST_PR_MEMORY_STORE", "/tmp/memory.json")

    skip_operations = skip_operations or []
    operations = PostPROperations(
        slack_webhook=slack_webhook,
        memory_store_path=memory_store_path,
        jira_url=jira_url,
        dry_run=dry_run,
    )

    results: List[OperationResult] = []

    # Operation 1: Update GitHub PR (add labels, JIRA link, request reviewers)
    if "github" not in skip_operations and "task" not in skip_operations:
        result = operations.task_update(pr_url, pr_number, ticket_id, reviewers)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(operation="task_update", status=OperationStatus.SKIPPED, message="Skipped by user request")
        )

    # Operation 2: Transition JIRA issue
    if "jira" not in skip_operations:
        result = operations.jira_transition_issue(ticket_id)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(
                operation="jira_transition_issue", status=OperationStatus.SKIPPED, message="Skipped by user request"
            )
        )

    # Operation 3: Add JIRA comment
    if "jira" not in skip_operations:
        result = operations.jira_add_comment(ticket_id, pr_url, summary)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(
                operation="jira_add_comment", status=OperationStatus.SKIPPED, message="Skipped by user request"
            )
        )

    # Operation 4: Slack notification
    if "slack" not in skip_operations:
        result = operations.slack_notify(pr_url, pr_number, summary, ticket_id, slack_channel)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(operation="slack_notify", status=OperationStatus.SKIPPED, message="Skipped by user request")
        )

    # Operation 5: Store memory
    if "memory" not in skip_operations:
        learnings = {"summary": summary, "pr_url": pr_url, "patterns": [], "gotchas": [], "decisions": []}
        result = operations.memory_store(pr_url, ticket_id, learnings)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(operation="memory_store", status=OperationStatus.SKIPPED, message="Skipped by user request")
        )

    # Operation 6: Update bot status
    if "status" not in skip_operations:
        result = operations.bot_status_update("idle")
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(
                success=False, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results
            )
    else:
        results.append(
            OperationResult(
                operation="bot_status_update", status=OperationStatus.SKIPPED, message="Skipped by user request"
            )
        )

    return WorkflowResult(success=True, pr_url=pr_url, pr_number=pr_number, ticket_id=ticket_id, operations=results)


def main():
    """CLI entrypoint."""
    parser = argparse.ArgumentParser(description="Post-PR workflow automation")
    parser.add_argument("pr_url", help="GitHub PR URL")
    parser.add_argument("pr_number", type=int, help="PR number")
    parser.add_argument("ticket_id", help="JIRA ticket ID")
    parser.add_argument("summary", help="PR summary")
    parser.add_argument("--slack-channel", default="#hcc-ai-assistant", help="Slack channel for notifications")
    parser.add_argument("--reviewers", help="Comma-separated list of GitHub usernames to request as reviewers")
    parser.add_argument(
        "--skip", help="Comma-separated list of operations to skip (github, jira, slack, memory, status)"
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done without executing")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of human-readable format")

    args = parser.parse_args()

    skip_operations = args.skip.split(",") if args.skip else []
    reviewers = args.reviewers.split(",") if args.reviewers else None

    result = execute_post_pr_workflow(
        pr_url=args.pr_url,
        pr_number=args.pr_number,
        ticket_id=args.ticket_id,
        summary=args.summary,
        slack_channel=args.slack_channel,
        reviewers=reviewers,
        skip_operations=skip_operations,
        dry_run=args.dry_run,
    )

    if args.json:
        print(json.dumps(result.to_dict(), indent=2))
    else:
        print(f"\n{'=' * 80}")
        print(f"Post-PR Workflow: {'SUCCESS' if result.success else 'FAILED'}")
        print(f"{'=' * 80}")
        print(f"PR: {result.pr_url} (#{result.pr_number})")
        print(f"Ticket: {result.ticket_id}")
        print(f"Timestamp: {result.timestamp}")
        print("\nOperations:")
        for op in result.operations:
            status_icon = (
                "✓" if op.status == OperationStatus.SUCCESS else "✗" if op.status == OperationStatus.FAILED else "-"
            )
            print(f"  {status_icon} {op.operation}: {op.message}")
        print(f"{'=' * 80}\n")

    sys.exit(0 if result.success else 1)


if __name__ == "__main__":
    main()

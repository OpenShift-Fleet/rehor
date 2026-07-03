"""
Claim ticket workflow operations.

Consolidates ticket claiming into a single script:
1. get_bot_email - retrieve bot's JIRA account ID via MCP
2. get_transitions - get available transitions via MCP
3. assign_ticket - assign ticket via MCP
4. transition_to_in_progress - move to "In Progress" via MCP
5. resolve_board - determine correct board from labels via MCP
6. get_active_sprint - get active sprint via MCP
7. add_to_sprint - add ticket to sprint via MCP
8. task_add - track ticket in memory server

All JIRA operations use MCP via jira_call() - no API tokens needed.
"""

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from jira_mcp import jira_call

TRANSITION_IN_PROGRESS = "In Progress"

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)


class OperationStatus(Enum):
    """Status of an individual operation."""

    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class OperationResult:
    """Result of a single operation."""

    operation: str
    status: OperationStatus
    message: str
    details: Optional[Dict[str, Any]] = None


@dataclass
class WorkflowResult:
    """Result of the entire workflow."""

    success: bool
    operations: List[OperationResult]
    jira_key: str


class ClaimTicketOperations:
    """Handles all ticket claiming operations."""

    # Class-level cache for bot account ID
    _bot_account_id_cache: Optional[str] = None

    def __init__(
        self,
        memory_url: str,
        dry_run: bool = False,
    ):
        """
        Initialize claim ticket operations handler.

        Args:
            memory_url: Memory server base URL
            dry_run: If True, log actions without executing them
        """
        self.memory_url = memory_url.rstrip("/")
        self.dry_run = dry_run

        # Workflow state
        self.bot_account_id: Optional[str] = None
        self.transition_id: Optional[str] = None
        self.board_id: Optional[str] = None
        self.sprint_id: Optional[int] = None

    def get_bot_email(self) -> OperationResult:
        """
        Get bot's JIRA email from BOT_JIRA_EMAIL env var.

        No MCP call needed — jira_update_issue accepts email strings directly.
        """
        bot_email = os.environ.get("BOT_JIRA_EMAIL")
        if not bot_email:
            error_msg = "BOT_JIRA_EMAIL env var not set"
            logger.error(error_msg)
            return OperationResult(
                operation="get_bot_email",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        self.bot_account_id = bot_email
        logger.info(f"Using bot email for assignment: {bot_email}")
        return OperationResult(
            operation="get_bot_email",
            status=OperationStatus.SUCCESS,
            message=f"Using bot email: {bot_email}",
            details={"email": bot_email},
        )

    def get_transitions(self, jira_key: str) -> OperationResult:
        """
        Get available transitions and find "In Progress" transition ID.

        Args:
            jira_key: JIRA ticket key (e.g., RHCLOUD-12345)

        Returns:
            OperationResult with transition ID
        """
        logger.info(f"Getting transitions for {jira_key}...")

        if self.dry_run:
            self.transition_id = "dry-run-transition-id"
            logger.info(f"[DRY RUN] Would call jira_get_transitions for {jira_key}")
            return OperationResult(
                operation="get_transitions",
                status=OperationStatus.SUCCESS,
                message=f"Found 'In Progress' transition (dry run): {self.transition_id}",
                details={"transition_id": self.transition_id},
            )

        try:
            data = jira_call("jira_get_transitions", {"issue_key": jira_key})
            if not data:
                error_msg = "jira_get_transitions returned None"
                logger.error(error_msg)
                return OperationResult(
                    operation="get_transitions",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            transitions = data if isinstance(data, list) else data.get("transitions", [])

            # Find "In Progress" transition
            in_progress_transition = None
            for transition in transitions:
                if (
                    transition.get("name") == TRANSITION_IN_PROGRESS
                    or transition.get("to", {}).get("name") == TRANSITION_IN_PROGRESS
                ):
                    in_progress_transition = transition
                    break

            if not in_progress_transition:
                available = [t.get("name", "unknown") for t in transitions]
                error_msg = f"'{TRANSITION_IN_PROGRESS}' transition not found. Available: {available}"
                logger.error(error_msg)
                return OperationResult(
                    operation="get_transitions",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            self.transition_id = in_progress_transition["id"]

            logger.info(f"Found 'In Progress' transition ID: {self.transition_id}")
            return OperationResult(
                operation="get_transitions",
                status=OperationStatus.SUCCESS,
                message=f"Found 'In Progress' transition ID: {self.transition_id}",
                details={"transition_id": self.transition_id},
            )
        except Exception as e:
            error_msg = f"Failed to get transitions: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="get_transitions",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def assign_ticket(self, jira_key: str) -> OperationResult:
        """
        Assign ticket to bot user via jira_update_issue.

        Args:
            jira_key: JIRA ticket key (e.g., RHCLOUD-12345)

        Returns:
            OperationResult with assignment details
        """
        if not self.bot_account_id:
            error_msg = "Bot account ID not available. Run get_bot_email first."
            logger.error(error_msg)
            return OperationResult(
                operation="assign_ticket",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        logger.info(f"Assigning {jira_key} to bot user {self.bot_account_id}...")

        if self.dry_run:
            logger.info(f"[DRY RUN] Would assign {jira_key} to {self.bot_account_id}")
            return OperationResult(
                operation="assign_ticket",
                status=OperationStatus.SUCCESS,
                message=f"Assigned {jira_key} to bot user (dry run)",
            )

        try:
            data = jira_call(
                "jira_update_issue",
                {
                    "issue_key": jira_key,
                    "fields": json.dumps({"assignee": self.bot_account_id}),
                },
            )

            if data is None:
                error_msg = "jira_update_issue returned None"
                logger.error(error_msg)
                return OperationResult(
                    operation="assign_ticket",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            logger.info(f"Successfully assigned {jira_key} to bot user")
            return OperationResult(
                operation="assign_ticket",
                status=OperationStatus.SUCCESS,
                message=f"Assigned {jira_key} to bot user",
            )
        except Exception as e:
            error_msg = f"Failed to assign ticket: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="assign_ticket",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def transition_to_in_progress(self, jira_key: str) -> OperationResult:
        """
        Transition ticket to "In Progress" status via jira_transition_issue.

        Args:
            jira_key: JIRA ticket key (e.g., RHCLOUD-12345)

        Returns:
            OperationResult with transition details
        """
        if not self.transition_id:
            error_msg = "Transition ID not available. Run get_transitions first."
            logger.error(error_msg)
            return OperationResult(
                operation="transition_to_in_progress",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        logger.info(f"Transitioning {jira_key} to 'In Progress'...")

        if self.dry_run:
            logger.info(f"[DRY RUN] Would transition {jira_key} to 'In Progress'")
            return OperationResult(
                operation="transition_to_in_progress",
                status=OperationStatus.SUCCESS,
                message=f"Transitioned {jira_key} to 'In Progress' (dry run)",
            )

        try:
            data = jira_call(
                "jira_transition_issue",
                {
                    "issue_key": jira_key,
                    "transition_id": self.transition_id,
                },
            )

            if data is None:
                error_msg = "jira_transition_issue returned None"
                logger.error(error_msg)
                return OperationResult(
                    operation="transition_to_in_progress",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            logger.info(f"Successfully transitioned {jira_key} to 'In Progress'")
            return OperationResult(
                operation="transition_to_in_progress",
                status=OperationStatus.SUCCESS,
                message=f"Transitioned {jira_key} to 'In Progress'",
            )
        except Exception as e:
            error_msg = f"Failed to transition ticket: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="transition_to_in_progress",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def resolve_board(self, jira_key: str) -> OperationResult:
        """
        Resolve board from BOT_BOARD_ID or BOT_BOARD_NAME environment variables.

        Args:
            jira_key: JIRA ticket key (used for logging only)

        Returns:
            OperationResult with board ID
        """
        logger.info(f"Resolving board for {jira_key}...")

        bot_board_id = os.environ.get("BOT_BOARD_ID", "")
        bot_board_name = os.environ.get("BOT_BOARD_NAME", "")

        if self.dry_run:
            self.board_id = bot_board_id or "dry-run-board"
            logger.info(f"[DRY RUN] Would resolve board for {jira_key}")
            return OperationResult(
                operation="resolve_board",
                status=OperationStatus.SUCCESS,
                message=f"Resolved board ID (dry run): {self.board_id}",
                details={"board_id": self.board_id},
            )

        try:
            if bot_board_id:
                self.board_id = bot_board_id
                logger.info(f"Using BOT_BOARD_ID: {self.board_id}")
            elif bot_board_name:
                data = jira_call("jira_get_agile_boards", {"board_name": bot_board_name, "limit": 1})
                if not data:
                    error_msg = f"No board found matching name '{bot_board_name}'"
                    logger.error(error_msg)
                    return OperationResult(
                        operation="resolve_board",
                        status=OperationStatus.FAILED,
                        message=error_msg,
                    )
                boards = data if isinstance(data, list) else data.get("values", [])
                if not boards:
                    error_msg = f"No board found matching name '{bot_board_name}'"
                    logger.error(error_msg)
                    return OperationResult(
                        operation="resolve_board",
                        status=OperationStatus.FAILED,
                        message=error_msg,
                    )
                self.board_id = str(boards[0]["id"])
                logger.info(f"Resolved board '{bot_board_name}' → {self.board_id}")
            else:
                error_msg = "Neither BOT_BOARD_ID nor BOT_BOARD_NAME is set"
                logger.error(error_msg)
                return OperationResult(
                    operation="resolve_board",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            return OperationResult(
                operation="resolve_board",
                status=OperationStatus.SUCCESS,
                message=f"Resolved board ID: {self.board_id}",
                details={"board_id": self.board_id},
            )
        except Exception as e:
            error_msg = f"Failed to resolve board: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="resolve_board",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def get_active_sprint(self) -> OperationResult:
        """
        Get active sprint from the resolved board via jira_get_sprints_from_board.

        Returns:
            OperationResult with sprint ID
        """
        if not self.board_id:
            error_msg = "Board ID not available. Run resolve_board first."
            logger.error(error_msg)
            return OperationResult(
                operation="get_active_sprint",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        logger.info(f"Getting active sprint from board {self.board_id}...")

        if self.dry_run:
            self.sprint_id = 12345
            logger.info(f"[DRY RUN] Would get active sprint from board {self.board_id}")
            return OperationResult(
                operation="get_active_sprint",
                status=OperationStatus.SUCCESS,
                message=f"Found active sprint (dry run): {self.sprint_id}",
                details={"sprint_id": self.sprint_id},
            )

        try:
            data = jira_call(
                "jira_get_sprints_from_board",
                {
                    "board_id": self.board_id,
                    "state": "active",
                },
            )

            if not data:
                error_msg = "jira_get_sprints_from_board returned None"
                logger.error(error_msg)
                return OperationResult(
                    operation="get_active_sprint",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            sprints = data if isinstance(data, list) else data.get("sprints", [])

            if not sprints:
                error_msg = f"No active sprint found on board {self.board_id}"
                logger.error(error_msg)
                return OperationResult(
                    operation="get_active_sprint",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            self.sprint_id = sprints[0]["id"]

            logger.info(f"Found active sprint ID: {self.sprint_id}")
            return OperationResult(
                operation="get_active_sprint",
                status=OperationStatus.SUCCESS,
                message=f"Found active sprint ID: {self.sprint_id}",
                details={"sprint_id": self.sprint_id, "sprint_name": sprints[0].get("name")},
            )
        except Exception as e:
            error_msg = f"Failed to get active sprint: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="get_active_sprint",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def _check_existing_sprint(self, jira_key: str) -> Optional[str]:
        """Return the name of the ticket's current active/future sprint, or None."""
        try:
            data = jira_call(
                "jira_get_issue",
                {"issue_key": jira_key, "fields": "customfield_10020"},
            )
            if not data:
                return None
            fields = data.get("fields", {}) if isinstance(data, dict) else {}
            sprints = fields.get("customfield_10020") or []
            for s in sprints:
                if isinstance(s, dict) and s.get("state") in ("active", "future"):
                    return s.get("name", "unknown")
        except Exception as e:
            logger.warning(f"Could not check existing sprint for {jira_key}: {e}")
        return None

    def add_to_sprint(self, jira_key: str) -> OperationResult:
        """
        Add ticket to the active sprint via jira_add_issues_to_sprint.
        Skips if the ticket already belongs to an active or future sprint.

        Args:
            jira_key: JIRA ticket key (e.g., RHCLOUD-12345)

        Returns:
            OperationResult with sprint addition details
        """
        if not self.sprint_id:
            error_msg = "Sprint ID not available. Run get_active_sprint first."
            logger.error(error_msg)
            return OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        existing = self._check_existing_sprint(jira_key)
        if existing:
            msg = f"{jira_key} already in sprint '{existing}' — skipping"
            logger.info(msg)
            return OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.SUCCESS,
                message=msg,
                details={"skipped": True, "existing_sprint": existing},
            )

        logger.info(f"Adding {jira_key} to sprint {self.sprint_id}...")

        if self.dry_run:
            logger.info(f"[DRY RUN] Would add {jira_key} to sprint {self.sprint_id}")
            return OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.SUCCESS,
                message=f"Added {jira_key} to sprint {self.sprint_id} (dry run)",
            )

        try:
            data = jira_call(
                "jira_add_issues_to_sprint",
                {
                    "sprint_id": self.sprint_id,
                    "issue_keys": [jira_key],
                },
            )

            if data is None:
                error_msg = "jira_add_issues_to_sprint returned None"
                logger.error(error_msg)
                return OperationResult(
                    operation="add_to_sprint",
                    status=OperationStatus.FAILED,
                    message=error_msg,
                )

            logger.info(f"Successfully added {jira_key} to sprint {self.sprint_id}")
            return OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.SUCCESS,
                message=f"Added {jira_key} to sprint {self.sprint_id}",
            )
        except Exception as e:
            error_msg = f"Failed to add to sprint: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def task_add(self, jira_key: str) -> OperationResult:
        """
        Track ticket in memory server.

        Args:
            jira_key: JIRA ticket key (e.g., RHCLOUD-12345)

        Returns:
            OperationResult with task tracking details
        """
        logger.info(f"Adding {jira_key} to memory server...")

        task_payload = {
            "external_key": jira_key,
            "status": "in_progress",
            "assigned_to": self.bot_account_id or "unknown",
            "board_id": self.board_id,
            "sprint_id": self.sprint_id,
        }

        if self.dry_run:
            logger.info(f"[DRY RUN] Would POST to memory server: {task_payload}")
            return OperationResult(
                operation="task_add",
                status=OperationStatus.SUCCESS,
                message=f"Added {jira_key} to memory server (dry run)",
            )

        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.post(
                    f"{self.memory_url}/tasks",
                    json=task_payload,
                )
                response.raise_for_status()

                logger.info(f"Successfully added {jira_key} to memory server")
                return OperationResult(
                    operation="task_add",
                    status=OperationStatus.SUCCESS,
                    message=f"Added {jira_key} to memory server",
                )
        except httpx.HTTPStatusError as e:
            error_msg = f"Failed to add task to memory server: HTTP {e.response.status_code}"
            logger.error(error_msg)
            return OperationResult(
                operation="task_add",
                status=OperationStatus.FAILED,
                message=error_msg,
            )
        except Exception as e:
            error_msg = f"Failed to add task to memory server: {str(e)}"
            logger.error(error_msg)
            return OperationResult(
                operation="task_add",
                status=OperationStatus.FAILED,
                message=error_msg,
            )


def execute_claim_ticket_workflow(
    jira_key: str,
    memory_url: Optional[str] = None,
    skip_operations: Optional[List[str]] = None,
    dry_run: bool = False,
) -> WorkflowResult:
    """
    Execute the complete claim ticket workflow.

    Args:
        jira_key: JIRA ticket key (e.g., RHCLOUD-12345)
        memory_url: Memory server URL (optional, defaults to env var)
        skip_operations: List of operation names to skip (optional)
        dry_run: If True, log actions without executing them

    Returns:
        WorkflowResult with success status and operation results
    """
    # Resolve configuration from environment variables
    memory_url = memory_url or os.getenv("BOT_MEMORY_URL")

    # Validate required configuration
    if not memory_url:
        logger.error("Memory server URL not configured (set BOT_MEMORY_URL)")
        return WorkflowResult(
            success=False,
            operations=[
                OperationResult(
                    operation="config_validation",
                    status=OperationStatus.FAILED,
                    message="Memory server URL not configured",
                )
            ],
            jira_key=jira_key,
        )

    skip_operations = skip_operations or []
    operations = ClaimTicketOperations(
        memory_url=memory_url,
        dry_run=dry_run,
    )

    results: List[OperationResult] = []

    # Execute operations in sequence (fail-fast)
    logger.info(f"Starting claim ticket workflow for {jira_key}...")

    # 1. Get bot account ID
    if "get_bot_email" not in skip_operations:
        result = operations.get_bot_email()
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="get_bot_email",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 2. Get transitions
    if "get_transitions" not in skip_operations:
        result = operations.get_transitions(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="get_transitions",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 3. Assign ticket
    if "assign_ticket" not in skip_operations:
        result = operations.assign_ticket(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="assign_ticket",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 4. Transition to In Progress
    if "transition_to_in_progress" not in skip_operations:
        result = operations.transition_to_in_progress(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="transition_to_in_progress",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 5. Resolve board
    if "resolve_board" not in skip_operations:
        result = operations.resolve_board(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="resolve_board",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 6. Get active sprint
    if "get_active_sprint" not in skip_operations:
        result = operations.get_active_sprint()
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="get_active_sprint",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 7. Add to sprint
    if "add_to_sprint" not in skip_operations:
        result = operations.add_to_sprint(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="add_to_sprint",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    # 8. Task add
    if "task_add" not in skip_operations:
        result = operations.task_add(jira_key)
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=results, jira_key=jira_key)
    else:
        results.append(
            OperationResult(
                operation="task_add",
                status=OperationStatus.SKIPPED,
                message="Skipped by user request",
            )
        )

    logger.info(f"Claim ticket workflow completed successfully for {jira_key}")
    return WorkflowResult(success=True, operations=results, jira_key=jira_key)


def main() -> int:
    """CLI entrypoint for claim ticket workflow."""
    parser = argparse.ArgumentParser(description="Execute claim ticket workflow")
    parser.add_argument("jira_key", help="JIRA ticket key (e.g., RHCLOUD-12345)")
    parser.add_argument("--memory-url", help="Memory server URL (default: env var BOT_MEMORY_URL)")
    parser.add_argument(
        "--skip",
        help="Comma-separated list of operations to skip",
        default="",
    )
    parser.add_argument("--dry-run", action="store_true", help="Log actions without executing them")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")

    args = parser.parse_args()

    skip_operations = [op.strip() for op in args.skip.split(",") if op.strip()]

    result = execute_claim_ticket_workflow(
        jira_key=args.jira_key,
        memory_url=args.memory_url,
        skip_operations=skip_operations,
        dry_run=args.dry_run,
    )

    if args.json:
        # Output JSON for programmatic consumption
        output = {
            "success": result.success,
            "jira_key": result.jira_key,
            "operations": [
                {
                    "operation": op.operation,
                    "status": op.status.value,
                    "message": op.message,
                    "details": op.details,
                }
                for op in result.operations
            ],
        }
        print(json.dumps(output, indent=2))
    else:
        # Human-readable output
        print(f"\nClaim ticket workflow for {result.jira_key}:")
        print("=" * 60)
        for op in result.operations:
            if op.status == OperationStatus.SUCCESS:
                status_symbol = "✓"
            elif op.status == OperationStatus.FAILED:
                status_symbol = "✗"
            else:
                status_symbol = "○"
            print(f"{status_symbol} {op.operation}: {op.message}")
        print("=" * 60)
        if result.success:
            print("✓ All operations completed successfully")
        else:
            print("✗ Workflow failed")

    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())

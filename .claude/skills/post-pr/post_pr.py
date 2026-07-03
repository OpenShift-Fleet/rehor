#!/usr/bin/env python3
"""Post-PR bookkeeping: update PR, transition Jira, notify Slack, store learnings.

Usage: python3 .claude/skills/post-pr/post_pr.py <JIRA_KEY> [--dry-run]
"""

import json
import logging
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

# Import the operations module
sys.path.insert(0, str(Path(__file__).resolve().parent))
from scripts.post_pr_operations import execute_post_pr_workflow

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Configure logging
logging.basicConfig(level=logging.INFO, format="[post-pr] %(levelname)s: %(message)s", stream=sys.stdout)
logger = logging.getLogger(__name__)


def normalize_memory_url(url):
    """Normalize memory server URL, stripping /mcp suffix and trailing slashes."""
    if not url:
        return "http://localhost:8080"

    if not isinstance(url, str):
        logger.warning(f"BOT_MEMORY_URL is not a string: {type(url).__name__}, using default")
        return "http://localhost:8080"

    # Strip trailing slashes first
    url = url.rstrip("/")

    # Strip /mcp suffix if present (case-insensitive)
    if url.lower().endswith("/mcp"):
        url = url[:-4]

    # Validate URL has a scheme
    if not url.startswith(("http://", "https://")):
        logger.warning(f"BOT_MEMORY_URL missing scheme: {url}, using default")
        return "http://localhost:8080"

    return url


MEMORY_URL = normalize_memory_url(os.environ.get("BOT_MEMORY_URL"))


def http_request(url, method="GET", body=None, headers=None, timeout=15):
    """Make HTTP request with error handling."""
    hdrs = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        logger.error(f"{method} {url}: HTTP {e.code} - {body_text[:200]}")
        return None
    except urllib.error.URLError as e:
        logger.error(f"{method} {url}: Network error - {e.reason}")
        return None
    except Exception as e:
        logger.error(f"{method} {url}: {type(e).__name__} - {e}")
        return None


def get_task(jira_key):
    """Fetch task from memory server."""
    logger.info(f"Fetching task {jira_key} from memory server")
    try:
        data = http_request(f"{MEMORY_URL}/api/tasks?exclude_status=archived&limit=50")
        if not data:
            logger.error("Failed to fetch tasks from memory server")
            return None
        if "items" not in data:
            logger.error(f"Unexpected response format: {list(data.keys())}")
            return None

        for t in data["items"]:
            if t.get("external_key") == jira_key:
                logger.info(f"Found task {jira_key}")
                return t

        available = [t.get("external_key") for t in data.get("items", [])]
        logger.error(f"Task {jira_key} not found. Available tasks: {available}")
        return None
    except Exception as e:
        logger.error(f"Error fetching task: {type(e).__name__} - {e}")
        return None


def validate_task_data(task):
    """Validate task has required PR data."""
    pr_url = task.get("pr_url")
    pr_number = task.get("pr_number")

    if not pr_url:
        logger.error("Task missing 'pr_url' field")
        return False, "pr_url", pr_url

    if not pr_number:
        logger.error("Task missing 'pr_number' field")
        return False, "pr_number", pr_number

    # Validate PR URL format
    if not isinstance(pr_url, str) or "github.com" not in pr_url:
        logger.error(f"Invalid PR URL format: {pr_url}")
        return False, "pr_url", pr_url

    # Validate PR number is numeric
    try:
        int(pr_number)
    except (ValueError, TypeError):
        logger.error(f"Invalid PR number format: {pr_number}")
        return False, "pr_number", pr_number

    return True, None, None


def main():
    if len(sys.argv) < 2:
        print("Usage: post_pr.py <JIRA_KEY> [--dry-run]", file=sys.stderr)
        sys.exit(1)

    jira_key = sys.argv[1]
    dry_run = "--dry-run" in sys.argv

    if dry_run:
        logger.info(f"DRY RUN mode enabled for {jira_key}")

    logger.info(f"Starting post-PR workflow for {jira_key}")

    # 1. Fetch task from memory server
    task = get_task(jira_key)
    if not task:
        logger.error(f"Cannot proceed: task {jira_key} not found")
        sys.exit(1)

    # 2. Validate task has required PR data
    valid, missing_field, value = validate_task_data(task)
    if not valid:
        logger.error(f"Cannot proceed: task missing or invalid '{missing_field}': {value}")
        logger.info(f"Task data: {json.dumps(task, indent=2)}")
        sys.exit(1)

    # 3. Extract data
    pr_url = task["pr_url"]
    pr_number = task["pr_number"]
    summary = task.get("summary", "")

    logger.info("Task validated successfully")
    logger.info(f"  JIRA: {jira_key}")
    logger.info(f"  PR: {pr_url} (#{pr_number})")
    logger.info(f"  Summary: {summary or '(none)'}")
    print()  # Blank line for readability

    # 4. Execute the workflow
    try:
        logger.info("Executing post-PR workflow...")
        result = execute_post_pr_workflow(
            pr_url=pr_url,
            pr_number=pr_number,
            ticket_id=jira_key,
            summary=summary,
            dry_run=dry_run,
        )
    except Exception as e:
        logger.error(f"Workflow execution failed: {type(e).__name__} - {e}", exc_info=True)
        sys.exit(1)

    # 5. Print results
    print()  # Blank line
    print("=" * 80)
    if result.success:
        logger.info("POST-PR WORKFLOW COMPLETED SUCCESSFULLY")
    else:
        logger.error("POST-PR WORKFLOW FAILED")
    print("=" * 80)

    for op in result.operations:
        status_icon = "[OK]" if op.status.value == "success" else "[FAIL]" if op.status.value == "failed" else "[SKIP]"
        level = (
            logging.INFO
            if op.status.value == "success"
            else logging.WARNING
            if op.status.value == "skipped"
            else logging.ERROR
        )
        logger.log(level, f"{status_icon} {op.operation}: {op.message}")

    print("=" * 80)

    # 6. Exit with appropriate code
    if not result.success:
        logger.error("Workflow failed - see errors above")
        sys.exit(1)

    logger.info("Post-PR workflow complete")
    sys.exit(0)


if __name__ == "__main__":
    main()

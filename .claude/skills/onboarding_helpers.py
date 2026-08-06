"""Shared helpers for onboarding skills — label management, comment posting."""

import json
import sys

from jira_mcp import jira_call

BLOCKED_LABEL = "onboarding:blocked"

WORKFLOW_REQUIRED_FIELDS = {
    "jira-sprint": {
        "required": ["board_name"],
        "optional": ["sprint_prefix"],
    },
    "jira-kanban": {
        "required": ["board_name"],
        "optional": [],
    },
}


def get_missing_workflow_fields(workflow, requirements):
    """Return list of required fields missing for the given workflow."""
    spec = WORKFLOW_REQUIRED_FIELDS.get(workflow, {})
    return [f for f in spec.get("required", []) if not requirements.get(f)]


def post_comment(epic_key, body):
    result = jira_call("jira_add_comment", {"issue_key": epic_key, "body": body})
    if not result:
        print(f"ERROR: Failed to post comment on {epic_key}", file=sys.stderr)
        return False
    print(f"Posted comment on {epic_key}", file=sys.stderr)
    return True


def apply_label(epic_key, new_label):
    result = jira_call("jira_get_issue", {"issue_key": epic_key, "fields": "labels"})
    if not result:
        print(f"WARNING: Could not read labels on {epic_key}", file=sys.stderr)
        return False

    existing = result.get("labels") or result.get("fields", {}).get("labels") or []
    updated = [lbl for lbl in existing if not lbl.startswith("onboarding:") or lbl == BLOCKED_LABEL]
    updated.append(new_label)

    update_result = jira_call(
        "jira_update_issue",
        {"issue_key": epic_key, "fields": json.dumps({"labels": updated})},
    )
    if not update_result:
        print(f"WARNING: Could not apply label {new_label} to {epic_key}", file=sys.stderr)
        return False

    print(f"Applied label {new_label} to {epic_key}", file=sys.stderr)
    return True


def apply_blocked_label(epic_key):
    """Add onboarding:blocked without removing the step label."""
    result = jira_call("jira_get_issue", {"issue_key": epic_key, "fields": "labels"})
    if not result:
        return False

    existing = result.get("labels") or result.get("fields", {}).get("labels") or []
    if BLOCKED_LABEL in existing:
        return True

    updated = [*existing, BLOCKED_LABEL]
    update_result = jira_call(
        "jira_update_issue",
        {"issue_key": epic_key, "fields": json.dumps({"labels": updated})},
    )
    if not update_result:
        print(f"WARNING: Could not apply {BLOCKED_LABEL} to {epic_key}", file=sys.stderr)
        return False

    print(f"Applied {BLOCKED_LABEL} to {epic_key}", file=sys.stderr)
    return True


def remove_blocked_label(epic_key):
    """Remove onboarding:blocked without touching the step label."""
    result = jira_call("jira_get_issue", {"issue_key": epic_key, "fields": "labels"})
    if not result:
        return False

    existing = result.get("labels") or result.get("fields", {}).get("labels") or []
    if BLOCKED_LABEL not in existing:
        return True

    updated = [lbl for lbl in existing if lbl != BLOCKED_LABEL]
    update_result = jira_call(
        "jira_update_issue",
        {"issue_key": epic_key, "fields": json.dumps({"labels": updated})},
    )
    if not update_result:
        print(f"WARNING: Could not remove {BLOCKED_LABEL} from {epic_key}", file=sys.stderr)
        return False

    print(f"Removed {BLOCKED_LABEL} from {epic_key}", file=sys.stderr)
    return True


def sanitize_for_markdown(val):
    """Strip newlines that could inject Markdown structure."""
    return str(val).replace("\n", " ").replace("\r", "")


def update_task_metadata(memory_url, task_id, metadata_updates):
    import httpx

    if not memory_url or not task_id:
        print("WARNING: memory_url or task_id not set, skipping metadata update", file=sys.stderr)
        return False

    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.get(f"{memory_url}/tasks/{task_id}")
            if resp.status_code != 200:
                print(f"WARNING: Could not get task {task_id}", file=sys.stderr)
                return False
            task = resp.json()
            meta = task.get("metadata") or {}
            for key, val in metadata_updates.items():
                if isinstance(val, dict) and isinstance(meta.get(key), dict):
                    meta[key].update(val)
                else:
                    meta[key] = val
            resp = client.patch(
                f"{memory_url}/tasks/{task_id}",
                json={"metadata": meta},
            )
            return resp.status_code == 200
    except Exception as e:
        print(f"WARNING: metadata update failed: {e}", file=sys.stderr)
        return False

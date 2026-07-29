#!/usr/bin/env python3
"""Create 3 phase sub-tickets under an onboarding epic.

Usage:
    python3 create_phase_tickets.py '<json_config>'

Config JSON:
    {"epic_key": "RHCLOUD-123", "project_key": "RHCLOUD", "team_name": "My Team"}

Output: JSON with created ticket keys and applied label.
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_call, jira_cleanup
from onboarding_helpers import apply_label

PHASES = [
    {"key": "phase1", "summary": "[Phase 1] Instance Setup"},
    {"key": "phase2", "summary": "[Phase 2] Konflux CI/CD"},
    {"key": "phase3", "summary": "[Phase 3] Deployment"},
]

INITIAL_LABEL = "onboarding:intake"


def _detect_parent_type(issue_key):
    """Return the issue type name of the parent ticket (e.g. 'Epic', 'Story')."""
    result = jira_call(
        "jira_get_issue",
        {"issue_key": issue_key, "fields": "issuetype"},
    )
    if not result:
        return None
    issuetype = result.get("issuetype") or result.get("fields", {}).get("issuetype")
    if isinstance(issuetype, dict):
        return issuetype.get("name")
    return None


def create_tickets(epic_key, project_key, team_name):
    parent_type = _detect_parent_type(epic_key)
    if parent_type and parent_type.lower() == "epic":
        child_type = "Story"
        link_field = {"epicKey": epic_key}
    else:
        child_type = "Sub-task"
        link_field = {"parent": epic_key}
    print(
        f"Parent {epic_key} is {parent_type or 'unknown'}, using {child_type}",
        file=sys.stderr,
    )

    phase_tickets = {}

    for phase in PHASES:
        summary = f"{phase['summary']} — {team_name}"
        result = jira_call(
            "jira_create_issue",
            {
                "project_key": project_key,
                "summary": summary,
                "issue_type": child_type,
                "additional_fields": json.dumps(link_field),
            },
        )
        if not result:
            print(f"ERROR: Failed to create ticket for {phase['key']}", file=sys.stderr)
            return None

        ticket_key = result.get("key")
        if not ticket_key:
            print(f"ERROR: No key returned for {phase['key']}: {result}", file=sys.stderr)
            return None

        phase_tickets[phase["key"]] = ticket_key
        print(f"Created {phase['key']}: {ticket_key} — {summary}", file=sys.stderr)

    return phase_tickets


def main():
    if len(sys.argv) < 2:
        print("Usage: create_phase_tickets.py '<json_config>'", file=sys.stderr)
        sys.exit(1)

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    epic_key = config.get("epic_key")
    project_key = config.get("project_key")
    team_name = config.get("team_name", "Unknown Team")

    if not epic_key or not project_key:
        print("ERROR: epic_key and project_key are required", file=sys.stderr)
        sys.exit(1)

    try:
        phase_tickets = create_tickets(epic_key, project_key, team_name)
        if not phase_tickets:
            sys.exit(1)

        if not apply_label(epic_key, INITIAL_LABEL):
            print("ERROR: Failed to apply label", file=sys.stderr)
            sys.exit(1)

        output = {
            "epic_key": epic_key,
            "phase_tickets": phase_tickets,
            "label_applied": INITIAL_LABEL,
        }
        print(json.dumps(output, indent=2))
    finally:
        jira_cleanup()


if __name__ == "__main__":
    main()

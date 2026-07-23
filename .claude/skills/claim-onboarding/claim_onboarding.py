#!/usr/bin/env python3
"""Claim an onboarding ticket: assign, transition, create phase tickets, track.

Usage:
    python3 claim_onboarding.py '<json_config>'
"""

import json
import os
import sys

import httpx

_skills_dir = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _skills_dir)
sys.path.insert(0, os.path.join(_skills_dir, "create-phase-tickets"))
from create_phase_tickets import add_label as _add_label  # noqa: E402
from create_phase_tickets import create_tickets  # noqa: E402
from jira_mcp import jira_call, jira_cleanup  # noqa: E402

BOT_JIRA_EMAIL = os.environ.get("BOT_JIRA_EMAIL", "")
BOT_MEMORY_URL = os.environ.get("BOT_MEMORY_URL", "")
BOT_INSTANCE_ID = os.environ.get("BOT_INSTANCE_ID", "")


def _assign(epic_key):
    if not BOT_JIRA_EMAIL:
        print("WARNING: BOT_JIRA_EMAIL not set, skipping assign", file=sys.stderr)
        return False
    result = jira_call(
        "jira_update_issue",
        {"issue_key": epic_key, "fields": json.dumps({"assignee": BOT_JIRA_EMAIL})},
    )
    return bool(result)


def _transition_in_progress(epic_key):
    transitions = jira_call("jira_get_transitions", {"issue_key": epic_key})
    if not transitions:
        return False
    target = None
    for t in transitions.get("transitions", []):
        name = t.get("name", "").lower()
        if name in ("in progress", "in_progress", "start progress"):
            target = t.get("id")
            break
    if not target:
        print("WARNING: No 'In Progress' transition found", file=sys.stderr)
        return False
    result = jira_call(
        "jira_transition_issue",
        {"issue_key": epic_key, "transition_id": str(target)},
    )
    return bool(result)


def _create_task(epic_key, summary, phase_tickets):
    if not BOT_MEMORY_URL:
        print("WARNING: BOT_MEMORY_URL not set, skipping task creation", file=sys.stderr)
        return False

    payload = {
        "external_key": epic_key,
        "status": "in_progress",
        "title": summary,
        "summary": summary,
        "source": "onboarding-jira",
        "assigned_to": BOT_JIRA_EMAIL or BOT_INSTANCE_ID or "unknown",
        "metadata": {
            "phase": 1,
            "step": "intake",
            "epic_key": epic_key,
            "phase_tickets": phase_tickets,
            "requirements": {},
            "konflux": {},
        },
    }
    try:
        with httpx.Client(timeout=30.0) as client:
            resp = client.post(f"{BOT_MEMORY_URL}/tasks", json=payload)
            if resp.status_code in (200, 201):
                print(f"Created memory task for {epic_key}", file=sys.stderr)
                return True
            print(f"WARNING: task creation returned {resp.status_code}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"ERROR: task creation failed: {e}", file=sys.stderr)
        return False


def main():
    if len(sys.argv) < 2:
        print("Usage: claim_onboarding.py '<json_config>'", file=sys.stderr)
        sys.exit(1)

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    epic_key = config.get("epic_key")
    project_key = config.get("project_key")
    team_name = config.get("team_name", "Unknown Team")
    summary = config.get("summary", f"Onboard {team_name}")

    if not epic_key or not project_key:
        print("ERROR: epic_key and project_key are required", file=sys.stderr)
        sys.exit(1)

    try:
        print(f"Claiming {epic_key}...", file=sys.stderr)

        _assign(epic_key)
        _transition_in_progress(epic_key)

        phase_tickets = create_tickets(epic_key, project_key, team_name)
        if not phase_tickets:
            print("ERROR: Failed to create phase tickets", file=sys.stderr)
            sys.exit(1)

        _add_label(epic_key, "onboarding:intake")

        task_ok = _create_task(epic_key, summary, phase_tickets)

        output = {
            "epic_key": epic_key,
            "phase_tickets": phase_tickets,
            "task_created": task_ok,
        }
        print(json.dumps(output, indent=2))
    finally:
        jira_cleanup()


if __name__ == "__main__":
    main()

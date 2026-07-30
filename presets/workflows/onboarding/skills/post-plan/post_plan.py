#!/usr/bin/env python3
"""Post the onboarding plan comment for team approval.

Usage:
    python3 post_plan.py '<json_config>'
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_cleanup
from onboarding_helpers import apply_label, get_missing_workflow_fields, post_comment, sanitize_for_markdown

LABEL = "onboarding:plan-posted"


def _build_comment(config):
    instance_name = sanitize_for_markdown(config.get("instance_name", "?"))
    config_name = sanitize_for_markdown(config.get("config_name", "?"))
    bot_name = sanitize_for_markdown(config.get("bot_name", "?"))
    bot_label = sanitize_for_markdown(config.get("bot_label", "?"))
    workflow = config.get("workflow", "jira-sprint")
    repos = config.get("repos", [])
    envs_and_personas = config.get("envs_and_personas", "auto-detected")
    dedicated_proxy = config.get("dedicated_proxy", False)

    tech_stacks = config.get("tech_stacks", [])
    stack_lines = []
    unsupported_warning = ""
    if isinstance(tech_stacks, dict):
        items = tech_stacks.items()
    else:
        items = [(ts.get("repo", "unknown"), ts) for ts in tech_stacks]
    for repo_name, info in items:
        if isinstance(info, dict):
            stack = ", ".join(info.get("stack", []))
            stack_lines.append(f"  - **{repo_name}**: {stack}")
            if info.get("unsupported_stacks"):
                unsupported = ", ".join(info["unsupported_stacks"])
                unsupported_warning += (
                    f"\n> **Note**: {repo_name} uses {unsupported} which is not yet "
                    f"supported by Rehor. The Rehor team has been notified and will "
                    f"follow up with env preset support.\n"
                )
        else:
            stack_lines.append(f"  - **{repo_name}**: {info}")
    stacks_str = "\n".join(stack_lines) if stack_lines else "  (none detected)"

    def _fmt_repo(r):
        if isinstance(r, dict):
            name = sanitize_for_markdown(r.get("name", "?"))
            url = sanitize_for_markdown(r.get("url", ""))
            return f"  - [{name}]({url})"
        return f"  - {sanitize_for_markdown(r)}"

    repo_list = "\n".join(_fmt_repo(r) for r in repos) if repos else "  (none)"

    requirements = config.get("requirements", config)
    missing = get_missing_workflow_fields(workflow, requirements)
    missing_warning = ""
    if missing:
        fields = ", ".join(f"`{f}`" for f in missing)
        missing_warning = (
            f"\n> **Action needed**: Your `{workflow}` workflow requires "
            f"{fields} — please provide "
            f"{'it' if len(missing) == 1 else 'them'} before approving.\n\n"
        )

    return f"""\
## [Phase 1/3] Instance Setup — Onboarding Plan

Based on our conversation, here's the plan:

### Instance Configuration
- **Instance name**: {instance_name}
- **Config name**: {config_name}
- **Bot name**: {bot_name}
- **Bot label**: {bot_label}
- **Workflow**: {workflow}
- **Target repos**:
{repo_list}
- **Detected stacks**:
{stacks_str}
- **Suggested presets**: {envs_and_personas}
- **Infrastructure**: {
        "dedicated — own proxy, memory server, and bot accounts"
        if dedicated_proxy
        else "shared — uses shared proxy, memory server, and bot accounts"
    }
{unsupported_warning}
### What I'll automate
- Phase 1: Generate scaffolding files, open PR on your instance repo
- Phase 2: Open Konflux MR for CI/CD registration
- Phase 3: Open app-interface MR for deployment

### What you'll need to do
- Phase 1: Create the GitHub repo, grant bot access, merge scaffolding PR
- Phase 2: Merge Konflux MR, generate Tekton pipelines from UI, verify Quay image
- Phase 3: Merge app-interface MR, verify deployment
{
        '''
### Dedicated infrastructure — additional requirements
- **GCP project** — you'll need your own GCP project with Vertex AI API enabled (for billing separation)
- **Dedicated proxy** — create a ticket in the **REHOR** Jira project so the Rehor team can collaborate on setup
- **Bot accounts** — your team must provide GitHub/GitLab bot accounts (shared defaults will not be used)
- **Memory server** — stays shared by default (no action needed unless your agent handles sensitive data)
- **App-interface service tree** — work with app-sre to set up your service tree before Phase 3
'''
        if dedicated_proxy
        else ""
    }{missing_warning}\
**Does this look good?** Reply "approved" or let me know what to change.
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: post_plan.py '<json_config>'", file=sys.stderr)
        sys.exit(1)

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    epic_key = config.get("epic_key")
    if not epic_key:
        print("ERROR: epic_key is required", file=sys.stderr)
        sys.exit(1)

    try:
        comment = _build_comment(config)
        ok = post_comment(epic_key, comment)
        if not ok:
            sys.exit(1)

        if not apply_label(epic_key, LABEL):
            sys.exit(1)

        print(json.dumps({"epic_key": epic_key, "label": LABEL, "posted": True}))
    finally:
        jira_cleanup()


if __name__ == "__main__":
    main()

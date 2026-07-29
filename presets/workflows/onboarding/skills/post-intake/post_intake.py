#!/usr/bin/env python3
"""Post Phase 1 intake questions on the onboarding epic.

Usage:
    python3 post_intake.py '<json_config>'
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_cleanup
from onboarding_helpers import apply_label, post_comment

LABEL = "onboarding:requirements-gathering"

COMMENT = """\
## [Phase 1/3] Instance Setup — Getting Started

Welcome! I'll be helping you set up your Rehor bot instance. This is a 3-phase process:

1. **Instance Setup** (we're here) — configure and scaffold your bot repo
2. **Konflux CI/CD** — register with Konflux and build your container image
3. **Deployment** — deploy via app-interface and verify

To get started, I need some details about your instance:

### Required
- **Instance name** — pick something memorable! This becomes your repo name \
(`<name>-agent-dev`), bot label, and identity. Examples: *phoenix*, *herald*, \
*ziggy*, *arclight*. Doesn't have to be your team name.
- **Team name** — your team's display name (for docs and Jira comments)
- **GitHub org** — the org that will own your instance repo (e.g., `RedHatInsights`, `project-kessel`)
- **Target repo URL(s)** — the repo(s) your bot will work on (GitHub and/or GitLab)
- **Jira project key** — the project your bot will pick up tickets from
- **Infrastructure: shared or dedicated?** — most teams use the shared Rehor infrastructure: \
shared proxy, bot accounts, namespace, GCP project, and memory server. This \
works across orgs (e.g., `RedHatInsights`, `project-kessel`). You only need **dedicated \
infrastructure** if your team needs a separate GCP project (typically for billing separation) \
or separate Jira/GitHub/GitLab credentials. Dedicated means your own GCP project, proxy, \
and bot accounts — but the memory server stays shared unless your agent handles sensitive \
data. Let us know so we can plan accordingly. (Default: shared)

### Optional (defaults applied if not specified)
- Workflow type — default: `jira-sprint` (also available: `jira-kanban`)
- Default branch — default: `main` (let us know if your org uses `master` or another branch)
- KEDA schedule — default: weekdays 9am–6pm ET
- Fork accounts — default: `platex-rehor-bot` (GitHub), \
`platform-experience-services-bot` (GitLab). Dedicated infrastructure teams must provide \
their own bot accounts.
- Slack notifications — provide a Slack webhook URL if you want the bot to post status updates to a channel

### Workflow-specific (required based on your workflow choice)
- **If using `jira-sprint`** (default): Board name and sprint prefix (e.g., `My Board`, `SPRINT-`)
- **If using `jira-kanban`**: Board ID and Jira project key for the kanban board

### Heads up for Phase 2 & 3
These aren't needed yet, but good to start thinking about:
- **Konflux tenant** — do you have an existing Konflux tenant namespace, or will we create one?
- **GCP project** — a GCP project with Vertex AI API enabled is required for deployment. \
If you're using shared infrastructure, the existing project covers you. \
If dedicated, you'll need your own — start the request early if needed.
- **Dedicated proxy** — dedicated infrastructure requires a dedicated proxy deployment for your \
credentials. Create a ticket in the **REHOR** Jira project so the Rehor team can collaborate \
on setup — this adds lead time, so start early.

Please provide these details and I'll put together an onboarding plan for your approval.
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: post_intake.py '<json_config>'", file=sys.stderr)
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
        ok = post_comment(epic_key, COMMENT)
        if not ok:
            sys.exit(1)

        if not apply_label(epic_key, LABEL):
            sys.exit(1)

        print(json.dumps({"epic_key": epic_key, "label": LABEL, "posted": True}))
    finally:
        jira_cleanup()


if __name__ == "__main__":
    main()

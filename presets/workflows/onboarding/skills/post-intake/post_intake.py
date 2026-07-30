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

I've created sub-tickets for each phase in this issue so you can track progress as we go.

To get started, I need some details about your instance:

### Required
- **Repo name** — name for your instance GitHub repo and Konflux application/component \
(e.g., `hcc-framework-agent-dev`). Convention: `<team-or-project>-agent-dev`.
- **GitHub org** — the org that will own your instance repo (e.g., `RedHatInsights`)
- **Target repo URL(s)** — the repo(s) your bot will work on (GitHub and/or GitLab)
- **Team name** — your team's display name, used in docs and Jira comments \
(e.g., *HCC Framework*)
- **Bot identity** — a fun, human-readable name for your bot (used as `BOT_INSTANCE_ID` \
in the memory server). Examples: *Řehoř Hrubý z Jelení*, *Phoenix*, *Arclight*. \
Doesn't have to be your team name — get creative!
- **Jira project key** — the project your bot will pick up tickets from
- **Infrastructure: shared or dedicated?** — see FAQ below. (Default: shared)

### Required — Workflow-specific
- **Board name or ID** (required for `jira-sprint` and `jira-kanban`) — the Jira board \
the bot will work from (e.g., `My Board` or board ID `123`)

### Optional (defaults applied if not specified)
- Workflow type — default: `jira-sprint` (also available: `jira-kanban`)
- Default branch — default branch of your instance repo: `main` \
(let us know if your org uses `master` or another branch)
- KEDA schedule — default: weekdays 9am–6pm ET. See FAQ below.
- Fork accounts — default: `platex-rehor-bot` (GitHub), \
`platform-experience-services-bot` (GitLab). See FAQ below.
- Slack notifications — provide a Slack webhook URL if you want the bot to post status updates to a channel

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

---

### FAQ

**Shared vs. dedicated infrastructure?**
Most teams use the shared Rehor infrastructure: shared proxy, bot accounts, namespace, \
GCP project, and memory server. This works across orgs. \
You only need **dedicated infrastructure** if your team needs a separate \
GCP project (typically for billing separation) or separate Jira/GitHub/GitLab credentials. \
Dedicated means your own GCP project, proxy, and bot accounts — but the memory server \
stays shared unless your agent handles sensitive data.

**What's the difference between repo name and bot identity?**
The **repo name** (e.g., `hcc-framework-agent-dev`) is the name of your instance GitHub repo \
and Konflux application/component — it's used everywhere in infrastructure. \
The **bot identity** (e.g., *Řehoř Hrubý z Jelení*) is a fun, human-readable name set as \
`BOT_INSTANCE_ID` — it's how the bot identifies itself in the memory server and task system. \
They serve different purposes and are set independently.

**What are fork accounts and why does the bot need them?**
The bot opens pull requests on your target repos by pushing branches from a fork. \
The fork accounts (`platex-rehor-bot` for GitHub, `platform-experience-services-bot` for \
GitLab) are shared bot accounts that already have access to most orgs. Ensure they have \
appropriate access to your org and repos — the bot will attempt to auto-fork. If you're using \
dedicated infrastructure, you'll need to provide your own bot accounts with fork access \
to your repos.

**What is the KEDA schedule?**
KEDA (Kubernetes Event-Driven Autoscaling) controls when your bot runs. By default, \
the bot scales up on weekdays 9am–6pm ET and scales to zero outside that window. \
This saves resources when your team isn't working. You can customize the schedule \
to match the hours your team is active, including across geographies.

**Can we change these settings later?**
Yes — nothing here is permanent. Settings like workflow type, KEDA schedule, Slack \
notifications, and board configuration can all be updated after onboarding. We actively \
encourage teams to explore new workflows, skills, and configurations as your needs evolve.
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

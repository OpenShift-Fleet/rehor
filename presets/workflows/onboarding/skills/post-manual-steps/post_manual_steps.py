#!/usr/bin/env python3
"""Post final manual steps checklist.

Usage:
    python3 post_manual_steps.py '<json_config>'
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_cleanup
from onboarding_helpers import apply_label, post_comment

LABEL = "onboarding:manual-steps"


def _build_comment(config):
    bot_label = config.get("bot_label", "<bot_label>")
    bot_name = config.get("bot_name", "<bot_name>")
    workflow = config.get("workflow", "jira-sprint")
    dedicated_proxy = config.get("dedicated_proxy", False)

    credentials_step = (
        "\n- [ ] **Credentials** — your team is using a dedicated proxy. "
        "Coordinate with the Rehor team to configure your proxy deployment "
        "with the correct Jira/GitHub/GitLab credentials."
        if dedicated_proxy
        else ""
    )

    if workflow == "jira-sprint":
        test_step = (
            f"- [ ] **Test the bot** — pick a Jira ticket in an **active sprint** "
            f"(not a future one) and:\n"
            f"  - Add the label `{bot_label}`\n"
            f"  - Add a label `repo:<repo_name>` matching an entry in your `project-repos.json`\n"
            f"  - Make sure **no one is assigned** to the ticket — the bot skips assigned tickets"
        )
    else:
        test_step = (
            f"- [ ] **Test the bot** — pick a Jira ticket and:\n"
            f"  - Add the label `{bot_label}`\n"
            f"  - Add a label `repo:<repo_name>` matching an entry in your `project-repos.json`\n"
            f"  - Make sure **no one is assigned** to the ticket — the bot skips assigned tickets"
        )

    return f"""\
## [Phase 3/3] Deployment — Final Steps

The deployment MR is merged. Almost there! A few manual steps remain:

- [ ] **Verify deployment** — confirm the `{bot_name}` deployment shows up on the target cluster in the namespace\
{credentials_step}
{test_step}

Reply here once verified and I'll close out the epic. Welcome to Rehor!

### What's next?
- **Docs** — check out the [Rehor docs](https://github.com/OpenShift-Fleet/rehor/tree/master/docs) \
for future roadmap, how to add custom workflows, and more!
- **Feedback** — the Rehor team is always looking for feedback and suggestions. \
Please create tickets in the **REHOR** Jira project documenting your experience \
and any ideas for improvement!
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: post_manual_steps.py '<json_config>'", file=sys.stderr)
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

#!/usr/bin/env python3
"""Post Tekton pipeline generation instructions.

Usage:
    python3 post_konflux_instructions.py '<json_config>'
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_cleanup
from onboarding_helpers import apply_label, post_comment

LABEL = "onboarding:tekton-setup"


def _build_comment(config):
    instance_name = config.get("instance_name", "<instance_name>")
    quay_org = config.get("quay_org", "<quay_org>")
    tenant = config.get("tenant", "<tenant>")

    return f"""\
## [Phase 2/3] Konflux CI/CD — Action Required: Generate Tekton Pipelines

The Konflux Component is registered. Now generate the CI pipeline files:

- [ ] **Install the Konflux GitHub app** on your instance repo: \
[red-hat-konflux](https://github.com/apps/red-hat-konflux) — configure it to have access \
to your repo. A GitHub **org admin** may need to approve or install this. \
Required before Tekton pipelines can trigger.
- [ ] **Navigate to your component** in the Konflux UI: \
go to your cluster's Konflux console → `ns/{tenant}/applications/{instance_name}/components`
- [ ] **Trigger pipeline generation** — use "Send PR" to create a PR on your instance repo \
with `.tekton/` pipeline files. If "Send PR" fails, common causes: the Konflux GitHub app \
isn't installed on the repo (see step above), or commit signing requirements. \
Workaround: [Konflux Pipeline Setup Guide]\
(https://docs.google.com/document/d/1c_UraNynI6h-K5ap1ORfO2Lvs0YsE9QFtBw82jZYr6E/edit?usp=sharing)
- [ ] **Merge the pipeline PR**
- [ ] **Verify the initial build** — after merge, the Tekton push pipeline should trigger automatically
- [ ] **Confirm Quay image** — verify the image appears at \
`quay.io/redhat-services-prod/{quay_org}/{instance_name}`

Reply here once the pipelines are merged and the Quay image is available, and we'll move to Phase 3: Deployment.
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: post_konflux_instructions.py '<json_config>'", file=sys.stderr)
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

#!/usr/bin/env python3
"""Post Phase 2 Konflux info gathering questions.

Usage:
    python3 post_konflux_questions.py '<json_config>'
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from jira_mcp import jira_cleanup
from onboarding_helpers import apply_label, post_comment

LABEL = "onboarding:konflux-info"


def _build_comment(config):
    team_name = config.get("team_name", "your team")
    instance_name = config.get("instance_name", "<instance_name>")
    return f"""\
## [Phase 2/3] Konflux CI/CD — Getting Started

Phase 1 is complete! Now let's set up Konflux CI/CD for your instance.

Do you have an existing Konflux tenant, or should I create a new one? \
Fill in **one** of the two sections below.

---

### Existing tenant — adding a component

**Required**
- **Tenant name** — your existing tenant namespace

**Optional** (defaults applied if not specified)
- Quay org — default: same as tenant name. \
Determines your image URL: `quay.io/redhat-services-prod/<quay_org>/{instance_name}`

- Cluster — auto-detected from your existing tenant. If your tenant spans multiple clusters, specify which one to use.

---

### New tenant — full setup

**Required**
- **Admin usernames** — SSO/Kerberos usernames for namespace admin RBAC access (e.g., `jdoe`). \
Admins will also be set as maintainers and codeowners initially. \
You can update these roles separately in the MR if needed.
- **Cost center** — your team's cost center

**Optional** (defaults applied if not specified)
- Tenant name — default: `<derived from {team_name}>`
- Cluster — default: `kflux-prd-rh02`
- Quay org — default: same as tenant name. \
Determines your image URL: `quay.io/redhat-services-prod/<quay_org>/{instance_name}`
- Quota tier — default: `1.small` (options: `0.base` through `6.xxxlarge`)
- Dockerfile — default: `dev-bot/Dockerfile.runner`
"""


def main():
    if len(sys.argv) < 2:
        print("Usage: post_konflux_questions.py '<json_config>'", file=sys.stderr)
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

#!/usr/bin/env python3
"""Seed the memory database with historical data from the bot's PoC work."""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

import asyncpg
from pgvector.asyncpg import register_vector


async def main():
    url = os.environ.get(
        "DATABASE_URL", "postgresql://bot:bot@localhost:5433/bot_memory"
    )
    conn = await asyncpg.connect(url)

    # Run schema and register vector type
    schema = (Path(__file__).parent / "src" / "schema.sql").read_text()
    await conn.execute(schema)
    await register_vector(conn)

    # --- Seed tasks from open-prs.json ---
    json_path = Path(__file__).parent.parent / "state" / "open-prs.json"
    if json_path.exists():
        prs = json.loads(json_path.read_text())
        for pr in prs:
            jira_key = pr["jira"]
            existing = await conn.fetchrow(
                "SELECT id FROM tasks WHERE jira_key = $1", jira_key
            )
            if existing:
                print(f"  Task {jira_key} already exists, skipping")
                continue

            status = "paused" if pr.get("paused") else "pr_open"
            await conn.execute(
                """
                INSERT INTO tasks (jira_key, status, repo, branch, pr_number, created_at, last_addressed, paused_reason)
                VALUES ($1, $2::task_status, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8)
                """,
                jira_key,
                status,
                pr.get("repo"),
                pr.get("branch"),
                pr.get("pr"),
                datetime.fromisoformat(
                    pr.get("created", "2026-03-19T00:00:00Z").replace("Z", "+00:00")
                ),
                datetime.fromisoformat(
                    pr.get("lastAddressed", "2026-03-19T00:00:00Z").replace(
                        "Z", "+00:00"
                    )
                ),
                pr.get("paused"),
            )
            print(f"  Task: {jira_key} ({status}, PR #{pr.get('pr')})")

    # --- Seed completed tasks from report ---
    completed_tasks = [
        {
            "jira_key": "RHCLOUD-46165",
            "repo": "widget-layout",
            "branch": "bot/RHCLOUD-46165",
            "status": "done",
            "created": "2026-03-19T00:00:00+00:00",
            "title": "Upgrade frontend-components-notifications for alert fix",
            "summary": "Bumped @redhat-cloud-services/frontend-components-notifications to fix danger alert variant in notification banner. Package version bump only, no code changes.",
        },
        {
            "jira_key": "RHCLOUD-46011",
            "repo": "astro-virtual-assistant-frontend",
            "branch": "bot/RHCLOUD-46011",
            "status": "done",
            "pr_number": 368,
            "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-frontend/pull/368",
            "created": "2026-03-19T15:31:00+00:00",
            "title": "Move VA to top of assistant dropdown",
            "summary": "PR merged. Reordered addHook calls in useAsyncManagers so VA is registered first, making it appear at the top of the Chameleon dropdown.",
        },
        {
            "jira_key": "RHCLOUD-37880",
            "repo": "notifications-frontend",
            "branch": "bot/RHCLOUD-37880",
            "status": "done",
            "pr_number": 878,
            "pr_url": "https://github.com/RedHatInsights/notifications-frontend/pull/878",
            "created": "2026-03-26T10:00:00+00:00",
            "title": "Fix bulk select text truncation in notification drawer",
            "summary": "PR merged. Added flex-shrink: 0 CSS fix for PF6 notification drawer bulk select menu toggle. Prevents '50 selected' count text from being truncated.",
        },
        {
            "jira_key": "RHCLOUD-43838",
            "repo": "payload-tracker-frontend",
            "branch": None,
            "status": "done",
            "created": "2026-03-20T00:00:00+00:00",
            "title": "CVE: node-forge vulnerability in payload-tracker",
            "summary": "Closed as already fixed. Ran npm ls and npm audit — node-forge vulnerability was already patched via transitive dependency update.",
        },
        {
            "jira_key": "RHCLOUD-44642",
            "repo": "pdf-generator",
            "branch": None,
            "status": "done",
            "created": "2026-03-20T00:00:00+00:00",
            "title": "CVE: node-tar vulnerability in pdf-generator",
            "summary": "Closed as already fixed. The node-tar vulnerability was already resolved in the existing lockfile.",
        },
        {
            "jira_key": "RHCLOUD-44644",
            "repo": "payload-tracker-frontend",
            "branch": "bot/RHCLOUD-44644",
            "status": "done",
            "created": "2026-03-20T00:00:00+00:00",
            "title": "CVE-2026-24842: node-tar lockfile update",
            "summary": "Fixed via npm lockfile update. Ran npm update node-tar, verified with npm audit, committed updated package-lock.json.",
        },
        {
            "jira_key": "RHCLOUD-45698",
            "repo": "chrome-service-backend",
            "branch": None,
            "status": "done",
            "created": "2026-03-21T00:00:00+00:00",
            "title": "Add grype scanning to chrome-service-backend",
            "summary": "Closed as already implemented. Grype scanning workflow was already present in the repo.",
        },
        {
            "jira_key": "RHCLOUD-46251",
            "repo": "learning-resources",
            "branch": "bot/RHCLOUD-46251",
            "status": "pr_open",
            "pr_number": 279,
            "pr_url": "https://github.com/RedHatInsights/learning-resources/pull/279",
            "created": "2026-03-26T00:00:00+00:00",
            "title": "Fix flaky Playwright e2e test counts",
            "summary": "PR closed by reviewer. Hardcoded baseline counts in Playwright tests broke when backend seeding changed. Reviewer said to address tolerances in a separate PR.",
        },
    ]

    for t in completed_tasks:
        existing = await conn.fetchrow(
            "SELECT id FROM tasks WHERE jira_key = $1", t["jira_key"]
        )
        if existing:
            print(f"  Task {t['jira_key']} already exists, skipping")
            continue
        await conn.execute(
            """
            INSERT INTO tasks (jira_key, status, repo, branch, pr_number, pr_url, title, summary, created_at, last_addressed)
            VALUES ($1, $2::task_status, $3, $4, $5, $6, $7, $8, $9, $9)
            """,
            t["jira_key"],
            t["status"],
            t["repo"],
            t.get("branch"),
            t.get("pr_number"),
            t.get("pr_url"),
            t.get("title"),
            t.get("summary"),
            datetime.fromisoformat(t["created"]),
        )
        print(f"  Task: {t['jira_key']} ({t['status']})")

    # --- Seed memories ---
    # Load embedding model
    from src.embeddings import embed

    memories = [
        # Learnings from completed tickets
        {
            "category": "learning",
            "title": "PF6 SelectOption requires children for labels",
            "content": "PatternFly v6 SelectOption no longer auto-renders labels from the value prop. Must pass label text as children explicitly: <SelectOption value={v}>{labels[v]}</SelectOption>. This was the root cause of RHCLOUD-44667 where timespan dropdown labels appeared empty.",
            "repo": "notifications-frontend",
            "jira_key": "RHCLOUD-44667",
            "tags": ["bug-fix", "patternfly", "ui-change", "pf6-migration"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/notifications-frontend/pull/883"
            },
        },
        {
            "category": "learning",
            "title": "PF6 flex-shrink needed for notification drawer bulk select",
            "content": "In PF6 notification drawer, the bulk select menu toggle needs flex-shrink: 0 on .pf-v6-c-notification-drawer__header-action > .pf-v6-c-menu-toggle to prevent the '50 selected' count text from being truncated. The old .ins-c-bulk-select class no longer exists in PF6.",
            "repo": "notifications-frontend",
            "jira_key": "RHCLOUD-37880",
            "tags": ["bug-fix", "css", "patternfly", "pf6-migration"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/notifications-frontend/pull/878"
            },
        },
        {
            "category": "learning",
            "title": "Hook registration order determines dropdown item order",
            "content": "In astro-virtual-assistant-frontend, the order of addHook() calls in useAsyncManagers determines the order of items in the Chameleon assistant dropdown. To move VA to the first position, the VA hook must be registered before ARH and RHEL hooks.",
            "repo": "astro-virtual-assistant-frontend",
            "jira_key": "RHCLOUD-46011",
            "tags": ["feature", "ui-change"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-frontend/pull/368"
            },
        },
        {
            "category": "learning",
            "title": "CVE triage: check npm ls before attempting fix",
            "content": "Before fixing a CVE, always run 'npm ls <package>' to trace the dependency through the tree. For RHCLOUD-43838, node-forge was a transitive dep of selfsigned. Running npm update and npm audit confirmed the vulnerability was already patched. This saved unnecessary work.",
            "repo": "payload-tracker-frontend",
            "jira_key": "RHCLOUD-43838",
            "tags": ["cve", "dependency-upgrade", "triage"],
        },
        {
            "category": "learning",
            "title": "CVE lockfile-only fix via npm update",
            "content": "For CVE-2026-24842 (node-tar), the fix was a simple npm lockfile update. Run 'npm update node-tar' to bump the transitive dependency, verify with 'npm audit', and commit the updated package-lock.json. No code changes needed.",
            "repo": "payload-tracker-frontend",
            "jira_key": "RHCLOUD-44644",
            "tags": ["cve", "dependency-upgrade"],
        },
        {
            "category": "learning",
            "title": "Grype scanning workflow: adapt from reference implementation",
            "content": "When adding grype scanning GitHub Actions, fetch the reusable workflow from platform-security-gh-workflow repo and study how chrome-service-backend implements it. Then adapt the pattern for the target repo's language and Dockerfile structure. For Python repos with multiple Dockerfiles, each needs a separate scan job.",
            "repo": "astro-virtual-assistant-v2",
            "jira_key": "RHCLOUD-45699",
            "tags": ["ci", "security", "github-actions"],
        },
        {
            "category": "learning",
            "title": "Always verify existing state before implementing",
            "content": "For both RHCLOUD-43838 (CVE node-forge), RHCLOUD-44642 (CVE node-tar in pdf-generator), and RHCLOUD-45698 (grype scanning in chrome-service), the fix was already in place. Always check current state before starting work — run npm audit, check if workflows already exist, verify package versions. Closing as already-fixed saves significant time.",
            "tags": ["triage", "cve", "ci"],
        },
        # Review feedback learnings
        {
            "category": "review_feedback",
            "title": "CSS selectors must match actual PF6 class names",
            "content": "Reviewer (karelhala) caught that .ins-c-bulk-select class doesn't exist in PF6. The bot initially used an incorrect selector. Always inspect the actual rendered DOM to find the correct PF6 class names. Use browser DevTools or snapshot tools to verify selectors before submitting.",
            "repo": "notifications-frontend",
            "jira_key": "RHCLOUD-37880",
            "tags": ["review-feedback", "css", "patternfly"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/notifications-frontend/pull/878"
            },
        },
        {
            "category": "review_feedback",
            "title": "Floating button must be explicitly round with width/height",
            "content": "Reviewer (Hyperkid123) caught that the floating VA button was not round after icon swap. Fix: set explicit width: 52px and height: 52px on the badge button with border-radius: 50%. Don't rely on padding alone for circular buttons — use fixed dimensions.",
            "repo": "astro-virtual-assistant-frontend",
            "jira_key": "RHCLOUD-44597",
            "tags": ["review-feedback", "css", "ui-change"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-frontend/pull/371"
            },
        },
        {
            "category": "review_feedback",
            "title": "Icon centering needs flexbox, not just padding",
            "content": "Reviewer (karelhala) caught that the icon in the floating button was not centered after making it round. Fix: use display: flex, align-items: center, justify-content: center on the button, and set the icon to fixed 32x32px size inside the 52px circle.",
            "repo": "astro-virtual-assistant-frontend",
            "jira_key": "RHCLOUD-44597",
            "tags": ["review-feedback", "css", "ui-change"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-frontend/pull/371"
            },
        },
        {
            "category": "review_feedback",
            "title": "UX team may pause work pending design review",
            "content": "After implementing the VA robot icon swap (RHCLOUD-44597), UX team decided to reconsider the design. PR #371 was moved to draft. When implementing visual/design changes, be aware that UX stakeholders may want to re-evaluate. The bot correctly paused work when told to by Hyperkid123.",
            "repo": "astro-virtual-assistant-frontend",
            "jira_key": "RHCLOUD-44597",
            "tags": ["review-feedback", "process", "ux"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-frontend/pull/371"
            },
        },
        # Codebase patterns
        {
            "category": "codebase_pattern",
            "title": "notifications-frontend: EventLog date filter structure",
            "content": "EventLogDateFilter.tsx in notifications-frontend uses a labels map (DateFilterLabel enum values → display strings) and renders SelectOption components for each. The component is at src/components/Notifications/EventLog/EventLogDateFilter.tsx. Tests are in the same directory.",
            "repo": "notifications-frontend",
            "tags": ["component-structure", "patternfly"],
        },
        {
            "category": "codebase_pattern",
            "title": "astro-virtual-assistant-frontend: icon asset conventions",
            "content": "SVG icons in astro-virtual-assistant-frontend are stored in src/assets/ and imported directly in component files. The convention is rh-icon-ai-chatbot-happy-{color}.svg naming. Components reference these via ESM imports. UniversalBadge, UniversalHeader, UniversalMessages, VAMessageEntry, and ARHMessageEntry all use bot avatar icons.",
            "repo": "astro-virtual-assistant-frontend",
            "tags": ["component-structure", "assets", "ui-change"],
        },
        {
            "category": "codebase_pattern",
            "title": "notifications-frontend: App.scss for global PF overrides",
            "content": "Global PatternFly CSS overrides in notifications-frontend go in src/app/App.scss. This is where the notification drawer bulk select fix was applied. Use PF6 class selectors like .pf-v6-c-notification-drawer__header-action.",
            "repo": "notifications-frontend",
            "tags": ["css", "patternfly", "component-structure"],
        },
        {
            "category": "codebase_pattern",
            "title": "CI: pre-existing failures check pattern",
            "content": "When PR CI checks fail, always check if the same checks also fail on the default branch (main/master). If they do, the failure is pre-existing and not caused by the PR. Use 'gh pr checks <number>' on the PR and compare with the default branch. This prevents wasted effort fixing CI issues outside the PR's scope.",
            "tags": ["ci", "process"],
        },
        # Additional learnings from remaining tickets
        {
            "category": "learning",
            "title": "widget-layout: upgrade frontend-components-notifications for alert fix",
            "content": "RHCLOUD-46165 required upgrading @redhat-cloud-services/frontend-components-notifications to fix the danger alert variant in the notification banner. The fix was a package version bump, not a code change. Always check if the issue is in a dependency before modifying application code.",
            "repo": "widget-layout",
            "jira_key": "RHCLOUD-46165",
            "tags": ["bug-fix", "dependency-upgrade", "patternfly"],
        },
        {
            "category": "learning",
            "title": "Playwright e2e tests: avoid hardcoded counts from backend seeding",
            "content": "RHCLOUD-46251 in learning-resources: Playwright tests had hardcoded baseline counts (98 resources, 13 for Observability filter) that broke when backend seeding changed. Reviewer (Hyperkid123) said the PR could be closed since there were no net code changes after restoring tolerances. Lesson: hardcoded counts in e2e tests are fragile; use count > 0 or tolerance ranges instead. But also respect reviewer decisions — if they say close, close.",
            "repo": "learning-resources",
            "jira_key": "RHCLOUD-46251",
            "tags": ["testing", "e2e", "playwright"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/learning-resources/pull/279"
            },
        },
        {
            "category": "review_feedback",
            "title": "Reviewer may close PR if approach is wrong",
            "content": "On RHCLOUD-46251 (learning-resources), reviewer Hyperkid123 said 'Since there are no code changes, I think this PR can be closed. We can address the tolerances in a different PR.' The bot correctly closed the PR per reviewer feedback. When a reviewer says to close/abandon, respect it — don't push back or try alternative approaches.",
            "repo": "learning-resources",
            "jira_key": "RHCLOUD-46251",
            "tags": ["review-feedback", "process"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/learning-resources/pull/279"
            },
        },
        {
            "category": "review_feedback",
            "title": "Don't pin reusable GitHub Action workflows to SHA",
            "content": "On RHCLOUD-45699 (grype scanning), sourcery-ai bot suggested pinning the reusable workflow to a specific SHA. Reviewer Hyperkid123 corrected this: 'we do not want to pin the workflow, we want to receive the latest version as it may include updates to the workflow and security DB.' For security scanning workflows, always use @master/@main to get latest signatures.",
            "repo": "astro-virtual-assistant-v2",
            "jira_key": "RHCLOUD-45699",
            "tags": ["review-feedback", "ci", "security", "github-actions"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-v2/pull/150"
            },
        },
        {
            "category": "review_feedback",
            "title": "Run security scan workflow on PRs too, not just push",
            "content": "On RHCLOUD-45699, reviewer Hyperkid123 noted 'we do want to run the workflow even for PRs'. The grype scanning workflow should trigger on both push to main/master AND pull_request events. This catches vulnerabilities before merge.",
            "repo": "astro-virtual-assistant-v2",
            "jira_key": "RHCLOUD-45699",
            "tags": ["review-feedback", "ci", "security", "github-actions"],
            "metadata": {
                "pr_url": "https://github.com/RedHatInsights/astro-virtual-assistant-v2/pull/150"
            },
        },
        {
            "category": "codebase_pattern",
            "title": "astro-virtual-assistant-v2: multiple Dockerfiles need separate scan jobs",
            "content": "astro-virtual-assistant-v2 has multiple Dockerfiles: Dockerfile.virtual-assistant and Dockerfile.watson-extension. When adding grype scanning, each Dockerfile needs its own scan job in the GitHub Actions workflow. The reusable workflow from platform-security-gh-workflow accepts a dockerfile input parameter.",
            "repo": "astro-virtual-assistant-v2",
            "tags": ["ci", "security", "github-actions", "component-structure"],
        },
        {
            "category": "codebase_pattern",
            "title": "widget-layout: frontend notification component dependency",
            "content": "widget-layout uses @redhat-cloud-services/frontend-components-notifications for toast/alert notifications. Issues with alert variants (danger, warning, etc.) may come from this package rather than the app code. Check the package version and changelog first.",
            "repo": "widget-layout",
            "tags": ["dependency-upgrade", "component-structure"],
        },
        {
            "category": "learning",
            "title": "Bot workflow: never commit screenshots to repos",
            "content": 'The bot initially committed PNG screenshots to PR branches and used relative image paths in PR descriptions. Both are wrong. Screenshots must be base64-encoded and embedded in PR comments using <img src="data:image/png;base64,...">. Never commit binary files to the repo for verification purposes.',
            "tags": ["process", "bot-workflow"],
        },
        {
            "category": "learning",
            "title": "Bot workflow: always use npm scripts, not direct CLI tools",
            "content": "The bot initially called 'npx jest', 'npx eslint', 'tsc' directly. This is wrong — always use npm scripts: 'npm test', 'npm run lint', 'npm run build'. Check package.json for available scripts. The only exception is the dev server command (node_modules/.bin/fec dev --clouddotEnv stage) which has no npm script equivalent.",
            "tags": ["process", "bot-workflow", "testing"],
        },
        {
            "category": "learning",
            "title": "Dev server: fec dev takes 2-3 minutes for initial load",
            "content": "The HCC dev server (fec dev --clouddotEnv stage) proxies all requests to console.stage.redhat.com. The initial page load takes 2-3 minutes because hundreds of federated module assets are fetched through the proxy without cache. Use wait_for with 180000ms timeout. Always kill stale dev servers on port 1337 before starting a new one.",
            "tags": ["process", "bot-workflow", "dev-server"],
        },
        {
            "category": "learning",
            "title": "SSO login is a two-step flow",
            "content": "The Red Hat SSO/Keycloak login is two-step: (1) enter username and click Next, (2) wait for password field, enter password and click Log in. The bot must handle each step separately with waits between them. Credentials are in the .credentials file in the dev-bot root directory.",
            "tags": ["process", "bot-workflow", "dev-server", "authentication"],
        },
    ]

    for m in memories:
        existing = await conn.fetchrow(
            "SELECT id FROM memories WHERE title = $1", m["title"]
        )
        if existing:
            print(f"  Memory '{m['title'][:50]}...' already exists, skipping")
            continue

        vector = embed(f"{m['title']}\n{m['content']}")
        await conn.execute(
            """
            INSERT INTO memories (category, repo, jira_key, title, content, tags, embedding, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            """,
            m["category"],
            m.get("repo"),
            m.get("jira_key"),
            m["title"],
            m["content"],
            m.get("tags", []),
            vector,
            json.dumps(m.get("metadata", {})),
        )
        print(f"  Memory: {m['title'][:60]}")

    await conn.close()
    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())

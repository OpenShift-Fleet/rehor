# Rehor Roadmap

Planned improvements and new capabilities for the Rehor autonomous development platform. Items are listed by theme, not priority order.

---

## 1. Shared Memory MCP Server

Expose the memory server as a read-only MCP endpoint that engineers can connect to from their local Claude Code, Cursor, or other agentic tool sessions.

**Why:** Bot instances accumulate valuable knowledge — repo conventions, API quirks, deployment gotchas, common failure patterns. All instances already share a global long-term memory server, but that knowledge is only accessible to bot sessions. A read-only MCP endpoint lets any engineer query it from their own tools: "What did the bot learn about this repo's test setup?" or "What CI issues have been seen in this project?"

**Scope:**
- Read-only MCP access to the shared memory store
- MCP resource endpoints for browsing memories by instance, type, and topic
- MCP tool for semantic search across all memories
- Authentication via existing platform identity
- Documentation for connecting from local Claude Code / Cursor / OpenCode

**Future:** Enable write access from local sessions so engineers can contribute knowledge back to the shared memory (e.g., document a fix the bot should learn from).

---

## 2. Instance Onboarding Agent

A dedicated bot instance that automates onboarding new teams and repos onto the platform.

**Why:** Today, onboarding a new instance requires manual setup — creating config files, Jira labels, Konflux components, and repo permissions. An onboarding agent can handle the mechanical steps while maintaining a conversation with the requester across Jira comments, PR reviews, and other channels to gather requirements and iterate on the configuration.

**How it works:**
- Triggered by a new Jira issue (e.g., "Onboard repo X to Rehor")
- Engages in a multi-channel dialog with the reporter (Jira comments, PRs) to gather details:
  - Repository URL and hosting platform (GitHub / GitLab)
  - Jira project and board
  - Workflow type (scrum, kanban, etc.)
  - Team and reviewer preferences
  - Any special build or test requirements
- Generates the instance configuration (env preset, workflow, CLAUDE.md)
- Opens a PR to add the new instance to the fleet
- Validates the setup with a dry-run preflight

---

## 3. Instance Improvement Agent

A meta-agent that analyzes bot instance performance and opens PRs to improve the platform.

**Why:** The primary goals are cost reduction and quality improvement. Bot instances generate rich signal — transcripts, preflight logs, token usage, success/failure patterns. A dedicated agent can mine this data to find systematic improvements that would be tedious for humans to extract manually.

**What it does:**
- Reviews instance transcripts to find recurring patterns, issues, and inefficiencies
- Identifies repetitive task sequences that should become skills
- Detects preflight gaps (tickets that start but shouldn't have)
- Analyzes feedback patterns (repeated human corrections → instruction updates)
- Opens PRs with concrete improvements:
  - New or refined preflight checks
  - New skills for repetitive task patterns
  - Updated CLAUDE.md instructions based on feedback trends
  - Workflow optimizations

---

## 4. Additional Workflow Presets

Expand the workflow preset library beyond the current scrum-based Jira workflow.

**Planned presets:**
- **jira-kanban** — Continuous flow workflow without sprints. Pull from backlog by priority, no sprint boundaries.
- **github-issues** — For teams that use GitHub Issues instead of Jira. Poll issues by label, manage project boards.
- **gitlab-issues** — Same concept for GitLab-native teams.
- **maintenance-only** — No ticket work. Focused entirely on dependency updates, CI fixes, and PR maintenance across a set of repos.
- **review-bot** — Dedicated to code review. Watches for PRs on configured repos, provides review feedback, and verifies fixes.

Each preset includes its own workflow CLAUDE.md, preflight checks, and default configuration.

---

## 5. Agentic SDLC Integration

Integrate with the [Fleet Engineering Agentic SDLC](https://github.com/OpenShift-Fleet/agentic-sdlc) tooling — a shared skill and command catalog used across the organization.

**Why:** The agentic-sdlc repo provides battle-tested skills (`start-work`, `finish-work`, `pr-review`, `jira-create`, etc.) and SDLC practices that the broader engineering org already uses. Aligning Rehor with these standards means bot instances follow the same workflows human engineers do, and improvements flow both ways.

**Integration points:**
- Install the agentic-sdlc plugin into bot runner images so skills are available at runtime
- Align bot workflows with SDLC practices (e.g., `start-work` / `finish-work` lifecycle)
- Use shared Jira skills (`jira-create`, `story-specialist`, `bug-specialist`) instead of custom implementations
- Adopt `pr-review` and `scored-code-review` for bot self-review before opening PRs
- Contribute bot-specific skills back upstream (e.g., preflight patterns, autonomous loop management)
- Keep skill versions in sync — pin to releases, auto-update via Konflux

---

## Status

| Item | Status |
|------|--------|
| Shared Memory MCP | Planned |
| Onboarding Agent | Planned |
| Improvement Agent | Planned |
| Workflow Presets | Planned (scrum-jira exists today) |
| Agentic SDLC Integration | Planned |

# Rehor Roadmap

Planned improvements and new capabilities for the Rehor autonomous development platform.

---

## Suggested priority

Start with items that are low-cost, reuse existing data, and unblock later work.

**Tier 1 — Foundations (do first, in this order):**

1. **CI Foundation** — merge gate for all components. Prerequisite for safe iteration on everything else.
2. **Logging & Observability** — structured logs, cycle correlation ID, preflight duration. Low cost, immediate engineer and platform-team value.
3. **Run Identity** — stable `run_id` linking cost, task, transcript, PR, and outcome. Required before cost analysis or improvement agents are useful.

**Tier 2 — Direct engineer value:**

4. **Agentic SDLC Integration** — pin and install the plugin, integrate one lifecycle skill first. Reuses existing battle-tested skills rather than building custom implementations.
5. **Shared Memory MCP** — read-only semantic search. Low infrastructure cost, direct value to engineers using local agentic tools.
6. **Model Customization & Cost Tiering** — per-workflow defaults and cost tracking. Measure where spend concentrates before building per-task routing.
7. **Task Blocker Explanation** — expose preflight decisions in dashboard. Reuses existing data, directly reduces engineer debugging time.
8. **Ticket Readiness Doctor** — analyze ticket specification quality before execution, request missing info, store findings for reuse.

**Tier 3 — Larger scope (after foundations exist):**

9. **Failure Fingerprinting** — group recurring failures for faster diagnosis. Builds on logging and run identity from tier 1.
10. **Onboarding Agent** — schema, validator, dry-run, PR generator first. Conversational multi-channel agent later.
11. **Improvement Agent** — depends on telemetry from tiers 1–2. Primary input: PR review comments and `review_feedback` memories. Start with SQL analytics, not per-transcript LLM analysis.
12. **Workflow Presets** — one preset at a time, driven by team demand.

Engineer experience items (§9–§12) pair naturally with platform foundations: run identity provides stable IDs that improvement analysis references, and logging & observability supplies structured events that blocker explanations and failure fingerprinting consume. Prioritize platform foundations first so engineer experience features build on real data rather than ad-hoc log parsing.

---

## Status

| Item | Status |
|------|--------|
| CI Foundation | Planned |
| Logging & Observability | Planned |
| Run Identity | Planned |
| Shared Memory MCP | Planned |
| Agentic SDLC Integration | Planned |
| Model Customization | Planned |
| Task Blocker Explanation | Planned |
| Ticket Readiness Doctor | Planned |
| Failure Fingerprinting | Planned |
| Onboarding Agent | Planned |
| Improvement Agent | Planned (after telemetry exists) |
| Workflow Presets | Planned (scrum-jira exists today) |

---

## 1. Shared Memory MCP Server

Expose the memory server as a read-only MCP endpoint that engineers can connect to from their local Claude Code, Cursor, or other agentic tool sessions.

**Why:** Bot instances accumulate valuable knowledge — repo conventions, API quirks, deployment gotchas, common failure patterns. All instances already share a global long-term memory server, but that knowledge is only accessible to bot sessions. A read-only MCP endpoint lets any engineer query it from their own tools: "What did the bot learn about this repo's test setup?" or "What CI issues have been seen in this project?"

**Scope:**
- Read-only MCP access to the shared memory store
- MCP resource endpoints for browsing memories by instance, type, and topic
- MCP tool for semantic search across all memories
- Authentication via existing platform identity
- Rate limits and clear instance/tenant filtering
- Documentation for connecting from local Claude Code / Cursor / OpenCode

**First slice:** Read-only semantic search with authentication, rate limits, and instance/tenant filtering. Keep write access and cross-instance aggregation for later.

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

**First slice:** Configuration schema, validator, dry-run, and PR generator. The multi-channel conversational agent can come after the core validation loop is reliable.

---

## 3. Instance Improvement Agent

A meta-agent that analyzes bot instance performance and opens PRs to improve the platform.

**Why:** The primary goals are cost reduction and quality improvement. Bot instances generate rich signal — transcripts, preflight logs, token usage, success/failure patterns. A dedicated agent can mine this data to find systematic improvements that would be tedious for humans to extract manually.

**What it does:**
- Reviews instance transcripts to find recurring patterns, issues, and inefficiencies
- Identifies repetitive task sequences that should become skills
- Detects preflight gaps (tickets that start but shouldn't have)
- Mines PR review comments and `review_feedback` memories for recurring corrections — the bot already stores these, but no automated process aggregates or acts on them
- Opens PRs with concrete improvements:
  - New or refined preflight checks
  - New skills for repetitive task patterns
  - Updated CLAUDE.md instructions based on review feedback trends
  - Workflow optimizations

**First slice:** Useful after telemetry and run identity exist. Primary input: PR review comments (already collected by preflight) and `review_feedback` memories (already stored by the wrap-up skill). Start with aggregating recurring review corrections using SQL/analytics before running LLM analysis. Run an LLM auditor weekly or on demand, not on every transcript. Require human approval for any generated PRs.

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

**First slice:** Add one preset only when a team is ready to use it. Do not build all presets as a batch — each needs a real user to validate against.

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

## 6. Model Customization & Cost Tiering

Configure which AI models are used for different tasks and workflows, matching model capability to task complexity.

**Why:** Not every task needs the most capable (and expensive) model. Status checks, label management, simple PR maintenance, and boilerplate generation can run on smaller, cheaper models without any quality loss. Reserving top-tier models for complex implementation work can significantly reduce per-instance cost while maintaining output quality where it matters.

**Scope:**
- **Per-workflow model configuration** — allow workflow presets to specify a default model tier. A maintenance-only workflow or a review-bot can default to a cheaper model than a full implementation workflow.
- **Per-task model selection** — within a single session, use cheaper models for mechanical sub-tasks (status checks, formatting, label updates, commit message generation) and escalate to stronger models for design decisions, complex bug fixes, or multi-file refactors.
- **Sub-agent model tiers** — when the main agent spawns sub-agents (e.g., for parallel research, file scanning, test generation), those sub-agents can run on cheaper models since they handle scoped, well-defined tasks.
- **Model routing rules** — configurable rules in instance or workflow config that map task types to model tiers (e.g., `preflight: haiku`, `implementation: sonnet`, `architecture: opus`).
- **Cost tracking per model tier** — break down token spend by model in instance metrics to measure savings and validate routing decisions.

**Examples:**
- A preflight check agent that just reads PR status and Jira state → cheapest available model
- A sub-agent grepping for patterns across a repo → cheap model
- The main loop deciding which ticket to work on → mid-tier model
- Implementing a multi-file feature from a Jira story → top-tier model

**First slice:** Begin with per-workflow model defaults and cost tracking per model tier. The current runner creates one `ClaudeAgentOptions` with one model per session, so per-task model switching and sub-agent tiers require a larger architecture change — scope that separately after measuring where spend concentrates.

---

## 7. CI Foundation

Add required CI checks for all platform components before expanding into full governance.

**Why:** Without CI, regressions in core components are caught late or not at all. A reliable check suite is a prerequisite for safe iteration on every other roadmap item.

**Scope:**
- Required checks for Python (bot runner, presets), Go (memory-server), and dashboard components
- Linting, type checking, and unit tests as merge gates
- A clear contribution guide for adding checks when new components land

**Success metric:** No PR merges without passing checks for affected components.

---

## 8. Logging & Observability

Add structured logging and traceability across bot runs so engineers and the platform team can diagnose issues without reading raw transcripts.

**Why:** The current logging infrastructure is unstructured plain text with no cross-event correlation:
- `bot/run.py` uses `[%(asctime)s] %(message)s` format — no structured/JSON logging anywhere, no `structlog` or equivalent in the project.
- No correlation ID links events across a single cycle. The main loop runs preflight → agent cycle → cost recording → transcript storage, but each step logs independently. `session_id` from Claude SDK is captured *after* the cycle ends, never used during it. Preflight scripts have zero ID awareness.
- Preflight duration is not tracked — `_run_script()` runs subprocesses but never records timing. Only the Claude SDK's `duration_ms` on the agent cycle itself is captured.
- Multiple silent failures: dashboard status push uses bare `except Exception: pass` (`bot/agent.py:59-61`); cost API push catches all exceptions at DEBUG level only (`bot/costs.py:88-91`); WebSocket events swallow all errors silently (`server.py:133`).
- Engineers diagnose issues by grepping `data/bot.log` (plain text, append mode). There is no way to filter by cycle, task, or error class.

**Scope:**
- Structured log format (JSON) with consistent fields across runner, preflight, and dashboard components
- Cycle correlation ID linking all events within a single bot run
- Preflight duration tracking
- Fix silent failures: log dashboard-post, cost-push, and WebSocket errors at WARNING level with context
- No external observability tooling exists today (no Prometheus, OpenTelemetry, Sentry) — structured logs are the prerequisite for adding any of these later

**First slice:** Structured logs, a cycle correlation ID, and fix silent `except Exception: pass` blocks. Defer centralized log aggregation until the format is stable.

---

## 9. Run Identity

Add a stable identifier that links all artifacts produced by a single bot run.

**Why:** Cost data, task outcomes, transcripts, PRs, and feedback currently lack a common key. Without run identity, cross-cutting queries ("how much did this ticket cost?" or "which runs produced rejected PRs?") require manual correlation.

**Scope:**
- A stable `run_id` generated at cycle start
- Propagated to cost records, task/ticket references, transcript metadata, PR metadata, and outcome/feedback records
- Queryable from the dashboard

**First slice:** Generate `run_id`, attach it to cost and transcript records. Extend to PR metadata and dashboard after the core ID is stable.

---

## 10. Task Blocker Explanation

Show why Rehor did not pick up a task and what an engineer must do next. The task detail view should expose the latest preflight decision, failed checks, stale inputs, retry timing, and a short remediation message.

**Why:** Engineers cannot currently ask "why hasn't PROJ-123 been picked up?" Preflight produces free-text skip reasons (e.g., "No eligible work — 3 candidates lack repo: labels"), but these are dumped as a single text blob into idle cycle runs (`progress.summary`, truncated to 2000 chars), not linked to individual tasks. The dashboard shows paused tasks with `paused_reason` and idle cycle run summaries, but candidate tickets that were evaluated and skipped have no representation in the dashboard at all — they only exist in Jira. The Task model has no field for `last_skip_reason` or `last_preflight_result`. Today, engineers must go to the Cycle Runs page, filter for "idle" cycle type, read free-text summaries across multiple cycles, and piece together why their ticket wasn't picked — or read runner logs directly.

**Scope:**
- Add per-ticket skip reasons to preflight output (structured reason codes, not just free text)
- Link skip decisions to individual tasks or Jira tickets in the dashboard
- Render existing preflight output in the dashboard with stable reason codes
- Short remediation message per reason code
- Manual recheck action (after explanation is reliable)

**First slice:** Add a `last_skip_reason` field to the Task model and populate it from preflight output. Render per-ticket skip reasons in the dashboard with links to the affected Jira ticket, repository, or PR. Add a manual recheck action only after the explanation is reliable.

**Guardrail:** Do not use an LLM to interpret deterministic state. Success means an engineer can resolve common blocked tasks without reading runner logs or asking the platform team.

---

## 11. Ticket Readiness Doctor

Validate whether a Jira ticket is sufficiently well-specified for Rehor to work on it, and improve it when it isn't.

**Why:** Underspecified tickets are the most common reason bot runs produce wrong or incomplete results. The bot starts work, discovers ambiguity mid-implementation, and either guesses wrong or stalls. Catching specification gaps before execution saves bot cycles and engineer rework.

**Scope:**
- Analyze ticket description, acceptance criteria, and linked context for completeness and clarity
- Identify missing information: unclear requirements, ambiguous scope, missing acceptance criteria, undefined edge cases
- Update the ticket with specific questions and a structured summary of what's missing
- Request more information from the reporter via Jira comment
- Store detailed findings (what was checked, what gaps were found, what context was gathered) so a subsequent bot session can reuse them without re-analyzing the ticket
- Return structured pass, warning, and failure results with reasons

**First slice:** Run ticket analysis as part of preflight. If gaps found, comment on the ticket requesting clarification and mark the task as not ready. Store findings in run metadata for reuse by future sessions.

**Guardrail:** Do not silently skip underspecified tickets — always explain what's missing and what the reporter should add. Do not fabricate missing requirements.

---

## 12. Failure Fingerprinting

Group recurring preflight, tool, build, and CI failures so engineers can recognize known problems and reuse proven fixes.

**Why:** Recurring failures are already a real problem being worked around manually:
- The workflow hardcodes three failure classes (`clone_failed`, `push_failed`, `ci_failed`) with retry-then-pause logic — primitive manual fingerprinting in prompt instructions.
- Known issues are documented as prose in persona files (e.g., the RBAC persona documents a Redis health check false positive) — not queryable or aggregatable.
- Persona files contain repo-specific CI fix patterns, but they are referenced by the agent at runtime, not searchable across instances.
- The runner uses exponential backoff (`consecutive_preflight_errors`, up to 300s) for transient recurring failures.

Despite this, the system has no infrastructure for error analysis: errors are stored as a single `is_error=True` boolean or `cycle_type="error"` string with free-text summaries. The dashboard shows error count as one undifferentiated number. The memory system has no failure or workaround category.

**Scope:**
- Normalize deterministic error signatures
- Count occurrences by repository and workflow
- Link each signature to recent examples and an optional human-maintained workaround
- Add a `failure` or `known_issue` memory category so the bot can store and recall structured workarounds
- Add semantic clustering only if exact fingerprints prove insufficient

**First slice:** Normalize deterministic error signatures, count occurrences by repository and workflow, and link each signature to recent examples and an optional human-maintained workaround. Add an error breakdown to the dashboard (replacing the current single error count).

**Guardrail:** Never hide the original error or automatically apply a fix from a fingerprint. Success means repeated incidents are diagnosed faster and the platform team can prioritize the most common failure classes.


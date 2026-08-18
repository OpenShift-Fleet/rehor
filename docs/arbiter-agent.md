# Arbiter Agent Design

A meta-agent that audits, analyzes, and improves all Rehor agent instances. It reads telemetry (cycles, transcripts, PRs, costs, memories) across the fleet and produces actionable improvements — PRs to config repos, new skills, instruction fixes, Jira tickets, and dashboard alerts.

---

## Problem

Rehor runs 13+ agent instances across 9 teams. Each instance generates rich signal — cycle runs, transcripts, PRs/MRs, cost records, review feedback, memories. Today nobody systematically mines this data:

- **Token waste goes unnoticed.** An instance burning tokens on idle cycles (preflight passes but no real work exists) runs for days before a human spots it. Could be a stale schedule, a preflight bug, or a misconfigured board filter.
- **Repetitive patterns stay manual.** Agents perform the same multi-step tool call sequences across instances. These could be extracted into reusable skills, prompt improvements (CLAUDE.md/AGENTS.md), or deterministic rules/workflows — but nobody reviews transcripts looking for them.
- **Review feedback doesn't propagate.** When a reviewer corrects an agent's PR, that correction lives in one instance's `review_feedback` memory. If 5 reviewers across 3 instances say "don't use deprecated API X," nobody aggregates that into a platform-level instruction fix.
- **Repo setup gaps are invisible.** Missing CLAUDE.md sections, absent test commands, stale agent config — these cause agent confusion that shows up as wasted cycles and bad PRs, but the root cause isn't surfaced.
- **No cross-instance learning.** A fix discovered for one instance (a skill, an instruction, a preflight check) could benefit others on similar repos but there's no mechanism to propagate it.

---

## Goals

1. **Reduce cost** — detect and eliminate token waste from idle cycles, bad preflight, model mismatches, and stale instances
2. **Improve quality** — surface instruction gaps, repo setup issues, and recurring review corrections before they cost more cycles
3. **Extract improvements** — mine transcripts for repetitive patterns and generate reusable skills, prompt improvements (CLAUDE.md/AGENTS.md updates), and deterministic rules/workflows
4. **Propagate learning** — spread improvements discovered in one instance across the fleet where applicable
5. **Maintain accountability** — all arbiter actions are tracked, auditable, and require human approval for changes

---

## What the Arbiter Does

### 1. Idle Cycle Auditor

Detect instances burning tokens without producing useful output.

**Inputs:** Cycle run records (type, duration, token usage, outcome), preflight results, instance schedules.

**Detects:**
- Cycles where preflight passes but the agent concludes "nothing to do" (preflight gap)
- Cycles with high token usage but no PR opened, no commit pushed, no ticket transitioned
- Instances with sustained idle patterns (>N consecutive idle cycles)
- Sudden cost spikes — instance costs 3x its rolling average

**Outputs:**
- Dashboard alert with diagnosis (stale schedule, preflight bug, board filter misconfiguration, bad ticket quality)
- Prometheus alert for critical cases — sustained idle cycles with token burn, cost spikes exceeding threshold. These fire independently of the arbiter's own schedule so on-call gets notified in real time, not on the next daily arbiter run. Depends on Prometheus integration work currently in progress.
- Jira ticket if the root cause is a fixable bug
- Recommendation: adjust schedule, fix preflight, pause instance, or investigate

### 2. Transcript Pattern Miner

Analyze agent transcripts to find repetitive tool call sequences that should become skills.

**Inputs:** Session transcripts across all instances (tool calls, arguments, sequences, model used).

**Detects:**
- Repeated multi-step tool call sequences (≥3 steps appearing in ≥3 transcripts)
- Common file read/edit patterns tied to specific repo structures
- Boilerplate generation patterns (test files, config files, PR descriptions)

**Outputs:**
- GitHub issue on the instance config repo with the candidate skill definition, generic usage pattern description, and estimated frequency/savings. No sensitive data — no transcript excerpts, no file paths from target repos, no tool call arguments. Only the abstract pattern and the proposed skill structure.
- PR to core repo or instance config repo with the new skill (after team acknowledges the issue)
- Frequency and cost data showing how much the skill would save (aggregated numbers only — "pattern seen N times across M cycles, estimated saving X tokens per occurrence")

### 3. PR/MR Review Gap Analyzer

Mine PR review comments and outcomes to find instruction and repo setup gaps.

**Inputs:** PR/MR review comments, merge/reject outcomes, `review_feedback` memories across instances.

**Detects:**
- Recurring reviewer corrections (same feedback appearing across multiple PRs/instances)
- High rejection rate for specific types of changes
- Missing or outdated CLAUDE.md instructions causing predictable agent errors
- Repo setup issues: missing test commands, absent linting config, stale CI definitions
- PRs with unusually high comment count — signals a gap upstream. Common causes: underspecified Jira ticket (missing acceptance criteria, vague requirements), bad repo context (missing or outdated CLAUDE.md, no AGENTS.md), stale/misleading memories in the memory server causing wrong assumptions, or bad task tracking (agent re-doing work already done, addressing already-resolved feedback, working on stale ticket state)

**Outputs:**
- PR to instance config repo updating CLAUDE.md instructions
- PR to target repo adding missing scaffolding (test commands, CLAUDE.md sections)
- Aggregated report of most common review corrections fleet-wide

### 4. Cost Anomaly Detector

Spot unusual cost patterns across the fleet.

**Inputs:** Cost records per instance, per model, per cycle.

**Detects:**
- Instance cost deviating >2σ from rolling 7-day average
- Model usage mismatches (instance using Opus for work that could run on Sonnet/Haiku)
- Cycles with disproportionate token usage relative to output (high input, low output = confused agent)
- Sub-task model opportunities — tasks within a cycle that don't need the main model. CVE triage, dependency bumps, label management, and other non-coding tasks could run on cheaper models (Haiku) or non-Claude models entirely (Gemini, local models). Coding tasks with narrow scope (single-file fixes, test generation) could use sub-agents on a lighter tier while the main agent orchestrates.

**Outputs:**
- Dashboard cost anomaly alerts with instance, timeframe, and magnitude
- Model routing recommendations — per-instance ("instance X does simple label work, switch to Haiku") and per-task-type ("CVE triage across all instances could use Gemini, saving ~Y tokens/cycle"). Feeds into the model customization & cost tiering roadmap item (§6).
- Jira ticket for investigation if anomaly persists

### 5. Config Drift & Staleness Detector

Detect instance config repos that diverged from core presets or are running outdated versions.

**Note:** Basic instance health (pod liveness, cycle count, memory store size, stale schedules) belongs in Prometheus — metrics exported directly from agent pods and the dashboard, not requiring an LLM. The arbiter handles what Prometheus can't: semantic analysis of config drift and outdated instructions that require understanding the content, not just counting.

**Inputs:** Instance config repos (CLAUDE.md, workflow config, skills, preflight scripts), core preset repo state, instance registration metadata (REHOR-53).

**Detects:**
- Config repos that diverged from core presets — missing new features, outdated workflow version, stale skill definitions
- Instances running old preset versions when newer versions fix known issues
- CLAUDE.md instructions that contradict current core recommendations
- Missing adoption of new preflight checks or skills shipped in core

**Outputs:**
- GitHub issue on instance config repo listing what's outdated and what the current version provides (generic, no sensitive data)
- PR to config repo to sync with latest preset version (after team acknowledges)
- Dashboard report showing drift status per instance

**Not in scope (Prometheus instead):**
- Pod health, restart counts, scheduling issues
- Cycle count and activity metrics
- Memory store size and growth rate
- Stale instance detection (no cycles in >N days)

### 6. Cross-Instance Learning

Propagate improvements discovered in one instance to others where applicable.

**Inputs:** Skills, instructions, preflight checks across all instance config repos. Transcript analysis results.

**Detects:**
- Skill created for instance A that would benefit instances B, C (similar repos, similar workflows)
- Instruction fix in one config repo that addresses a pattern seen in other instances' transcripts
- Preflight check added to one instance that would prevent waste seen in others

**Outputs:**
- PR to other instance config repos with the proposed improvement
- Report showing which instances would benefit and estimated savings

### 7. Preflight Effectiveness Audit

Evaluate whether preflight checks are actually saving tokens.

**Inputs:** Preflight results (start/skip decisions), subsequent cycle outcomes when started.

**Detects:**
- Preflight checks that never trigger (dead code)
- Preflight checks that always trigger (too permissive — not filtering enough)
- Cycles that preflight approved but produced no useful output (gap in checks)
- Preflight scripts with high execution time relative to value

**Outputs:**
- Report on preflight effectiveness per check, per instance
- PR to add missing checks or remove dead ones
- Recommendations for new checks based on observed idle patterns

---

## Architecture

### Deployment

The arbiter runs as its own Rehor instance with a dedicated workflow (`arbiter`). It uses the same infrastructure — same proxy, same memory server, same dashboard registration — but with elevated read access to fleet-wide data.

```mermaid
flowchart TB
    subgraph Inputs["Data Sources (read-only)"]
        Dashboard["Dashboard API\ninstance registry, cycle runs,\ncost records, preflight results"]
        Transcripts["Transcript Store\nsession transcripts,\ntool calls, decisions"]
        Memory["Memory Server\nreview_feedback,\nlearned patterns"]
        Jira["Jira\nticket data,\nPR review comments"]
        GHGL["GitHub / GitLab\nPR/MR status,\nreview comments, merge outcomes"]
    end

    subgraph Arbiter["Arbiter Agent (workflow: arbiter)"]
        Preflight["Preflight\nquery watermarks,\nselect eligible data"]
        Analysis["Analysis\nidle audit, pattern mining,\nreview gaps, cost anomalies,\nconfig drift, preflight effectiveness"]
        Preflight --> Analysis
    end

    subgraph Outputs["Output Channels"]
        DashAlert["Dashboard Alerts"]
        PromAlert["Prometheus Alerts\nidle burn, cost spikes"]
        JiraOut["Jira Tickets\nbug reports, investigations"]
        PRs["PRs to Config Repos\ninstruction fixes, new skills,\npreset sync"]
        Reports["Reports\ncost, health, drift status"]
    end

    Dashboard --> Preflight
    Transcripts --> Analysis
    Memory --> Analysis
    Jira --> Analysis
    GHGL --> Analysis

    Analysis --> DashAlert
    Analysis --> PromAlert
    Analysis --> JiraOut
    Analysis --> PRs
    Analysis --> Reports
```

### Data Access

The arbiter needs read access to:

| Data Source | What | Access Method |
|---|---|---|
| Dashboard API | Instance registry, cycle runs, cost records, preflight results | REST API with service account |
| Transcript store | Full session transcripts (tool calls, responses, decisions) | Memory server (fleet-scoped read via memory MCP) |
| Memory server | Instance memories (`review_feedback`, learned patterns) | Memory MCP (read-only) |
| Instance config repos | CLAUDE.md, workflow config, skills, preflight scripts | Git clone via proxy |
| Target repos | CLAUDE.md, test setup, CI config | Git clone via proxy (read-only) |
| Jira | PR review comments, ticket data | Jira MCP |
| GitHub/GitLab | PR/MR status, review comments, merge outcomes | GitHub/GitLab API via proxy |

### Access Control

Arbiter data is privileged — transcripts contain reasoning, tool arguments, and potentially sensitive context from target repos. Not all agents should see this.

**Network-level enforcement (NetworkPolicy).** Fleet-wide data (transcripts, cycle records, cost data, cross-instance memories) is served on dedicated ports. OpenShift NetworkPolicy restricts those ports to pods with the `app.kubernetes.io/name=arbiter` label. Regular agent pods physically cannot reach fleet-wide endpoints — blocked at the kernel, no application code involved.

```yaml
# Example: memory server fleet-read port restricted to arbiter
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: memory-server-fleet-read
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: memory-server
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: arbiter
      ports:
        - port: 5433    # fleet-wide read
          protocol: TCP
    - from:
        - podSelector:
            matchLabels:
              role: agent
      ports:
        - port: 5432    # instance-scoped read/write
          protocol: TCP
```

Same pattern applies to dashboard API (fleet query port) and transcript store. Each service exposes two ports: one instance-scoped (open to all agents), one fleet-scoped (arbiter only).

**ServiceAccount identity check.** Dashboard sits behind the cluster auth proxy (SSO). Auth proxy sets `X-Forwarded-User` with the caller's ServiceAccount identity (e.g., `system:serviceaccount:<namespace>:arbiter`). Dashboard checks SA name — only the `arbiter` SA gets fleet endpoint access. No custom OAuth scopes needed — SA identity is the scope. Belt and suspenders with NetworkPolicy: network blocks unauthorized pods, SA identity blocks unauthorized requests even from permitted pods.

**Config repo access.** The arbiter's own config repo is restricted — only platform maintainers can modify its instructions.

**What the arbiter must NOT do:**
- Write directly to other instances' memory stores
- Push to instance config repos without PR (always PR, always human-approved)
- Access secrets or credentials beyond its own proxy routing
- Modify its own instructions or preflight checks

### State Tracking

The arbiter must not re-analyze the same data repeatedly. It tracks progress using **tasks** (operational state) and stores learnings in **memories** (knowledge).

**Watermarks via tasks.** Each watermark is a task record — not a memory. Tasks are operational cursors, not knowledge. The arbiter's preflight reads task watermarks to determine what's new since last run.

| Source | Watermark (stored as task) |
|---|---|
| Cycle runs | Last processed `cycle_id` per instance |
| Transcripts | Last processed `transcript_id` per instance |
| PRs/MRs | Last processed `updated_at` timestamp per repo (not PR number — older PRs receive new comments) |
| Cost records | Last processed timestamp per instance |
| Config repos | Last analyzed commit SHA per repo |

**Memories for learning.** Memories store what the arbiter has *learned* — extracted patterns, recurring review corrections, skill candidates, cross-instance insights. These are knowledge that informs future analysis, not operational bookkeeping.

**Memory auditing.** When §3 (PR Review Gap Analyzer) finds a bad PR — high comment count, repeated corrections — it should also check the instance's memories for stale or misleading entries that may have caused the bad output. Wrong memories (outdated patterns, incorrect assumptions from earlier cycles) are a root cause that shows up as bad PRs downstream.

### Preflight

The arbiter has its own preflight that selects what to analyze:

1. **Query dashboard** for new cycle runs since last watermark, across all instances
2. **Query transcript store** for new transcripts since last watermark
3. **Query GitHub/GitLab** for new PR review comments since last watermark
4. **Prioritize:** Round-robin across instances to ensure fair coverage — don't spend all cycles analyzing one noisy instance
5. **Skip if nothing new** — zero token spend when fleet is quiet

### Cadence

Two tiers: **always-run** (cheap, every cycle) and **rotating slot** (expensive, one per day). Prevents any single capability from starving the others.

**Always-run (every cycle):**

| Capability | Why cheap |
|---|---|
| §1 Idle Cycle Auditor | Dashboard API queries + comparisons, no LLM |
| §4 Cost Anomaly Detector | Cost records + math, no LLM |

**Rotating slot (one per day, weekdays):**

| Day | Capability | Why expensive |
|---|---|---|
| Monday | §2 Transcript Pattern Miner | Reads full transcripts, LLM pattern extraction |
| Tuesday | §3 PR/MR Review Gap Analyzer | Reads PR comments + review_feedback memories |
| Wednesday | §5 Config Drift Detector | Clones + diffs config repos against core presets |
| Thursday | §6 Cross-Instance Learning | Compares skills/instructions across all instances |
| Friday | §7 Preflight Effectiveness Audit | Correlates preflight results with cycle outcomes |

Each rotating capability gets a full day's token budget. Preflight queries only the data sources needed for that day's capability — transcript watermarks on Monday, PR watermarks on Tuesday, etc.

**On-demand:** Dashboard-triggered deep-dive on a specific instance runs any capability outside the rotation, with its own budget.

### Output Channels

| Output Type | Channel | Approval Required |
|---|---|---|
| Dashboard alert | Dashboard API | No (informational) |
| Prometheus alert | Prometheus metrics endpoint | No (fires automatically on threshold breach — sustained idle cycles, cost spikes) |
| Jira ticket | Jira MCP | No (creates ticket for human triage) |
| PR to instance config repo | GitHub/GitLab via proxy | Yes (human reviews and merges) |
| PR to core repo | GitHub via proxy | Yes (human reviews and merges) |
| New skill candidate | PR to core or instance repo | Yes (human reviews) |
| Cost/health report | Dashboard + optional Slack | No (informational) |

---

## Dependencies

| Dependency | Why | Status |
|---|---|---|
| REHOR-53 — Instance metadata in dashboard | Arbiter needs to know which instances exist, their config repos, workflows, and sources | New |
| Run Identity (REHOR-40) | Stable `run_id` generated before preflight and propagated to preflight results, cycle runs, costs, and transcripts. Provides correlation across all telemetry for a single run. | Planned |
| Logging & Observability (roadmap §8) | Structured logs with cycle correlation for meaningful analysis | Planned |
| Dashboard API auth | Set up SA identity checks on dashboard endpoints — separate fleet-scoped from instance-scoped | Not started |
| Prometheus integration | Metrics endpoint for critical alerts (idle cycle burn, cost spikes) that fire independently of arbiter schedule | In progress |

---

## Security Considerations

- **Transcript sensitivity.** Transcripts may contain reasoning about target repo code, tool arguments with file paths/content, and decision logic. Arbiter access must be scoped and audited.
- **PR content.** Arbiter-generated PRs modify agent instructions. A compromised arbiter could inject malicious instructions. Mitigation: all PRs require human approval, arbiter cannot self-modify.
- **Cross-instance isolation.** Today instances are isolated — they don't see each other's data. Arbiter breaks this isolation by design. Access must be read-only and scoped to analysis, not control.
- **Public repo output.** Instance config repos are public on GitHub. Any arbiter output written to issues or PRs on these repos must be sanitized — no transcript excerpts, no file paths from target repos, no tool call arguments, no internal hostnames or infrastructure details. Only generic patterns, aggregated metrics, and abstract recommendations. Sensitive details stay in dashboard alerts and Jira tickets (internal).
- **Rate limiting.** Arbiter analyzing transcripts is expensive. Hard cap on daily token budget prevents runaway analysis.

---

## First Slice: Langfuse as Triage Layer

Use Langfuse LLM-as-a-Judge evaluators as a cheap, fast gatekeeper before the full arbiter agent runs. Validated in a proof-of-concept with tasks 138 and 425.

### Why Langfuse First

The full arbiter needs access to code repos, Jira, GitHub PRs, memory server, and agent config — expensive context for every task. Most archived tasks are clean cycles that don't need deep analysis. Langfuse filters the noise cheaply so the arbiter only investigates flagged tasks.

### Pipeline

```
Archived tasks (memory server API)
  → Manual ingestion (OTEL format via ingest-task.ts)
  → Langfuse trace (one root observation per task, all cycles merged)
  → LLM-as-a-Judge evaluator (Gemini Flash, ~$0.001/eval)
  → Score + reasoning per task
  → Flagged tasks → new Rehor investigation tasks for arbiter deep-dive
```

### What Langfuse Evaluates

Single evaluator with these categories (one per task, most significant):

- **PREFLIGHT_MISMATCH** — preflight reported work but agent concluded nothing actionable
- **SKILL_FAILURE** — tool/skill failed, missing, or produced wrong results
- **CONFLICTING_INSTRUCTIONS** — contradictory guidance from system prompts or task description
- **MISSING_CAPABILITY** — can't complete due to missing env setup, tools, or credentials
- **TASK_UNDERSPECIFIED** — Jira ticket lacked detail, agent guessed or asked for clarification
- **EXCESSIVE_REVIEW_LOOP** — many revision cycles, unclear acceptance criteria or agent not learning
- **WASTED_CYCLE** — no meaningful progress, idle cycles, redundant tool calls, circular reasoning
- **CLEAN_CYCLE** — task executed well

### What Langfuse Cannot Do

- No access to code repos, PRs, or Jira — only sees transcript text and Jira description provided at ingestion
- No cross-instance analysis — evaluates one task at a time
- Cannot suggest specific config changes (CLAUDE.md patches, skill definitions) — lacks repo context
- Cannot correlate patterns across tasks or instances
- Runs on external infrastructure — transcript data leaves the internal network during ingestion. Alternative channels (e.g., Slack webhook payloads, dashboard API) may be needed if VPN constraints block direct OTEL export

### Ingestion Constraints

- Transcripts must be converted from JSONL to OTEL format before ingestion (handled by `ingest-task.ts` in mock-app)
- Ingestion is manual — triggered per task via CLI (`npm run ingest-task -- <task-id>`)
- VPN required to reach memory server API for transcript download; Langfuse instance runs locally (docker-compose) or on external cloud
- All cycles for a task are merged into a single root observation to stay within OTEL export limits — nested per-cycle/per-turn observations overwhelm the span processor at scale (51+ cycles)

### Arbiter Deep-Dive (Stage 2)

Non-CLEAN_CYCLE scores trigger investigation tasks for the arbiter agent, which has full context:

- Code repo access (git clone via proxy)
- Jira ticket details (Jira MCP)
- PR/MR review comments (GitHub/GitLab API)
- Agent config and instructions (instance config repos)
- Memory server history (fleet-scoped read)
- Cross-instance pattern data

The arbiter produces actionable output: CLAUDE.md patches, new skills, Jira tickets, instruction fixes. Langfuse just tells it where to look.

### First Slice Steps

1. **Langfuse triage only.** Run evaluator on archived tasks from 2-3 instances. Manual ingestion, manual review of scores.
2. **State tracking.** Track which tasks have been evaluated (task watermarks in arbiter tasks, or Langfuse session IDs).
3. **Cadence: on-demand.** Batch-ingest completed tasks periodically, review scores.
4. **Access: memory server API + Langfuse only.** No transcript reading by the arbiter in first slice — Langfuse handles transcript analysis.

**Expand to full arbiter after:**
- Langfuse triage proves useful (catches real issues, low false-positive rate)
- Run identity exists (can correlate cycle → transcript → PR)
- VPN/network path for automated ingestion is solved
- Arbiter agent can consume Langfuse scores API and create investigation tasks automatically

---

## Decisions

| Question | Decision |
|---|---|
| Transcript storage | Transcripts already stored in memory server. Arbiter reads them via memory MCP with fleet-scoped access. |
| Dashboard API | Existing endpoints sufficient — need to set up SA identity auth first (fleet vs instance scope). Agents don't call dashboard today, so locking it down before arbiter ships is prerequisite, not migration. |
| Arbiter instance repo | [OpenShift-Fleet/rehor-onboarding-agent](https://github.com/OpenShift-Fleet/rehor-onboarding-agent) — shared with onboarding agent. Keeps non-implementer agents together. |
| Slack integration | Yes — posts to `#team-rehor-ai` via normal task output, same as other instances. |
| Cross-team PR approval | Instance team approves PRs to their own config repo. Arbiter opens PR, team reviews and merges. |

---

## Changelog

| Date | Change |
|---|---|
| 2026-08-04 | Added Langfuse triage layer as first slice — validated with tasks 138 and 425. Replaces dashboard-only first slice with cheaper LLM-as-a-Judge gatekeeper before full arbiter (Martin Marosi) |
| 2026-07-28 | Initial design (Martin Marosi) |

## RDS Blue-Green Upgrade Guidelines

Multi-step infra process across multiple cycles. Track progress in task metadata + summary. Each cycle resumes where last left off.

### Overview

RDS EOL upgrades use blue-green deployments in app-interface. Stage needs 4-5 MRs (incl. optional param group prep), prod needs 5-6 (extra status page MR).

### MR Sequence — Stage

0. **Source param group prep** — check source param group for `rds.logical_replication = 1`. Missing → MR to add. MUST merge + wait for AWS apply (pending-reboot) BEFORE blue-green MR. CI dry-run validates against live AWS state.
1. **Create blue-green** — add `blue_green` section + target (postgres17) param group file. Target MUST include `rds.logical_replication = 1` + `rds.force_ssl = 1` (both `apply_method: pending-reboot`). Copy other params from source.
2. **Switchover** — ONLY: `switchover: true`. No other changes. No instance overrides to main spec.
3. **Delete** — ONLY: `delete: true`. No other changes. Removes old instance.
4. **Cleanup** — remove `blue_green_deployment` section, update main spec w/ new instance config, re-enable `deletion_protection`, remove `apply_immediately`.

### MR Sequence — Prod (same + status page)

0. **Source param group prep** — same as stage.
1. **Status page maintenance** — create maintenance incident before window.
2. **Create blue-green deployment**
3. **Switchover** — ONLY: `switchover: true`. Nothing else.
4. **Delete** — ONLY: `delete: true`. Nothing else.
5. **Cleanup** — remove blue-green config, update main spec, close status page incident.

### Critical Rules

- **Each MR does ONE thing.** Never combine switchover + delete or any other steps.
- **Main spec = ORIGINAL (blue) instance.** Adding overrides (`instance_class`, `allocated_storage`) to main spec during switchover/delete would resize live prod DB. Only update main spec in cleanup MR after old instance gone.
- **`blue_green_deployment` section = NEW (green) instance.** Instance type, storage, engine version, param group set in create step (step 1).
- **Wait between steps.** Each MR must merge + verify before opening next.
- **Do NOT proactively rebase app-interface MRs.** Auto-rebase built in. Only rebase when pipeline failed due to merge conflicts + no auto-rebase happened recently.

### Multi-Cycle Workflow

NOT a single-cycle task. Each MR may need review + merge before next.

Track in `task_update` metadata:
```json
{
  "last_step": "stage_mr1_opened",
  "next_step": "wait_for_mr1_merge_then_open_mr2",
  "environment": "stage",
  "mrs_opened": [{"mr_number": 123, "phase": "blue_green_create", "status": "open"}],
  "mrs_remaining": ["switchover", "delete", "cleanup"]
}
```

Cycle behavior:
- **First cycle**: Read ticket comments. Check source param group for `rds.logical_replication`. Missing → param group MR (step 0). Present → blue-green MR (step 1). Update task.
- **Subsequent**: Check prev MR status. Merged → open next. Feedback → address. **Step 0 → 1**: after param group MR merges, wait one cycle for AWS apply.
- **Between phases**: Stage complete before prod starts. Track `environment` in metadata.

### MR Content

Each MR modifies YAML in `data/services/insights/` or related paths. Follow existing patterns — `git log` for similar completed upgrades.

Conventional commits: `fix(app-interface): RDS blue-green create for <service> stage`

### Do NOT Skip These Tickets

RDS upgrades = well-defined multi-step processes. Each MR = simple YAML change. Complexity = sequencing, handled by task tracking.

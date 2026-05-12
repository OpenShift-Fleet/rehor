## Config Repo Guidelines

Config repo (e.g. app-interface).

### Cloning
- Large repos → `--depth 1`, deepen w/ `git fetch --deepen=50` as needed.

### Before Changes
- Read repo `CLAUDE.md`/`AGENTS.md` — strict validation rules.
- Understand schema + structure before modifying.

### Dev
- YAML/JSON files for env settings, deploy params, service config.
- Follow existing structure + naming exactly.
- Run validation/linting (`make validate`, `make bundle validate`) before commit.
- Do NOT invent/guess values — verify against schema or existing examples.
- Conventional commits: `fix(app-interface): update frontend deployment config`.

### Rebasing — app-interface

App-interface has **automatic rebase**. Do NOT proactively rebase MRs.

Only rebase when ALL true:
1. Pipeline **failed**
2. Failure = merge conflicts (not code issue)
3. No auto-rebase happened recently (CI re-ran in last hour → wait)

MR shows `need_rebase` but pipeline passing/running → **leave it alone**.

### Blue-green RDS upgrades

Strict multi-MR sequence. Each MR does ONE thing. Never combine steps.

**Key rules:**
- `blue_green_deployment` section = NEW (green) instance config.
- Main spec (outside `blue_green_deployment`) = ORIGINAL (blue) instance.
- **NEVER add instance overrides (`instance_class`, `allocated_storage`) to main spec** during switchover/delete. Would resize live prod DB.
- Main spec updates → **cleanup MR only** (after old instance deleted + `blue_green_deployment` removed).

**MR sequence (each must merge + verify before next):**

1. **Create** — add `blue_green_deployment` section + target param group file.
2. **Switchover** — ONLY: `switchover: true`. Nothing else.
3. **Wait** — verify switchover success. Jira comment confirming.
4. **Delete** — ONLY: `delete: true`. Removes old instance.
5. **Cleanup** — remove `blue_green_deployment`, update main spec w/ new instance config, re-enable `deletion_protection`, remove `apply_immediately`.

Prod: add status page maintenance MR before switchover.

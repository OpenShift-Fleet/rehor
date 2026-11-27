# Vendored Fabric runner-restoration contract

Unmodified copies of the Fabric review-only workflow files that define and
implement the `work.ledger_restore = "runner"` hand-off this preflight's start
content must satisfy:

- `restore_review_ledger.py` — the runner-side restoration CLI
- `review_ledger.py` / `public_comment_safety.py` — the ledger codec it reuses
- `persist_pending_publication.py` / `post_review.py` / `resolve_review_threads.py` — its import closure

Source: Fabric draft #191 worktree (`fabric-access-ai-dev-191-secret-refs`,
commit `68f9a5a`), `instance/rbac-config-review/agent/workflows/review-only/`
plus `agent/skills/restore-review-ledger/SKILL.md` (the invocation contract,
not copied here — see the `fabric-review-queue` tests that build the exact
command). The files are vendored so the end-to-end contract test runs the
real consumer code without depending on a Fabric checkout; refresh this
directory deliberately when the Fabric contract changes.

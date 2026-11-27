# Vendored Fabric review-queue parity goldens

Unmodified copies of the Fabric review-only workflow files that implement
the queue this preflight ports, plus the scaffolding that runs them as a
parity oracle:

- `review_queue.py` — the queue itself: candidate ladder, command scans,
  review-approval and ledger-recovery decisions, restore ordering
- `review_config.py`, `review_bot_commands.py`, `review_comment_footer.py`,
  `rereview_requests.py` — its import closure (config validation, contextual
  command parsing, the bot comment footer, re-review/verify command scans)
- `review_ledger.py`, `public_comment_safety.py`, `post_review.py`,
  `resolve_review_threads.py` are not duplicated here — the identical copies
  in `../fabric-restore-review-ledger/` are reused through `sys.path`

Scaffolding (not Fabric code):

- `common.py` — a stub of the `dev-bot` preflight helpers `review_queue.py`
  imports; `run_queue.py` patches every one of them before `main()` runs
- `run_queue.py` — the driver: reads one JSON scenario, patches the external
  boundaries (Bot Memory, the `gh` CLI, organization membership), runs the
  real `review_queue.main()`, and prints the result plus the gh api mutations

Source: Fabric `fabric-access-upstream-parity` worktree, commit `37d5263`
(`instance/rbac-config-review/agent/workflows/review-only/`). The
`fabric-review-queue` tests use this driver as the behavioral golden for the
approval, resume, recovery, and pending-publication paths: the TypeScript
port must emit the same start/skip/error outcomes, the same work fields
(modulo the documented `ledger_restore` runner hand-off replacing Python's
`ledger_path`), and byte-identical consent-comment bodies. Refresh this
directory deliberately when the Fabric reference changes.

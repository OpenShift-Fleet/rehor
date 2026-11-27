# Static Fabric review-queue goldens

`fabric-review-queue-golden.json` holds, for nine approval / resume /
recovery / pending-publication scenarios, the scenario inputs plus the
outcome the real Fabric `review_queue.py` (commit `37d5263`) produced for
them: result status, result content (the emitted work JSON for starts), and
the `gh api` mutations (including the exact consent-comment bodies).

Generated once on 2026-11-27 by running the Fabric reference against
stubbed Bot Memory, `gh` CLI, and organization-membership boundaries — every
queue decision path executed the real Python code. The `fabric-review-queue`
tests replay each stored scenario through the TypeScript port and require
identical outcomes, identical work fields (modulo the documented
`ledger_restore` runner hand-off replacing Python's `ledger_path`), and
byte-identical consent-comment bodies.

No Fabric source is vendored in this repository and CI runs no Python.
Regenerating the goldens requires a Fabric checkout at the reference commit
and re-stubbing the same boundaries; refresh deliberately when the Fabric
reference changes, and record the new source commit here.

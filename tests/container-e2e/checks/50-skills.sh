#!/usr/bin/env bash
set -euo pipefail

CONTAINER="$1"
RUNTIME="$2"

# Static checks — shared skill files present and loader wired correctly
"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
test -f presets/shared/skills/auto-fork/README.md
test -f presets/shared/skills/post-pr/README.md
grep -q "shared_dir = profile_dir.parent / \"shared\" / \"agent\"" bot/run.py
echo "shared skill source + loader wiring OK"
'

# CLI wiring — dev-bot --help must succeed (verifies uv + bot package intact)
if ! "$RUNTIME" exec "$CONTAINER" bash -lc 'uv run dev-bot --help >/dev/null 2>&1'; then
  echo "::error::dev-bot --help failed"
  exit 1
fi
echo "dev-bot --help OK"

# Runtime check — install_skills() provenance: shared skills get shared: prefix,
# workflow-owned skills (claim-ticket, wrap-up) get workflow: prefix
"$RUNTIME" exec "$CONTAINER" bash -lc '
set -euo pipefail
python3 - <<PY
from bot.merge import install_skills
from pathlib import Path

result = install_skills(
    Path("."),
    Path("presets/workflows/jira-sprint"),
    [],
)

expected_shared = ["shared:push-and-pr", "shared:post-pr", "shared:auto-fork"]
for skill in expected_shared:
    assert skill in result, f"expected {skill!r} in install_skills result; got: {result}"

expected_workflow = ["workflow:claim-ticket", "workflow:wrap-up"]
for skill in expected_workflow:
    assert skill in result, f"expected {skill!r} in install_skills result; got: {result}"

print("install_skills provenance OK:", result)
PY
'

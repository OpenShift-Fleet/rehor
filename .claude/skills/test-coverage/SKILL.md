---
name: test-coverage
description: >
  Evaluate test coverage for current branch/PR, enforce thresholds, report metrics.
  Supports Jest, Vitest, pytest, Go. Can check full coverage or diff-only (changed lines).
when_to_use: >
  Invoke after implementing changes and tests pass, before opening PR. Triggers on:
  "check coverage", "test coverage", "coverage report", "/test-coverage".
  Use to verify new code has adequate test coverage (70%+ default threshold).
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/test-coverage/scripts/coverage_operations.py *)"
  - Read
  - mcp__bot-memory__memory_store
---

## Usage

Evaluate test coverage for the current branch:

```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py [--threshold 70] [--diff-only] [--pr-comment] [--enforce] [--dry-run] 2>&1
```

**Arguments**:
- `--threshold N`: Coverage threshold percentage (default: 70)
- `--diff-only`: Only check coverage for changed lines (not full codebase)
- `--pr-comment`: Post coverage report as PR comment
- `--enforce`: Exit 1 if threshold not met (for CI integration)
- `--dry-run`: Preview without executing

## Operations Workflow

1. **Detect repository type** - Determine language/framework from repo files (package.json, pyproject.toml, go.mod)
2. **Run coverage** - Execute appropriate coverage command (jest, vitest, pytest, go test)
3. **Parse coverage report** - Extract coverage metrics from JSON/text output
4. **Get PR diff** (if `--diff-only`) - Fetch changed files/lines via gh/glab
5. **Calculate diff coverage** - Intersect coverage data with changed lines
6. **Check threshold** - Compare against required threshold
7. **Generate report** - Format human-readable coverage summary
8. **Post PR comment** (if `--pr-comment`) - Add coverage report to PR
9. **Store metrics** - Save to memory for trend analysis

## Supported Frameworks

| Framework | Detection | Coverage Command | Report Format |
|-----------|-----------|------------------|---------------|
| Jest | `devDependencies.jest` in package.json | `npm test -- --coverage --coverageReporters=json-summary` | `coverage/coverage-summary.json` |
| Vitest | `devDependencies.vitest` in package.json | `npx vitest run --coverage --coverage.reporter=json-summary` | `coverage/coverage-summary.json` |
| pytest | `pyproject.toml` or `setup.py` exists | `uv run pytest --cov=. --cov-report=json` or `pytest --cov=. --cov-report=json` | `coverage.json` |
| Go | `go.mod` exists | `go test ./... -coverprofile=coverage.out` | `coverage.out` |

## Examples

**Basic usage** (check overall coverage):
```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py
```

**Check only changed lines** (recommended for PRs):
```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py --diff-only --threshold 70
```

**Post report to PR**:
```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py --diff-only --pr-comment
```

**Enforce threshold** (fail if below 80%):
```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py --threshold 80 --enforce
```

**Dry run** (preview without executing):
```bash
python3 .claude/skills/test-coverage/scripts/coverage_operations.py --dry-run
```

## Integration with Bot Workflow

Add to CLAUDE.md workflow after "Testing mandatory" (line ~345):

```markdown
- **Coverage check**: After tests pass, run `/test-coverage --diff-only --threshold 70`.
  If below threshold, add tests for uncovered changed lines. Re-run until threshold met.
```

## Error Handling

- **No coverage tool detected** → Returns SKIPPED with suggestion to install jest/pytest
- **Coverage command fails** → Returns FAILED with stderr output
- **Report file missing** → Returns FAILED, check command output
- **No PR found** (diff-only mode) → Returns SKIPPED, use full coverage
- **Malformed coverage JSON** → Returns FAILED with parse error
- **Network timeout** (PR fetch) → Returns FAILED after 30s timeout

Fail-fast approach: if any critical operation fails, execution stops and reports the error.

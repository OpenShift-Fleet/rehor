# Container E2E Runtime Validation (REHOR-62)

This document tracks the REHOR-62 runtime validation harness that closes the
multi-container startup and `entrypoint.sh` gap intentionally deferred by
REHOR-107.

## Scope

The harness validates container runtime behavior, not only build-time tooling:

- bot starts through real `entrypoint.sh` with proxy + memory-server sidecars,
- executor socket readiness and memory-server health dependencies are exercised,
- Python imports and core runtime tooling are validated from inside the image,
- env-specific checks are fixture-driven (`minimal`, `full-stack`, `browser-only`).

## Harness layout

- `tests/container-e2e/sync-devbot.sh`
- `tests/container-e2e/test-container.sh`
- `tests/container-e2e/lib/common.sh`
- `tests/container-e2e/checks/*.sh`
- `tests/container-e2e/fixtures/*`

## CI wiring

- PR/default workflow: `.github/workflows/container-e2e.yml`
  - `e2e-minimal` job
- Manual workflow: `.github/workflows/container-e2e-manual.yml`
  - `e2e-full-stack` (node + go + container-scan)
  - `e2e-browser` (browser-only)

This staged approach keeps PR checks stable while preserving a path for deeper
preset coverage.

## Local runbook

```bash
make container-e2e
```

Run explicit fixture:

```bash
bash tests/container-e2e/test-container.sh --fixture full-stack
```

Keep logs and temporary context:

```bash
bash tests/container-e2e/test-container.sh --fixture full-stack --keep-artifacts
```

Collect logs into a specific directory:

```bash
bash tests/container-e2e/test-container.sh --fixture minimal --artifacts-dir /tmp/rehor62-logs
```

## Known behavior captured during initial rollout

- `minimal` fixture passes end-to-end locally.
- Browser coverage can fail when runner/build-host disk is constrained because
  Playwright Chromium download and browser runtime packages are large; browser
  checks are isolated in `browser-only` so core full-stack validation stays
  deterministic.
- Heavy fixtures now perform a Docker-engine free-space preflight and fail fast
  with an explicit disk-headroom message instead of failing late in long build
  steps.

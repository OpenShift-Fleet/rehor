# Container E2E Harness (REHOR-62)

This directory contains the first in-repo version of the REHOR-62 container E2E harness.

It validates runtime behavior that `container-verify.yml` intentionally does not cover:

- real `entrypoint.sh` startup path (with proxy sidecar + memory-server),
- baseline tool and import checks in the running bot container,
- env-specific checks driven by fixture inputs.

## Layout

- `sync-devbot.sh`: creates an isolated temporary build context for `Dockerfile.runner`.
- `test-container.sh`: orchestrates build + multi-container startup + checks.
- `lib/common.sh`: shared logging/wait helpers.
- `checks/*.sh`: focused validation checks.
- `fixtures/*`: fixture-specific `instance/` input and expected env checks.

## Run locally

```bash
bash tests/container-e2e/test-container.sh --fixture minimal
```

Run the broader env preset fixture:

```bash
bash tests/container-e2e/test-container.sh --fixture full-stack
```

Run browser coverage explicitly:

```bash
bash tests/container-e2e/test-container.sh --fixture browser-only
```

Keep logs and temporary build context for debugging:

```bash
bash tests/container-e2e/test-container.sh --fixture full-stack --keep-artifacts
```

Export logs to an explicit folder:

```bash
bash tests/container-e2e/test-container.sh --fixture minimal --artifacts-dir /tmp/rehor62-logs
```

## Fixture notes

- `minimal`: baseline runtime/entrypoint checks, stable default.
- `full-stack`: node + go + container-scan coverage (no browser).
- `browser-only`: browser preset coverage isolated because Chromium download and
  runtime dependencies are much heavier and can be sensitive to runner disk
  headroom.
- Heavy fixtures (`full-stack`, `browser-only`) run a Docker-engine free-space
  preflight and fail fast with a clear message if disk headroom is too low.

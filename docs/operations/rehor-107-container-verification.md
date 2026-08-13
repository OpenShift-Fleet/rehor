# Container Build Verification (REHOR-107)

This documents what `.github/workflows/container-verify.yml` actually checks, why the bot job differs from the proxy and memory-server jobs, and what's explicitly deferred to REHOR-62.

## What each job verifies

The workflow runs three independent jobs — `verify-bot`, `verify-proxy`, `verify-memory-server` — rather than one matrix job, because each image has a different runtime dependency surface and needs different services/env to smoke-test. Running them as separate jobs also means a failure in one image's build or smoke check shows up as its own named, unambiguous entry in the PR checks list.

| Job | Builds | Smoke check | Real runtime check? |
|-----|--------|-------------|----------------------|
| `verify-bot` | `Dockerfile` | Verifies required tooling is present and executable (`python3`, `uv`, `git`, `tini`, `bwrap`, `buildah`, `node`, `go`, `gh`, `glab`, `gpg`) | No — see below |
| `verify-proxy` | `proxy/Dockerfile` | Starts the container with a dummy `GH_TOKEN`, waits for Squid to answer `squidclient mgr:info`, checks the executor socket exists | Yes |
| `verify-memory-server` | `memory-server/Dockerfile` | Starts the container against a real `pgvector/pgvector:pg17` service, polls `GET /health` | Yes |

## Why bot's check is tooling-presence, not a live start

The bot image's `ENTRYPOINT` is `entrypoint.sh`, which unconditionally waits up to 30 seconds for a Unix socket at `EXECUTOR_ADDR` (default `/var/run/devbot/executor.sock`) and hard-exits if it never appears:

```bash
until [ -S "$SOCK_PATH" ]; do
    elapsed=$((elapsed + 1))
    [ "$elapsed" -ge 30 ] && { echo "FATAL: executor socket not ready after 30s" >&2; exit 1; }
    sleep 1
done
```

That socket is only created by the proxy sidecar's `executor-server`. `entrypoint.sh` also expects `GH_USER_EMAIL`/`GL_USER_EMAIL`/GPG signing keys and depends on the memory-server and proxy health URLs being reachable. None of that exists for a standalone `docker run` of the bot image in an isolated CI job — running the real entrypoint here would always dead-end at the executor wait, regardless of whether the image itself is healthy.

So `verify-bot` bypasses `entrypoint.sh` entirely (`--entrypoint bash`) and instead confirms the build actually produced a working image: every binary the Dockerfile installs is present and runnable. `gh`, `glab`, and `gpg` are checked with `command -v` only, never invoked — they're symlinks to the executor thin client (`proxy/executor/cmd/client`), which dials `EXECUTOR_ADDR` immediately regardless of arguments and would fail without a live socket. That's expected and intentionally out of scope for this check.

## Why proxy and memory-server get real smoke checks

Unlike the bot image, both of these can genuinely start standalone:

- **proxy**: `start.sh` treats `GITLAB_TOKEN`, `GPG_PRIVATE_KEY_B64`, `GOOGLE_SA_KEY_B64`, and the Jira variables as optional — each is wrapped in `if [ -n "${VAR:-}" ]`. Only `GH_TOKEN` is written unconditionally (an empty/dummy value is fine), and Squid + `executor-server` always start. The smoke check reuses the exact command `docker-compose.yml` already uses as its own healthcheck (`squidclient -h 127.0.0.1 -p 3128 mgr:info`) plus a socket existence check.
- **memory-server**: exposes `GET /health` returning `{"status": "ok"}`, but its `lifespan()` hook calls `init_pool()` first, so it needs a real Postgres with the `vector` extension available. The smoke check reuses the same `pgvector/pgvector:pg17` service pattern already established in `.github/workflows/memory-server-ci.yml`.

## What's deferred to REHOR-62

REHOR-62 ("Add container e2e test suite for env presets and entrypoint validation") owns full multi-container runtime verification: launching the bot image with a live executor sidecar, proxy, and memory-server, and running the real `entrypoint.sh` end to end. A prototype already exists in the separate `test-preset-instance` repo (`sync-devbot.sh` + `test-container.sh`, ~40 validation checks covering env presets, entrypoint stages, tool availability, and skill loading).

This ticket deliberately does not replicate that. Once REHOR-62 lands and is wired into this repo's CI, it can replace or extend `verify-bot` with a real entrypoint-driven smoke test instead of the tooling-presence check documented above.

## Non-blocking behavior for unrelated PRs

`container-verify.yml` is path-filtered like every other GitHub Actions workflow in this repo (see the trigger `paths:` list in the workflow file). GitHub does not render a "skipped" status for a workflow that never triggered — it simply doesn't appear on the PR's checks list at all. "Non-blocking for unrelated PRs" means exactly that: a PR that doesn't touch any container-relevant path never sees this check, the same way `format`/`lint`/`typecheck`/`test` don't appear on a PR that only touches Go code.

## Required-checks status

None of these three jobs run unconditionally on every PR (they're all path-filtered), so per the existing branch-protection policy documented in `.github/branch-protection/required-checks.json` and `.github/branch-protection/README.md`, they stay advisory rather than hard-required. This mirrors every other GitHub Actions check in this repo — only the two Konflux checks that fire on every PR with no path filter are hard-required in branch protection.

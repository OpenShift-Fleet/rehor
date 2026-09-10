# Integration Tests

Tests in this directory require external services and are **excluded from CI
pytest collection** via `--ignore=tests/integration` in `pyproject.toml`.

## Prerequisites

1. **Docker Compose stack running**:
   ```bash
   docker compose up -d
   ```
   (or `make docker-up`)

2. **Environment variables** (in `.env` file):
   ```bash
   GH_TOKEN=ghp_your_github_token
   GITLAB_TOKEN=glpat_your_gitlab_token  # Optional
   GL_USERNAME=your_gitlab_username      # Optional
   ```

## Running

```bash
# Via Makefile
make test-integration

# Directly
pytest tests/integration/ -v

# Specific file/class/test
pytest tests/integration/test_git_proxy_integration.py::TestGitProxyEndToEnd -v
```

## Adding new integration tests

Place any test that requires Docker, docker-compose, live databases, or
external network access in this directory. Tests under this directory are
marked `@pytest.mark.integration` via the local `conftest.py` (path-filtered
so mixed `pytest tests/integration tests/...` sessions do not mark unit tests).

Unit tests (mocked, no external deps) belong in `bot/tests/`, `tests/`,
or the appropriate skill `tests/` directory.

If the docker-compose stack is not running, these tests **skip** rather than
fail. That is the right laptop default. A scheduled/CI job that must actually
exercise the stack should treat skips as a problem (for example by requiring
the proxy health check to pass before invoking `make test-integration`).

## `test_git_proxy_integration.py`

Validates end-to-end git operations (clone, fetch) through the Git Auth
Reverse Proxy with credential injection.

### Test coverage

- **TestGitProxyEndToEnd** — `/healthz` endpoint, git clone/fetch through the proxy
- **TestGitProxyConfigMigration** — `GIT_AUTH_PROXY_HOST` env var, `.gitconfig` `insteadOf` rewrites
- **TestGitProxyErrorHandling** — 400 for malformed requests, 403 for unknown hosts, 503 when token missing
- **TestGitProxyValidation** — proxy starts with valid config

### Expected test flow

1. Tests check if the docker-compose stack is running
2. If the proxy isn't healthy, tests are skipped (not failed)
3. Bot container executes git commands through the proxy
4. Proxy logs are inspected to verify traffic routing
5. Git operations are validated by checking cloned files

### Troubleshooting

Tests skip with "Proxy service not healthy":
```bash
docker compose ps proxy
docker compose logs proxy
docker compose exec proxy curl http://localhost:8447/healthz
```

Git clone fails with authentication error:
```bash
docker compose exec proxy sh -c 'echo $GH_TOKEN'
docker compose logs proxy | grep gitauth
```

Tests fail with "docker-compose.yml not found" — run from the repo root:
```bash
cd /path/to/rehor
pytest tests/integration/test_git_proxy_integration.py -v
```

### Notes

- Tests use public GitHub repos to avoid authentication dependencies
- Tests clean up `/tmp/test-clone` between runs
- Proxy logs are checked with `--since 2m` to avoid noise from other services
- Tests are designed to be idempotent (can run multiple times)

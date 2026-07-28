# Git Proxy Integration Tests

Integration tests for the Git Auth Reverse Proxy feature (`test_git_proxy_integration.py`).

## Prerequisites

1. **Docker Compose stack running**:
   ```bash
   docker compose up -d
   ```

2. **Environment variables** (in `.env` file):
   ```bash
   GH_TOKEN=ghp_your_github_token
   GITLAB_TOKEN=glpat_your_gitlab_token  # Optional
   GL_USERNAME=your_gitlab_username      # Optional
   ```

3. **Proxy container healthy**:
   The proxy must expose port 8447 for the git-auth proxy (this is Phase 2 work).

## Running the Tests

### Run all git proxy integration tests:
```bash
pytest tests/test_git_proxy_integration.py -v
```

### Run specific test class:
```bash
pytest tests/test_git_proxy_integration.py::TestGitProxyEndToEnd -v
```

### Run specific test:
```bash
pytest tests/test_git_proxy_integration.py::TestGitProxyEndToEnd::test_git_clone_public_repo_through_proxy -v
```

### Run with detailed output:
```bash
pytest tests/test_git_proxy_integration.py -vvs
```

## Test Coverage

### TestGitProxyEndToEnd
- **test_proxy_healthz_endpoint**: Verifies `/healthz` endpoint is accessible
- **test_git_clone_public_repo_through_proxy**: Clones a public GitHub repo through proxy
- **test_git_fetch_through_proxy**: Tests git fetch operation

### TestGitProxyConfigMigration
- **test_proxy_mode_env_var_present**: Checks `GIT_AUTH_PROXY_HOST` env var
- **test_gitconfig_has_insteadof_when_proxy_available**: Validates `.gitconfig` URL rewrites

### TestGitProxyErrorHandling
- **test_proxy_returns_400_for_bare_path**: Validates 400 error for malformed requests
- **test_proxy_returns_403_for_unknown_host**: Validates 403 error for unknown hosts
- **test_proxy_returns_503_when_token_missing**: Documents expected behavior (skip in tests)

### TestGitProxyValidation
- **test_proxy_validates_config_at_startup**: Verifies proxy starts with valid config

## Expected Test Flow

1. Tests check if docker-compose stack is running
2. If proxy not healthy, tests are skipped (not failed)
3. Bot container executes git commands through proxy
4. Proxy logs are inspected to verify traffic routing
5. Git operations are validated by checking cloned files

## Troubleshooting

### Tests skip with "Proxy service not healthy"
```bash
# Check proxy container status
docker compose ps proxy

# Check proxy logs
docker compose logs proxy

# Verify healthz endpoint
docker compose exec proxy curl http://localhost:8447/healthz
```

### Git clone fails with authentication error
```bash
# Verify GH_TOKEN is set in proxy container
docker compose exec proxy sh -c 'echo $GH_TOKEN'

# Check if proxy received the token
docker compose logs proxy | grep gitauth
```

### Tests fail with "docker-compose.yml not found"
```bash
# Run tests from repository root
cd /path/to/rehor
pytest tests/test_git_proxy_integration.py -v
```

## Phase 1 vs Phase 2

**Phase 1** (current): 
- Proxy implementation exists (`proxy/executor/gitauth.go`)
- Unit tests pass
- Integration tests written but may skip if proxy not fully integrated

**Phase 2** (future):
- Proxy integrated into docker-compose (port 8447 exposed)
- `bot/run.py` updated to generate `.gitconfig` with `insteadOf` rewrites
- Integration tests fully functional

## CI/CD Integration

These tests can be added to GitHub Actions workflow:

```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

on:
  pull_request:
    paths:
      - 'proxy/executor/**'
      - 'tests/test_git_proxy_integration.py'

jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up environment
        run: |
          echo "GH_TOKEN=${{ secrets.GH_TOKEN }}" >> .env
      - name: Start docker-compose stack
        run: docker compose up -d
      - name: Wait for services
        run: sleep 30
      - name: Run integration tests
        run: pytest tests/test_git_proxy_integration.py -v
      - name: Show logs on failure
        if: failure()
        run: docker compose logs
```

## Notes

- Tests use public GitHub repos to avoid authentication dependencies
- Tests clean up `/tmp/test-clone` between runs
- Proxy logs are checked with `--since 2m` to avoid noise from other services
- Tests are designed to be idempotent (can run multiple times)

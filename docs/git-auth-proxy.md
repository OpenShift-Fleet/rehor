# Git Auth Reverse Proxy Design

HTTP reverse proxy that injects Git credentials into push/pull requests, eliminating PAT exposure in workload pods.

---

## Problem

Today git credentials reach the workload container through a credential-helper chain:

```
workload: git push
  → git calls `gh auth git-credential` (via .gitconfig credential helper)
  → hardlink routes to executor-client (thin gRPC client)
  → executor-server (proxy deployment) runs real `gh auth git-credential`
  → reads ~/.config/gh/hosts.yml → returns PAT
  → git receives the PAT in the workload container
  → git makes HTTPS request to github.com with PAT in Authorization header
```

The PAT transits through the gRPC response and lives in git's memory inside the workload container. The workload never sees the token in a file, but it exists in process memory during the push. This is a defense-in-depth gap — a compromised workload process could intercept the credential helper response.

The same issue applies to GitLab tokens via `glab credential-helper get`.

## Proposed Solution

Replace the credential-helper flow with an HTTP reverse proxy. Git never receives the token — the proxy injects it on the upstream leg:

```
bot pod                             proxy deployment                 upstream
─────────────────                   ──────────────────               ─────────
git push origin main
  │
  │  git config url rewrite:
  │  https://github.com/ → http://devbot-proxy:8447/github.com/
  │
  ├─── HTTP ──► devbot-proxy:8447 ───── HTTPS + PAT ──► github.com
  │             (inject Authorization)
  │
  ◄─── response ◄───────────────────◄─── response ◄────────────────
```

The bot pod uses plain HTTP to the proxy's ClusterIP Service (`devbot-proxy`, same as Squid/Vertex/Jira). The proxy upgrades to HTTPS and injects the token. Git smart HTTP protocol (info/refs, git-receive-pack, git-upload-pack) works transparently through `httputil.ReverseProxy`.

## Architecture

### Where It Lives

New listener in the existing executor server (`proxy/executor/cmd/server/main.go`), following the same pattern as the other reverse proxies. The proxy is a **separate Deployment** (`${PROXY_NAME}`, default `devbot-proxy`) exposed via a ClusterIP Service — NOT a sidecar. Bot pods reach it over the cluster network.

| Existing proxy | Port | Service address | Auth method |
|---|---|---|---|
| Squid | `:3128` | `devbot-proxy:3128` | N/A (allowlist) |
| Executor (gRPC) | `:9090` | `devbot-proxy:9090` | N/A (UDS in-pod) |
| Vertex AI | `:8443` | `devbot-proxy:8443` | GCP OAuth2 Bearer token |
| Jira MCP | `:8444` | `devbot-proxy:8444` | Basic auth (username:token) |
| Screenshot upload | `:8446` | `devbot-proxy:8446` | GitHub Bearer token |
| **Git auth (new)** | **`:8447`** | **`devbot-proxy:8447`** | **Per-host (see below)** |

Single port, multi-host. The proxy determines the upstream host and auth method from the request URL path.

### URL Scheme

The bot rewrites git URLs programmatically during startup. `setup_git()` in `bot/run.py` already generates `.gitconfig` — the `insteadOf` rewrites replace the existing credential helper sections:

```ini
# In generated .gitconfig (replaces [credential] sections):
[url "http://devbot-proxy:8447/github.com/"]
    insteadOf = https://github.com/

[url "http://devbot-proxy:8447/gitlab.cee.redhat.com/"]
    insteadOf = https://gitlab.cee.redhat.com/
```

The proxy host (`devbot-proxy`) comes from `${PROXY_NAME}` — passed to the bot pod as an env var (e.g. `GIT_AUTH_PROXY_HOST`). No manual `git config` commands needed.

The proxy extracts the real host from the first path segment:

```
Request:  GET http://devbot-proxy:8447/github.com/org/repo.git/info/refs?service=git-upload-pack
Upstream: GET https://github.com/org/repo.git/info/refs?service=git-upload-pack
          + Authorization: Bearer <GH_TOKEN>
```

### Host Registry

The proxy maintains a map of allowed hosts and their auth configuration:

```go
type GitHost struct {
    Scheme   string            // "https"
    AuthType string            // "bearer" or "basic"
    Token    func() string     // token getter (reads env at call time)
    Username func() string     // for basic auth only
}

var hosts = map[string]GitHost{
    "github.com": {
        Scheme:   "https",
        AuthType: "bearer",
        Token:    func() string { return os.Getenv("GH_TOKEN") },
    },
    "gitlab.cee.redhat.com": {
        Scheme:   "https",
        AuthType: "basic",
        Username: func() string { return os.Getenv("GL_USERNAME") },
        Token:    func() string { return os.Getenv("GITLAB_TOKEN") },
    },
}
```

Requests to unregistered hosts are rejected with 403. This is a security boundary — the proxy only forwards to explicitly configured git providers.

### Request Flow

```
1. Parse host from URL path: /github.com/org/repo.git/... → host="github.com"
2. Look up host in registry → found? continue : 403
3. Strip host prefix from path: /org/repo.git/info/refs
4. Build upstream URL: https://github.com/org/repo.git/info/refs
5. Inject auth header:
   - bearer: Authorization: Bearer <token>
   - basic:  Authorization: Basic base64(username:token)
6. Forward request via httputil.ReverseProxy
7. Return response unchanged
```

### Git Smart HTTP Protocol

Git over HTTPS uses two endpoints per repo:

| Endpoint | Method | Purpose |
|---|---|---|
| `/<repo>.git/info/refs?service=git-upload-pack` | GET | Clone/fetch — discover refs |
| `/<repo>.git/info/refs?service=git-receive-pack` | GET | Push — discover refs |
| `/<repo>.git/git-upload-pack` | POST | Clone/fetch — transfer objects |
| `/<repo>.git/git-receive-pack` | POST | Push — transfer objects |

`httputil.ReverseProxy` handles all of these transparently, including:
- Large request bodies (pack data during push)
- Chunked transfer encoding
- Content-Type negotiation (`application/x-git-*`)

No special handling needed — the proxy is auth injection only.

## Implementation

### New File: `proxy/executor/gitauth.go`

```go
package executor

// NewGitAuthProxy creates an HTTP handler that injects git credentials
// into upstream requests based on the host extracted from the URL path.
//
// URL scheme: http://devbot-proxy:8447/<host>/<path>
// Example:    http://proxy:8447/github.com/org/repo.git/info/refs
//           → https://github.com/org/repo.git/info/refs + Authorization header
func NewGitAuthProxy() http.Handler
```

Follows the exact same pattern as `jira.go` and `vertex.go`:
- `httputil.ReverseProxy` with `Rewrite` function
- `statusRecorder` for access logging
- `/healthz` endpoint
- Request logging with method, host, path, status, duration

### Server Integration: `proxy/executor/cmd/server/main.go`

Add flags and startup, same pattern as jira/vertex:

```go
var gitAuthListen = flag.String("git-auth-listen", ":8447", "git auth proxy listen address")

// In main():
if os.Getenv("GH_TOKEN") != "" || os.Getenv("GITLAB_TOKEN") != "" {
    handler := executor.NewGitAuthProxy()
    gitAuthSrv = &http.Server{Addr: *gitAuthListen, Handler: handler}
    go func() {
        log.Printf("git-auth-proxy listening on %s", *gitAuthListen)
        // ...
    }()
}
```

### Workload Configuration: `bot/run.py`

In `setup_git()`, replace credential helper entries with `insteadOf` rewrites when `GIT_AUTH_PROXY_HOST` is set:

```python
git_proxy_host = os.environ.get("GIT_AUTH_PROXY_HOST")  # e.g. "devbot-proxy"
if git_proxy_host:
    # URL rewrite — token stays in proxy, never reaches bot pod
    lines.extend([
        f'[url "http://{git_proxy_host}:8447/github.com/"]',
        '\tinsteadOf = https://github.com/',
        f'[url "http://{git_proxy_host}:8447/gitlab.cee.redhat.com/"]',
        '\tinsteadOf = https://gitlab.cee.redhat.com/',
    ])
else:
    # Fallback: credential helper (local dev, proxy not available)
    lines.extend([
        '[credential "https://github.com"]',
        '\thelper = !/usr/local/bin/gh auth git-credential',
        '[credential "https://gitlab.cee.redhat.com"]',
        '\thelper = !/usr/local/bin/glab credential-helper',
    ])
```

The env var is injected by the deployment template from `${PROXY_NAME}`. No code change needed when the proxy Service name changes.

### Proxy Startup: `proxy/start.sh`

Add git-auth-proxy flags to executor-server launch. No separate process — it's another listener in the same binary:

```bash
/usr/local/bin/executor-server \
    --listen "${EXECUTOR_LISTEN:-unix:///var/run/devbot/executor.sock}" \
    --gh-path /usr/local/bin/gh-real \
    --glab-path /usr/local/bin/glab-real \
    --gpg-path /usr/bin/gpg \
    --git-auth-listen ":8447"
```

### Dockerfile: `proxy/Dockerfile`

Expose the new port:

```dockerfile
EXPOSE 8447
```

### OpenShift Deployment

Add port to the proxy container spec and ClusterIP Service (`deploy/template.yaml`):

```yaml
# In proxy container ports:
- containerPort: 8447
  name: git-auth
  protocol: TCP

# In proxy Service ports:
- port: 8447
  targetPort: git-auth
  protocol: TCP
  name: git-auth
```

## Security Considerations

### What This Eliminates

- PAT no longer transits through gRPC credential-helper response
- PAT no longer exists in git's process memory in the workload container
- `gh auth git-credential` and `glab credential-helper` can be removed from the executor allowlist (policy.go)

### What This Preserves

- All existing proxy security layers remain (Squid allowlist, executor policy, GPG isolation)
- Cluster-internal HTTP is not exposed outside the namespace (ClusterIP + NetworkPolicy)
- Host registry acts as an allowlist — only configured hosts are reachable through the proxy

### New Attack Surface

- **Cluster-internal HTTP**: Traffic between bot pod and proxy is unencrypted HTTP over the cluster network. This is acceptable — same pattern as Vertex proxy (`:8443`), Jira MCP (`:8444`), and screenshot (`:8446`). The proxy Service is ClusterIP (no external exposure) and protected by NetworkPolicy (`${PROXY_NAME}-ingress`).
- **Host injection**: A malicious git URL could try `http://proxy:8447/evil.com/...`. The host registry rejects unknown hosts with 403.
- **Path traversal**: The proxy must validate the extracted host against the registry before forwarding. No path traversal possible — the host is always the first path segment, and the upstream URL is constructed from the registry entry, not from the raw path.

### Credential Helper Cleanup

After the git-auth proxy is validated, remove credential helper support:

1. Remove `gh auth git-credential` from executor policy allowlist
2. Remove `glab credential-helper` handler from executor server
3. Remove credential helper lines from `.gitconfig` generation in `setup_git()`
4. Remove `needsStdin` cases for credential helpers in executor client

This is a separate follow-up — both paths can coexist during migration.

## Migration Plan

### Phase 1: Add Git Auth Proxy (non-breaking)

- Implement `gitauth.go` + tests
- Add `--git-auth-listen` flag to executor server
- Expose port in Dockerfile
- Proxy starts when `GH_TOKEN` or `GITLAB_TOKEN` env vars are present (already available in proxy container)

### Phase 2: Switch Workload to URL Rewrite

- Update `setup_git()` in `bot/run.py` to use `insteadOf` when `GIT_AUTH_PROXY` env var is set
- Deploy and validate pushes work through the proxy
- Both credential-helper and proxy paths work simultaneously

### Phase 3: Remove Credential Helper Path

- Remove credential helper from executor policy
- Remove credential helper handler from executor server
- Remove credential helper config from `.gitconfig` generation
- Clean up `needsStdin` in executor client

## Testing

### Unit Tests: `proxy/executor/gitauth_test.go`

| Test | What |
|---|---|
| `TestGitAuthProxy_GitHub` | GitHub URL → Bearer token injected, HTTPS upstream |
| `TestGitAuthProxy_GitLab` | GitLab URL → Basic auth injected, HTTPS upstream |
| `TestGitAuthProxy_UnknownHost` | Unknown host → 403 |
| `TestGitAuthProxy_NoHost` | Bare path (no host segment) → 400 |
| `TestGitAuthProxy_Healthz` | `/healthz` → 200 |
| `TestGitAuthProxy_LargeBody` | Simulated pack push (large POST body) → forwarded correctly |
| `TestGitAuthProxy_MissingToken` | Host configured but env var empty → 503 |
| `TestGitAuthProxy_EncodedHost` | `/%67ithub.com/org/repo` or `/github.com%2F..%2Fevil.com/...` → 403 (not in registry after decode) |
| `TestGitAuthProxy_PathTraversal` | `/github.com/../evil.com/org/repo` → 403 (cleaned path doesn't match registry) |

### Integration Tests

- `git clone` through proxy → success
- `git push` through proxy → success
- `git fetch` through proxy → success
- Concurrent pushes to different repos → no race conditions
- Upstream error (non-fast-forward) → error propagated transparently to workload

## Files

**New:**
- `proxy/executor/gitauth.go` — reverse proxy implementation
- `proxy/executor/gitauth_test.go` — unit tests

**Modified:**
- `proxy/executor/cmd/server/main.go` — add `--git-auth-listen` flag + startup
- `proxy/start.sh` — pass git-auth flag to executor-server
- `proxy/Dockerfile` — `EXPOSE 8447`
- `bot/run.py` — `setup_git()` uses `insteadOf` when proxy available
- `proxy/executor/policy.go` — (Phase 3) remove credential helper from allowlist
- `proxy/executor/cmd/client/main.go` — (Phase 3) remove credential helper stdin handling
- `proxy/squid.conf` — no changes needed (github.com and .redhat.com already allowed)

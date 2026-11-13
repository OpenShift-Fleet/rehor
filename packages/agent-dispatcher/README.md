# Agent dispatcher

The agent dispatcher is a long-running, non-HTTP Node.js process. It validates memory-server credentials and OpenShell Gateway authentication on startup. When agent repositories are configured, it runs their work preflights. It exposes no ports or HTTP API.

With no memory, Gateway, or agent repository configuration, the dispatcher starts and idles. Partial authentication configuration fails startup.

## Agent work preflights

Set `AGENT_DISPATCHER_CONFIG_REPOS` to a JSON array of trusted HTTPS or SSH Git repository URLs. Both the memory and Gateway configurations below must also be enabled; the authenticated memory URL must identify the exact `/health` endpoint. Set deployment-owned `BOT_MEMORY_URL` to the exact HTTPS `/mcp` endpoint on the same origin; missing or invalid values fail startup. `AGENT_DISPATCHER_CONFIG_DIR` optionally selects the writable checkout cache; the default is `rehor-agent-dispatcher` under the system temporary directory. The dispatcher checks each repository's default-branch SHA and fetches its pinned submodules when the revision changes or the local copy is missing. Startup fails fast when `git` is unavailable; synchronization failures surface only a coarse category (timeout, unavailable, rejected) so Git output and arguments never leak credentials.

Each `instance/*/agent/instance.yaml` selects a workflow and provides an image repository and optional tag. The omitted tag defaults to `latest`. Every profile requires a nonblank `BOT_INSTANCE_ID`; `preflight.env` overrides the deployment value for that profile. Non-secret `BOT_` settings under `preflight.env` are passed to that agent's sandbox runtime — an instance cannot override deployment-owned `BOT_MEMORY_URL` or operational variables the dispatcher forwards itself (proxies, `JIRA_MCP_URL`, `EXECUTOR_ADDR`); credentials belong in runtime secret mechanisms, not the repository. Missing or blank identity, memory URL, or minted memory credential blocks preflight and sandbox execution, including for an empty preflight list. A `preflight.error` record identifies the profile and missing field without exposing values. For example:

```yaml
workflow: onboarding
image:
  repository: quay.io/example/onboarding-agent
  tag: v1
preflight:
  env:
    BOT_INSTANCE_ID: onboarding-test
    BOT_LABEL: onboarding-test
preflights:
  - id: onboarding
    with:
      label: onboarding-test
  - gh-pr-status
```

Preflight execution uses [`@rehor/preflights`](../preflights/README.md). Each agent declares preflights in `preflights:` using shorthand strings or `{ id, with }` parameter entries. An omitted field inherits the workflow's central default set. A profile with neither a declaration nor a registered default returns an error. An explicit empty list (`[]`) declares no preflights.

The engine runs entries sequentially in declared order, at most once per agent every five minutes (the in-memory timer resets on restart). Its run context contains the per-cycle minted memory credential, instance identity, memory route, and optional services gateway. The instance's `project-repos.json` is used as-is. An actionable `start` among non-errored entries produces a start decision despite another entry's failure; all-skip is a skip; all-error is an error. The agent prompt contains `start` results only. Memory-server authorization failures fail the preflight instead of reporting empty results.

Only non-secret `BOT_` variables, `JIRA_MCP_URL`, `EXECUTOR_ADDR`, and proxy settings are forwarded from the dispatcher environment to the sandbox. The engine receives its wiring explicitly; its short-lived memory credential is minted per cycle, not passed through the process environment.

## Sandbox dispatch

A normal `start` decision creates a per-run workspace, provider, profile, and sandbox. The configured profile image is used without fallback; it must include Python 3.12 and Bash for the idle command and input-file write. Sandbox creation overrides the image's default entrypoint with an idle command and sets `restartPolicy: NEVER`. After the sandbox reaches `READY`, the dispatcher sends preflight output and starts the runner. Legacy layout invokes `/home/botuser/app/entrypoint.sh`; private layout uses the image's `/opt/rehor/sandbox-bootstrap.py`.

The dispatcher writes one UTF-8 JSON envelope to `/tmp/rehor-input.json` using exec stdin, creating the file with mode `0600`:

```json
{"schemaVersion":1,"runId":"…","prompt":"…","metadata":{"action":"start","scripts":[{"name":"…","status":"…"}]}}
```

The 64 KiB limit applies to the complete serialized envelope. An oversized or invalid envelope fails dispatch without creating a sandbox. Empty or whitespace-only prompts and `skip` or `error` decisions do not create a sandbox. Runs with an explicitly empty `preflights: []` declaration are rejected earlier by the engine as `no-scripts`; the envelope builder does not enforce that rule. Prompt contents travel through stdin, not environment variables, argv, sandbox configuration, or logs. The runner exec receives fixed per-exec controls, `REHOR_INPUT_SOURCE=sandbox` and `REHOR_INPUT_FILE=/tmp/rehor-input.json`, alongside its non-secret runtime settings; its output is discarded by the dispatcher. OpenShell SDK supports environment, argv, and stdin input, but stdin keeps prompt content out of inspectable configuration and process arguments. Each runner exec has a unique durable request ID; sandbox creation and exec are not automatically retried.

Non-secret `BOT_` settings and explicitly allowed service/proxy settings are forwarded to the sandbox, with agent-profile settings applied per agent. The dispatcher does not copy its raw process environment, `PATH`, or authentication credentials into the sandbox; the memory credential is delivered through its OpenShell provider. Existing memory and Gateway authentication variables below remain unchanged.

On completion, the dispatcher verifies resource ownership and confirms sandbox absence before dependent cleanup, then removes all run-owned resources. Ambiguous cleanup fails closed and retains the agent's in-flight reservation. `SessionDispatcher` allows one in-flight run per agent per process; reservations are process-local and cannot be recovered after a dispatcher restart.

The current bootstrap policy authorizes only Python access to the configured HTTPS memory `/health` endpoint, plus the optional model-gateway route below. Legacy layout keeps `/home/botuser/app` read-only and permits writes under `/tmp`, `/home/botuser/repos`, and `/home/botuser/data`. Private layout requests `/opt/rehor`, `/opt/opencode`, and the configured runtime source read-only, and `/tmp` and the configured runtime parent writable. The effective policy must retain every requested read-only and read-write path. Gateway-added write paths are accepted only when they are normalized absolute paths that do not overlap any requested read-only path; root, ancestor/descendant overlaps, and ambiguous path forms fail closed. Unexpected `includeWorkdir: true` also fails closed. Safe exact additions such as `/dev/null` remain supported. See [`sandbox-session.ts`](src/sandbox-session.ts) and [`runtime-layout.ts`](src/runtime-layout.ts) for the check. Full memory MCP/proxy connectivity and runtime permissions remain REHOR-215 dependencies; the dispatcher does not infer broad egress from environment variables. Do not deploy for real agent work until those dependencies are ready.

### Model-gateway route

`AGENT_DISPATCHER_MODEL_PROXY_URL` optionally points dispatched runs at the authenticated OpenAI-compatible model-gateway Route (REHOR-237). The value is validated like other configured endpoints and must be the exact HTTPS `/v1` endpoint — no userinfo, query, or fragment. An unset value keeps the memory-only policy; a set-but-invalid value fails startup.

- When set, the sandbox bootstrap policy gains a `model-proxy` rule scoped to the `/v1/**` subtree on that host, admitting `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`, bound to the same run-scoped provider credential as memory health.
- The runner environment receives `REHOR_MODEL_PROXY_URL` with the validated URL; the dispatcher never forwards its own ambient value of that variable.
- In sandbox mode the coordinator maps `REHOR_MODEL_PROXY_TOKEN` to the supervisor-issued `BOT_MEMORY_TOKEN` placeholder, which the sandbox network layer substitutes with the real minted bearer for admitted requests. Legacy deployments are unchanged.

#### Private runtime layout

Set `AGENT_DISPATCHER_RUNTIME_LAYOUT=private` only after all configured runner images have been rebuilt with the matching `Dockerfile.runner`. Without it, the dispatcher retains the legacy contract. `AGENT_DISPATCHER_RUNTIME_SOURCE` defaults to `/opt/rehor/app` and `AGENT_DISPATCHER_RUNTIME_PARENT` to `/tmp`; overrides must be absolute normalized paths and the writable parent must not overlap the immutable package or bootstrap. The Gateway must allow read access to the source, traversal and execution of `/opt/rehor/sandbox-bootstrap.py`, and writes under both the selected parent and `/tmp` (the latter holds the 0600 input file). A configured parent is not assumed writable merely because its Unix mode permits it; the effective sandbox filesystem policy and backing filesystem must permit directory creation.

The bootstrap creates a fresh mode-0700 directory owned by the actual sandbox UID, with private `HOME` and app subdirectories. It copies configuration and runner code there, links the image-owned Python venv and coordinator dependencies rather than copying them per run, and sets the OpenCode workspace owner to the actual UID. The coordinator consumes the existing input file without running preflight again. Python remains necessary for bootstrap and coordinator helpers. The sandbox lifecycle owns cleanup; size and capacity of the writable parent must accommodate runtime state. The image keeps its legacy installation and adds a second immutable dependency tree, increasing image size.

The image package is readable by arbitrary sandbox UIDs. Never bake credentials into an instance image or its setup artifacts: the build rejects several known credential file names in application source but cannot detect every possible secret or file name, including in dependencies. Review instance configuration and `setup.sh` before enabling this layout. The source directory must not contain absolute symlinks or symlinks escaping the source tree apart from the separately linked dependency directories. Existing source images and deployments are not automatically upgraded. Run `bash tests/container-e2e/checks/verify-private-runtime.sh IMAGE` for an offline, empty-input smoke test, then validate the effective Gateway policy with an isolated, non-secret test before rollout; local Docker success alone does not establish HyperShell filesystem behavior or full agent connectivity.

Sandbox dispatch requires explicit `BOT_EXECUTION_ENGINE=coordinator`; the entrypoint rejects the default Python engine and other values. Configure onboarding instances for the OpenCode runtime. The TypeScript coordinator reads the delivered envelope from `REHOR_INPUT_FILE` with fail-closed validation (any missing, malformed, unsupported, or oversized input exits nonzero without running local preflights or launching an agent), runs exactly one dispatched cycle without rerunning preflights, then exits. An empty or whitespace-only prompt skips the launch and exits zero. Unset or `legacy` keeps the runner's polling behavior, so non-dispatcher deployments and the legacy Python runner remain unchanged. Dispatcher deployments set `REHOR_INPUT_SOURCE` and `REHOR_INPUT_FILE` per exec; configure the engine separately. The prompt travels only through the input file.

### Public egress policy (REHOR-253)

`AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED` is a global dispatcher-deployment opt-in (default `false`, parsed fail-closed: only the exact strings `true`/`false` are accepted) for the centrally compiled public-egress rule. When enabled, the sandbox bootstrap policy gains one additional `public_egress` network rule, merged at policy construction and owned entirely by the dispatcher deployment: teams, instance configs, agent profiles, and `preflightEnv` contribute nothing, and the rule is a compile-time constant with no parameters. Unset or invalid values keep today's memory-only behavior; the flag is a rollout switch for an approved deployment change, never a per-agent knob.

The classification is migrated from the Squid `allowed_domains` allowlist in `proxy/squid.conf` (which stays byte-for-byte unchanged for legacy deployments) and is enforced by the parity test in `test/egress-policy.test.mjs`:

- **Direct sandbox egress (HTTPS 443 only, L4, enforced):** GitHub git-over-HTTPS and raw content, npm/Node/PyPI/PyPI-python/pythonhosted/PyTorch package indexes, Playwright browser-download CDNs, Go toolchain and module hosts (`go.dev`, `dl.google.com`, `proxy.golang.org`, `sum.golang.org`, `storage.googleapis.com`), public Quay registry/CDN reads, the Anchore Grype database hosts, and Fedora package mirrors. Squid's exact-versus-leading-dot semantics are preserved: exact hosts stay exact, and leading-dot domains map to an exact endpoint plus a recursive `**.` subdomain pattern — the single-label `*` form is never used because it would miss deeper subdomains.
- **Intentionally excluded (auth-bearing, stay on the HTTP OAuth gateway; vendor credentials are never delivered through OpenShell):** `.atlassian.net` (Jira), `.googleapis.com` (Vertex AI — with `storage.googleapis.com` carved out as a direct download destination), `.redhat.com` and `registry.redhat.io` (SSO/authenticated registry), and `glitchtip.devshift.net` (DSN-embedded credentials).
- **Intentionally excluded ports:** SSH 22 (use git over HTTPS) and plain HTTP 80 (HTTPS-only egress). Squid's allowed 443 is the only granted port.

The rule's binaries are the reviewed system toolset grounded in `Dockerfile.runner` and the env presets: `/usr/bin/git`, `/usr/bin/curl`, `/usr/bin/python3.12`, `/usr/local/bin/uv`, `/usr/local/bin/node`, `/usr/local/bin/grype`, plus the preset-managed versioned interpreters matched with single-segment version globs under their fixed root-owned roots (`/usr/local/nvm/versions/node/*/bin/node`, `/usr/local/goenv/versions/*/bin/go`, `/usr/local/pyenv/versions/*/bin/python`). No writable location is ever globbed. The supervisor also enforces its default SSRF/private-IP denial for these glob-host endpoints and SHA-256 trust-on-first-use binary integrity.

- **Public endpoint shape (enforced by tests):** every public egress endpoint uses L4-only protocol `""` with `NetworkTlsMode.SKIP` and no `credentialBinding` — the supervisor relays a raw client TLS tunnel, and its OPA per-binary host/port/DNS/IP checks still apply. SKIP disables supervisor TLS interception, not the client's own TLS verification. Losing HTTP method/path inspection on these endpoints is parity with Squid's opaque CONNECT. The existing memory and model-gateway endpoint bindings are unchanged. Tests hard-fail on any public endpoint that is not TLS-skip/L4/unbound; the flag remains `false` until the approved rollout.
- **Browser binary:** the Playwright Chromium executable lives at a version-dynamic path under `/opt/pw-browsers`; rather than grant a wildcard, it receives no network egress. Browser downloads are performed by `node`/`npx` (covered); E2E tests must use local servers.
- **Effective-policy verification is strict under the flag:** while `AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED=true`, the effective network rule set returned by the Gateway must match the requested set exactly — any extra network rule fails the session closed before the writer or runner executes. With the flag off (default), the existing permissive contract is unchanged: additive Gateway baseline rules and safe filesystem additions remain accepted.

### Reviewed-head E2E evidence (PR #620)


The full-route live E2E ran on pre-review-fix commit `a619b14`: runner exited 0 after the coordinator consumed the real preflight transcript once. The onboarding instance recorded orphan cycle 62208 (2,611 tokens across three turns); memory and Jira MCP initialization returned HTTP 200, and sandbox cleanup succeeded. The test forced three real `skip` results into `start` and used temporary policy changes. It proves the one-shot runner path and initialization/cleanup, not normal production skip behavior or real task work. Subsequent review fixes for the teardown race, OpenCode-only sandbox guard, and effective filesystem policy have local/container regression coverage but have not been rerun against Gateway live. No clean production image was validated, and production networking was not wired. Earlier -11/-12 attempts failed only because a stricter test-only filesystem guard rejected Gateway's `/dev/null` default; they were not failures of the production PR guard.

Follow-ups: REHOR-241 (dispatcher configuration), REHOR-242 (auth route scope), REHOR-243/244 (no-work classification and tool-call reporting), and REHOR-245 (real onboarding/pilot validation).

## Memory credential preflight

| Variable | Purpose |
| --- | --- |
| `AGENT_DISPATCHER_AUTH_NAMESPACE` | Namespace of the token's service account |
| `AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT` | Service account the token is minted for |
| `AGENT_DISPATCHER_AUTH_MEMORY_URL` | Exact memory-server HTTPS GET endpoint to check |
| `AGENT_DISPATCHER_AUTH_AUDIENCE` | Optional TokenRequest audience; the API server's default is used when omitted |

```yaml
env:
  - name: AGENT_DISPATCHER_AUTH_NAMESPACE
    value: "sandbox-namespace"
  - name: AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT
    value: "sandbox-service-account"
  - name: AGENT_DISPATCHER_AUTH_MEMORY_URL
    value: "https://memory.example.com/health"
```

Configure the full externally reachable memory endpoint including the path, not only the route hostname. The URL must be HTTPS without userinfo, query, or fragment, and its certificate must be trusted by Node.

The dispatcher mints the token through the Kubernetes TokenRequest API using the standard in-cluster host and the projected service-account token and CA files. The dispatcher's own service account needs `create` permission on the target `serviceaccounts/token` resource; the two service accounts need not be the same. The requested token lifetime is one hour; the API server may return a different expiry. A per-session memory-provider credential is minted once and is not refreshed; it must remain valid for the runner lifetime. Credential refresh is a REHOR-215 follow-up and shorter-lived tokens can expire during long runs.

A preflight passes only when the endpoint rejects a request without credentials and a request with a deliberately invalid bearer token with 401 or 403, and returns 2xx for the minted token. Requests have a five-second deadline, verify TLS, never follow redirects or retry, and never log credentials or response bodies. `createCredentialProvider` mints and revalidates a fresh credential on each `get()`; startup calls it once.

## OpenShell Gateway preflight

Gateway integration uses NVIDIA's `@nvidia/openshell-sdk` 0.1.5. The published distribution is vendored as a private local npm/Nx workspace at `packages/openshell-sdk`; the Agent Dispatcher depends on that workspace instead of fetching this package from GitHub Packages. The SDK's Apache-2.0 license, upstream provenance, integrity, and update procedure are documented in `packages/openshell-sdk/LICENSE` and `packages/openshell-sdk/VENDORING.md`. Its three runtime dependencies remain separate npm dependencies.

Set all six required variables to enable Gateway preflight; partial configuration fails closed. Source the client secret from a runtime secret mechanism, not from source control.

| Variable | Purpose |
| --- | --- |
| `OPENSHELL_GATEWAY_ENDPOINT` | Required HTTPS gateway origin, without path, userinfo, query, or fragment |
| `OPENSHELL_GATEWAY_NAME` | Required local descriptive name; not sent to the SDK or used to select a gateway |
| `OPENSHELL_OIDC_ISSUER` | Required HTTPS OIDC issuer URL, without userinfo, query, or fragment |
| `OPENSHELL_CLIENT_ID` | Required OIDC client ID |
| `OPENSHELL_OIDC_AUDIENCE` | Required token audience; distinct from the service-account subject |
| `OPENSHELL_OIDC_CLIENT_SECRET` | Required client secret from the process environment |
| `OPENSHELL_SERVICE_ACCOUNT_SUBJECT` | Optional expected authenticated subject; exact match required when set |

```yaml
env:
  - name: OPENSHELL_GATEWAY_ENDPOINT
    value: "https://gateway.example.com"
  - name: OPENSHELL_GATEWAY_NAME
    value: "example-gateway"
  - name: OPENSHELL_OIDC_ISSUER
    value: "https://issuer.example.com/realm"
  - name: OPENSHELL_CLIENT_ID
    value: "example-client"
  - name: OPENSHELL_OIDC_AUDIENCE
    value: "example-audience"
  - name: OPENSHELL_SERVICE_ACCOUNT_SUBJECT
    value: "example-subject"
```

The SDK's client-credentials provider discovers the issuer, obtains, caches, and refreshes tokens on demand. Startup calls `GetCurrentUser` and requires `identityProvider` to be exactly `oidc` with a nonempty subject, plus an exact match with the optional configured subject. The identity RPC has a thirty-second deadline, as does each SDK discovery or token HTTP request. Setting `NODE_TLS_REJECT_UNAUTHORIZED=0` fails Gateway startup.

SDK 0.1.5 behavior to be aware of: aborting a token wait does not cancel its shared underlying acquisition, so the preflight drains any started acquisition before reporting its result; and an OIDC discovery document may advertise a plaintext HTTP token endpoint on loopback even when the issuer uses HTTPS, so the issuer's discovery document is trusted by design.

Failures at any stage report a fixed message naming the stage, never SDK error details or credentials.

## Lifecycle logs

The dispatcher writes JSON lifecycle events to stdout through [pino](https://getpino.io). Records carry `level`, fixed `event` and `status` strings, and optional bounded duration and fixed diagnostic fields. A `preflight.error` includes `profile`, `repository`, and the opaque `agentId`: profile names support Unicode, nonprinting characters are escaped, and repository URLs omit SSH userinfo. Invalid or oversized identity fields are omitted while `agentId` remains. Preflight transcripts, prompts, credentials, and exception text are not logged. Failures log at `error` (50); everything else logs at `info` (30).

| Event | Meaning |
| --- | --- |
| `startup` | Startup begins or completes/fails. |
| `configuration` | Memory and Gateway configuration validation. |
| `kubernetes.token_request` | TokenRequest preparation, request, and response validation. |
| `memory.missing_token` | Endpoint must reject a request without credentials. |
| `memory.invalid_token` | Endpoint must reject a deliberately invalid credential. |
| `memory.token` | Credential expiry validation and authenticated endpoint check. |
| `gateway.authentication` | Gateway preflight, including the OIDC identity and optional subject checks. |
| `gateway.oidc` | An SDK token-provider call starts and completes/fails. |
| `preflight.error` | A profile's preflight run failed; carries fixed `reason` (`configuration` or `execution`) and the instance identity fields below. |
| `sandbox.session` | Sandbox input delivery and runner execution start and complete/fail. |
| `sandbox.cleanup` | Run-owned resource cleanup succeeds or remains ambiguous. |
| `ready` | Startup completed. |
| `shutdown` | Shutdown after a signal or startup failure. |

Failure records carry a fixed `category` from a closed set, assigned at the failure site so startup problems are diagnosable without exposing details: `configuration` (invalid variables), `credentials` (missing projected service-account files), `network` (connect or timeout failures), `authorization` (TokenRequest or endpoint rejection of a missing/invalid credential), `authentication` (endpoint rejection of a valid credential, or a Gateway identity mismatch), `response` (unparseable TokenRequest response), and `internal` (anything else).

Only attempted steps are logged: disabled preflights produce no events, and a failure prevents later checks. On SIGTERM or SIGINT, the dispatcher cancels active work and drains in-flight sessions, including Gateway cleanup. Each cleanup uses one shared 20-minute budget across reads, retries, deletes, and absence checks; exhaustion records cleanup as unknown. The shutdown drain deadline is 22 minutes, leaving two minutes for bookkeeping. Deployments must set runtime termination grace to at least 23 minutes; this repository has no dispatcher workload manifest to configure that value. An unresolved session or a drain deadline logs shutdown failure and keeps process exit nonzero.

## Container image

The SDK does not require GitHub Packages authentication: `package-lock.json` resolves `@nvidia/openshell-sdk` to the local workspace, and `@rehor/preflights` is a workspace dependency of the dispatcher. Hermeto prefetches the lockfile's remaining npm dependencies, and both npm install stages use `npm ci --offline`. With the Python runner removed, no `dnf`/`pip`/`go` steps remain: the build is fully offline and hermetic.

The Containerfile copies `packages/openshell-sdk` and `packages/preflights` into the dependency stages. The final image copies them to `/app/packages/…` alongside `node_modules`; those paths are required by the local workspace links at `node_modules/@nvidia/openshell-sdk` and `node_modules/@rehor/preflights`. Copying a link without its target would break module resolution at runtime.

From the repository root, provide the repository as build context. This does not read or send `packages/agent-dispatcher/.env`:

```sh
tar -cf - package.json package-lock.json nx.json \
  packages/agent-dispatcher/package.json \
  packages/agent-dispatcher/project.json \
  packages/agent-dispatcher/tsconfig.json \
  packages/agent-dispatcher/Containerfile \
  packages/agent-dispatcher/src \
  packages/preflights/package.json \
  packages/preflights/project.json \
  packages/preflights/tsconfig.json \
  packages/preflights/src \
  packages/openshell-sdk | \
  podman build \
    -f packages/agent-dispatcher/Containerfile \
    -t registry.example.com/team/agent-dispatcher:dev -
```

The final UBI 9 Node.js 22 image contains the compiled dispatcher, its production dependencies (including the built `@rehor/preflights` package and its SDK clients), and Git. It runs as UID 1001 and supports an OpenShift-assigned arbitrary UID. Configure runtime authentication separately from dependency installation.

## Development

Run the test suite from the repository root:

```sh
npm test --workspace=@rehor/agent-dispatcher
```

# Agent dispatcher

The agent dispatcher is a long-running, non-HTTP Node.js process. It validates memory-server credentials and OpenShell Gateway authentication on startup. When agent repositories are configured, it runs their work preflights. It exposes no ports or HTTP API.

With no memory, Gateway, or agent repository configuration, the dispatcher starts and idles. Partial authentication configuration fails startup.

## Agent work preflights

Set `AGENT_DISPATCHER_CONFIG_REPOS` to a JSON array of trusted HTTPS or SSH Git repository URLs. Both the memory and Gateway configurations below must also be enabled; the memory URL must identify the exact `/health` endpoint. `AGENT_DISPATCHER_CONFIG_DIR` optionally selects the writable checkout cache; the default is `rehor-agent-dispatcher` under the system temporary directory. The dispatcher checks each repository's default-branch SHA and fetches its pinned submodules when the revision changes or the local copy is missing. Startup fails fast when `python3` or `git` are unavailable; synchronization failures surface only a coarse category (timeout, unavailable, rejected) so Git output and arguments never leak credentials.

Each `instance/*/agent/instance.yaml` selects a workflow and provides an image repository and optional tag. The omitted tag defaults to `latest`. Non-secret `BOT_` settings under `preflight.env` are passed to that agent's scripts — an instance cannot override operational variables the dispatcher forwards itself (`PATH`, proxies, `JIRA_MCP_URL`, `EXECUTOR_ADDR`); credentials belong in runtime secret mechanisms, not the repository. For example:

```yaml
workflow: onboarding
image:
  repository: quay.io/example/onboarding-agent
  tag: v1
preflight:
  env:
    BOT_INSTANCE_ID: onboarding-test
    BOT_LABEL: onboarding-test
```

Shared Python workflow scripts and helpers come from the repository's pinned `dev-bot` submodule. Python execution is a stopgap: existing preflight scripts run unchanged during migration, but preflights will move to `.mjs` and only `.mjs` preflights will be supported long-term. The instance's `project-repos.json` is used as-is, never merged with the shared map. Checks run sequentially and at most once per agent every five minutes; the in-memory timer resets on restart. Python preflight failures use the existing aggregation contract: an actionable successful script can produce a start decision despite another script's failure. Missing scripts never produce a start decision.

Only non-secret `BOT_` variables, `PATH`, `JIRA_MCP_URL`, `EXECUTOR_ADDR`, and proxy settings are forwarded from the dispatcher environment. When authentication is configured, the dispatcher also mints a short-lived memory credential per cycle and forwards it to preflight scripts as `BOT_MEMORY_TOKEN` (never via the process environment); helpers attach it as a bearer header, and an authorization failure fails the preflight instead of reporting empty results. Preflight scripts and their imports execute from a private materialized runtime copy, so a symlinked script cannot resolve shared helpers, the repository map, or state files in the synced checkout. Supply service endpoints and any required executor integration separately. The image includes Python 3 and Git from the Node.js base image, but not the Python MCP client (hermetic builds cannot install it over the network) and not the agent executor's `gh`/`glab` shims; skills that import the `mcp` package do not run in deployments until it is vendored. Only trusted repositories should be configured: their scripts execute in the dispatcher.

## Sandbox dispatch

A normal `start` decision creates a per-run workspace, provider, profile, and sandbox. The configured profile image is used without fallback; it must include Python 3.12 and Bash for the idle command and input-file write. Sandbox creation overrides the image's default entrypoint with an idle command and sets `restartPolicy: NEVER`. After the sandbox reaches `READY`, the dispatcher sends preflight output and starts the runner. Legacy layout invokes `/home/botuser/app/entrypoint.sh`; private layout uses the image's `/opt/rehor/sandbox-bootstrap.py`.

The dispatcher writes one UTF-8 JSON envelope to `/tmp/rehor-input.json` using exec stdin, creating the file with mode `0600`:

```json
{"schemaVersion":1,"runId":"…","prompt":"…","metadata":{"action":"start","scripts":[{"name":"…","status":"…"}]}}
```

The 64 KiB limit applies to the complete serialized envelope. An oversized or invalid envelope fails dispatch without creating a sandbox. Empty or whitespace-only prompts and `skip` or `error` decisions do not create a sandbox. Runs with no scripts are rejected earlier by work-preflight as `no-scripts`; the envelope builder does not enforce that rule. Prompt contents travel through stdin, not environment variables, argv, sandbox configuration, or logs. The runner exec receives fixed per-exec controls, `REHOR_INPUT_SOURCE=sandbox` and `REHOR_INPUT_FILE=/tmp/rehor-input.json`, alongside its non-secret runtime settings; its output is discarded by the dispatcher. OpenShell SDK supports environment, argv, and stdin input, but stdin keeps prompt content out of inspectable configuration and process arguments. Each runner exec has a unique durable request ID; sandbox creation and exec are not automatically retried.

Non-secret `BOT_` settings and explicitly allowed service/proxy settings are forwarded to the sandbox, with agent-profile settings applied per agent. The dispatcher does not copy its raw process environment, `PATH`, or authentication credentials into the sandbox; the memory credential is delivered through its OpenShell provider. Existing memory and Gateway authentication variables below remain unchanged.

On completion, the dispatcher verifies resource ownership and confirms sandbox absence before dependent cleanup, then removes all run-owned resources. Ambiguous cleanup fails closed and retains the agent's in-flight reservation. `SessionDispatcher` allows one in-flight run per agent per process; reservations are process-local and cannot be recovered after a dispatcher restart.

The current bootstrap policy authorizes only Python access to the configured HTTPS memory `/health` endpoint. Legacy layout keeps `/home/botuser/app` read-only and permits writes under `/tmp`, `/home/botuser/repos`, and `/home/botuser/data`. Private layout requests `/opt/rehor`, `/opt/opencode`, and the configured runtime source read-only, and `/tmp` and the configured runtime parent writable. The effective policy must retain every requested read-only and read-write path. Gateway-added write paths are accepted only when they are normalized absolute paths that do not overlap any requested read-only path; root, ancestor/descendant overlaps, and ambiguous path forms fail closed. Unexpected `includeWorkdir: true` also fails closed. Safe exact additions such as `/dev/null` remain supported. See [`sandbox-session.ts`](src/sandbox-session.ts) and [`runtime-layout.ts`](src/runtime-layout.ts) for the check. Full memory MCP/proxy connectivity and runtime permissions remain REHOR-215 dependencies; the dispatcher does not infer broad egress from environment variables. Do not deploy for real agent work until those dependencies are ready.

#### Private runtime layout

Set `AGENT_DISPATCHER_RUNTIME_LAYOUT=private` only after all configured runner images have been rebuilt with the matching `Dockerfile.runner`. Without it, the dispatcher retains the legacy contract. `AGENT_DISPATCHER_RUNTIME_SOURCE` defaults to `/opt/rehor/app` and `AGENT_DISPATCHER_RUNTIME_PARENT` to `/tmp`; overrides must be absolute normalized paths and the writable parent must not overlap the immutable package or bootstrap. The Gateway must allow read access to the source, traversal and execution of `/opt/rehor/sandbox-bootstrap.py`, and writes under both the selected parent and `/tmp` (the latter holds the 0600 input file). A configured parent is not assumed writable merely because its Unix mode permits it; the effective sandbox filesystem policy and backing filesystem must permit directory creation.

The bootstrap creates a fresh mode-0700 directory owned by the actual sandbox UID, with private `HOME` and app subdirectories. It copies configuration and runner code there, links the image-owned Python venv and coordinator dependencies rather than copying them per run, and sets the OpenCode workspace owner to the actual UID. The coordinator consumes the existing input file without running preflight again. Python remains necessary for bootstrap and coordinator helpers. The sandbox lifecycle owns cleanup; size and capacity of the writable parent must accommodate runtime state. The image keeps its legacy installation and adds a second immutable dependency tree, increasing image size.

The image package is readable by arbitrary sandbox UIDs. Never bake credentials into an instance image or its setup artifacts: the build rejects several known credential file names in application source but cannot detect every possible secret or file name, including in dependencies. Review instance configuration and `setup.sh` before enabling this layout. The source directory must not contain absolute symlinks or symlinks escaping the source tree apart from the separately linked dependency directories. Existing source images and deployments are not automatically upgraded. Run `bash tests/container-e2e/checks/verify-private-runtime.sh IMAGE` for an offline, empty-input smoke test, then validate the effective Gateway policy with an isolated, non-secret test before rollout; local Docker success alone does not establish HyperShell filesystem behavior or full agent connectivity.

Sandbox dispatch requires explicit `BOT_EXECUTION_ENGINE=coordinator`; the entrypoint rejects the default Python engine and other values. Configure onboarding instances for the OpenCode runtime. The TypeScript coordinator reads the delivered envelope from `REHOR_INPUT_FILE` with fail-closed validation (any missing, malformed, unsupported, or oversized input exits nonzero without running local preflights or launching an agent), runs exactly one dispatched cycle without rerunning preflights, then exits. An empty or whitespace-only prompt skips the launch and exits zero. Unset or `legacy` keeps the runner's polling behavior, so non-dispatcher deployments and the legacy Python runner remain unchanged. Dispatcher deployments set `REHOR_INPUT_SOURCE` and `REHOR_INPUT_FILE` per exec; configure the engine separately. The prompt travels only through the input file.

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

The dispatcher writes one JSON object per lifecycle event to stdout through [pino](https://getpino.io), whose default stdout destination is synchronous (sonic-boom `sync: true`) and EPIPE-safe. Synchronous writes are what is wanted before the `process.exit(1)` at the shutdown deadline: no record is lost. Records carry pino's `level` plus fixed `event` and `status` strings, an optional integer `durationMs` (rounded, bounded to 0–86,400,000), an optional fixed `category` on failure, and closed-set session `stage`/`errorCode` fields. Failures log at `error` (50); everything else logs at `info` (30). No raw error, credential, identity, URL, request, or response content is ever included, and the logger accepts no free-form message text.

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
| `sandbox.session` | Sandbox input delivery and runner execution start and complete/fail. |
| `sandbox.cleanup` | Run-owned resource cleanup succeeds or remains ambiguous. |
| `ready` | Startup completed. |
| `shutdown` | Shutdown after a signal or startup failure. |

Failure records carry a fixed `category` from a closed set, assigned at the failure site so startup problems are diagnosable without exposing details: `configuration` (invalid variables), `credentials` (missing projected service-account files), `network` (connect or timeout failures), `authorization` (TokenRequest or endpoint rejection of a missing/invalid credential), `authentication` (endpoint rejection of a valid credential, or a Gateway identity mismatch), `response` (unparseable TokenRequest response), and `internal` (anything else).

Only attempted steps are logged: disabled preflights produce no events, and a failure prevents later checks. On SIGTERM or SIGINT, the dispatcher cancels active work and drains in-flight sessions, including Gateway cleanup. Each cleanup uses one shared 20-minute budget across reads, retries, deletes, and absence checks; exhaustion records cleanup as unknown. The shutdown drain deadline is 22 minutes, leaving two minutes for bookkeeping. Deployments must set runtime termination grace to at least 23 minutes; this repository has no dispatcher workload manifest to configure that value. An unresolved session or a drain deadline logs shutdown failure and keeps process exit nonzero.

## Container image

The SDK does not require GitHub Packages authentication: `package-lock.json` resolves `@nvidia/openshell-sdk` to the local workspace. Hermeto prefetches the lockfile's remaining npm dependencies, and both image install stages run offline.

The Containerfile copies `packages/openshell-sdk` into both dependency stages. The final image copies it to `/app/packages/openshell-sdk` alongside `node_modules`; this path is required by the local workspace link at `node_modules/@nvidia/openshell-sdk`. Copying the link without its target would break SDK resolution at runtime.

From the repository root, provide the repository as build context. This does not read or send `packages/agent-dispatcher/.env`:

```sh
tar -cf - package.json package-lock.json nx.json \
  packages/agent-dispatcher/package.json \
  packages/agent-dispatcher/project.json \
  packages/agent-dispatcher/tsconfig.json \
  packages/agent-dispatcher/Containerfile \
  packages/agent-dispatcher/src \
  packages/openshell-sdk | \
  podman build \
    -f packages/agent-dispatcher/Containerfile \
    -t registry.example.com/team/agent-dispatcher:dev -
```

The multi-stage UBI 9 Node.js 22 image contains the compiled dispatcher, production dependencies, Python 3, and Git, all from the base image: hermetic builds perform no network installs. It runs as UID 1001 and supports an OpenShift-assigned arbitrary UID. Configure runtime authentication separately from dependency installation.

## Development

Run the test suite from the repository root:

```sh
npm test --workspace=@rehor/agent-dispatcher
```

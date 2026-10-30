# Agent dispatcher credential preflight

The scaffold optionally checks memory-server credentials and OpenShell Gateway authentication at startup. It does not create sandboxes or deploy services. With no memory or Gateway configuration, scaffold behavior is unchanged. Partial configuration fails startup. Proxy checks are deferred.

| Variable | Purpose |
| --- | --- |
| `AGENT_DISPATCHER_AUTH_NAMESPACE` | Namespace of the token's service account |
| `AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT` | Service account for the future sandbox credential |
| `AGENT_DISPATCHER_AUTH_MEMORY_URL` | Exact memory-server HTTPS GET endpoint to check |
| `AGENT_DISPATCHER_AUTH_AUDIENCE` | Optional TokenRequest audience; omitted uses the API server's default |

For an in-cluster deployment, configure the full externally reachable memory OAuth Route including `/health`, not only the route hostname. Replace these example values with the namespace and service account for the credential being requested, and the actual memory route:

```yaml
env:
  - name: AGENT_DISPATCHER_AUTH_NAMESPACE
    value: "sandbox-namespace"
  - name: AGENT_DISPATCHER_AUTH_SERVICE_ACCOUNT
    value: "sandbox-service-account"
  - name: AGENT_DISPATCHER_AUTH_MEMORY_URL
    value: "https://memory.example.com/health"
```

Omit `AGENT_DISPATCHER_AUTH_AUDIENCE` to use the API server's default audience, or set it to the exact audience accepted by the memory OAuth endpoint. Do not set it to an empty value. The dispatcher pod itself needs a mounted service-account token and CA and permission to request a token for the specified target service account; the two service accounts need not be the same.

The URL cannot contain userinfo, query strings, or fragments. Configure the actual memory endpoint and access path intended for the sandbox; a local test endpoint does not establish sandbox reachability. Its certificate must be trusted by Node. The Kubernetes API uses the standard in-cluster host/port and projected service-account token and CA files. The dispatcher's identity needs narrowly scoped `create` permission on the target `serviceaccounts/token` resource. The requested token lifetime is one hour; the API server may return a different expiry.

The endpoint must reject both missing and deliberately invalid bearer credentials with 401 or 403, then return 2xx for the same minted token. Redirects, network errors, other statuses, and credentials near expiry fail closed. Requests have a five-second deadline, verify TLS, never follow redirects or retry, and do not log credentials or response bodies. Failures report the configuration, TokenRequest, or memory endpoint stage without exposing details. These checks cannot prove identity isolation, endpoint policy correctness, or authorization of other paths and protocols. Current memory OAuth policy admits unrelated service accounts; configuration alone does not fix this.

`createCredentialProvider` returns a validated token and expiry. Retain the provider and call `get()` before each use; it refreshes and revalidates on demand when within 60 seconds of expiry. Scaffold startup performs one check only; there is no background refresh or runtime recheck. Never log or expose the returned token. Ensure longer sandbox lifetimes and downstream credential rotation are designed before integrating it.

Run `npm test --workspace=@rehor/agent-dispatcher` from the repository root.

## Lifecycle logs

The dispatcher writes one JSON object per lifecycle event to stdout on a best-effort basis. Objects contain fixed `event` and `status` strings, an optional integer `durationMs` (rounded and bounded to 0–86,400,000), and an optional fixed `category` on failure. Status is `start`, `success`, or `failure`; categories currently emitted are `configuration`, `authentication`, and `internal`. `internal` means the precise cause is not safely classified, not necessarily an internal defect. No raw error, credential, identity, URL, request, or response is included. Existing fixed failure messages remain on stderr, and the scaffold's greeting remains plain text on stdout.

| Event | Meaning |
| --- | --- |
| `startup` | Startup begins or completes/fails. |
| `configuration` | Memory and Gateway configuration validation. |
| `kubernetes.token_request` | TokenRequest preparation, request, and response validation, including projected credential reads. |
| `memory.missing_token` | Endpoint must reject a request without credentials. |
| `memory.invalid_token` | Endpoint must reject a deliberately invalid credential. |
| `memory.token` | Credential expiry validation and, if usable, authenticated endpoint check. |
| `gateway.authentication` | Gateway preflight, including the OIDC identity and optional subject checks. |
| `gateway.oidc` | An SDK token-provider call starts and completes/fails; the SDK may return a cached token rather than make an HTTP request. |
| `ready` | Startup completed; this is not a continuing health or authorization guarantee. |
| `shutdown` | Shutdown after a signal or startup failure. |

Only attempted steps are logged: disabled preflights and cached memory credentials produce no corresponding check events, and failure prevents later checks. A `success` for the two negative memory checks means the endpoint rejected those requests as required. Gateway authentication succeeds only after the identity response reports `oidc`, a nonempty subject, and any configured expected subject matches. A failed or timed-out Gateway RPC can still have a pending token-provider call; its completion is drained before the Gateway preflight finishes. A dedicated output worker isolates blocking writes; its queue is limited to 64 records and emission is abandoned if the sink fails or does not progress within one second. Records and the greeting can be dropped under backpressure or on exit; sink and clock failures cannot change authentication behavior.

On SIGTERM or SIGINT during startup, the dispatcher cancels the Gateway RPC, prevents subsequent startup stages, and waits for the current preflight to settle before reporting successful shutdown. Memory preflight operations are drained rather than cancelled; each network request has a five-second timeout. SDK token work already started is also drained, because the SDK does not cancel its underlying exchange. If startup has not stopped within 25 seconds of the signal, shutdown fails and the process exits with code 1; a stuck filesystem operation or SDK work may be terminated rather than drained. A startup interrupted by a signal does not emit startup success or failure.

## OpenShell Gateway

Gateway integration is independent of the memory preflight and uses `@nvidia/openshell-sdk` 0.1.5, not the OpenShell CLI. Set all six required variables to enable it. A partial configuration fails closed. Do not load credentials from the repository or include them in sandbox arguments, environment variables, or logs.

| Variable | Purpose |
| --- | --- |
| `OPENSHELL_GATEWAY_ENDPOINT` | Required HTTPS gateway origin, without path, userinfo, query, or fragment |
| `OPENSHELL_GATEWAY_NAME` | Required local descriptive name; not sent to the SDK or used to select a gateway |
| `OPENSHELL_OIDC_ISSUER` | Required HTTPS OIDC issuer URL, without userinfo, query, or fragment |
| `OPENSHELL_CLIENT_ID` | Required OIDC client ID |
| `OPENSHELL_OIDC_AUDIENCE` | Required token audience; distinct from the service-account subject |
| `OPENSHELL_OIDC_CLIENT_SECRET` | Required client secret from the process environment; use a runtime secret source, not source control |
| `OPENSHELL_SERVICE_ACCOUNT_SUBJECT` | Optional expected authenticated subject; exact match required when set |

Example configuration with nonsecret placeholders (supply the client secret separately through the runtime's secret mechanism):

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

The SDK's client-credentials provider discovers the issuer, obtains tokens, caches them, and refreshes them on demand. The SDK client is lazy: startup calls `GetCurrentUser`, requires `identityProvider` to be exactly `oidc` and the subject nonempty, and checks the optional expected subject. Upstream v0.1.5 uses `local_dev` for unauthenticated local access, which is rejected. Health alone is not an authentication check. Gateway and issuer must have certificates trusted by Node; disabling TLS verification with `NODE_TLS_REJECT_UNAUTHORIZED=0` fails Gateway startup. Failures expose only fixed stage messages, not SDK error details or credentials. Gateway policy and the running server's enforcement of this identity RPC must still be verified against the real deployment.

The identity RPC has a ten-second deadline, and each SDK discovery or token HTTP request has a ten-second timeout. In SDK 0.1.5, aborting a token wait does not cancel its shared underlying acquisition. Preflight therefore waits for any started acquisition to finish before reporting success or failure; a timed-out RPC can take longer than ten seconds to return, and the SDK can still issue its token request after the RPC deadline. Underlying cancellation is not implemented.

SDK 0.1.5 permits an OIDC discovery document to advertise a plaintext HTTP token endpoint on loopback, even when the configured issuer uses HTTPS. The adapter cannot override that SDK behavior. Trust the issuer's discovery document and verify that its token endpoint is HTTPS; this integration does not enforce that restriction itself.

When a memory token is sent to Gateway for provider injection, it is also available to the trusted supervisor; runtime credential isolation has not been independently verified. The scaffold performs startup preflights only and does not manage sandbox lifecycle.

## Known issue

Sandbox deletion can remain pending in Gateway, leaving dependent provider, profile, and workspace resources undeleted.

## Container image

The SDK is hosted on GitHub Packages. Dependency installation needs a GitHub Packages token with `read:packages` access. Provide an npm authentication file outside the build context and mount it as a build secret; never commit it. The repository `.npmrc` included below must contain registry configuration only, not credentials.

From the repository root, stream only the allowlisted build inputs to Podman, targeting AMD64. This does not read or send `packages/agent-dispatcher/.env`:

```sh
tar -cf - package.json package-lock.json nx.json .npmrc \
  packages/agent-dispatcher/package.json \
  packages/agent-dispatcher/project.json \
  packages/agent-dispatcher/tsconfig.json \
  packages/agent-dispatcher/Containerfile \
  packages/agent-dispatcher/src | \
  podman build --platform linux/amd64 \
    --secret id=npmrc,src=/path/outside/build-context/npmrc \
    -f packages/agent-dispatcher/Containerfile \
    -t registry.example.com/team/agent-dispatcher:dev -
```

The builder uses the host architecture. The multi-stage UBI 9 Node.js 22 image contains the compiled dispatcher and production dependencies, not build dependencies. It runs as UID 1001 and supports an OpenShift-assigned arbitrary UID. Keep credentials and secrets out of the allowlisted inputs. Configure runtime authentication separately from the build secret. A local run without auth variables exercises only the scaffold; the configured memory preflight requires Kubernetes credentials, API access, and the memory route.

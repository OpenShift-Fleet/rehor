# OpenCode V2 Canary and Rollout

This runbook carries the original [REHOR-146](https://issues.redhat.com/browse/REHOR-146) canary forward to the REHOR-200 V2 contract.
The canary changes runtime and provider selection per instance while keeping the
legacy Claude/Vertex path available for rollback.

Use client/CLI `2.1.2` and the single runtime ID `opencode`; versioned IDs and legacy aliases are unsupported. Migrate Claude SDK instances directly to V2. Historical V1 was onboarding-only validation, not a rollout prerequisite. Follow the [migration procedure](../migrations/opencode-migration.md#runtime-migration): main PR merges first, then a separate onboarding PR updates the merged gitlink, runtime, and native profile settings.

## Scope

The selection is declared in the instance config and carried through Python
config preparation into the TypeScript coordinator:

```yaml
runtime: opencode
provider: rehor-openai
model: gpt-6-luna
```

The rollback configuration is explicit and independently selectable:

```yaml
runtime: claude
provider: vertex
model: claude-sonnet-4-6
```

Supported combinations are:

| Runtime | Provider | Role |
|---|---|---|
| `claude` | `vertex` | Legacy/default rollback path |
| `opencode` | `vertex` | Claude on Vertex through the existing Rehor auth proxy |
| `opencode` | `rehor-openai` | Native Responses runtime (`@opencode/ai/providers/openai/responses`), default model `gpt-6-luna` |
| `opencode` | `rehor-openai-chat` | Native Chat Completions runtime (`@opencode/ai/providers/openai-compatible`) |

With `runtime: opencode`, `provider: rehor-openai`, and no model override,
Python reads `config.json`'s `opencode.model` (`gpt-6-luna`). OpenCode+Vertex
continues to use `claude.model`; `rehor-openai-chat` requires a model declared
under that provider. GPT-6 Luna uses the native Responses route. The
native compatible runtime uses the pinned CLI; GPT-4o's model configuration caps
output at 16384 tokens.
Set a model declared under `rehor-openai-chat` (for example `gpt-4.1`); an
undeclared model fails before OpenCode starts.

The packaged OpenCode defaults declare Vertex Claude Sonnet 4.6, Opus 4.6, and
Haiku 4.5. The coordinator's Vertex adapter sends a placeholder bearer value to
the proxy; proxy injects its Google service-account token and enforces
`VERTEX_ALLOWED_MODELS`. The OpenCode child receives no Google ADC file or
credential.

Do not rely on a provider name embedded in a model string to select the
runtime. Runtime and provider are separate fields so either can be rolled back
without changing the other.

## Before enabling a canary

1. Confirm the target image includes `coordinator/dist/cli.js`, its locked Node
   dependencies including `@opencode/client@2.1.2`, `/usr/local/bin/opencode` from `@opencode/cli@2.1.2`,
   the native Responses/compatible provider runtimes, `@ai-sdk/google-vertex@4.0.219` for the coordinator-owned Vertex shim, `zstd`, and configured provider proxies. Native OpenAI runtimes require no `packages` entries or separate `@ai-sdk` metadata. Preserve frozen pricing-catalog provenance `1.18.35` separately.
2. Confirm the instance has a known-good Claude/Vertex deployment or revision
   available for rollback.
3. Confirm the instance config contains no API keys. Credentials remain in
   deployment secrets and provider gateway configuration.
4. Run the coordinator unit suite, typecheck, build, and image smoke checks from
   the exact image revision.
5. Verify the config-preparation response contains non-empty `runtimeId` and
   `providerId`, and that the cycle config hash changes when either selection
   changes.
6. Verify `BOT_EXECUTION_ENGINE=coordinator` is set deliberately,
   `CYCLE_RUNS_API_URL` is configured, and the OpenCode deployment JSON declares
   the prepared provider with native `package`/`settings` fields and environment references. Exact external-package pins are required only for external providers/plugins.
7. For an OpenAI route (`rehor-openai` or `rehor-openai-chat`), verify the
   runner's SandboxTemplate egress list allows TCP/8450 to `devbot-proxy` (see
   `deploy/sandbox-template.example.yaml`); without it the gateway is
   unreachable and every cycle fails.
8. Verify preflight `skip` and `error` outcomes do not start a runtime.
9. Run one local/staging `--once` cycle first; verify `/health`, `/ready`,
   `/metrics`, local JSONL output, HTTP projections, transcript compression,
   and lock release.
10. Verify native V2 profiles: core/shared/workflow `AGENTS.md`, strict native agent/command YAML frontmatter rejecting legacy/mixed fields, canonical plural resource directories, skills, `mcp.servers`, `experimental.subagent_depth`, and V2-compatible local/external plugins. Check utility-model selection at `agents.title.model` and ordered `permissions` using `shell`/`subagent`/`edit` actions. Confirm the runner's global native policy ceiling survives project/agent grants and that private server auth/config/data/DB remain isolated while root/child shells recover original XDG homes. Use the [native and image acceptance gates](../migrations/opencode-migration.md#local-and-image-validation); earlier partial checks are not full acceptance.
11. Verify native Code Mode selection: central `mcpServers.<server>` and native `mcp.servers.<server>` accept optional boolean `codemode`, with omitted/default `true` or explicit direct `false`. Allowed active generated wrapped MCP grants automatically enable `execute`; agent allow/deny changes wrapper availability but cannot rewrap direct servers. Confirm nested grants/denials, no-count wrapper containers, unique successful nested/native-fetch accounting, and unfiltered nested work-context results even when scripts filter output. Errors do not count. Test batch budget exhaustion at the next root model boundary, not as an atomic nested-call stop. Code Mode fetch uses raw HTTP, not `webfetch` permission; verify effective network sandbox/egress and `execute` authority. Scoped management plugins stay disabled.

Native Code Mode bridge and configuration tests have passed for root and child execution. The generated runner plugin uses native Effect with fiber-ID invocation correlation, including repeated scalar/null inputs, rather than Promise hooks or input identity. External V2 plugins may use native Effect or supported Promise APIs. Strict native Markdown validation is implemented. The full rebuild succeeded after the earlier external DNS failure, and a fresh unmounted Linux ARM64 production image containing the final fiber fix passed Responses/Chat/Vertex, read-tool, exact usage, and Code Mode checks. The built runtime captures filtered task results, counts two nested successes separately, blocks denied MCP calls before the server, and excludes the wrapper from budget accounting; budget 3 completes and budget 2 stops at the next root model boundary. These offline checks do not establish live canary acceptance; the deployment procedure and staging work-cycle checks above remain required.

The Python compatibility entrypoint remains the default. A deployment must set
`BOT_EXECUTION_ENGINE=coordinator` before setting a non-default runtime in an
instance config. An older Python-only image fails closed for that selection;
it must not silently route OpenCode work through the Claude SDK.

## Rollout stages

### 1. Single-instance canary

Set `runtime: opencode` and `provider: rehor-openai` for one low-volume
instance. Keep the previous deployment revision and config ready. Observe at
least one complete work cycle and one no-work/preflight cycle.

Required gates:

- exactly one terminal event per started attempt;
- terminal state and status projection agree;
- transcript, cost, cycle-run, and legacy metric records are written;
- provider/model attribution matches the selected provider and effective model;
- usage counts one assistant projection per V2 step, replaces duplicate/recovered IDs, and deduplicates compaction recovery; positive native costs remain estimates, and interrupted/pending steps retain incomplete known subtotals;
- MCP failures remain visible and do not produce a false successful terminal;
- no runtime process or session remains after completion, cancellation, timeout,
  or shutdown;
- no credentials or raw provider payloads appear in events, logs, or metrics.

### 2. Small rollout

Expand to a small, representative set of instances. Compare each OpenCode
instance with its recent Claude/Vertex baseline for:

- cycle completion and failure rate;
- no-work classification;
- p50/p95 runtime duration;
- interruption and timeout rate;
- token/cost totals by model and provider;
- transcript and Jira/status projection parity;
- resource-leak count.

Do not remove Vertex configuration or the legacy deployment while this stage
is under observation.

### 3. General rollout

Promote only after the small rollout has no unexplained compatibility
regressions and all runtime health and cleanup alerts remain at baseline. Keep
an explicit rollback window and retain the previous image/config revision until
that window expires.

## Metrics and alerts

The compatibility projection emits provider-neutral runtime metrics with
`runtime` and `provider` labels:

| Metric | Meaning | Canary signal |
|---|---|---|
| `devbot_runtime_health_total` | Runtime became ready, then ended healthy or failed (`status`) | Failure count above Claude baseline |
| `devbot_runtime_sessions_total` | Runtime session reference observed | Missing session for a started run |
| `devbot_runtime_duration_seconds` | End-to-end normalized runtime duration (`state`) | p95 regression |
| `devbot_runtime_interruptions_total` | `interrupted`, `cancelled`, or `timed_out` terminal | Increase above baseline |
| `devbot_runtime_resource_leaks_total` | Runtime cleanup reported a process-group leak | Any unexplained increase is a stop signal |

Continue monitoring the existing compatibility metrics, especially
`devbot_cycles_total`, `devbot_cycle_duration_seconds`, cost/token counters,
and `devbot_idle_with_tokens_total`. Query by both `runtime` and `provider`
when comparing canary and rollback traffic.

## Rollback

1. Stop promotion and capture the instance ID, config hash, run ID, attempt ID,
   timestamp, and the first failing event/error. Do not dump credentials or
   full environment values.
2. Change the instance config to the known-good pair:

   ```yaml
   runtime: claude
   provider: vertex
   ```

   If deployment environment overrides are being used, set both
   `BOT_RUNTIME=claude` and `BOT_PROVIDER=vertex`; an `instance.yaml` value
   takes precedence over those fallbacks.
3. Restore the previous known-good **Claude image digest and matching config/template revision**, including its gitlink and engine setting. For the Python baseline restore `BOT_EXECUTION_ENGINE=python` (or its previous omitted default); for a coordinator Claude baseline restore that exact setup. Obtain a fresh Sandbox and confirm the first new cycle reports `claude`/`vertex`. Provider-only changes are not runtime rollback.
4. Check that no OpenCode process, session, or temporary state directory
   remains. Escalate any `devbot_runtime_resource_leaks_total` increase before
   retrying the canary.
5. Preserve the failed canary artifacts and compare the normalized event stream
   with the last successful Claude/Vertex cycle before changing the canary
   configuration again.

Rollback is complete only when the legacy status, transcript, cost, cycle-run,
and metric projections are healthy again. Do not delete the OpenCode image or
provider configuration until the failure is understood and the rollback window
is closed.

## Troubleshooting checklist

- **Selection missing in coordinator:** inspect the Python bridge response for
  `runtimeId` and `providerId`; verify the active config path and config hash.
- **Unsupported selection:** fix the instance config or `BOT_RUNTIME`/
  `BOT_PROVIDER`; validation rejects unknown IDs and `claude` + `rehor-openai`.
- **No runtime started:** inspect preflight action first. `skip` and `error` are
  expected to avoid runtime startup.
- **Runtime starts but no terminal:** inspect the event ledger, supervisor
  cleanup logs, and cycle timeout. Do not retry repeatedly while a process leak
  is present.
- **Cost/model mismatch:** compare `providerId`, `run.provider.id`, effective
  model, and returned usage model. A model returned by a provider must not be
  relabeled as the requested model.

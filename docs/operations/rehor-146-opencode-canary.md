# OpenCode Compatibility Canary and Rollout

This runbook covers the compatibility canary for [REHOR-146](https://issues.redhat.com/browse/REHOR-146).
The canary changes runtime and provider selection per instance while keeping the
legacy Claude/Vertex path available for rollback.

## Scope

The selection is declared in the instance config and carried through Python
config preparation into the TypeScript coordinator:

```yaml
runtime: opencode-v1
provider: rehor-openai
model: gpt-5.6-luna
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
| `opencode-v1` | `vertex` | OpenCode compatibility canary through Vertex |
| `opencode-v1` | `rehor-openai` | OpenCode canary through the OpenAI-compatible gateway |

Do not rely on a provider name embedded in a model string to select the
runtime. Runtime and provider are separate fields so either can be rolled back
without changing the other.

## Before enabling a canary

1. Confirm the target image includes `coordinator/dist/cli.js`, its locked Node
   dependencies, `/usr/local/bin/opencode` version `1.18.29`, `zstd`, and the
   configured provider gateway.
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
   the prepared provider with exact package versions and environment references.
7. Verify preflight `skip` and `error` outcomes do not start a runtime.
8. Run one local/staging `--once` cycle first; verify `/health`, `/ready`,
   `/metrics`, local JSONL output, HTTP projections, transcript compression,
   and lock release.

The Python compatibility entrypoint remains the default. A deployment must set
`BOT_EXECUTION_ENGINE=coordinator` before setting a non-default runtime in an
instance config. An older Python-only image fails closed for that selection;
it must not silently route OpenCode work through the Claude SDK.

## Rollout stages

### 1. Single-instance canary

Set `runtime: opencode-v1` and `provider: rehor-openai` for one low-volume
instance. Keep the previous deployment revision and config ready. Observe at
least one complete work cycle and one no-work/preflight cycle.

Required gates:

- exactly one terminal event per started attempt;
- terminal state and status projection agree;
- transcript, cost, cycle-run, and legacy metric records are written;
- provider/model attribution matches the selected provider and effective model;
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
3. Redeploy or restart the instance using the previous known-good image/config
   revision. Confirm the first new cycle reports `claude`/`vertex` selection.
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

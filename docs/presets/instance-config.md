# Instance Configuration

`instance.yaml` controls workflow, env-preset, runtime, and provider selection for
one bot instance. It lives at `<BOT_CONFIG_PATH>/agent/instance.yaml` in the
remote config repo.

## Resolution Order

`run.py` resolves configuration in this order:

1. `instance.yaml`, when present in the remote config repo.
2. `BOT_WORKFLOW_PRESET`, `BOT_ENV_PRESETS`, `BOT_RUNTIME`, and `BOT_PROVIDER`
   environment variables.
3. Defaults: workflow `jira-sprint`, source `jira`, all available env presets,
   runtime `claude`, and provider `vertex`.

The file is optional for default behavior. Use it when configuration must be
explicit, reviewable, or different between profiles.

## Reference

```yaml
workflow: jira-sprint
source: jira
envs:
  - browser
  - slack
  - container-scan
claude_md:
  strategy: ignore
idle_cycle_limit: 0
runtime: claude
provider: vertex
model: claude-sonnet-4-6
```

| Field | Default | Meaning |
|---|---|---|
| `workflow` | `jira-sprint` | Built-in workflow name or `./workflows/<name>` for an instance workflow |
| `source` | `jira` | Work source passed to workflow skills |
| `envs` | `null` | `null` enables all env presets; `[]` disables them |
| `claude_md.strategy` | `ignore` | `ignore`, `append`, or `replace` for instance `CLAUDE.md` |
| `idle_cycle_limit` | `0` | Optional idle-cycle reminder threshold; `0` disables it |
| `runtime` | `claude` | Runtime adapter: `claude` or `opencode` (V2 only) |
| `provider` | Runtime-dependent | `vertex` (Claude on Vertex through the auth proxy), `rehor-openai` (native Responses), or `rehor-openai-chat` (Chat Completions). Defaults to `vertex` for Claude and `rehor-openai` for OpenCode. |
| `model` | `null` | Optional model override. Claude/Vertex and OpenCode/Vertex use `claude.model`; OpenCode/`rehor-openai` uses `opencode.model`; Chat Completions requires an explicit model. |

## Runtime and Provider Selection

Runtime and provider are independent selections carried from Python config
preparation into the TypeScript coordinator. Supported pairs are:

| Runtime | Providers | Use |
|---|---|---|
| `claude` | `vertex` | Existing rollback/default path |
| `opencode` | `vertex` | Claude on Vertex through the existing auth proxy; available in packaged defaults |
| `opencode` | `rehor-openai` | Native OpenAI Responses route; default model is GPT-6 Luna |
| `opencode` | `rehor-openai-chat` | OpenAI-compatible Chat Completions route; model must be declared under this provider |

Unsupported IDs and either `claude`/OpenAI-provider combination fail
validation. OpenCode has one runtime ID, `opencode`, using client/CLI `2.1.2`;
versioned IDs and legacy aliases are unsupported. Migrate Claude instances directly
to V2 using the [migration steps](../migrations/opencode-migration.md#runtime-migration).
OpenCode's `vertex` adapter sends a placeholder bearer value to
`ANTHROPIC_VERTEX_BASE_URL`; the proxy replaces it with its service-account
token. The key and Google ADC credentials stay on the proxy. The runner supplies
the existing proxy URL without exposing Google credentials to OpenCode. URL
precedence is `REHOR_VERTEX_PROXY_URL`, `ANTHROPIC_VERTEX_BASE_URL`, then
`PROXY_HOST`/`PROXY_NAME`, with `http://devbot-proxy:8443` as final default.
For OpenCode Vertex deployments, `VERTEX_ALLOWED_MODELS` must be set on both
bot and proxy: coordinator validates selected and utility models; proxy
enforces the allowlist on Vertex requests. When `runtime` and `provider` are
omitted from `instance.yaml`, `BOT_RUNTIME` and `BOT_PROVIDER` provide
deployment-level defaults; absent an explicit provider, OpenCode selects
`rehor-openai` while Claude remains `vertex`. Keep the existing
Python/Claude/Vertex deployment available until the canary gates in the
[OpenCode rollout runbook](../operations/rehor-146-opencode-canary.md) pass.

`BOT_EXECUTION_ENGINE` is separate: it is a runner-deployment environment
setting, not an `instance.yaml` field. Omitted or `python` (default) launches
the Python runner; `coordinator` launches the TypeScript coordinator. Within
that coordinator, `runtime` selects the agent adapter. An OpenCode canary
therefore needs both `BOT_EXECUTION_ENGINE=coordinator` on the target
deployment and `runtime: opencode` plus a supported provider in this
instance's configuration. See [Onboarding a New Instance](../onboarding-new-instance.md#step-4-app-interface-configuration)
for how to scope the engine to one app-interface deployment.

## Model Resolution Order

When a cycle starts, explicit instance/deployment overrides take precedence;
workflow tiers apply to Claude and Vertex paths. With no override or tier,
Claude and OpenCode+Vertex read `claude.model`; OpenCode+`rehor-openai` reads
`opencode.model`. The defaults are
deliberately separate so GPT-6 Luna does not affect the Claude/Vertex rollback
path. `rehor-openai-chat` requires an explicit model declared under that
provider.

Claude model resolution uses 4-tier precedence:

1. **Instance pin (highest)**: `model` in `instance.yaml` (concrete model ID chosen by the instance repository owner).
2. **Deploy overlay**: `BOT_MODEL` environment variable. Applied when `instance.yaml` omits `model` (or when `instance.yaml` is absent), allowing deployment operators to set a model default across instances without modifying the config repo.
3. **Workflow tier**: `model_tier` in the workflow's `manifest.yaml` (e.g. `light`), mapped through `config.json` `claude.modelTiers`. Shared workflows stay provider-neutral by naming a tier rather than a concrete model ID.
4. **Global default (lowest)**: `claude.model` in `config.json`.

```json
"claude": {
  "model": "claude-opus-4-6",
  "modelTiers": {
    "light": "claude-sonnet-4-6",
    "heavy": "claude-opus-4-6"
  }
}
```

OpenCode+Vertex can use these workflow tiers. OpenCode+OpenAI has no separate
tier map yet and rejects `model_tier` unless an explicit instance or
`BOT_MODEL` override wins precedence; configure a concrete model for those
routes.

The OpenCode default is configured separately:

```json
"opencode": {
  "model": "gpt-6-luna"
}
```

> **Note**: Concrete model IDs must be in the selected gateway's allowlist (`VERTEX_ALLOWED_MODELS` for Vertex or `OPENAI_ALLOWED_MODELS` for OpenAI), or model calls will be rejected with HTTP 403. Unknown Claude model tiers in workflow manifests fail fast at bot startup validation.

## Environment Fallback

Use environment variables when no `instance.yaml` exists:

```bash
BOT_WORKFLOW_PRESET=jira-sprint
BOT_ENV_PRESETS=browser,slack,container-scan
```

An empty `BOT_ENV_PRESETS` value selects no env presets. Unknown workflow names
are fatal at startup. Unknown env presets are logged and skipped.

## Related Configuration

- [Preset Overview](README.md) — available workflow and env presets
- [Onboarding a New Instance](../onboarding-new-instance.md) — complete instance setup
- [Preset Migration Guide](../migrations/preset-migration-guide.md) — compatibility and migration context

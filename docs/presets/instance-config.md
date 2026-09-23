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
| `runtime` | `claude` | Runtime adapter: `claude` or `opencode-v1` |
| `provider` | Runtime-dependent | `vertex`, `rehor-openai` (native Responses), or `rehor-openai-chat` (Chat Completions). Defaults to `vertex` for Claude and `rehor-openai` for OpenCode. |
| `model` | `null` | Optional model override. Claude/Vertex and OpenCode/Vertex use `claude.model`; OpenCode/`rehor-openai` uses `opencode.model`; Chat Completions requires an explicit model. |

## Runtime and Provider Selection

Runtime and provider are independent selections carried from Python config
preparation into the TypeScript coordinator. Supported pairs are:

| Runtime | Providers | Use |
|---|---|---|
| `claude` | `vertex` | Existing rollback/default path |
| `opencode-v1` | `vertex` | OpenCode compatibility canary through the Vertex route |
| `opencode-v1` | `rehor-openai` | Native OpenAI Responses route; default model is GPT-6 Luna |
| `opencode-v1` | `rehor-openai-chat` | OpenAI-compatible Chat Completions route; model must be declared under this provider |

Unsupported IDs and either `claude`/OpenAI-provider combination fail
validation. When the keys are omitted from `instance.yaml`, `BOT_RUNTIME` and
`BOT_PROVIDER` provide deployment-level defaults; absent an explicit provider,
OpenCode selects `rehor-openai` while Claude remains `vertex`. Keep the existing Python/Claude/Vertex deployment available
until the canary gates in the [OpenCode rollout runbook](../operations/rehor-146-opencode-canary.md)
pass.

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

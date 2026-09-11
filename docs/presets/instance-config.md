# Instance Configuration

`instance.yaml` controls workflow and env-preset selection for a bot instance.
It lives at `<BOT_CONFIG_PATH>/agent/instance.yaml` in the remote config repo.

## Resolution Order

`run.py` resolves configuration in this order:

1. `instance.yaml`, when present in the remote config repo.
2. `BOT_WORKFLOW_PRESET` and `BOT_ENV_PRESETS` environment variables.
3. Defaults: workflow `jira-sprint`, source `jira`, all available env presets.

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
model: claude-sonnet-4-6
```

| Field | Default | Meaning |
|---|---|---|
| `workflow` | `jira-sprint` | Built-in workflow name or `./workflows/<name>` for an instance workflow |
| `source` | `jira` | Work source passed to workflow skills |
| `envs` | `null` | `null` enables all env presets; `[]` disables them |
| `claude_md.strategy` | `ignore` | `ignore`, `append`, or `replace` for instance `CLAUDE.md` |
| `idle_cycle_limit` | `0` | Optional idle-cycle reminder threshold; `0` disables it |
| `model` | `null` | Explicit model override for this instance (e.g. `claude-sonnet-4-6`) |

## Model Resolution Order

When a cycle starts, the model used by the Claude Agent SDK is resolved using 4-tier precedence:

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

> **Note**: Concrete model IDs configured in `instance.yaml`, `BOT_MODEL`, or `config.json` must be listed in the proxy's `VERTEX_ALLOWED_MODELS` allowlist; otherwise, model calls will be rejected with HTTP 403. Unknown model tiers in workflow manifests fail fast at bot startup validation.

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

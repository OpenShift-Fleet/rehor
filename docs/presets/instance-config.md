# Instance Configuration

## Dispatcher-managed profiles

In a configured repository, the dispatcher reads `instance/<name>/agent/instance.yaml`. Each profile chooses a workflow, runner image, and registered preflights. The runner image must launch with `BOT_EXECUTION_ENGINE=coordinator`; set `runtime: opencode` in the profile.

```yaml
workflow: jira-sprint
runtime: opencode
provider: rehor-openai
image:
  repository: quay.io/example/rehor-runner
  tag: reviewed-build
envs:
  - node
preflight:
  env:
    BOT_INSTANCE_ID: example-agent
    BOT_EXECUTION_ENGINE: coordinator
preflights:
  - gh-pr-status
  - gl-mr-status
  - id: jira-sprint
    with:
      label: example-agent
```

| Field | Meaning |
|---|---|
| `workflow` | Built-in workflow name or `./workflows/<name>` within the agent directory. |
| `image.repository`, `image.tag` | Runner image. Set an explicit reviewed build tag; omission uses `latest`. |
| `envs` | Environment presets for the runner build; `null` enables all, `[]` disables all. |
| `preflight.env` | Allowed non-secret profile settings. Set a stable, unique `BOT_INSTANCE_ID`; profile settings cannot override the deployment's memory route. |
| `preflights` | Registered check IDs and literal parameters. See [Dispatcher Preflights](custom-preflight.md) for defaults and contribution rules, and the [Preflight Reference](preflight-reference.md) for each check's inputs. |
| `cycle_timeout_seconds` | Optional per-instance timeout override. |

## Runtime and provider selection

Dispatched sandboxes use `runtime: opencode`. The `provider` and optional `model` must match the configured model route and allowlist. OpenCode defaults to `rehor-openai` when no provider is selected; select a different provider only when its route is available to the sandbox. See [Model Configuration](../models.md) for provider and model resolution.

Keep credentials out of `instance.yaml`. See [Dispatcher Credentials and Secrets](../dispatcher-secrets.md) for current platform authentication and planned instance-secret support.

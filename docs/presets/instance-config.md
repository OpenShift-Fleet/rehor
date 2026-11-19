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
| `env` | Allowed non-secret `BOT_*` profile settings, shared by dispatcher wiring and the sandbox runner. Set a stable, unique `BOT_INSTANCE_ID`; the deployment owns the memory route. |
| `sandbox.env` | **Planned; not currently supported by deployed dispatchers.** Intended for static sandbox environment values and approved workload-scoped secret references. See [Dispatcher Credentials and Secrets](../dispatcher-secrets.md) for the user setup guide and proposed syntax. |
| `preflights` | Registered check IDs and literal parameters. See [Dispatcher Preflights](custom-preflight.md) for defaults and contribution rules, and the [Preflight Reference](preflight-reference.md) for each check's inputs. |
| `cycle_timeout_seconds` | Optional per-instance timeout override. |

## Runtime and provider selection

Dispatched sandboxes use `runtime: opencode`. The `provider` and optional `model` must match the configured model route and allowlist. OpenCode defaults to `rehor-openai` when no provider is selected; select a different provider only when its route is available to the sandbox. See [Model Configuration](../models.md) for provider and model resolution.

Keep credential values and backend paths out of `instance.yaml`. See [Dispatcher Credentials and Secrets](../dispatcher-secrets.md) for Tier 2 sandbox environment references and the platform authentication boundary.

Existing profiles may continue using `preflight.env` during migration; it has
the same behavior as `env`. Do not declare both in one profile: discovery rejects
ambiguous configuration. Deploy a dispatcher supporting `env` before migrating
an existing profile. Only nonempty string `BOT_*` entries without secret-bearing
names are accepted; `BOT_MEMORY_URL` remains deployment-owned. Preflight `with`
values are explicit literals, not interpolated from `env`. `envs` selects build
presets and is unrelated to `env`.

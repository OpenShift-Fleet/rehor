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
sandbox:
  env:
    SLACK_WEBHOOK_URL: ${{ secret('myteam-slack-webhook', 'url') }}
preflights:
  - gh-pr-status
  - gl-mr-status
  - id: jira-sprint
    with:
      label: example-agent
schedule:
  triggers:
    - timezone: Europe/Prague
      start: "0 8 * * 1-5"
      end: "0 18 * * 1-5"
```

| Field | Meaning |
|---|---|
| `workflow` | Built-in workflow name or `./workflows/<name>` within the agent directory. |
| `image.repository`, `image.tag` | Runner image. Set an explicit reviewed build tag; omission uses `latest`. |
| `envs` | Environment presets for the runner build; `null` enables all, `[]` disables all. |
| `env` | Allowed non-secret `BOT_*` profile settings, shared by dispatcher wiring and the sandbox runner. Set a stable, unique `BOT_INSTANCE_ID`; the deployment owns the memory route. |
| `sandbox.env` | Sandbox runner environment values delivered per dispatch. Plain strings pass through; `${{ secret('name','key') }}` placeholders render before sandbox creation from tier-2 Kubernetes Secrets (Vault-synced by ESO, labeled `rehor.dev/secret-tier: "2"`). Secret names are provisioned per the `<team-prefix>-<name>` convention — see [Dispatcher Credentials and Secrets](../dispatcher-secrets.md). Fail-closed: an unresolvable, denied, or malformed reference creates no sandbox, and values never appear in logs or diagnostics. Tier-1 credentials (`devbot-secrets`) and runtime-owned names are rejected. Usable once a dispatcher with rendering support is deployed; see [Dispatcher Credentials and Secrets](../dispatcher-secrets.md). |
| `preflights` | Registered check IDs and literal parameters. See [Dispatcher Preflights](custom-preflight.md) for defaults and contribution rules, and the [Preflight Reference](preflight-reference.md) for each check's inputs. |
| `schedule` | Optional KEDA-style cron windows (`triggers` with `timezone`, `start`, `end` five-field crons). Gates only new dispatches; in-flight sessions drain. Malformed declarations fail discovery. See [Agent Scheduling](../scheduling.md). |
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

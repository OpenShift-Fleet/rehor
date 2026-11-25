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
  egress:
    - host: downloads.example.com
      port: 443
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
| `sandbox.egress` | Optional list of at most 32 requested extra sandbox egress destinations, each exactly `host` plus `port: 443` — an exact lowercase public DNS hostname. Wildcards, IP literals, URLs, other ports, and raw policy are not expressible. Absent or `[]` leaves the sandbox policy unchanged; each host additionally requires a platform approval for this exact repository and profile plus `AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED=true`, otherwise the session fails before sandbox creation. See [Sandbox egress requests](#sandbox-egress-requests). |
| `preflights` | Registered check IDs and literal parameters. See [Dispatcher Preflights](custom-preflight.md) for defaults and contribution rules, and the [Preflight Reference](preflight-reference.md) for each check's inputs. |
| `schedule` | Optional KEDA-style cron windows (`triggers` with `timezone`, `start`, `end` five-field crons). Gates only new dispatches; in-flight sessions drain. Malformed declarations fail discovery. See [Agent Scheduling](../scheduling.md). |
| `cycle_timeout_seconds` | Optional per-instance timeout override. |

## Sandbox egress requests

`sandbox.egress` optionally requests additional direct egress destinations for the sandbox runner. The shape is closed — an exact hostname and port, nothing else:

```yaml
sandbox:
  egress:
    - host: downloads.example.com
      port: 443
```

Declaration is strict. A malformed declaration fails profile discovery for the whole repository:

- At most 32 entries, no duplicate hosts, and each entry contains only `host` and `port`.
- `port` is exactly `443`.
- `host` is an exact lowercase ASCII DNS hostname: multiple labels containing `a-z`, `0-9`, or `-` (no leading or trailing hyphen), at most 253 characters total. Wildcards, IP literals, URLs, punycode (`xn--` labels), and local or reserved suffixes are rejected.

Older dispatcher builds reject the declaration at discovery; deploy a supporting build before declaring it.

A well-formed request grants nothing by itself. Each host must be platform-approved for the exact configured repository URL and the profile directory name, and the deployment must run with `AGENT_DISPATCHER_PUBLIC_EGRESS_ENABLED=true`. Until both hold, any non-empty request fails the session at policy construction — before any sandbox or workspace is created — while an absent or empty (`[]`) declaration leaves the sandbox policy unchanged. Request only public, non-credential-bearing download destinations: the platform approval additionally pins 1–16 stable public IPv4 addresses for the host, profiles cannot supply addresses, and hosts without stable, dedicated public IPv4 addressing cannot be approved.

The grant is layer-4 TCP 443 with TLS passthrough — the sandbox's own TLS validation stays normal. It is not HTTPS enforcement: HTTP methods and paths cannot be restricted, and no credentials belong on approved hosts. Route authenticated or protocol-level access through the platform's authenticated gateway instead; gateway-only destinations are never approvable. Only the reviewed system toolset (git, curl, Python, Node.js, uv, Grype, Go) may open these connections. See [Agent Dispatcher Deployment](../agent-dispatcher-deployment.md) for the approval process — including the address-dedication requirement — enforcement points, and rollout and rollback.

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

# Model Configuration

Model configuration has two parts: deployment declarations make models
available to OpenCode, and instance or agent configuration selects them. The
coordinator's packaged OpenCode defaults and pricing catalog are separate from
instance configuration.

## Available models

The packaged declarations are in `coordinator/opencode-deployment.default.json`
and `coordinator/opencode-deployment.example.json`. The Responses provider uses
`@opencode/ai/providers/openai/responses` through the model proxy on port 8450.

| Model ID | Name | Reasoning | Packaged default |
|---|---|---|---|
| `gpt-6-luna` | GPT-6 Luna | Supported | Declared |
| `gpt-6.1-sol` | GPT-6.1 Sol | Supported | Not declared |
| `gpt-6.1-terra` | GPT-6.1 Terra | Supported | Declared |

The repo's packaged defaults include Luna and Terra under `rehor-openai`, but
not Sol. Existing instances close that gap in their own deployment configs:
the onboarding instance and the framework-agent instances all declare both Sol
and Luna under `rehor-openai`, with Sol selected as the root model on
onboarding and Luna as the root model elsewhere, and both models used by
native subagents. Selecting Sol therefore requires a deployment config that
declares it. See
`coordinator/opencode-deployment.default.json`,
`coordinator/src/runtimes/opencode/pricing.json`, and the Sol/Luna migration
inventory in `docs/migrations/opencode-migration.md`.

`rehor-openai-chat` uses Chat Completions via
`@opencode/ai/providers/openai-compatible`. `vertex` serves Claude through the
Rehor proxy. Their packaged models:

| Provider | Model | Details |
|---|---|---|
| `rehor-openai-chat` | `gpt-4.1` | — |
| `rehor-openai-chat` | `gpt-4.1-mini` | — |
| `rehor-openai-chat` | `gpt-4o` | Reasoning unsupported; context 128,000; output 16,384. |
| `vertex` | `claude-sonnet-4-6` | Context 200,000; output 32,000. |
| `vertex` | `claude-opus-4-6` | Context 200,000; output 32,000. |
| `vertex` | `claude-haiku-4-5@20251001` | Context 200,000; output 32,000. |

### Catalog price estimates

`coordinator/src/runtimes/opencode/pricing.json` is a hand-maintained fallback
catalog. Rates are USD per million tokens; these are catalog estimates, not
billed amounts. Input/output cache rates are shown as cache-read/cache-write.
For the context tier, rates apply only when context is greater than 272,000
tokens. The catalog stores canonical `openai/<model-id>` keys for both OpenAI
routes.

| Model | Base I/O | Base cache R/W | Over 272K I/O | Over 272K cache R/W |
|---|---:|---:|---:|---:|
| `gpt-6-luna` | $0.10 / $0.50 | $0.01 / $0.125 | $0.20 / $0.75 | $0.02 / $0.25 |
| `gpt-6.1-sol` | $2 / $10 | $0.10 / $2.50 | $4 / $15 | $0.20 / $5 |
| `gpt-6.1-terra` | $1 / $5 | $0.05 / $1.25 | $2 / $7.50 | $0.10 / $2.50 |

The context threshold is a pricing tier, not a declared model context limit.
Rates come from models.dev. Unpriced usage falls back to unknown pricing; add a
catalog entry when adding a model. See
`coordinator/src/runtimes/opencode/pricing.json` and the cost-estimates section
of `docs/migrations/opencode-migration.md`.

## Add a model

1. **Declare the model under its provider.** Add it to the `models` map in
   `coordinator/opencode-deployment.default.json` and
   `coordinator/opencode-deployment.example.json` when it belongs in shared
   defaults. Instance-specific models can instead be declared in an
   instance-owned OpenCode deployment config. Model fields are limited to
   `name`, `modelID`, `limit`, `settings`, and `capabilities`. Set reasoning as
   `capabilities.reasoning.supported: true`; do not use top-level `reasoning`
   or legacy `options` fields. The renderer rejects those fields.
2. **Add catalog pricing.** Add an entry to the plain `models` map in
   `coordinator/src/runtimes/opencode/pricing.json`, using rates from models.dev.
   OpenAI model keys use `openai/<model-id>`; Vertex keys and aliases are
   described in the migration guide. Without a matching entry, cost reporting
   has unknown pricing when no native estimate is available.
3. **Update the gateway allowlist.** Add OpenAI route model IDs to
   `OPENAI_ALLOWED_MODELS` on the proxy (see
   [SETUP.md](https://github.com/RedHatInsights/platform-frontend-ai-dev/blob/master/SETUP.md)).
   For Vertex, add IDs to `VERTEX_ALLOWED_MODELS` on both bot and proxy. The coordinator
   requires the Vertex list and the proxy enforces it. Missing or disallowed
   models fail closed; gateway requests outside an allowlist receive HTTP 403.
   See [Instance Configuration](presets/instance-config.md#runtime-and-provider-selection).
4. **Roll out deployment declarations.** Packaged deployment JSON is copied
   into the runner image, so changing it requires rebuilding the image and
   rolling out a new deployment. An `instance.yaml` selection change is read on
   the next config sync and does not require an image rebuild.
5. **Keep credentials out of JSON.** Custom deployment configs must use
   `{env:REHOR_MODEL_PROXY_URL}` and `{env:REHOR_MODEL_PROXY_TOKEN}` references,
   never literal credentials. `REHOR_OPENCODE_DEPLOYMENT_CONFIG` optionally
   overrides packaged defaults; see `coordinator/opencode-deployment.example.json`
   and the local coordinator launch section of `coordinator/README.md`.
6. **Select the model.** For an agent-specific selection, declare the model
   under the provider selected by the instance and include it in that
   provider's gateway allowlist. Use provider-qualified `model:` in agent
   frontmatter as shown below.

The deployment model schema and legacy-field rejection are implemented in
`coordinator/src/runtimes/opencode/render.ts`.

## Select a model

### Root model per cycle

The runner resolves the cycle's root model in this order:

1. `model` in the instance's `instance.yaml`.
2. `BOT_MODEL` deployment override.
3. Workflow `model_tier`, mapped through `config.json`'s
   `claude.modelTiers` (Claude and Vertex only).
4. Provider-specific model in `config.json`.

For Claude/Vertex, the fallback is currently `claude.model: claude-opus-4-6`.
For OpenCode with `rehor-openai`, it is `opencode.model: gpt-6-luna`.
OpenCode with `rehor-openai` has no tier map; a workflow `model_tier` is rejected
unless an explicit instance or `BOT_MODEL` override wins. `rehor-openai-chat`
requires an explicit model declared under that provider. The resolver is in
`bot/config.py`; see
[Instance Configuration](presets/instance-config.md#model-resolution-order).

Instance selection example:

```yaml
runtime: opencode
provider: rehor-openai
model: gpt-6-luna
```

Use `gpt-6.1-terra` or `gpt-6.1-sol` for `model` when that ID is declared under
`rehor-openai` in the deployment configuration and allowlisted. Sol is not in
the packaged defaults.

### Per-agent model

Native agent files live in `.opencode/agents/*.md`. Specify a provider-qualified
model in YAML frontmatter:

```markdown
---
description: Investigates a task
mode: subagent
model: rehor-openai/gpt-6.1-sol
---
Investigate the assigned task.
```

The root model remains runner-selected; native `default_agent` configuration
chooses which agent is primary. The renderer normalizes a bare **root** model
using the selected deployment provider, but agent frontmatter uses native
`provider/model` syntax and bare names fail validation. Agent model selection
must use a model declared under the selected provider and included in its
gateway allowlist. Frontmatter validation is in
`coordinator/src/runtimes/opencode/native-definitions.ts`; root model
normalization is in `coordinator/src/runtimes/opencode/render.ts`.

### Utility/title model

The renderer sets the title-generation model as native `agents.title.model`,
never `small_model`. An explicit deployment `smallModel` overrides the default.
Otherwise Vertex prefers Claude Sonnet when it is declared and allowlisted;
other routes use the selected model. See
`coordinator/src/runtimes/opencode/model-defaults.ts` and
`coordinator/src/runtimes/opencode/render.ts`.

## Related Configuration

- [Instance Configuration](presets/instance-config.md) — instance selection and model precedence.
- [OpenCode Migration](migrations/opencode-migration.md) — renderer contract and cost accounting.
- [SETUP.md](https://github.com/RedHatInsights/platform-frontend-ai-dev/blob/master/SETUP.md)
  — gateway environment variables and allowlists.

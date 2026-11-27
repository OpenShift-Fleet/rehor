# Dispatcher Credentials and Secrets

## Secret tiers reflect disclosure impact

**Both tiers are sensitive.** Tier describes potential impact if a value is disclosed, not whether the value is secret.

- **Tier 1 — platform-impacting or internally revealing credentials.** Keep these in platform-owned secret and authentication boundaries. Do not make them selectable in instance configuration or expose them to agent workloads.
- **Tier 2 — workload-scoped credentials with bounded impact.** Use only when a workload needs a credential and its disclosure would not grant platform access or reveal sensitive internal information. A dedicated webhook can still be abused; scope it to one workload and make it independently revocable.

The [dispatcher](agent-dispatcher-deployment.md) mints short-lived credentials for platform services. These platform credentials are not delivered as ordinary sandbox environment values.

## Configure a Tier 2 sandbox secret

`sandbox.env` secret references need two deployed pieces: a dispatcher image with rendering support, and the named tier-2 Kubernetes Secret the reference points to. The Secret is provisioned once through private platform configuration; instance repositories then reference it by name only.

### 1. Choose an eligible credential

Confirm the credential is workload-scoped and safe to expose to the agent process running in that sandbox. Do not use this feature for Tier 1 or platform-shared credentials. Any process in the sandbox can read the resulting environment value.

### 2. Arrange Vault storage

Use a Vault location owned by the team responsible for the workload. If suitable storage or write permission does not exist, ask the platform/Vault owner to set it up before adding a reference. Store the value through the approved Vault process; never put secret values or Vault paths in a public instance repository.

### 3. Provision the named Secret in the workload namespace

`secret(name, key)` takes no Vault path. The `name` is a Kubernetes Secret in the dispatcher's namespace, synced from Vault by ESO from an `ExternalSecret` defined in private app-interface configuration. You cannot invent the name in the instance repository: you reference the name that was provisioned, and you request provisioning when it does not exist yet.

**Naming convention: `<team-prefix>-<name>`.** All teams provisioning into the shared namespace prefix target Secret names with their team or workload prefix — `ocm-fleet-rehor`, `ui-slack-webhook`. Bare generic names such as `slack-webhook` collide across teams and are not accepted for new provisioning.

Provisioning is one app-interface change per secret, coordinated with the namespace owner:

- An `ExternalSecret` mapping only the approved Vault properties into the target Secret — never sync an entire Vault object by default — and labeling the target `rehor.dev/secret-tier: "2"` so the dispatcher accepts it for resolution.
- A Role and RoleBinding granting the dispatcher's service account `get` on that one target Secret name only. Do not grant `list` or `watch` on Secrets.

Worked example — the `ocm-fleet-rehor` Secret (live in the stage namespace). The `ExternalSecret` in app-interface:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ocm-fleet-rehor              # <team-prefix>-<name>: ocm-fleet + rehor
  namespace: platform-frontend-ai-dev-stage
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: rehor-vault
    kind: SecretStore
  target:
    name: ocm-fleet-rehor            # the Kubernetes Secret name instances reference
    template:
      metadata:
        labels:
          rehor.dev/secret-tier: "2"  # required — the dispatcher resolves only tier-2 Secrets
  data:
  - secretKey: SLACK_WEBHOOK_URL     # the key instances reference
    remoteRef:
      key: secrets/<team>/<workload>  # private Vault path — lives only in app-interface
      property: SLACK_WEBHOOK_URL
```

The dispatcher RBAC in the same app-interface change:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: rehor-agent-dispatcher-ocm-fleet-rehor
rules:
- apiGroups: [""]
  resources: [secrets]
  resourceNames: [ocm-fleet-rehor]   # the same target name
  verbs: [get]
```

The RoleBinding binds this Role to the `rehor-agent-dispatcher` ServiceAccount.

The Vault path, policies, and store authentication never leave app-interface. Instance authors work with exactly two public facts: the target Secret name and the key.

### 4. Reference it from `instance.yaml`

Use `sandbox.env` for values delivered to the sandbox runner. This references the Secret provisioned above:

```yaml
sandbox:
  env:
    SLACK_WEBHOOK_URL: "${{ secret('ocm-fleet-rehor', 'SLACK_WEBHOOK_URL') }}"
    FEATURE_FLAG: "enabled"
```

In `secret(name, key)`, `name` is the target Secret name from step 3 — `spec.target.name` of the `ExternalSecret` — and `key` is one of its `secretKey` entries. Neither argument is a Vault path or a Vault property name unless the private mapping intentionally uses the same text. Only approved `secret()` references are supported; this is not a general-purpose template language. Plain strings pass through unchanged.

Target Secret names are unique within a namespace. Kubernetes RBAC grants access to the whole Secret object, not individual keys, so keep each target object limited to one workload's approved values. If a requested Secret or key is missing or denied, resolution fails closed and the dispatcher does not create a partially configured sandbox.

Top-level `env` configures allowed non-secret `BOT_*` profile settings for both
dispatcher wiring and the sandbox runner. The same approved settings are also
delivered to the registered TypeScript preflights as one read-only `instanceEnv`
unit on the run context — never merged with process.env, `sandbox.env`, secret
references, or resolved credentials. The legacy `preflight.env` form has the
same behavior. Neither form is a secret store. `envs` selects runner build
presets and is separate from both `env` and `sandbox.env`.

### 5. Verify without exposing values

After deployment, check that the `ExternalSecret` reports a successful sync and that the target Secret exists. Do not print or copy secret values into logs, tickets, prompts, or public repositories. Rotation is handled by ESO's configured refresh interval; do not pin a Vault version unless the owning team has a specific rollback requirement.

## Reference tier-2 secrets in preflight parameters

Registered [preflight checks](presets/preflight-reference.md) can receive tier-2 values through their `with:` parameter maps, using the same reference syntax as `sandbox.env`:

```yaml
preflights:
  - id: jira-kanban
    with:
      project: "${{ secret('team-settings', 'JIRA_PROJECT') }}"
      label: rehor-pilot
```

Use this only for tier-2 settings the selected preflight and agent may legitimately consume — team field ids, workload-scoped endpoints, feature toggles. Never reference platform credentials: tier-1 Secrets are denied before any request is made, and unlabeled Secrets are rejected.

**Audit the check before routing a secret through it.** Any registered preflight may echo its supplied parameter values into its result content, transcripts, or tool output — the dispatcher guarantees only its own errors, logs, and diagnostics, never preflight content. Review the specific check's implementation (and the agent consuming its output) before referencing a secret in its `with:` map, and keep secret-derived settings inside trusted helpers whenever the check does not need them in its output.

Rendering happens per entry, immediately before that entry executes. Values can rotate at any time, so nothing is cached across entries, cycles, or the dispatcher process lifetime: each entry reads its referenced Secrets fresh, and only that entry's prefetch deduplicates repeated references within the entry. Entries whose parameters carry no reference never read anything.

Validation is fail-closed at every step:

- Entry shape, preflight ids, unknown and missing parameters, and reserved keys are validated on the declared literals before any entry executes or any Secret is read. A placeholder supplied as the whole value of a parameter whose schema can provably never accept a string (a plain number, boolean, or list parameter) also fails closed here — the dispatcher never coerces a rendered string itself; a schema that asks Zod for coercion may legitimately accept one, so coercing fields defer to the post-render parse. For plain non-string parameters, use `sandbox.env` or non-secret `env` settings instead.
- For entries carrying references, the check's input schema runs exactly once — on the fully rendered parameter map, immediately before the entry executes. All value constraints, including string formats, list element schemas, and whole-`with:`-map refinements, apply to the rendered values; schema callbacks (transforms, refinements, preprocessors) never run on declaration literals. Wrappers the dispatcher cannot assess structurally without running schema code (preprocessors, lazy schemas) defer to that same single post-render parse.
- A missing, invalid, rotated, or transport-failed render prevents the whole dispatch, even when earlier entries already ran.
- Rendered values never appear in error messages, transcripts, lifecycle logs, or structured diagnostics. Failures carry fixed messages naming at most the reference and key. What a preflight chooses to include in its own content is the preflight implementation's responsibility — see the audit warning above.

**Compatibility change.** A `with:` string value containing `${{` is now a render template, exactly like a `sandbox.env` value. Before this feature, such a literal reached the preflight verbatim; now it renders through the template engine, and a span that is not a valid `secret()` reference either renders to different text or fails the dispatch. Verbatim passthrough cannot be offered safely: a malformed intended secret reference would then be delivered to the preflight as if it were the configured value. Literal values that do not contain `${{` are unaffected.

Rotation within one run is detected, not averaged away. Every entry's rendered values are recorded in a private in-memory ledger — nothing is overwritten, and no values, hashes, or digests are ever logged or serialized. Only start-outcome entries bind: their content is the only preflight output that reaches the sandbox (the input envelope carries start content plus script names and statuses, nothing else), so only their observations constrain the launch. Two starts that observed different values for the same reference produce a mixed prompt, and the dispatch fails closed as a transient error — the next cycle re-runs the preflights against fresh values. At sandbox launch, `sandbox.env` references are rendered once and compared against the bound values in dispatcher memory — no second fetch. A value that changed between the preflight reads and the launch render refuses the launch the same way. Skip and error entries' observations never bind: their content stays in the cycle report and cannot reach the sandbox. Values referenced only by preflight parameters (never by `sandbox.env`) are not re-checked at launch: the sandbox receives exactly the preflight's intentional output, and re-verification would require a second fetch that still could not guarantee post-launch stability.

Vault freshness is bounded by ESO: the dispatcher reads the Kubernetes Secret, so a rotated Vault value reaches preflight parameters only after the `ExternalSecret`'s `refreshInterval` re-syncs it. Configure the interval with that latency in mind.

## Runtime guarantees and limits

- Secret resolution completes before sandbox creation.
- Resolved values are not written to prompts, logs, or diagnostics.
- Rendered values are delivered through the native OpenShell sandbox environment: sandbox-wide, persisted by the gateway for the sandbox lifetime, and readable by any process in the sandbox.
- The value is available to code running inside the sandbox and can be disclosed by that workload. Use only independently revocable, workload-scoped Tier 2 credentials.
- Tier 1 credentials remain within platform-owned authentication and secret mechanisms; they must never be mapped into `sandbox.env`.
- Preflight `with:` parameters follow the same tier rules and the same reference syntax; see [Reference tier-2 secrets in preflight parameters](#reference-tier-2-secrets-in-preflight-parameters).
- Every Kubernetes Secret read is bounded (a five-second hard timeout per request, one parallel request per distinct Secret name) and cannot hang a cycle; an abort signal during a pending read never executes the entry.

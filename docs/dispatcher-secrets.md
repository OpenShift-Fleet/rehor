# Dispatcher Credentials and Secrets

## Secret tiers reflect disclosure impact

**Both tiers are sensitive.** Tier describes potential impact if a value is disclosed, not whether the value is secret.

- **Tier 1 — platform-impacting or internally revealing credentials.** Keep these in platform-owned secret and authentication boundaries. Do not make them selectable in instance configuration or expose them to agent workloads.
- **Tier 2 — workload-scoped credentials with bounded impact.** Use only when a workload needs a credential and its disclosure would not grant platform access or reveal sensitive internal information. A dedicated webhook can still be abused; scope it to one workload and make it independently revocable.

The [dispatcher](agent-dispatcher-deployment.md) mints short-lived credentials for platform services. These platform credentials are not delivered as ordinary sandbox environment values.

## Planned: configure a Tier 2 sandbox secret

Tier 2 references in `sandbox.env` are a **future capability** and are not available in deployed dispatchers yet. This guide describes the intended setup. It will work only after dispatcher rendering support and the matching namespace configuration are deployed.

### 1. Choose an eligible credential

Confirm the credential is workload-scoped and safe to expose to the agent process running in that sandbox. Do not use this feature for Tier 1 or platform-shared credentials. Any process in the sandbox can read the resulting environment value.

### 2. Arrange Vault storage

Use a Vault location owned by the team responsible for the workload. If suitable storage or write permission does not exist, ask the platform/Vault owner to set it up before adding a reference. Store the value through the approved Vault process; never put secret values or Vault paths in a public instance repository.

### 3. Allow the secret in the workload namespace

Coordinate with the namespace owner to:

- Configure ESO to read only the approved Vault path.
- Add an `ExternalSecret` mapping from the Vault property to a target Kubernetes Secret name and key. Map only the properties the workload needs; do not sync an entire Vault object by default.
- Allow the `ExternalSecret` resource in the namespace.
- Grant the dispatcher `get` on that target Secret name only. Do not grant `list` or `watch` on Secrets.
- Mark the target as an approved Tier 2 Secret for dispatcher resolution.

This mapping belongs in private platform configuration. It connects the private Vault location/property to the Kubernetes target name/key; instance authors do not need the Vault path.

### 4. Reference it from `instance.yaml`

Use `sandbox.env` for values delivered to the sandbox runner:

```yaml
sandbox:
  env:
    WEBHOOK_URL: "${{ secret('workload-credentials', 'endpoint') }}"
    FEATURE_FLAG: "enabled"
```

In `secret(name, key)`, `name` is the approved Kubernetes Secret name and `key` is a key in that Kubernetes Secret. Neither argument is a Vault path or a Vault property name unless the private mapping intentionally uses the same text. Only approved `secret()` references are supported; this is not a general-purpose template language. Plain strings pass through unchanged.

Target Secret names are unique within a namespace. Kubernetes RBAC grants access to the whole Secret object, not individual keys, so keep each target object limited to one workload's approved values. If a requested Secret or key is missing or denied, resolution fails closed and the dispatcher does not create a partially configured sandbox.

Top-level `env` configures allowed non-secret `BOT_*` profile settings for both
dispatcher wiring and the sandbox runner. The legacy `preflight.env` form has
the same behavior. Neither form is a secret store. `envs` selects runner build
presets and is separate from both `env` and the planned `sandbox.env`.

### 5. Verify without exposing values

After deployment, check that the `ExternalSecret` reports a successful sync and that the target Secret exists. Do not print or copy secret values into logs, tickets, prompts, or public repositories. Rotation is handled by ESO's configured refresh interval; do not pin a Vault version unless the owning team has a specific rollback requirement.

## Runtime guarantees and limits

- Secret resolution completes before sandbox creation.
- Resolved values are not written to prompts, logs, or diagnostics.
- The value is available to code running inside the sandbox and can be disclosed by that workload. Use only independently revocable, workload-scoped Tier 2 credentials.
- Tier 1 credentials remain within platform-owned authentication and secret mechanisms; they must never be mapped into `sandbox.env`.

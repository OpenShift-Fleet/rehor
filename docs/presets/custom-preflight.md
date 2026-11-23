# Dispatcher Preflights

Dispatched agents select checks from the reviewed `@rehor/preflights` registry. Instance repositories provide only declarative `preflights:` configuration; the dispatcher does not execute scripts supplied by an instance. Every new dispatcher check must be contributed by pull request to this repository under [`packages/preflights`](https://github.com/OpenShift-Fleet/rehor/tree/master/packages/preflights).

## Configure an instance

Set `preflights:` in `instance/<name>/agent/instance.yaml`. Entries can be shorthand IDs when all inputs have defaults, or `{ id, with }` entries for parameters. `with` accepts plain literal strings, numbers, booleans, or lists of those values; it does not support nested objects, `null`, or interpolation.

Example using registered `jira-sprint` (requires a nonblank `label`) and `gh-pr-status` (no required inputs):

```yaml
workflow: jira-sprint
preflights:
  - id: jira-sprint
    with:
      label: rehor-pilot
  - gh-pr-status
```

An explicit list replaces workflow defaults; it does not merge with them. Required inputs are defined by each registered preflight's schema. For example, `jira-sprint` requires `label`; `onboarding` requires `label`; `jira-kanban` requires `project` and `label`. The [Preflight Reference](preflight-reference.md) lists all registered IDs, inputs, and defaults.

## Omitted, explicit, and empty declarations

| `preflights` in `instance.yaml` | Dispatcher behavior |
|---|---|
| Omitted | Inherit workflow's registered defaults. Currently, `jira-sprint` defaults to `gh-pr-status` and `gl-mr-status`. Other workflows have no default and must declare checks explicitly. |
| Non-empty list | Run exactly the listed checks in order, replacing any workflow defaults. Each entry is validated against the registry before any check executes; invalid configuration fails closed. |
| `[]` | Run no checks and launch no sandbox (`no-scripts`). Required dispatcher wiring still applies. |

A shorthand ID is valid only when that check's input schema accepts an empty parameter map. Use explicit `with:` values for required inputs.

## Runtime behavior

The registry and its input requirements are maintained in [`packages/preflights`](https://github.com/OpenShift-Fleet/rehor/tree/master/packages/preflights); the dispatcher consumes its populated registry. See the [Preflight Reference](preflight-reference.md) for the registered checks and their parameters. Checks run sequentially in declaration order, with each entry limited to 120 seconds. A `start` result dispatches actionable content; `skip` does not. Execution errors are reported separately, and an error from one check does not suppress a `start` from another. The agent prompt contains `start` content only.

Checks that access Jira, GitHub, or GitLab use the configured services gateway; the dispatcher does not call those services directly. See the [dispatcher deployment guide](../agent-dispatcher-deployment.md#preflight-execution-engine) for wiring and operational details.

## Contribute a new check

If an instance needs a check that is not registered, do not add Python, TypeScript, or other executable preflight files to its config repository. Implement the check in this repository under `packages/preflights/src/preflights/`, register it in `packages/preflights/src/preflights/index.ts`, add fixture-based tests, and submit a pull request. The package README documents [implementation and test steps](https://github.com/OpenShift-Fleet/rehor/blob/master/packages/preflights/README.md#adding-a-preflight).

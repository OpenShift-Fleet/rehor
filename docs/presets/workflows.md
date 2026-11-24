# Workflow Presets

A workflow supplies the agent's instructions and skills; the dispatcher preflight list decides **when** those instructions run. Set `workflow` and `preflights` in [`instance.yaml`](instance-config.md).

| Workflow | Use |
|---|---|
| `jira-sprint` | Work from sprint tickets; maintain PRs and MRs between implementation cycles. |
| `jira-kanban` | Work from configured Jira project statuses instead of the active sprint. |
| `onboarding` | Process onboarding work and advance tasks through their phases. |

`jira-sprint` inherits `gh-pr-status` and `gl-mr-status` when `preflights` is omitted. Add a parameterized `jira-sprint` check to an explicit list if the dispatcher should also find new sprint tickets. An explicit list replaces all defaults. See [Dispatcher Preflights](custom-preflight.md) for a complete example and the [Preflight Reference](preflight-reference.md) for all registered checks and their parameters.

For a new workflow, see [Custom Workflows](custom-workflows.md).

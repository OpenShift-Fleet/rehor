# Custom Workflows

Use a custom workflow when an instance needs different agent instructions or skills. The workflow supplies agent behavior; the dispatcher preflight list determines when to start a run.

1. Create a workflow directory inside the agent profile, such as `workflows/review-only/`.
2. Add `AGENTS.md` with concise instructions for the dispatched agent. Add only supported workflow resources and skills.
3. Set `workflow: ./workflows/review-only` in `instance.yaml`.
4. Declare registered preflight IDs explicitly. Custom workflows do not inherit central workflow defaults.

```yaml
workflow: ./workflows/review-only
runtime: opencode
preflights:
  - gh-pr-status
  - gl-mr-status
```

This example checks tracked PRs and MRs. It does not search for new tickets. If a required check is not registered, [contribute it to `packages/preflights`](custom-preflight.md#contribute-a-new-check) before referencing its ID. Instance repositories cannot supply executable preflight code.

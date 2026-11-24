# OpenShell Deployment

The dispatcher creates a per-run OpenShell sandbox only after registered preflights find actionable work. It verifies the sandbox's effective policy before starting the runner.

Use the [Agent Dispatcher Deployment](agent-dispatcher-deployment.md) guide for dispatcher configuration, sandbox lifecycle, rollout, and verification. Instance profile requirements are in [Instance Configuration](presets/instance-config.md#dispatcher-managed-profiles).

Match the runner image to the dispatcher's configured runtime layout. Verify writable checkout and temporary paths, memory and service routes, and the model gateway before enabling live work. OpenCode tool permissions do not replace OpenShell filesystem or network policy.

# Onboard a Dispatcher-Managed Instance

Dispatcher-managed instances use registered preflights and receive a per-run OpenShell sandbox only when work is actionable.

## Primary path: onboarding agent

Start with the [Rehor onboarding agent](https://github.com/OpenShift-Fleet/rehor-onboarding-agent). It guides teams through instance setup; its README explains how to request onboarding, what information to provide, and the phases it handles. The manual guide below remains important reference and fallback when agent-assisted onboarding is unavailable or needs human intervention.

## Setup

1. Use `dev-bot` as a pinned submodule in the runner repository. Add the profile at `instance/<name>/agent/instance.yaml` with `runtime: opencode`, a unique `BOT_INSTANCE_ID`, and `BOT_EXECUTION_ENGINE: coordinator` in `preflight.env`. See [Instance Configuration](presets/instance-config.md#dispatcher-managed-profiles) for the complete example.
2. Select registered checks in `preflights:`. Instance repositories provide configuration only; new checks must be contributed to Řehoř. See [Dispatcher Preflights](presets/custom-preflight.md).
3. Build the runner from the instance repository root with `docker build -f dev-bot/Dockerfile.runner -t <runner-image>:<tag> .`. Publish it to the deployment's registry and set the released image and tag in the profile.
4. Enroll the configuration repository in the [dispatcher deployment](agent-dispatcher-deployment.md) and verify profile discovery, preflight decisions, and a dispatched run with cleanup. Keep credentials out of Git; see [Dispatcher Credentials and Secrets](dispatcher-secrets.md).

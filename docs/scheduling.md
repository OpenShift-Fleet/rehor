# Agent Scheduling

## Current behavior

The dispatcher checks configured agents at most once every five minutes. Registered preflights determine whether a per-run OpenShell session should start. Dispatcher-managed agents do not currently use KEDA or a per-instance schedule.

## Planned scheduling

The intended direction is a dispatcher-managed, per-instance schedule with KEDA-like configuration. The dispatcher would use that schedule to decide when to start agent cycles. Schedule syntax, timezone and daylight-saving behavior, and how scheduled cycles interact with preflight decisions are not specified yet; this page does not define a configuration contract.

Until scheduling is implemented, use the dispatcher's current cadence. Do not add KEDA `ScaledObject` or `SandboxWarmPool` configuration for dispatcher-managed agents. See [legacy warm-pool scheduling](legacy/scheduling.md) only when maintaining a template-managed deployment.

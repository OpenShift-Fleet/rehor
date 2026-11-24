# Řehoř

Řehoř finds actionable development work, implements changes, and maintains PRs and MRs through CI and review. Instance configuration selects workflows, target repositories, and preflight checks.

The dispatcher runs registered TypeScript preflights before starting an OpenShell sandbox. It passes actionable results to the coordinator, which runs one OpenCode V2 cycle and exits. No actionable result means no model session.

## Get started

- [Documentation site](https://openshift-fleet.github.io/rehor/)
- [Onboard a dispatched instance](docs/onboarding-new-instance.md)
- [Configure the shared dispatcher](docs/agent-dispatcher-deployment.md)
- [Architecture](ARCHITECTURE.md)

## Contribute a preflight

Instance repositories select registered check IDs and supply literal parameters. New checks must be contributed by PR to [`packages/preflights`](packages/preflights/README.md#adding-a-preflight) in this repository. The dispatcher does not execute preflight scripts from instance repositories.

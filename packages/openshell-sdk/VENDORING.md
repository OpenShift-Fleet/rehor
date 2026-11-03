# Vendored OpenShell SDK

This workspace contains the published `@nvidia/openshell-sdk` 0.1.5 distribution. It is vendored to keep Konflux builds from fetching this package from GitHub Packages, which is not an approved Enterprise Contract package source for this component.

## Provenance

- Upstream project: [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell), tag [`v0.1.5`](https://github.com/NVIDIA/OpenShell/tree/v0.1.5), commit `bdb956f2cd65a635f1294fccf1d138d263bf650f`
- Package: `@nvidia/openshell-sdk@0.1.5`, copied from its published npm package distribution
- Published artifact SHA-512: `pqeumlEkIoFko9kL8EmemULuEPGf7dbFz1DXac9mB5H5e0+vGs24T1S+jT/UOtjhYEdmBSR3WjMojBBAyh6lSQ==`
- License: Apache-2.0; upstream `LICENSE` is retained in this directory

SDK files under `dist/` and the upstream `README.md` are kept as published. The local package manifest removes upstream publish/build-only configuration and marks this copy private; runtime exports, version, and dependencies remain aligned with upstream 0.1.5. Do not publish this workspace.

## Updating

1. Select an upstream SDK version and obtain its published package artifact through an approved channel.
2. Verify the artifact checksum and the matching upstream tag/commit before replacing `dist/` and the upstream `README.md`.
3. Update this package's runtime manifest, `LICENSE` if changed upstream, and this provenance record. Preserve upstream copyright and license notices; mark any modified upstream files.
4. Update the Agent Dispatcher dependency and npm lockfile. Confirm the lock resolves `@nvidia/openshell-sdk` to this workspace, not `npm.pkg.github.com`.
5. Run dependency, license, image-runtime, SBOM, and Enterprise Contract checks. Do not assume vendoring removes the policy violation until the resulting SBOM/EC evaluation confirms it.

The SDK's `@bufbuild/protobuf`, `@connectrpc/connect`, and `@connectrpc/connect-node` dependencies are not vendored here; they continue to resolve from their configured registries.

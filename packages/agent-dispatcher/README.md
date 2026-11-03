# Agent Dispatcher

## OpenShell SDK dependency

The dispatcher uses NVIDIA's `@nvidia/openshell-sdk` 0.1.5. We keep its published distribution in the private npm/Nx workspace at `packages/openshell-sdk` instead of fetching it from GitHub Packages. This avoids requiring Konflux credentials or an Enterprise Contract package-source exception for this SDK. The vendored files are Apache-2.0; see `packages/openshell-sdk/LICENSE` and `packages/openshell-sdk/VENDORING.md` for license, provenance, checksum, and update instructions.

The dispatcher depends on the local workspace version `0.1.5`. The SDK's three runtime dependencies are not vendored and continue to resolve from their configured registries.

## Container image layout

The Containerfile installs the npm workspaces and creates `node_modules/@nvidia/openshell-sdk` as a workspace link to `/app/packages/openshell-sdk`. The final image must copy both `node_modules` and the vendored directory to that exact path; copying only the link would leave it broken at runtime. The Containerfile also preserves the Agent Dispatcher package manifest beside its compiled output so Node resolves the package's ESM configuration.

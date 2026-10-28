# Nx workspace foundation

Nx is available from the repository root for future projects only. This is a
gradual-adoption foundation: it does not migrate or register existing projects,
or replace their package managers, build/test commands, or deployment flows.

## Root commands

Use Node.js 22 or newer. Root Nx is pinned to `24.0.1`; install only root
dependencies with:

```bash
npm ci
npm exec nx -- --version
npm exec nx -- show projects
```

`show projects` reports registered Nx projects. The private root npm manifest
declares workspaces only for `packages/*`; npm workspaces exist solely to install
and manage packages under that path. The existing `coordinator/` and
`dashboard/` projects remain independent, with their own manifests and
lockfiles, and are not included in root workspaces or registered as Nx projects.
No Nx plugins are configured.

## Adding future Nx projects

Add all new Nx-managed packages under `packages/`. For each package, add a
`project.json` with its name, root, and Nx targets, or use a generator from a
deliberately selected Nx plugin. If a plugin is needed, add its version
matching the pinned Nx release to the root dev dependencies, then use that
plugin's documented generator. Keep project-specific build, test, and deployment
behavior explicit in the new project's targets.

Do not add existing directories to Nx or root npm workspaces, or change
existing project manifests/lockfiles as part of this foundation. Any migration
of `coordinator/` or `dashboard/` requires separate scope and review.

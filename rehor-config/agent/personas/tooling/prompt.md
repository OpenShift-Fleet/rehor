## Tooling & Build Infrastructure Guidelines

You are working on a build/dev tooling repo — Dockerfiles, shell scripts, proxy configs, CI pipelines, and similar infrastructure that supports frontend and backend applications.

### General

- These repos are NOT application code. They are shared infrastructure used by many teams.
- Changes here have a wide blast radius — a broken build image or proxy affects all frontend apps.
- Follow existing patterns. These repos prioritize stability over cleverness.
- Read the repo's `README.md` and any docs for repo-specific conventions.

### Dockerfiles

- Use multi-stage builds where appropriate.
- Prefer UBI (Universal Base Image) base images for production.
- Keep images minimal — only install what's needed.
- Never hardcode secrets or tokens in Dockerfiles. Use build args or mounted secrets.
- Pin base image versions to specific tags, not `latest`.
- Run as non-root user where possible.

### Shell scripts

- Use `set -euo pipefail` at the top of scripts.
- Quote all variables: `"${VAR}"` not `$VAR`.
- Use `shellcheck` if available to lint scripts.
- Add comments explaining non-obvious logic — these scripts are maintained by many people.
- Test scripts locally before committing.

### Proxy / Caddy / NGINX configs

- Test config changes against a real running instance if possible.
- Be careful with route ordering — more specific routes before catch-alls.
- Document any new environment variables or config options.

### Go plugins (e.g. Caddy modules)

- Follow Go conventions: `go vet`, `gofmt`, table-driven tests.
- Use `go build` to verify compilation.
- Run `go test ./...` for any Go code.

### Testing

- For shell scripts: test edge cases (missing files, empty vars, special characters).
- For Dockerfiles: build the image and verify it starts correctly.
- For config changes: validate syntax before committing.
- Run any existing test suites: check for `test/`, `Makefile` targets, or CI scripts.

### CVE fixes in these repos

- CVEs here are typically in base images or system packages, not application dependencies.
- Fix by updating the base image tag or adding explicit `dnf update` / `apk upgrade` for affected packages.
- Verify the CVE is actually resolved in the new image by checking package versions.

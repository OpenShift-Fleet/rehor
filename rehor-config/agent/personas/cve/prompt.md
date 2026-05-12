## CVE Remediation

Fixing security vulnerability (CVE).

### Check if already fixed

`npm audit` or check current version vs fixed version in ticket. Already at/above fixed version → Jira comment confirming fixed (include version) → transition "Done" → stop.

### Determine source

1. **npm pkg** — in `package.json`/`package-lock.json`
2. **Base image dep** — from container image, not npm

### npm CVEs

- Direct or transitive? `npm ls <pkg>`
- Direct → bump version in `package.json`
- Transitive → upgrade parent dep. No fix available → add `overrides` in `package.json`
- `npm install` → regenerate lock file
- Run tests
- Commit both `package.json` + `package-lock.json`

### Non-npm CVEs (base image) — frontend only

Frontend apps inherit base image from `build-tools` → CVE can't be fixed in app repo.

- Jira comment: base image CVE from `build-tools`, needs fix there
- `build-tools` in `project-repos.json` → check if already updated

Backend repos → investigate + fix normally (own base images).

### Verification — npm

- `npm audit` → confirm resolved
- Full test suite
- LSP `get_diagnostics` if upgraded pkg has API changes

### Verification — container image scanning

After CVE fix → verify image clean w/ Buildah + Grype.

#### Build & scan (fix verification)

```bash
buildah build -t <repo>:scan .
buildah push <repo>:scan oci-archive:/tmp/<repo>.tar
grype oci-archive:/tmp/<repo>.tar --only-fixed
rm -f /tmp/<repo>.tar
buildah rmi <repo>:scan
```

Multiple Dockerfiles → use plain `Dockerfile` (not `.hermetic`).
`--only-fixed` → only CVEs w/ known fixes. Verify ticket CVE gone.

#### Scan existing Quay images (investigation)

```bash
grype registry:quay.io/<namespace>/<image>:<tag> --only-fixed
```

No build needed — grype pulls from registry directly.

#### Report results

Grype summary in PR description + Jira comment. Table format:
```
| CVE | Package | Installed | Fixed | Severity |
```

# Env Presets

Env presets add tools, runtimes, and capabilities to your bot instance. Each preset is a self-contained package under `presets/envs/<name>/` in the dev-bot repo.

## Using Env Presets

Add preset names to the `envs` list in your `instance.yaml`:

```yaml
# instance/<your-config>/agent/instance.yaml
workflow: jira-sprint
source: jira
envs:
  - node          # nvm + Node.js
  - go            # goenv + Go
  - browser       # Chromium + chrome-devtools MCP
  - slack         # Slack notifications
```

Presets are installed during `docker build` — their `install.sh` scripts run automatically. No runtime setup needed.

---

## node

**Path**: `presets/envs/node/`

Installs [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager) with Node.js 22 LTS as the default. The bot can switch versions per-repo at runtime.

**What gets installed**:
- nvm v0.40.3 at `/usr/local/nvm`
- Node.js 22 (LTS) as default
- `node`, `npm`, `npx` symlinked to `/usr/local/bin/`
- Shell init via `/etc/profile.d/nvm.sh`

**When to use**: Any instance working on repos with `package.json` — frontend, Node.js backends, monorepos.

**Version switching** (the bot does this automatically if a repo needs a different version):
```bash
nvm install 20    # install Node 20
nvm use 20        # switch to it
```

**Depends on**: nothing

---

## go

**Path**: `presets/envs/go/`

Installs [goenv](https://github.com/go-nv/goenv) (Go version manager) with Go 1.24.2 and 1.25.7, plus golangci-lint.

**What gets installed**:
- goenv at `/usr/local/goenv`
- Go 1.24.2 (default) and 1.25.7
- golangci-lint v2.1.6
- `go`, `gofmt`, `golangci-lint` symlinked to `/usr/local/bin/`
- Shell init via `/etc/profile.d/goenv.sh`

**When to use**: Any instance working on repos with `go.mod` — Go services, operators, CLI tools.

**Version switching**:
```bash
goenv install 1.23.0    # install a specific version
goenv global 1.23.0     # set as default
```

**Depends on**: nothing

---

## patternfly-mcp

**Path**: `presets/envs/patternfly-mcp/`

Installs the [hcc-pf-mcp](https://www.npmjs.com/package/@redhat-cloud-services/hcc-pf-mcp) MCP server, which gives the bot PatternFly component guidance — available components, props, examples, and CSS utilities.

**What gets installed**:
- `@redhat-cloud-services/hcc-pf-mcp` (npm global package)
- Registered as the `hcc-patternfly-data-view` MCP server

**When to use**: Frontend instances working on PatternFly-based UIs. Helps the bot use correct PF components and patterns.

**Depends on**: `node` preset (needs npm)

```yaml
envs:
  - node              # must come before patternfly-mcp
  - patternfly-mcp
```

---

## browser

**Path**: `presets/envs/browser/`

Installs Chromium and the chrome-devtools MCP server for visual verification. The bot can take screenshots, inspect the DOM, and verify UI changes in a real browser.

**What gets installed**:
- Chromium (via Playwright)
- `chrome-devtools-mcp` MCP server
- `gh-release-upload` skill (for uploading screenshots to PR comments)
- Runtime init script at `entrypoint.d/10-chromium.sh`

**When to use**: Any instance working on UI repos where visual verification matters. The bot starts a dev server, navigates to the relevant page, and takes screenshots.

**Requires env var**: `PLAYWRIGHT_BROWSERS_PATH` (set automatically in the container)

**Depends on**: nothing

---

## container-scan

**Path**: `presets/envs/container-scan/`

Installs Grype (vulnerability scanner) and Buildah (container image builder) for CVE investigation and scanning.

**What gets installed**:
- [Grype](https://github.com/anchore/grype) — scans container images for known vulnerabilities
- [Buildah](https://github.com/containers/buildah) — builds container images without Docker daemon

**When to use**: Instances handling CVE tickets or security scanning. The bot builds the Dockerfile, scans the image, and reports findings.

**Depends on**: nothing

---

## dev-proxy

**Path**: `presets/envs/dev-proxy/`

Installs a custom Caddy reverse proxy for verifying frontend changes against stage environments.

**What gets installed**:
- Custom Caddy build with HCC-specific modules
- `start-dev-proxy.sh` script
- Runtime init script at `entrypoint.d/20-dev-proxy.sh`

**When to use**: Frontend instances that need to verify UI changes against a running stage deployment (e.g. console.redhat.com stage).

**Requires env var**: `PROXY_HOST` (the stage hostname to proxy to)

**Depends on**: nothing

---

## slack

**Path**: `presets/envs/slack/`

Adds the Slack notification skill. The bot sends alerts when PRs are created, tickets are blocked, or infrastructure errors occur. 48-hour cooldown per ticket prevents spam.

**What gets installed**:
- `slack-notify` skill

**When to use**: Any instance where the team wants Slack notifications about bot activity.

**Requires env var**: `SLACK_WEBHOOK_URL` (Slack incoming webhook URL)

**Depends on**: nothing

---

## Creating a New Env Preset

1. Create `presets/envs/<name>/` in the dev-bot repo
2. Add `install.sh` — must be idempotent (detect existing installs and skip):
   ```bash
   #!/bin/bash
   # presets/envs/my-tool/install.sh
   set -e
   if command -v my-tool &>/dev/null; then
       echo "my-tool preset: already installed, skipping"
       exit 0
   fi
   # ... install logic ...
   ```
3. Add `manifest.yaml`:
   ```yaml
   name: my-tool
   type: env
   description: What this preset adds

   install: install.sh

   provides:
     binaries:
       - my-tool

   requires:
     presets:
       - node           # if it depends on another preset
     env_vars:
       - MY_REQUIRED_VAR
   ```
4. Test: build a Docker image, run `my-tool --version` inside it
5. Add to your `instance.yaml` `envs:` list
6. Open a PR against dev-bot

Install scripts run during `docker build` via the loop in `Dockerfile.runner` (line 155):
```dockerfile
RUN for script in presets/envs/*/install.sh; do bash "$script"; done
```

They run as root and must be idempotent — the Docker layer cache means they may run multiple times during development.

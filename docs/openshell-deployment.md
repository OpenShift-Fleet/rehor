# OpenShell Deployment

Production runner instances use OpenShell `SandboxTemplate` + `SandboxWarmPool` resources instead of bot `Deployment` replicas. KEDA scales `SandboxWarmPool` during work windows. Start from `deploy/sandbox-template.example.yaml`.

## Prerequisites

- Shared platform namespace: OpenShell gateway, agent-sandbox controller, CRDs, and KEDA are already installed.
- Standalone namespace: install OpenShell gateway, agent-sandbox controller, `extensions.agents.x-k8s.io/v1beta1` SandboxTemplate/SandboxWarmPool CRDs, and KEDA before applying the template.
- Shared `devbot-proxy`, `devbot-memory-server`, and `devbot-secrets` deployed first.
- Bot image available to cluster; use immutable `BOT_IMAGE_DIGEST`.
- App-interface `managedResourceTypes` includes `SandboxTemplate.agents.x-k8s.io`, `SandboxWarmPool.agents.x-k8s.io`, `ScaledObject.keda.sh`, and `NetworkPolicy`.

## Filesystem Contract

| Path | Access | Purpose |
|------|--------|---------|
| `/home/botuser/app` | read by agent; bootstrap runtime writes only | Runner code and config |
| `/home/botuser/repos` | read/write | Checked-out target repositories and implementation changes |
| `/home/botuser/data` | read/write | Caches, cycle state, merged config, and reports |
| `/tmp` | read/write | Temporary files |
| `/usr`, `/lib`, `/etc`, `/proc`, `/dev` | read-only | Runtime and system tooling |
| Credential paths | denied | SSH, GPG, cloud, and CLI credential stores |

Agent implementation changes belong under `/home/botuser/repos`. Never write runner source, instance config, system paths, or credential locations.

## Network Contract

Sandbox egress allows only:

- `devbot-proxy` ports `3128`, `8443`, `8444`, `8446`, and `9090`.
- `devbot-memory-server` port `8080`.
- OpenShift DNS on TCP/UDP `53`.

This example blocks direct internet egress. HTTP/HTTPS traffic uses Squid through `HTTP_PROXY` and `HTTPS_PROXY`. Credentials remain in proxy services; Sandbox receives no service tokens.

## Verification

```bash
oc get sandboxtemplate,sandboxwarmpool,scaledobject -l app.kubernetes.io/name=<bot-name>
oc get pods -l app.kubernetes.io/name=<bot-name>
oc logs -l app.kubernetes.io/component=bot --tail=100
```

Verify KEDA scales `SandboxWarmPool` to one replica during work windows and back to zero afterward.
